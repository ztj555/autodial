package com.autodial.app

import android.Manifest
import android.app.*
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.PhoneStateListener
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.telephony.SmsManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class DialService : Service() {

    companion object {
        private const val TAG = "DialService"
        private const val CHANNEL_ID = "autodial_service"
        private const val NOTIFICATION_ID = 1001
        private const val ACTION_CONNECTION = "com.autodial.CONNECTION_CHANGE"
        private const val ACTION_NEW_DIAL = "com.autodial.NEW_DIAL"
        private const val ACTION_CALL_ENDED = "com.autodial.CALL_ENDED"
        private const val ACTION_LAST_CALL_HINT = "com.autodial.LAST_CALL_HINT"
        /** 拨号前需要用户选卡时发出此广播，MainActivity 弹出 SimSelectBottomSheet */
        const val ACTION_SHOW_SIM_SELECT = "com.autodial.SHOW_SIM_SELECT"
        /** 收到短信发送请求时发出此广播，MainActivity 启动 SmsConfirmActivity */
        const val ACTION_SHOW_SMS_CONFIRM = "com.autodial.SHOW_SMS_CONFIRM"
        /** 云端连接状态变化 */
        const val ACTION_CLOUD_STATUS = "com.autodial.CLOUD_STATUS"

        var isRunning = false
            private set
        /** 委托给 ConnectionManager */
        val isConnected: Boolean get() = _instance?.connectionManager?.isConnected ?: false
        val serverAddress: String get() = "" // 不再单独追踪，由 ConnectionManager 管理
        val isCloudConnected: Boolean get() = _instance?.connectionManager?.isCloudConnected ?: false
        val transportMode: String get() = _instance?.connectionManager?.getTransportMode() ?: ""
        val currentCloudServer: String get() = "" // 不再单独追踪
        val currentPin: String get() = _instance?.let { it.lastPin } ?: ""

        fun newIntent(context: Context): Intent = Intent(context, DialService::class.java)

        // 供 DialConfirmActivity 调用，回报拨号结果给电脑
        fun sendDialResult(number: String, status: String) {
            _instance?._sendResultToPC(number, status)
        }
        // 供 SmsConfirmActivity 调用，回报短信发送结果给电脑
        fun sendSmsResult(number: String, status: String) {
            _instance?._sendSmsResultToPC(number, status)
        }
        internal var _instance: DialService? = null
    }

    // ==================== ConnectionManager 委托 ====================

    lateinit var connectionManager: ConnectionManager
        private set
    var connectionMode: String = ""
        private set

    // v4: 拨号引擎
    private lateinit var dialEngine: DialEngine

    private var manualConnecting = false
    private var lastPin = ""
    private var lastIp = ""
    private var wakeLock: PowerManager.WakeLock? = null
    private lateinit var callLogDb: CallLogDb
    private var phoneStateListener: PhoneStateListener? = null
    // A1修复: 保存 TelephonyCallback 引用以便 onDestroy 注销
    private var telephonyCallback: android.telephony.TelephonyCallback? = null
    private val handler = Handler(Looper.getMainLooper())
    // v6: 亮屏广播 — 解决 Doze 后连接失效问题
    private var screenOnReceiver: BroadcastReceiver? = null

    /** 当前正在等待用户选卡的号码（队列，防止并发拨号覆盖） */
    private val pendingDialQueue = ArrayDeque<String>()
    private var pendingDialNumber: String?
        get() = pendingDialQueue.firstOrNull()
        set(value) {
            // A2修复: 检查非空再 removeFirst，防止空队列崩溃
            if (value == null) { pendingDialQueue.removeFirstOrNull() }
            else pendingDialQueue.addLast(value)
        }

    /** 标记 listener 是否已注册（防止 catch 路径重复注册） */
    private var listenerRegistered = false

    /** ConnectionManager 状态监听器 */
    private val connectionListener = object : ConnectionManager.ConnectionStateListener {
        override fun onStateChanged(
            newState: ConnectionManager.ConnectionState,
            oldState: ConnectionManager.ConnectionState
        ) {
            connectionMode = connectionManager.getTransportMode()
            FileLogger.i("DialService", "状态变化: $oldState → $newState, 通道=$connectionMode")
            when (newState) {
                ConnectionManager.ConnectionState.CONNECTED -> {
                    updateNotification("已连接到电脑(${connectionMode})")
                    getSharedPreferences("autodial", MODE_PRIVATE)
                        .edit().putBoolean("was_connected", true).apply()
                    notifyConnectionChange(true, null)
                    notifyCloudStatus(null)
                }
                ConnectionManager.ConnectionState.DISCONNECTED -> {
                    if (oldState == ConnectionManager.ConnectionState.CONNECTED) {
                        updateNotification("连接已断开")
                        notifyConnectionChange(false, "disconnected")
                    }
                }
                ConnectionManager.ConnectionState.CONNECTING -> {
                    updateNotification("正在连接...")
                }
                ConnectionManager.ConnectionState.DISCOVERING -> {
                    updateNotification("正在搜索电脑...")
                }
            }
        }

        override fun onMessageReceived(msg: JSONObject) {
            // Bug2修复: 提取 messageId，立即回发 ACK
            val messageId = msg.optString("messageId", "")
            val originalType = msg.optString("type", "")
            FileLogger.logMessage("RECV", originalType, msg.toString())
            if (messageId.isNotEmpty()) {
                try {
                    sendToPC(JSONObject().apply {
                        put("type", "ack")
                        put("messageId", messageId)
                        put("originalType", originalType)
                        put("deviceName", android.os.Build.MODEL ?: android.os.Build.DEVICE ?: "Android")
                    })
                    FileLogger.i("DialService", "ACK sent for $originalType (id=$messageId)")
                    Log.d(TAG, "ACK sent for $originalType (id=$messageId)")
                } catch (e: Exception) {
                    Log.e(TAG, "ACK send failed: ${e.message}")
                    FileLogger.e("DialService", "ACK send failed: ${e.message}")
                }
            }

            // 业务消息分发（dial, sms, hangup 等）
            try {
                when (originalType) {
                    "dial" -> {
                        val number = msg.optString("number", "")
                        FileLogger.i("DialService", "收到拨号请求: $number")
                        if (number.isNotEmpty() && ::dialEngine.isInitialized) {
                            Log.d(TAG, "拨号请求: $number")
                            dialEngine.dialNumber(number)
                        }
                    }
                    "reconnect_request" -> {
                        FileLogger.i("DialService", "收到 PC 端云端唤醒指令")
                        if (::connectionManager.isInitialized) {
                            connectionManager.onReconnectRequest()
                        }
                    }
                    "sms" -> {
                        val number = msg.optString("number", "")
                        val content = msg.optString("content", "")
                        FileLogger.i("DialService", "收到短信请求: $number, 内容长度=${content.length}")
                        if (number.isNotEmpty()) {
                            Log.d(TAG, "短信请求: $number, 内容长度=${content.length}")
                            val intent = Intent(ACTION_SHOW_SMS_CONFIRM).apply {
                                putExtra("number", number)
                                putExtra("content", content)
                                setPackage(packageName)
                            }
                            sendBroadcast(intent)
                        }
                    }
                    "hangup" -> {
                        FileLogger.i("DialService", "收到挂断指令")
                        Log.d(TAG, "收到挂断指令")
                        if (::dialEngine.isInitialized) dialEngine.endCall()
                    }
                }
            } catch (e: Exception) { Log.e(TAG, "消息处理失败: ${e.message}") }
        }

        override fun onError(error: ConnectionManager.ConnectionError) {
            when (error) {
                is ConnectionManager.ConnectionError.AuthFailed -> {
                    updateNotification("配对码错误")
                    notifyConnectionChange(false, "pin_wrong")
                }
                is ConnectionManager.ConnectionError.Disconnected -> {
                    updateNotification("连接已断开")
                    notifyConnectionChange(false, error.reason)
                }
                else -> {
                    Log.w(TAG, "Connection error: $error")
                }
            }
        }
    }

    // ==================== v4: 拨号引擎代理 ====================

    /** 拨号结果回调（供 DialEngine 使用） */
    internal fun onDialResult(number: String, status: String) {
        _sendResultToPC(number, status)
    }

    /** 设置待拨号号码（供弹窗选卡后回调使用） */
    internal fun setPendingDialNumber(number: String?) {
        pendingDialNumber = number
    }

    /**
     * 确保 ConnectionManager 的 listener 已注册
     */
    private fun ensureListenerRegistered() {
        if (listenerRegistered) return
        if (!::connectionManager.isInitialized) return
        connectionManager.addListener(connectionListener)
        listenerRegistered = true
        Log.d(TAG, "ConnectionManager listener registered")
    }

    // ==================== 生命周期 ====================

    override fun onCreate() {
        super.onCreate()
        _instance = this
        FileLogger.init(this)  // 最早初始化，确保日志系统可用
        try {
            isRunning = true
            callLogDb = CallLogDb.getInstance(this)
            createNotificationChannel()
            startForeground(NOTIFICATION_ID, buildNotification("跨屏拨号 运行中"))

            // 保持CPU唤醒，防止MIUI杀掉后台WebSocket连接
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "autodial:wake").apply {
                setReferenceCounted(false)
                acquire(12 * 60 * 60 * 1000L) // 12小时后自动释放
            }

            // 异步同步系统通话记录到 SIM 缓存（首次安装或数据库升级后）
            Thread {
                try {
                    val count = callLogDb.syncFromSystemCallLog(this@DialService)
                    if (count > 0) Log.d(TAG, "SIM缓存同步完成：$count 个号码")
                } catch (e: Exception) {
                    Log.e(TAG, "SIM缓存同步失败: ${e.message}")
                }
            }.start()

            // 监听通话状态，通话结束时通知UI刷新通话记录
            registerCallStateListener()

            // ==================== 初始化 DialEngine ====================
            dialEngine = DialEngine(this, callLogDb)

            // ==================== 初始化 ConnectionManager ====================
            connectionManager = ConnectionManager(this)
            ensureListenerRegistered()

            // v6: 注册网络监听器
            connectionManager.registerNetworkMonitor()

            // v6: 注册亮屏广播 — 屏幕亮起时检查连接健康
            registerScreenOnReceiver()

            // 自动重连（从保存的配置恢复）
            connectionManager.loadSavedConfig()

        } catch (e: Exception) {
            Log.e(TAG, "Service onCreate error: ${e.message}", e)
            isRunning = true
            callLogDb = CallLogDb.getInstance(this)
            createNotificationChannel()
            try { startForeground(NOTIFICATION_ID, buildNotification("跨屏拨号 运行中")) } catch (_: Exception) {}
            // 即使初始化失败，也要创建 ConnectionManager 并注册 listener
            if (!::connectionManager.isInitialized) {
                connectionManager = ConnectionManager(this)
            }
            if (!::dialEngine.isInitialized) {
                dialEngine = DialEngine(this, callLogDb)
            }
            ensureListenerRegistered()
            // v6: 注册网络监听器
            try { connectionManager.registerNetworkMonitor() } catch (_: Exception) {}
            // 尝试自动重连
            try { connectionManager.loadSavedConfig() } catch (_: Exception) {}
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            // 确保 ConnectionManager 已初始化且 listener 已注册
            if (!::connectionManager.isInitialized) {
                connectionManager = ConnectionManager(this)
            }
            if (!::dialEngine.isInitialized) {
                dialEngine = DialEngine(this, callLogDb)
            }
            ensureListenerRegistered()

            when (intent?.action) {
                "CONNECT" -> {
                    val ip = intent.getStringExtra("ip") ?: ""
                    val pin = intent.getStringExtra("pin") ?: ""
                    if (pin.isNotEmpty()) {
                        lastPin = pin
                        lastIp = ip
                        manualConnecting = true
                        getSharedPreferences("autodial", MODE_PRIVATE).edit()
                            .putString("ip", ip).putString("pin", pin).apply()
                        // v7: 读取用户设定的连接策略（自动迁移旧配置）
                        val strategy = ConnectionStrategy.readFromPrefs(
                            getSharedPreferences("autodial", MODE_PRIVATE)
                        )
                        connectionManager.connect(pin, ip, strategy)
                    }
                }
                "DISCONNECT" -> {
                    manualConnecting = false
                    getSharedPreferences("autodial", MODE_PRIVATE).edit()
                        .putBoolean("was_connected", false).apply()
                    connectionManager.disconnect()
                    updateNotification("跨屏拨号 运行中")
                }
                /** SimSelectBottomSheet 用户选好卡后回调 */
                "DIAL_WITH_SIM" -> {
                    val number = intent.getStringExtra("number") ?: return START_STICKY
                    val simSlot = intent.getIntExtra("sim_slot", 0)
                    pendingDialNumber = null
                    dialEngine.broadcastDialSimInfo(number, simSlot)  // v4: delegate
                    dialEngine.performDial(number, simSlot)
                }
                /** SimSelectBottomSheet 用户取消 */
                "DIAL_CANCELLED" -> {
                    pendingDialNumber = null
                    val number = intent.getStringExtra("number") ?: return START_STICKY
                    _sendResultToPC(number, "cancelled")
                }
            }
        } catch (e: Exception) { e.printStackTrace() }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        try {
            // 注销通话状态监听
            val tm = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // A1修复: 注销 TelephonyCallback（Android 12+）
                telephonyCallback?.let { try { tm.unregisterTelephonyCallback(it) } catch (_: Exception) {} }
                telephonyCallback = null
            } else {
                phoneStateListener?.let { try { @Suppress("DEPRECATION") tm.listen(it, PhoneStateListener.LISTEN_NONE) } catch (_: Exception) {} }
            }
            // v6: 注销亮屏广播
            unregisterScreenOnReceiver()
            if (::connectionManager.isInitialized) connectionManager.cleanup()
            FileLogger.shutdown()
            isRunning = false
            wakeLock?.release(); wakeLock = null
            pendingDialQueue.clear()
            _instance = null
        } catch (_: Exception) {}
    }

    // ==================== 发送方法（委托 ConnectionManager）====================

    private fun sendToPC(msg: JSONObject) {
        if (::connectionManager.isInitialized) {
            val sent = connectionManager.send(msg)
            FileLogger.logMessage("SEND", msg.optString("type", "?"), msg.toString())
            if (!sent) FileLogger.w("DialService", "sendToPC failed: ${msg.optString("type", "?")}")
        }
    }

    private fun _sendResultToPC(number: String, status: String) {
        try {
            FileLogger.i("DialService", "拨号结果: $number → $status")
            sendToPC(JSONObject().apply {
                put("type", "dial_result"); put("number", number); put("status", status)
            })
        } catch (_: Exception) {}
    }

    private fun _sendSmsResultToPC(number: String, status: String) {
        try {
            FileLogger.i("DialService", "短信结果: $number → $status")
            sendToPC(JSONObject().apply {
                put("type", "sms_result"); put("number", number); put("status", status)
            })
        } catch (_: Exception) {}
    }

    private fun notifyCloudStatus(reason: String? = null) {
        try {
            val intent = Intent(ACTION_CLOUD_STATUS).apply {
                putExtra("connected", if (::connectionManager.isInitialized) connectionManager.isCloudConnected else false)
                putExtra("mode", if (::connectionManager.isInitialized) connectionManager.getTransportMode() else "")
                reason?.let { putExtra("reason", it) }
                setPackage(packageName)
            }
            sendBroadcast(intent)
        } catch (_: Exception) {}
    }

    // ==================== 通话状态监听 ====================

    private fun registerCallStateListener() {
        try {
            val tm = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Android 12+: 使用 TelephonyCallback，保存引用以便 onDestroy 注销（A1修复）
                telephonyCallback = object : android.telephony.TelephonyCallback(),
                    android.telephony.TelephonyCallback.CallStateListener {
                    override fun onCallStateChanged(state: Int) {
                        if (state == TelephonyManager.CALL_STATE_IDLE) {
                            Log.d(TAG, "通话结束，通知刷新通话记录")
                            notifyCallEnded()
                        }
                    }
                }
                tm.registerTelephonyCallback(mainExecutor, telephonyCallback!!)
                Log.d(TAG, "已注册通话状态监听 (TelephonyCallback)")
            } else {
                @Suppress("DEPRECATION")
                phoneStateListener = object : PhoneStateListener() {
                    override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                        if (state == TelephonyManager.CALL_STATE_IDLE) {
                            Log.d(TAG, "通话结束，通知刷新通话记录")
                            notifyCallEnded()
                        }
                    }
                }
                @Suppress("DEPRECATION")
                tm.listen(phoneStateListener, PhoneStateListener.LISTEN_CALL_STATE)
                Log.d(TAG, "已注册通话状态监听 (PhoneStateListener)")
            }
        } catch (e: Exception) {
            Log.e(TAG, "注册通话状态监听失败: ${e.message}")
        }
    }

    private fun notifyCallEnded() {
        try {
            val intent = Intent(ACTION_CALL_ENDED).apply { setPackage(packageName) }
            sendBroadcast(intent)
        } catch (_: Exception) {}
    }

    // ==================== v6: 亮屏健康检查 ====================

    /**
     * 注册亮屏广播 — 屏幕亮起时检查连接是否存活
     * 解决 Android Doze 休眠后 WebSocket 变成僵尸连接的问题
     */
    private fun registerScreenOnReceiver() {
        unregisterScreenOnReceiver()
        screenOnReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action == Intent.ACTION_SCREEN_ON
                    || intent?.action == Intent.ACTION_USER_PRESENT) {
                    Log.d(TAG, "屏幕亮起，触发连接健康检查")
                    FileLogger.i(TAG, "亮屏健康检查")
                    if (::connectionManager.isInitialized) {
                        connectionManager.wakeAndReconnect()
                    }
                }
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        registerReceiver(screenOnReceiver, filter)
        Log.d(TAG, "已注册亮屏广播")
    }

    private fun unregisterScreenOnReceiver() {
        screenOnReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
            screenOnReceiver = null
        }
    }

    // ==================== SIM 卡信息 ====================

    /**
     * 获取当前可用的 SIM 卡列表（subscriptionId → simSlotIndex 映射）
     */
    private fun getSimInfoList(): List<SubscriptionInfo> {
        return dialEngine.getSimInfoList()
    }

    /**
     * 根据 simSlot (0/1) 获取对应的 PhoneAccountHandle
     *
     * 国产 ROM（MIUI / ColorOS / EMUI / OriginOS 等）的 PhoneAccount extras
     * 中 subscriptionId 的 key 各不相同，且 ComponentName 也与 AOSP 不同。
     * 本方法采用 5 层策略逐级 fallback，确保在各种设备上都能找到有效 handle。
     */
    private fun getPhoneAccountHandle(simSlot: Int): PhoneAccountHandle? {
        return dialEngine.getPhoneAccountHandle(simSlot)
    }

    // ==================== 拨号卡选择逻辑 ====================

    /**
     * 根据当前拨号模式决定使用哪张卡，或是否弹窗让用户选
     * @return simSlot (0=卡1, 1=卡2)，-1 表示需要弹窗
     */
    // ==================== v4: Delegate to DialEngine ====================

    private fun resolveSimSlot(number: String): Int {
        return dialEngine.resolveSimSlot(number)
    }

    private fun getLastDialHintForPopup(number: String): Pair<Int, Long>? {
        return dialEngine.getLastDialHintForPopup(number)
    }

    private fun dialNumber(number: String) {
        dialEngine.dialNumber(number)
    }

    private fun performDial(number: String, simSlot: Int) {
        dialEngine.performDial(number, simSlot)
    }

    private fun onDialSuccess(number: String, simSlot: Int) {
        dialEngine.onDialSuccess(number, simSlot)
    }

    private fun copyNumberToClipboard(number: String) {
        // moved to DialEngine, called via onDialSuccess
    }

    private fun showDialAnimation() {
        // moved to DialEngine, called via onDialSuccess
    }

    private fun broadcastDialSimInfo(number: String, simSlot: Int) {
        dialEngine.broadcastDialSimInfo(number, simSlot)
    }

    private fun notifyLastCallHint(number: String) {
        // moved to DialEngine, called via dialNumber
    }


    // ==================== 通知 UI ====================

    private fun notifyConnectionChange(connected: Boolean, reason: String?) {
        val intent = Intent(ACTION_CONNECTION).apply {
            putExtra("connected", connected)
            putExtra("mode", connectionMode)
            reason?.let { putExtra("reason", it) }
            setPackage(packageName)
        }
        sendBroadcast(intent)
    }

    private fun notifyNewDial(number: String) {
        dialEngine.notifyNewDial(number)
    }

    // ==================== 通知栏 ====================

    private fun createNotificationChannel() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val channel = NotificationChannel(CHANNEL_ID, "跨屏拨号 服务", NotificationManager.IMPORTANCE_LOW)
                    .apply {
                        description = "保持拨号连接"
                        setVibrationPattern(longArrayOf(0))  // 禁用振动
                        enableVibration(false)
                    }
                getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
            }
        } catch (_: Exception) {}
    }

    private fun buildNotification(text: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("跨屏拨号").setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true).setSilent(true)
            .setVibrate(longArrayOf(0))  // 禁用振动
            .build()
    }

    private fun updateNotification(text: String) {
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(NOTIFICATION_ID, buildNotification(text))
        } catch (_: Exception) {}
    }
}
