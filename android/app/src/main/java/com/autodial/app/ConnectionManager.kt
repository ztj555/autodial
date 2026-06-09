package com.autodial.app

import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.util.concurrent.TimeUnit

/**
 * AutoDial ConnectionManager v7
 * 统一连接管道：策略驱动 LAN/Cloud 双通道，单一入口 connect()
 * 策略: AUTO(同时LAN+Cloud) / LAN_ONLY / CLOUD_ONLY
 */
class ConnectionManager(private val context: Context) {

    companion object {
        private const val TAG = "ConnMgr"
        private const val LAN_PORT = 35432
        private const val DISCOVERY_PORT = 35433
        private const val DISCOVERY_TIMEOUT_MS = 8000L
        private const val DISCOVERY_RETRY_COUNT = 3
        private const val DISCOVERY_INTERVAL_MS = 200L
        private const val HEARTBEAT_INTERVAL_MS = 30000L
        private const val PONG_TIMEOUT_MS = 15000L
        private const val NETWORK_DEBOUNCE_MS = 2000L
    }

    // ==================== 状态机 ====================

    enum class ConnectionState { DISCONNECTED, DISCOVERING, CONNECTING, CONNECTED }

    sealed class ConnectionError {
        data class LanDiscoveryFailed(val reason: String) : ConnectionError()
        data class LanConnectFailed(val reason: String) : ConnectionError()
        data class CloudConnectFailed(val server: String, val reason: String) : ConnectionError()
        data class AuthFailed(val reason: String) : ConnectionError()
        data class Disconnected(val reason: String) : ConnectionError()
    }

    interface ConnectionStateListener {
        fun onStateChanged(newState: ConnectionState, oldState: ConnectionState)
        fun onMessageReceived(msg: JSONObject)
        fun onError(error: ConnectionError)
    }

    // ==================== 内部状态 ====================

    @Volatile private var state: ConnectionState = ConnectionState.DISCONNECTED
    @Volatile private var transportMode: String = ""

    @Volatile private var lanWebSocket: WebSocket? = null
    @Volatile private var cloudWebSocket: WebSocket? = null

    private val lanClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS).pingInterval(30, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS).build()
    private val cloudClient = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS).pingInterval(30, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS).build()

    private val handler = Handler(Looper.getMainLooper())

    // ReconnectScheduler
    private var reconnectAttempts = 0
    private var reconnectRunnable: Runnable? = null
    private var cloudReconnectAttempts = 0
    private var cloudReconnectRunnable: Runnable? = null
    private val MAX_RETRY_ATTEMPTS = 30
    private val MAX_CLOUD_RETRY_ATTEMPTS = 8

    // 心跳
    private var heartbeatRunnable: Runnable? = null
    private var lastLanPongTime = 0L
    private var lastCloudPongTime = 0L
    private var lanPingSentTime = 0L
    private var cloudPingSentTime = 0L
    private var lanPingInFlight = false
    private var cloudPingInFlight = false
    @Volatile var lanLatencyMs: Long = -1
        private set
    @Volatile var cloudLatencyMs: Long = -1
        private set

    // NetworkMonitor
    private var networkDebounceRunnable: Runnable? = null
    private var lanRetryRunnable: Runnable? = null
    private var lanRetryCount = 0
    private val MAX_LAN_RETRIES = 10 // 最多10次LAN恢复尝试
    private val LAN_RETRY_INTERVAL_MS = 60000L
    private val connectivityManager by lazy {
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    }
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    // ==================== 配置 ====================

    private var lastPin = ""
    private var lastLanIp = ""
    private var currentCloudServer = ""
    private var cloudServerList: List<String> = emptyList()
    private var autoReconnect = true
    private var manualConnecting = false
    @Volatile private var manualDisconnecting = false
    private var currentStrategy: ConnectionStrategy = ConnectionStrategy.AUTO

    // PC 在线状态（通过云中继确认）
    @Volatile var pcConfirmedOnline = false
        private set

    // LAN 发现序列
    private var lanDiscoveryCount = 0
    private val MAX_LAN_DISCOVERIES = 4
    private val FIRST_LAN_DISCOVERY_DELAY = 60_000L
    private val LAN_DISCOVERY_INTERVAL = 120_000L
    private var lanDiscoveryRunnable: Runnable? = null
    private var wasWifiAvailable = false

    private fun isAnyNetworkAvailable(): Boolean {
        try {
            val n = connectivityManager.activeNetwork ?: return false
            val caps = connectivityManager.getNetworkCapabilities(n) ?: return false
            return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        } catch (_: Exception) { return false }
    }

    private fun isWifiActive(): Boolean {
        try {
            val n = connectivityManager.activeNetwork ?: return false
            val caps = connectivityManager.getNetworkCapabilities(n) ?: return false
            return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
        } catch (_: Exception) { return false }
    }

    private val prefs: SharedPreferences by lazy {
        context.getSharedPreferences("autodial", Context.MODE_PRIVATE)
    }

    private val listeners = mutableListOf<ConnectionStateListener>()

    // ==================== 公开属性 ====================

    val isConnected: Boolean
        get() {
            if (state != ConnectionState.CONNECTED) return false
            val lanOk = lanWebSocket != null && transportMode.contains("lan")
            val cloudOk = cloudWebSocket != null && transportMode.contains("cloud")
            return lanOk || cloudOk
        }
    /** PC 是否通过云中继可达（LAN 直接连接视为始终可达） */
    val isPcReachable: Boolean
        get() = isLanConnected || (isCloudConnected && pcConfirmedOnline)
    val connectionMode: String get() = transportMode
    val isLanConnected: Boolean get() = lanWebSocket != null
    val isCloudConnected: Boolean get() = cloudWebSocket != null
    val currentCloudUrl: String get() = currentCloudServer
    fun getState(): ConnectionState = state
    fun getTransportMode(): String = transportMode

    // ==================== 公开 API ====================

    /**
     * v7: 统一连接入口，根据策略决定通道行为
     */
    fun connect(pin: String, hintIp: String = "", strategy: ConnectionStrategy = ConnectionStrategy.AUTO) {
        v6LogI(TAG, pin, "connect(hintIp=$hintIp, strategy=${strategy.label})")
        manualDisconnecting = false
        cancelReconnect()
        cancelCloudReconnect()
        reconnectAttempts = 0
        cloudReconnectAttempts = 0
        currentStrategy = strategy

        lastPin = pin
        manualConnecting = true

        val cloudAvailable = cloudServerList.isNotEmpty()

        when (strategy) {
            ConnectionStrategy.AUTO -> {
                // AUTO: 同时尝试 LAN + Cloud，谁先通谁先亮
                if (hintIp.isNotEmpty()) {
                    lastLanIp = hintIp
                    setState(ConnectionState.CONNECTING)
                    connectLan(hintIp, pin)
                } else {
                    lastLanIp = prefs.getString("ip", "") ?: ""
                    setState(ConnectionState.DISCOVERING)
                    startLanDiscovery(pin)
                }
                // 同时连接云端（不等LAN发现结果）
                if (cloudAvailable) connectCloud(cloudServerList, pin)
            }
            ConnectionStrategy.LAN_ONLY -> {
                if (hintIp.isNotEmpty()) {
                    lastLanIp = hintIp
                    setState(ConnectionState.CONNECTING)
                    connectLan(hintIp, pin)
                } else {
                    lastLanIp = prefs.getString("ip", "") ?: ""
                    setState(ConnectionState.DISCOVERING)
                    startLanDiscovery(pin)
                }
            }
            ConnectionStrategy.CLOUD_ONLY -> {
                if (!cloudAvailable) {
                    v6LogW(TAG, pin, "云端未配置, 无法使用仅云中转策略")
                    setState(ConnectionState.DISCONNECTED)
                    manualConnecting = false
                    return
                }
                setState(ConnectionState.CONNECTING)
                connectCloud(cloudServerList, pin)
            }
        }
    }

    /**
     * v7: 断开所有连接
     */
    fun disconnect() {
        v6LogI(TAG, lastPin, "disconnect()")
        manualConnecting = false
        manualDisconnecting = true
        cancelReconnect()
        cancelCloudReconnect()
        cancelLanRetry()
        cancelLanDiscoveryCycle()
        reconnectAttempts = 0
        cloudReconnectAttempts = 0

        try { lanWebSocket?.cancel() } catch (_: Exception) {}
        lanWebSocket = null
        try { cloudWebSocket?.cancel() } catch (_: Exception) {}
        cloudWebSocket = null

        setState(ConnectionState.DISCONNECTED)
    }

    /**
     * v7: 断开云端连接（内部使用，LAN保持时清理cloud）
     */
    fun disconnectCloud() {
        v6LogI(TAG, lastPin, "disconnectCloud()")
        cancelCloudReconnect()
        cloudReconnectAttempts = 0

        try { cloudWebSocket?.cancel() } catch (_: Exception) {}
        cloudWebSocket = null

        if (transportMode.contains("cloud")) {
            transportMode = if (transportMode.contains("lan")) "lan" else ""
            if (transportMode.isEmpty()) setState(ConnectionState.DISCONNECTED)
        }
    }

    fun send(msg: JSONObject): Boolean {
        if (transportMode.contains("lan") && lanWebSocket != null) {
            try {
                val sent = lanWebSocket?.send(msg.toString()) ?: false
                if (sent) {
                    v6LogMsg("SEND-LAN", msg.optString("type", "?"), msg.toString(), lastPin)
                    return true
                }
            } catch (_: Exception) {
                v6LogW(TAG, lastPin, "LAN 发送失败, 尝试云端降级")
                lanWebSocket = null
                if (cloudWebSocket != null && transportMode.contains("cloud")) {
                    transportMode = "cloud"
                } else {
                    transportMode = ""
                    setState(ConnectionState.DISCONNECTED)
                }
            }
        }

        if (transportMode.contains("cloud") && cloudWebSocket != null) {
            try {
                val sent = cloudWebSocket?.send(msg.toString()) ?: false
                if (sent) {
                    v6LogMsg("SEND-CLOUD", msg.optString("type", "?"), msg.toString(), lastPin)
                    return true
                }
            } catch (_: Exception) {
                v6LogW(TAG, lastPin, "Cloud 发送失败")
                cloudWebSocket = null
                if (transportMode == "cloud") {
                    transportMode = ""
                    setState(ConnectionState.DISCONNECTED)
                }
            }
        }
        return false
    }

    fun addListener(listener: ConnectionStateListener) {
        if (!listeners.contains(listener)) listeners.add(listener)
    }

    fun removeListener(listener: ConnectionStateListener) {
        listeners.remove(listener)
    }

    fun loadSavedConfig() {
        autoReconnect = prefs.getBoolean("auto_reconnect", true)
        if (prefs.getBoolean("manual_disconnect", false)) autoReconnect = false

        // 读取策略（向后兼容旧 cloud_enabled，自动迁移）
        currentStrategy = ConnectionStrategy.readFromPrefs(prefs)

        val wasConnected = prefs.getBoolean("was_connected", false)
        lastPin = prefs.getString("pin", "") ?: ""
        lastLanIp = prefs.getString("ip", "") ?: ""
        currentCloudServer = prefs.getString("cloud_server", "") ?: ""
        val serversJson = prefs.getString("cloud_servers", null)

        cloudServerList = if (serversJson != null) {
            try {
                val arr = JSONArray(serversJson)
                (0 until arr.length()).map { arr.getString(it) }
            } catch (_: Exception) {
                if (currentCloudServer.isNotEmpty()) listOf(currentCloudServer) else emptyList()
            }
        } else {
            if (currentCloudServer.isNotEmpty()) listOf(currentCloudServer) else emptyList()
        }

        if (!isAnyNetworkAvailable()) {
            v6LogI(TAG, lastPin, "无可用网络, 跳过连接")
            setState(ConnectionState.DISCONNECTED)
            return
        }

        val wifiAvailable = isWifiActive()
        wasWifiAvailable = wifiAvailable
        val cloudAvailable = cloudServerList.isNotEmpty()

        if (wasConnected && lastPin.isNotEmpty() && !isConnected) {
            when (currentStrategy) {
                ConnectionStrategy.AUTO -> {
                    val canLan = wifiAvailable
                    val canCloud = cloudAvailable
                    if (!canLan && !canCloud) {
                        v6LogW(TAG, lastPin, "AUTO: 无可用通道(LAN不可用且未配置云端)")
                        setState(ConnectionState.DISCONNECTED)
                        return
                    }
                    setState(ConnectionState.CONNECTING)
                    if (canLan && lastLanIp.isNotEmpty()) connectLan(lastLanIp, lastPin)
                    if (canLan) startLanDiscoveryCycle()
                    if (canCloud) connectCloud(cloudServerList, lastPin)
                }
                ConnectionStrategy.LAN_ONLY -> {
                    if (wifiAvailable && lastLanIp.isNotEmpty()) {
                        setState(ConnectionState.CONNECTING)
                        connectLan(lastLanIp, lastPin)
                        startLanDiscoveryCycle()
                    } else {
                        v6LogW(TAG, lastPin, "LAN_ONLY: WiFi不可用或无历史IP")
                        setState(ConnectionState.DISCONNECTED)
                    }
                }
                ConnectionStrategy.CLOUD_ONLY -> {
                    if (cloudAvailable) {
                        setState(ConnectionState.CONNECTING)
                        connectCloud(cloudServerList, lastPin)
                    } else {
                        v6LogW(TAG, lastPin, "CLOUD_ONLY: 未配置云服务器")
                        setState(ConnectionState.DISCONNECTED)
                    }
                }
            }
        }
    }

    fun setCloudServers(servers: List<String>) {
        cloudServerList = servers
        if (servers.isNotEmpty()) currentCloudServer = servers[0]
    }

    fun cleanup() {
        unregisterNetworkMonitor()
        cancelLanRetry()
        cancelLanDiscoveryCycle()
        disconnect()
        listeners.clear()
    }

    // ==================== 亮屏健康检查 ====================

    fun wakeAndReconnect() {
        if (!isConnected) {
            v6LogI(TAG, lastPin, "亮屏检测: 已断开, 触发重连")
            reconnectAttempts = 0
            loadSavedConfig()
            return
        }

        val pingMsg = JSONObject().put("type", "ping")

        if (transportMode.contains("lan") && lanWebSocket != null) {
            val lastPong = lastLanPongTime
            try {
                lanWebSocket?.send(pingMsg.toString())
                handler.postDelayed({
                    if (lastLanPongTime == lastPong && transportMode.contains("lan")) {
                        v6LogW(TAG, lastPin, "亮屏检测: LAN 僵尸连接, 重建")
                        try { lanWebSocket?.cancel() } catch (_: Exception) {}
                        lanWebSocket = null
                        connect(lastPin, lastLanIp, currentStrategy)
                    }
                }, 2000)
            } catch (_: Exception) {
                lanWebSocket = null
                connect(lastPin, lastLanIp, currentStrategy)
            }
        } else if (transportMode == "cloud" && currentStrategy == ConnectionStrategy.AUTO) {
            v6LogI(TAG, lastPin, "亮屏检测: cloud-only, 启动LAN发现序列")
            startLanDiscoveryCycle()
        }

        if (transportMode.contains("cloud") && cloudWebSocket != null) {
            val lastPong = lastCloudPongTime
            try {
                cloudWebSocket?.send(pingMsg.toString())
                handler.postDelayed({
                    if (lastCloudPongTime == lastPong && transportMode.contains("cloud")) {
                        v6LogW(TAG, lastPin, "亮屏检测: Cloud 僵尸连接, 重建")
                        try { cloudWebSocket?.cancel() } catch (_: Exception) {}
                        cloudWebSocket = null
                        connectCloud(cloudServerList, lastPin)
                    }
                }, 2000)
            } catch (_: Exception) {
                cloudWebSocket = null
                connectCloud(cloudServerList, lastPin)
            }
        }
    }

    fun onReconnectRequest() {
        v6LogI(TAG, lastPin, "收到云端唤醒 reconnect_request")
        cancelReconnect()
        reconnectAttempts = 0
        scheduleReconnect("pc_force")
    }

    // ==================== 上传协议桩方法 ====================

    fun sendFile(filePath: String, callback: ((Boolean, String?) -> Unit)?): Boolean {
        v6LogW(TAG, lastPin, "[UPLOAD-STUB] sendFile: $filePath")
        callback?.invoke(false, "Not implemented")
        return false
    }

    fun sendData(data: ByteArray, mimeType: String, fileName: String, callback: ((Boolean, String?) -> Unit)?): Boolean {
        v6LogW(TAG, lastPin, "[UPLOAD-STUB] sendData: $fileName (${data.size} bytes)")
        callback?.invoke(false, "Not implemented")
        return false
    }

    // ==================== NetworkMonitor ====================

    fun registerNetworkMonitor() {
        unregisterNetworkMonitor()
        try {
            networkCallback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { scheduleNetworkDebounce("network_available") }
                override fun onLost(network: Network) { scheduleNetworkDebounce("network_lost") }
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    scheduleNetworkDebounce("network_caps_changed")
                }
            }
            connectivityManager.registerNetworkCallback(
                NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
                networkCallback!!
            )
            v6LogI(TAG, lastPin, "NetworkMonitor 已注册")
        } catch (e: Exception) {
            v6LogE(TAG, lastPin, "NetworkMonitor 注册失败: ${e.message}")
        }
    }

    fun unregisterNetworkMonitor() {
        try {
            networkCallback?.let { connectivityManager.unregisterNetworkCallback(it) }
            networkCallback = null
            networkDebounceRunnable?.let { handler.removeCallbacks(it) }
            networkDebounceRunnable = null
        } catch (_: Exception) {}
    }

    private fun scheduleNetworkDebounce(reason: String) {
        networkDebounceRunnable?.let { handler.removeCallbacks(it) }
        networkDebounceRunnable = Runnable {
            v6LogI(TAG, lastPin, "网络变化: $reason")
            val wifiNow = isWifiActive()

            if (wifiNow && !wasWifiAvailable && currentStrategy != ConnectionStrategy.CLOUD_ONLY) {
                v6LogI(TAG, lastPin, "检测到WiFi打开, 启动LAN发现序列")
                startLanDiscoveryCycle()
            } else if (!wifiNow && wasWifiAvailable) {
                v6LogI(TAG, lastPin, "检测到WiFi关闭, 停止LAN发现")
                cancelLanDiscoveryCycle()
                cancelLanRetry()
            }
            wasWifiAvailable = wifiNow

            cancelReconnect()
            reconnectAttempts = 0

            if (autoReconnect && lastPin.isNotEmpty() && !isConnected) {
                scheduleReconnect("network_change")
            } else if (transportMode == "cloud" && currentStrategy != ConnectionStrategy.CLOUD_ONLY) {
                v6LogI(TAG, lastPin, "云端在线，尝试 LAN 发现")
                tryReconnectLanIfCloudOnly()
            }
        }
        handler.postDelayed(networkDebounceRunnable!!, NETWORK_DEBOUNCE_MS)
    }

    private fun tryReconnectLanIfCloudOnly() {
        if (transportMode != "cloud" || lastPin.isEmpty() || currentStrategy == ConnectionStrategy.CLOUD_ONLY) return
        if (!isWifiActive()) return
        v6LogI(TAG, lastPin, "云端在线，开始UDP发现LAN")
        startLanDiscovery(lastPin)
    }

    /** 云端在线时定期尝试LAN恢复，最多MAX_LAN_RETRIES次 */
    private fun scheduleLanRetry() {
        cancelLanRetry()
        if (transportMode != "cloud" || lastPin.isEmpty() || currentStrategy == ConnectionStrategy.CLOUD_ONLY) return
        if (lanRetryCount >= MAX_LAN_RETRIES) {
            v6LogI(TAG, lastPin, "LAN恢复重试已达上限($MAX_LAN_RETRIES), 停止")
            return
        }
        if (!isWifiActive()) return // WiFi不可用时跳过
        lanRetryCount++
        lanRetryRunnable = Runnable {
            tryReconnectLanIfCloudOnly()
            scheduleLanRetry()
        }
        handler.postDelayed(lanRetryRunnable!!, LAN_RETRY_INTERVAL_MS)
    }

    private fun cancelLanRetry() {
        lanRetryRunnable?.let { handler.removeCallbacks(it) }
        lanRetryRunnable = null
        lanRetryCount = 0
    }

    // ==================== LAN 发现序列 ====================

    private fun startLanDiscoveryCycle() {
        cancelLanDiscoveryCycle()
        lanDiscoveryCount = 0
        v6LogI(TAG, lastPin, "LAN发现序列启动")
        scheduleNextLanDiscovery()
    }

    private fun scheduleNextLanDiscovery() {
        if (lanDiscoveryCount >= MAX_LAN_DISCOVERIES) {
            v6LogI(TAG, lastPin, "LAN发现序列完成(已尝试${MAX_LAN_DISCOVERIES}次), 停止")
            cancelLanDiscoveryCycle()
            return
        }
        if (transportMode.contains("lan")) {
            cancelLanDiscoveryCycle()
            return
        }
        val delay = if (lanDiscoveryCount == 0) FIRST_LAN_DISCOVERY_DELAY else LAN_DISCOVERY_INTERVAL
        lanDiscoveryCount++
        v6LogI(TAG, lastPin, "LAN发现第${lanDiscoveryCount}次, ${delay/1000}s后")
        lanDiscoveryRunnable = Runnable {
            startLanDiscovery(lastPin)
            scheduleNextLanDiscovery()
        }
        handler.postDelayed(lanDiscoveryRunnable!!, delay)
    }

    private fun cancelLanDiscoveryCycle() {
        lanDiscoveryRunnable?.let { handler.removeCallbacks(it) }
        lanDiscoveryRunnable = null
        lanDiscoveryCount = 0
    }

    // ==================== 内部: LAN 发现 ====================

    private fun startLanDiscovery(pin: String) {
        Thread {
            var discoveredIp: String? = null
            try {
                val socket = DatagramSocket(null)
                socket.soTimeout = DISCOVERY_TIMEOUT_MS.toInt()
                socket.reuseAddress = true
                val discoverMsg = JSONObject().apply { put("type", "discover"); put("pin", pin) }.toString().toByteArray()
                for (i in 0 until DISCOVERY_RETRY_COUNT) {
                    try {
                        socket.send(DatagramPacket(discoverMsg, discoverMsg.size, InetAddress.getByName("255.255.255.255"), DISCOVERY_PORT))
                    } catch (_: Exception) {}
                    if (i < DISCOVERY_RETRY_COUNT - 1) Thread.sleep(DISCOVERY_INTERVAL_MS)
                }
                val buffer = ByteArray(1024)
                val startTime = System.currentTimeMillis()
                while (System.currentTimeMillis() - startTime < DISCOVERY_TIMEOUT_MS) {
                    try {
                        val response = DatagramPacket(buffer, buffer.size)
                        socket.receive(response)
                        val data = JSONObject(String(response.data, 0, response.length))
                        if ((data.optString("type") == "found" || data.optString("type") == "announce") && data.optString("pin") == pin) {
                            discoveredIp = data.optString("ip", "")
                            if (discoveredIp!!.isNotEmpty()) break
                        }
                    } catch (_: Exception) {}
                }
                socket.close()
            } catch (e: Exception) { v6LogE(TAG, pin, "LAN 发现异常: ${e.message}") }

            handler.post {
                // 如果在发现期间用户手动断开了，放弃结果
                if (manualDisconnecting) {
                    v6LogI(TAG, pin, "LAN 发现完成但已手动断开, 放弃")
                    return@post
                }
                if (discoveredIp != null && discoveredIp!!.isNotEmpty()) {
                    v6LogI(TAG, pin, "LAN 发现: $discoveredIp")
                    lastLanIp = discoveredIp!!
                    setState(ConnectionState.CONNECTING)
                    connectLan(discoveredIp!!, pin)
                } else {
                    v6LogW(TAG, pin, "LAN 发现失败")
                    // AUTO 策略下由同时发起的Cloud兜底，LAN_ONLY则提示
                    if (currentStrategy == ConnectionStrategy.AUTO || currentStrategy == ConnectionStrategy.CLOUD_ONLY) {
                        // Cloud已经并行在连，不需要额外动作
                    } else if (currentStrategy == ConnectionStrategy.LAN_ONLY) {
                        if (state != ConnectionState.CONNECTED) {
                            setState(ConnectionState.DISCONNECTED)
                            manualConnecting = false
                        }
                    }
                }
            }
        }.start()
    }

    // ==================== 内部: LAN 连接 ====================

    private fun connectLan(ip: String, pin: String) {
        try {
            try { lanWebSocket?.cancel() } catch (_: Exception) {}
            lanWebSocket = null
            v6LogI(TAG, pin, "LAN 连接: ws://$ip:$LAN_PORT")
            lanWebSocket = lanClient.newWebSocket(Request.Builder().url("ws://$ip:$LAN_PORT").build(), createLanListener(pin))
        } catch (e: Exception) {
            v6LogE(TAG, pin, "LAN 连接异常: ${e.message}")
            handler.post {
                notifyError(ConnectionError.LanConnectFailed(e.message ?: "unknown"))
                // AUTO策略下Cloud已在并行连接，不额外fallback
            }
        }
    }

    private fun createLanListener(pin: String): WebSocketListener {
        return object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                v6LogI(TAG, pin, "LAN WebSocket 已打开")
                try {
                    ws.send(JSONObject().apply {
                        put("type", "phone_hello"); put("pin", pin)
                        put("deviceName", android.os.Build.MODEL ?: android.os.Build.DEVICE ?: "Android")
                    }.toString())
                } catch (e: Exception) { v6LogE(TAG, pin, "LAN hello 发送失败: ${e.message}") }
            }

            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    val msg = JSONObject(text)
                    v6LogMsg("RECV-LAN", msg.optString("type", "?"), text, pin)
                    when (msg.optString("type", "")) {
                        "auth_ok" -> {
                            v6LogI(TAG, pin, "LAN 认证成功")
                            manualConnecting = false
                            reconnectAttempts = 0
                            transportMode = if (isCloudConnected) "lan+cloud" else "lan"
                            cancelLanRetry()
                            cancelLanDiscoveryCycle()
                            lastLanPongTime = System.currentTimeMillis()
                            lanPingInFlight = false
                            setState(ConnectionState.CONNECTED)
                        }
                        "auth_fail" -> {
                            v6LogW(TAG, pin, "LAN 认证失败")
                            manualConnecting = false
                            handler.post { notifyError(ConnectionError.AuthFailed(msg.optString("reason", ""))) }
                            ws.close(1000, "auth_fail")
                        }
                        "pong" -> { lastLanPongTime = System.currentTimeMillis(); lanPingInFlight = false; lanLatencyMs = lastLanPongTime - lanPingSentTime }
                        "kicked" -> {
                            v6LogW(TAG, pin, "被 PC 踢出")
                            manualConnecting = false; setState(ConnectionState.DISCONNECTED)
                            handler.post { notifyError(ConnectionError.Disconnected("kicked")) }
                        }
                        "reconnect_request" -> onReconnectRequest()
                        "wake_connect" -> {
                            v6LogI(TAG, pin, "收到局域网 UDP 唤醒包")
                            if (!isConnected) {
                                val wakeIp = msg.optString("ip", "")
                                if (wakeIp.isNotEmpty()) {
                                    cancelReconnect(); reconnectAttempts = 0
                                    handler.post { connect(pin, wakeIp, currentStrategy) }
                                } else onReconnectRequest()
                            }
                        }
                        else -> handler.post { notifyMessage(msg) }
                    }
                } catch (e: Exception) { v6LogE(TAG, pin, "LAN 消息解析失败: ${e.message}") }
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                try { ws.close(1000, null) } catch (_: Exception) {}
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                v6LogW(TAG, pin, "LAN closed code=$code")
                handleLanDisconnect()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                v6LogE(TAG, pin, "LAN 失败: ${t.message}")
                handleLanDisconnect()
            }
        }
    }

    private fun handleLanDisconnect() {
        try { lanWebSocket?.cancel() } catch (_: Exception) {}
        lanWebSocket = null
        v6LogW(TAG, lastPin, "handleLanDisconnect, transport=$transportMode")

        if (manualDisconnecting) {
            v6LogI(TAG, lastPin, "手动断开中，跳过LAN自动重连")
            return
        }

        if (transportMode.contains("lan")) {
            if (isCloudConnected) {
                transportMode = "cloud"
                v6LogI(TAG, lastPin, "LAN 断开, 已切换至云端")
                handler.post { notifyStateChange(ConnectionState.CONNECTED, ConnectionState.CONNECTED) }
                scheduleLanRetry()
            } else {
                setState(ConnectionState.DISCONNECTED)
                if (autoReconnect) scheduleReconnect("lan_disconnect")
            }
        }
    }

    // ==================== 内部: Cloud 连接 ====================

    private fun connectCloud(servers: List<String>, pin: String) {
        if (servers.isEmpty() || pin.isEmpty()) {
            if (state != ConnectionState.CONNECTED) {
                setState(ConnectionState.DISCONNECTED)
                manualConnecting = false
            }
            return
        }
        tryConnectCloudAtIndex(servers, pin, 0)
    }

    private fun tryConnectCloudAtIndex(servers: List<String>, pin: String, index: Int) {
        if (index >= servers.size) {
            v6LogW(TAG, pin, "所有云端服务器连接失败")
            if (state != ConnectionState.CONNECTED) {
                setState(ConnectionState.DISCONNECTED)
                manualConnecting = false
            }
            return
        }

        val server = servers[index]
        v6LogI(TAG, pin, "尝试云端 ${index + 1}/${servers.size}: $server")
        currentCloudServer = server

        if (state == ConnectionState.DISCOVERING || state == ConnectionState.DISCONNECTED) {
            setState(ConnectionState.CONNECTING)
        }

        try {
            cancelCloudReconnect()
            try { cloudWebSocket?.cancel() } catch (_: Exception) {}
            cloudWebSocket = null

            val url = if (server.startsWith("ws://") || server.startsWith("wss://")) server else "ws://$server"
            cloudWebSocket = cloudClient.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
                override fun onOpen(ws: WebSocket, response: Response) {
                    v6LogI(TAG, pin, "Cloud WebSocket 已打开: $currentCloudServer")
                    try {
                        ws.send(JSONObject().apply {
                            put("type", "phone_hello"); put("pin", pin)
                            put("deviceName", android.os.Build.MODEL ?: android.os.Build.DEVICE ?: "Android")
                        }.toString())
                    } catch (e: Exception) { v6LogE(TAG, pin, "Cloud hello 发送失败: ${e.message}") }
                }

                override fun onMessage(ws: WebSocket, text: String) {
                    try {
                        val msg = JSONObject(text)
                        v6LogMsg("RECV-CLOUD", msg.optString("type", "?"), text, pin)
                        when (msg.optString("type", "")) {
                            "auth_ok" -> {
                                v6LogI(TAG, pin, "Cloud 认证成功")
                                cloudReconnectAttempts = 0
                                manualConnecting = false
                                transportMode = if (transportMode.contains("lan")) "lan+cloud" else "cloud"
                                lastCloudPongTime = System.currentTimeMillis()
                                cloudPingInFlight = false
                                // 读取云中继上报的 PC 在线状态（兼容旧版云中继，默认 true）
                                pcConfirmedOnline = msg.optBoolean("pc_present", true)
                                v6LogI(TAG, pin, "PC 在线状态: $pcConfirmedOnline")
                                setState(ConnectionState.CONNECTED)
                            }
                            "auth_fail" -> {
                                v6LogW(TAG, pin, "Cloud 认证失败")
                                handler.post { notifyError(ConnectionError.AuthFailed(msg.optString("reason", ""))) }
                                ws.close(1000, "auth_fail")
                                tryConnectCloudAtIndex(servers, pin, index + 1)
                            }
                            "pong" -> { lastCloudPongTime = System.currentTimeMillis(); cloudPingInFlight = false; cloudLatencyMs = lastCloudPongTime - cloudPingSentTime }
                            "pc_online" -> {
                                v6LogI(TAG, pin, "PC 已上线 (via Cloud)")
                                pcConfirmedOnline = true
                                handler.post { notifyStateChange(ConnectionState.CONNECTED, ConnectionState.CONNECTED) }
                            }
                            "pc_offline" -> {
                                v6LogW(TAG, pin, "PC 已下线 (via Cloud)")
                                pcConfirmedOnline = false
                                handler.post { notifyStateChange(ConnectionState.CONNECTED, ConnectionState.CONNECTED) }
                            }
                            "reconnect_request" -> {
                                v6LogI(TAG, pin, "收到 PC 端云端唤醒指令 (via Cloud)")
                                onReconnectRequest()
                            }
                            else -> handler.post { notifyMessage(msg) }
                        }
                    } catch (e: Exception) { v6LogE(TAG, pin, "Cloud 消息解析失败: ${e.message}") }
                }

                override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                    try { ws.close(1000, null) } catch (_: Exception) {}
                }

                override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                    v6LogW(TAG, pin, "Cloud closed code=$code reason=$reason")
                    handleCloudDisconnect()
                    // 非手动断开时，根据策略决定是否重连
                    if (!manualDisconnecting && autoReconnect && currentStrategy != ConnectionStrategy.LAN_ONLY) {
                        scheduleCloudReconnect()
                    }
                }

                override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                    v6LogE(TAG, pin, "Cloud 失败: ${t.message}")
                    handleCloudDisconnect()
                    if (state == ConnectionState.CONNECTING) {
                        tryConnectCloudAtIndex(servers, pin, index + 1)
                    } else if (!manualDisconnecting && autoReconnect && currentStrategy != ConnectionStrategy.LAN_ONLY) {
                        scheduleCloudReconnect()
                    }
                }
            })
        } catch (e: Exception) {
            v6LogE(TAG, pin, "Cloud 连接异常: ${e.message}")
            tryConnectCloudAtIndex(servers, pin, index + 1)
        }
    }

    private fun handleCloudDisconnect() {
        try { cloudWebSocket?.cancel() } catch (_: Exception) {}
        cloudWebSocket = null
        pcConfirmedOnline = false
        v6LogW(TAG, lastPin, "handleCloudDisconnect, transport=$transportMode")

        if (manualDisconnecting) {
            v6LogI(TAG, lastPin, "手动断开中，跳过Cloud自动重连")
            return
        }

        if (transportMode.contains("cloud")) {
            if (transportMode.contains("lan")) {
                transportMode = "lan"
                v6LogI(TAG, lastPin, "Cloud 断开, LAN 仍活跃")
            } else {
                setState(ConnectionState.DISCONNECTED)
            }
        }
    }

    // ==================== ReconnectScheduler ====================

    private fun scheduleReconnect(reason: String) {
        cancelReconnect()
        if (!autoReconnect || lastPin.isEmpty() || manualDisconnecting) return
        if (isConnected) return
        if (reconnectAttempts >= MAX_RETRY_ATTEMPTS) {
            v6LogW(TAG, lastPin, "达到最大重试次数($MAX_RETRY_ATTEMPTS), 停止")
            return
        }

        val delayMs = getReconnectDelay(reconnectAttempts + 1)
        v6LogI(TAG, lastPin, "触发重连(第${reconnectAttempts + 1}次, $reason), ${delayMs}ms")

        reconnectRunnable = Runnable {
            if (!isConnected && lastPin.isNotEmpty() && !manualDisconnecting) {
                reconnectAttempts++
                connect(lastPin, lastLanIp, currentStrategy)
            }
        }
        handler.postDelayed(reconnectRunnable!!, delayMs)
    }

    private fun cancelReconnect() {
        try { reconnectRunnable?.let { handler.removeCallbacks(it) } } catch (_: Exception) {}
        reconnectRunnable = null
    }

    private fun scheduleCloudReconnect() {
        cancelCloudReconnect()
        if (!autoReconnect || lastPin.isEmpty() || manualDisconnecting) return
        if (cloudServerList.isEmpty()) return
        if (isCloudConnected) return
        if (currentStrategy == ConnectionStrategy.LAN_ONLY) return

        if (cloudReconnectAttempts >= MAX_CLOUD_RETRY_ATTEMPTS) {
            v6LogW(TAG, lastPin, "Cloud 重连达到最大次数, 停止")
            return
        }

        cloudReconnectAttempts++
        val delayMs = getReconnectDelay(cloudReconnectAttempts)

        cloudReconnectRunnable = Runnable {
            if (!isCloudConnected && cloudServerList.isNotEmpty() && !manualDisconnecting) {
                v6LogI(TAG, lastPin, "Cloud 重连(第${cloudReconnectAttempts}次)")
                connectCloud(cloudServerList, lastPin)
            }
        }
        handler.postDelayed(cloudReconnectRunnable!!, delayMs)
    }

    private fun cancelCloudReconnect() {
        try { cloudReconnectRunnable?.let { handler.removeCallbacks(it) } } catch (_: Exception) {}
        cloudReconnectRunnable = null
    }

    private fun getReconnectDelay(attempt: Int): Long {
        return when (attempt) {
            1 -> 0L; 2 -> 1000L; 3 -> 3000L
            in 4..6 -> 5000L; in 7..10 -> 10000L
            in 11..15 -> 30000L; in 16..20 -> 60000L
            else -> 300000L
        }
    }

    // ==================== 内部: 状态管理 ====================

    private fun setState(newState: ConnectionState) {
        val oldState = state
        if (oldState == newState) return
        state = newState
        v6LogI(TAG, lastPin, "State: $oldState → $newState, transport=$transportMode")
        handler.post { notifyStateChange(oldState, newState) }
        if (newState == ConnectionState.CONNECTED) startHeartbeat()
        else if (newState == ConnectionState.DISCONNECTED) stopHeartbeat()
    }

    private fun notifyStateChange(oldState: ConnectionState, newState: ConnectionState) {
        listeners.forEach { try { it.onStateChanged(newState, oldState) } catch (_: Exception) {} }
    }

    private fun notifyMessage(msg: JSONObject) {
        listeners.forEach { try { it.onMessageReceived(msg) } catch (_: Exception) {} }
    }

    private fun notifyError(error: ConnectionError) {
        listeners.forEach { try { it.onError(error) } catch (_: Exception) {} }
    }

    // ==================== 心跳 ====================

    private fun startHeartbeat() {
        stopHeartbeat()
        lastLanPongTime = System.currentTimeMillis()
        lastCloudPongTime = System.currentTimeMillis()
        lanPingInFlight = false
        cloudPingInFlight = false
        heartbeatRunnable = Runnable {
            if (state == ConnectionState.CONNECTED) {
                val now = System.currentTimeMillis()
                val pingMsg = JSONObject().put("type", "ping")
                if (lanWebSocket != null && transportMode.contains("lan")) {
                    if (lanPingInFlight && (now - lastLanPongTime) > PONG_TIMEOUT_MS) {
                        lanPingInFlight = false; handleLanPongTimeout()
                    } else {
                        try { lanPingSentTime = now; lanWebSocket?.send(pingMsg.toString()); lanPingInFlight = true } catch (_: Exception) { lanPingInFlight = false }
                    }
                }
                if (cloudWebSocket != null && transportMode.contains("cloud")) {
                    if (cloudPingInFlight && (now - lastCloudPongTime) > PONG_TIMEOUT_MS) {
                        cloudPingInFlight = false; handleCloudPongTimeout()
                    } else {
                        try { cloudPingSentTime = now; cloudWebSocket?.send(pingMsg.toString()); cloudPingInFlight = true } catch (_: Exception) { cloudPingInFlight = false }
                    }
                }
                // 防止心跳内部触发 stopHeartbeat() 后 heartbeatRunnable 已被置 null 导致 NPE
                heartbeatRunnable?.let { handler.postDelayed(it, HEARTBEAT_INTERVAL_MS) }
            }
        }
        handler.postDelayed(heartbeatRunnable!!, HEARTBEAT_INTERVAL_MS)
        v6LogI(TAG, lastPin, "心跳已启动")
    }

    private fun stopHeartbeat() {
        heartbeatRunnable?.let { handler.removeCallbacks(it) }
        heartbeatRunnable = null
        lanPingInFlight = false
        cloudPingInFlight = false
    }

    private fun handleLanPongTimeout() {
        v6LogW(TAG, lastPin, "LAN 通道死亡, 降级")
        try { lanWebSocket?.cancel() } catch (_: Exception) {}
        lanWebSocket = null
        if (transportMode.contains("lan")) {
            if (isCloudConnected) {
                transportMode = "cloud"
                handler.post { notifyStateChange(ConnectionState.CONNECTED, ConnectionState.CONNECTED) }
            } else {
                setState(ConnectionState.DISCONNECTED)
                if (autoReconnect) scheduleReconnect("lan_pong_timeout")
            }
        }
    }

    private fun handleCloudPongTimeout() {
        v6LogW(TAG, lastPin, "Cloud 通道死亡")
        try { cloudWebSocket?.cancel() } catch (_: Exception) {}
        cloudWebSocket = null
        if (transportMode.contains("cloud")) {
            if (transportMode.contains("lan")) {
                transportMode = "lan"
                handler.post { notifyStateChange(ConnectionState.CONNECTED, ConnectionState.CONNECTED) }
            } else {
                setState(ConnectionState.DISCONNECTED)
            }
            if (autoReconnect && currentStrategy != ConnectionStrategy.LAN_ONLY) scheduleCloudReconnect()
        }
    }

    // ==================== Logger ====================

    private fun v6LogI(module: String, pin: String, msg: String) { FileLogger.i(module, "[$pin] $msg") }
    private fun v6LogW(module: String, pin: String, msg: String) { FileLogger.w(module, "[$pin] $msg") }
    private fun v6LogE(module: String, pin: String, msg: String) { FileLogger.e(module, "[$pin] $msg") }
    private fun v6LogMsg(direction: String, type: String, content: String, pin: String) {
        val truncated = if (content.length > 500) content.substring(0, 500) + "...(truncated)" else content
        FileLogger.i(direction, "[$pin] [$type] $truncated")
    }
}
