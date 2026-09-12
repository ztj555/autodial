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
        const val ACTION_SHOW_SIM_SELECT = "com.autodial.SHOW_SIM_SELECT"
        const val ACTION_SHOW_SMS_CONFIRM = "com.autodial.SHOW_SMS_CONFIRM"
        // v4.16 修复A: 云端等待浏览器插件授权的中间态（不改变已连接/断开语义，仅供 UI 展示）
        const val ACTION_AUTH_PENDING = "com.autodial.AUTH_PENDING"
        const val ACTION_CLOUD_STATUS = "com.autodial.CLOUD_STATUS"
        const val ACTION_EXECUTE_PENDING_DIAL = "com.autodial.EXECUTE_PENDING_DIAL"

        var isRunning = false
            private set
        @Volatile var isActivityVisible = false
        @Volatile var wasActivityVisibleBeforeDial = false // v4.59: 记录拨号前 App 是否在前台
        var pendingBackgroundDialNumber: String? = null
        val isConnected: Boolean get() = _instance?.connectionManager?.isConnected ?: false
        val serverAddress: String get() = ""
        val isCloudConnected: Boolean get() = _instance?.connectionManager?.isCloudConnected ?: false
        val isLanConnected: Boolean get() = _instance?.connectionManager?.isLanConnected ?: false
        val isPcReachable: Boolean get() = _instance?.connectionManager?.isPcReachable ?: false
        val isExtOnline: Boolean get() = _instance?.connectionManager?.extOnline ?: false
        val transportMode: String get() = _instance?.connectionManager?.getTransportMode() ?: ""
        val currentCloudServer: String get() = ""
        val currentPin: String get() = _instance?.let { it.lastPin } ?: ""

        fun newIntent(context: Context): Intent = Intent(context, DialService::class.java)

        fun sendDialResult(number: String, status: String) {
            _instance?._sendResultToPC(number, status)
        }
        fun sendSmsResult(number: String, status: String) {
            _instance?._sendSmsResultToPC(number, status)
        }
        internal var _instance: DialService? = null
    }

    // ==================== ConnectionManager delegate ====================

    lateinit var connectionManager: ConnectionManager
        private set
    var connectionMode: String = ""
        private set

    internal lateinit var dialEngine: DialEngine

    private var manualConnecting = false
    private var lastPin = ""
    private var lastIp = ""
    private var wakeLock: PowerManager.WakeLock? = null
    private lateinit var callLogDb: CallLogDb
    private var phoneStateListener: PhoneStateListener? = null
    private var telephonyCallback: android.telephony.TelephonyCallback? = null
    private val handler = Handler(Looper.getMainLooper())
    private var lastDisconnectReason: String? = null  // 用于防止 kicked 被 disconnected 覆盖
    private var screenOnReceiver: BroadcastReceiver? = null
    private var syncRunnable: Runnable? = null  // 数据同步定时任务
    // 高位水位线：已上报的最新通话记录 _ID（用于"向上补新"）。
    // 低位水位线（历史回填边界）单独存在 SharedPreferences 的 sync_floor_call_id，
    // 两者配合保证"新记录不漏、老记录能补"（详见 syncCallRecords）。
    private var lastSyncedCallId: Long = 0
    private val executor = java.util.concurrent.Executors.newSingleThreadExecutor()

    private val pendingDialQueue = ArrayDeque<String>()
    private var pendingDialNumber: String?
        get() = pendingDialQueue.firstOrNull()
        set(value) {
            // Fix: 清空队列而非只移除队首，避免多号码场景下误清
            if (value == null) { pendingDialQueue.clear() }
            else pendingDialQueue.addLast(value)
        }

    // v4.15: 已处理消息 ID 去重（LRU）。PC 端 ACK 超时重发、云端重连重投时，
    // 同一条 dial/sms/hangup 只执行一次——此前会重复拨打同一客户。
    private val processedMessageIds = object : LinkedHashMap<String, Boolean>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?): Boolean = size > 128
    }
    private fun isDuplicateMessageId(id: String): Boolean =
        synchronized(processedMessageIds) { processedMessageIds.containsKey(id) }
    private fun rememberMessageId(id: String) {
        synchronized(processedMessageIds) { processedMessageIds[id] = true }
    }

    private var listenerRegistered = false

    /**
     * v4.15: 按系统版本选择前台服务类型启动。
     * Android 14 对 phoneCall 类型做运行时资格校验（要求默认拨号器/正在通话），
     * 未授权时 startForeground 会抛 SecurityException → 服务永远起不来（退后台被杀、
     * 开机自启 5 秒超时崩溃）。specialUse 类型无运行时资格要求，Android 14+ 用它。
     */
    private fun startForegroundCompat(notification: android.app.Notification) {
        when {
            Build.VERSION.SDK_INT >= 34 ->
                startForeground(NOTIFICATION_ID, notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            Build.VERSION.SDK_INT >= 29 ->
                startForeground(NOTIFICATION_ID, notification,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
            else ->
                @Suppress("DEPRECATION")
                startForeground(NOTIFICATION_ID, notification)
        }
    }

    internal fun requestDialInForeground(number: String) {
        Companion.pendingBackgroundDialNumber = number
        FileLogger.i("DialService", "Background dial queued: $number")

        val intent = Intent(this, MainActivity::class.java).apply {
            action = ACTION_EXECUTE_PENDING_DIAL
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val pi = PendingIntent.getActivity(this, 0, intent, flags)

        val n = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("AutoDial")
            .setContentText("Tap to dial $number")
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(Notification.CATEGORY_CALL)
            .setFullScreenIntent(pi, true)
            .setAutoCancel(true)
            .build()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(1002, n)
        // Auto-cancel after 3s: if fullScreenIntent didn't fire, discard silently
        handler.postDelayed({
            nm.cancel(1002)
            if (Companion.pendingBackgroundDialNumber == number) {
                Companion.pendingBackgroundDialNumber = null
            }
        }, 3000)
    }

    private val connectionListener = object : ConnectionManager.ConnectionStateListener {
        override fun onStateChanged(
            newState: ConnectionManager.ConnectionState,
            oldState: ConnectionManager.ConnectionState
        ) {
            connectionMode = connectionManager.getTransportMode()
            FileLogger.i("DialService", "\u72b6\u6001\u53d8\u5316: $oldState \u2192 $newState, \u901a\u9053=$connectionMode")
            when (newState) {
                ConnectionManager.ConnectionState.CONNECTED -> {
                    updateNotification("已连接")
                    getSharedPreferences("autodial", MODE_PRIVATE)
                        .edit().putBoolean("was_connected", true).apply()
                    notifyConnectionChange(true, null)
                    notifyCloudStatus(null)
                }
                ConnectionManager.ConnectionState.DISCONNECTED -> {
                    if (oldState == ConnectionManager.ConnectionState.CONNECTED) {
                        // 如果 onError 已发送了具体原因（如 kicked），不再用通用 disconnected 覆盖
                        if (lastDisconnectReason != "kicked") {
                            updateNotification("\u8fde\u63a5\u5df2\u65ad\u5f00")
                            notifyConnectionChange(false, "disconnected")
                        }
                    }
                }
                ConnectionManager.ConnectionState.CONNECTING -> {
                    updateNotification("\u6b63\u5728\u8fde\u63a5...")
                }
                ConnectionManager.ConnectionState.DISCOVERING -> {
                    updateNotification("\u6b63\u5728\u641c\u7d22\u7535\u8111...")
                }
            }
        }

        override fun onMessageReceived(msg: JSONObject) {
            val messageId = msg.optString("messageId", "")
            val originalType = msg.optString("type", "")
            FileLogger.logMessage("RECV", originalType, msg.toString())
            if (messageId.isNotEmpty()) {
                // v4.15: 重复消息只补发 ACK，不再执行（防止同一号码被重复拨打）
                if (isDuplicateMessageId(messageId)) {
                    Log.d(TAG, "duplicate $originalType (id=$messageId), re-ACK only")
                    FileLogger.i("DialService", "duplicate message $originalType (id=$messageId), re-ACK only")
                    try {
                        sendToPC(JSONObject().apply {
                            put("type", "ack")
                            put("messageId", messageId)
                            put("originalType", originalType)
                            put("deviceName", android.os.Build.MODEL ?: android.os.Build.DEVICE ?: "Android")
                        })
                    } catch (_: Exception) {}
                    return
                }
                rememberMessageId(messageId)
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

            try {
                when (originalType) {
                    "dial" -> {
                        val number = msg.optString("number", "")
                        FileLogger.i("DialService", "\u6536\u5230\u62e8\u53f7\u8bf7\u6c42: $number")
                        if (number.isNotEmpty() && ::dialEngine.isInitialized) {
                            Log.d(TAG, "\u62e8\u53f7\u8bf7\u6c42: $number")
                            Companion.wasActivityVisibleBeforeDial = isActivityVisible // v4.59: 记住拨号前状态
                            dialEngine.dialNumber(number)
                        }
                    }
                    "reconnect_request" -> {
                        FileLogger.i("DialService", "\u6536\u5230 PC \u7aef\u4e91\u7aef\u5524\u9192\u6307\u4ee4")
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
                            // v8修复: Activity 不可见时用通知替代，避免 Android 10+ 后台启动 Activity 被拦截
                            if (isActivityVisible) {
                                val intent = Intent(ACTION_SHOW_SMS_CONFIRM).apply {
                                    putExtra("number", number)
                                    putExtra("content", content)
                                    setPackage(packageName)
                                }
                                sendBroadcast(intent)
                            } else {
                                showSmsNotification(number, content)
                            }
                        }
                    }
                    "hangup" -> {
                        FileLogger.i("DialService", "\u6536\u5230\u6302\u65ad\u6307\u4ee4")
                        Log.d(TAG, "\u6536\u5230\u6302\u65ad\u6307\u4ee4")
                        if (::dialEngine.isInitialized) dialEngine.endCall()
                    }
                    // v4.16 修复A: 等待浏览器插件授权 —— 广播给 UI 展示"等待授权中"，
                    // 不调用 notifyConnectionChange（其语义是"已断开"，会误触发重连/状态栏逻辑）
                    "auth_pending" -> {
                        FileLogger.i("DialService", "等待授权中: ${msg.optString("message", "")}")
                        val intent = Intent(ACTION_AUTH_PENDING).apply {
                            putExtra("message", msg.optString("message", ""))
                            putExtra("default_name", msg.optString("default_name", ""))
                            setPackage(packageName)
                        }
                        sendBroadcast(intent)
                    }
                }
            } catch (e: Exception) { Log.e(TAG, "\u6d88\u606f\u5904\u7406\u5931\u8d25: ${e.message}") }
        }

        override fun onError(error: ConnectionManager.ConnectionError) {
            when (error) {
                is ConnectionManager.ConnectionError.AuthFailed -> {
                    updateNotification("\u8fde\u63a5\u88ab\u62d2\u7edd")
                    // v4.15: 不再把所有认证失败笼统映射成 pin_wrong——
                    // 服务端的具体原因（设备未注册/PIN不一致/请求过频繁）透传到 UI 显示
                    notifyConnectionChange(false, "auth_fail:" + error.reason)
                }
                is ConnectionManager.ConnectionError.Disconnected -> {
                    updateNotification("\u8fde\u63a5\u5df2\u65ad\u5f00")
                    notifyConnectionChange(false, error.reason)
                }
                else -> {
                    Log.w(TAG, "Connection error: $error")
                }
            }
        }
    }

    // ==================== v4: delegate ====================

    internal fun onDialResult(number: String, status: String) {
        _sendResultToPC(number, status)
        // v4.21: logEvent 接线——此前该函数零调用，云端 phone_events 表永远为空。
        // 拨号结果（ok/error/cancelled）全部上报，管理面板"行为日志"才有数据。
        logEvent("dial", "$number:$status")
    }

    internal fun setPendingDialNumber(number: String?) {
        pendingDialNumber = number
    }

    private fun ensureListenerRegistered() {
        if (listenerRegistered) return
        if (!::connectionManager.isInitialized) return
        connectionManager.addListener(connectionListener)
        listenerRegistered = true
        Log.d(TAG, "ConnectionManager listener registered")
    }

    // ==================== lifecycle ====================

    override fun onCreate() {
        super.onCreate()
        _instance = this
        FileLogger.init(this)
        try {
            isRunning = true
            callLogDb = CallLogDb.getInstance(this)
            createNotificationChannel()
            startForegroundCompat(buildNotification("\u8de8\u5c4f\u62e8\u53f7 \u8fd0\u884c\u4e2d"))

            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "autodial:wake").apply {
                setReferenceCounted(false)
                acquire(12 * 60 * 60 * 1000L)
            }

            // 启动数据同步到云中转
            startDataSync()

            Thread {
                try {
                    val count = callLogDb.syncFromSystemCallLog(this@DialService)
                    if (count > 0) Log.d(TAG, "SIM cache synced: $count numbers")
                } catch (e: Exception) {
                    Log.e(TAG, "SIM cache sync failed: ${e.message}")
                }
            }.start()

            registerCallStateListener()

            dialEngine = DialEngine(this, callLogDb)

            connectionManager = ConnectionManager(this)
            ensureListenerRegistered()

            connectionManager.registerNetworkMonitor()

            registerScreenOnReceiver()

            // v4.15: 选卡请求兜底接收器（界面不可见时也能收到，不再发进真空）
            registerSimSelectFallbackReceiver()

            connectionManager.loadSavedConfig()

            // v4.23: 保活自查——进程被杀（未重启）后由闹钟按 15 分钟周期尝试复活
            scheduleKeepAliveWatchdog()

        } catch (e: Exception) {
            Log.e(TAG, "Service onCreate error: ${e.message}", e)
            isRunning = true
            callLogDb = CallLogDb.getInstance(this)
            createNotificationChannel()
            try { startForegroundCompat(buildNotification("\u8de8\u5c4f\u62e8\u53f7 \u8fd0\u884c\u4e2d")) } catch (_: Exception) {}
            // v9: 补全异常恢复路径 — 缺失 WakeLock/CallState/ScreenOn 会导致功能残缺
            try {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "autodial:wake").apply {
                    setReferenceCounted(false)
                    acquire(12 * 60 * 60 * 1000L)
                }
            } catch (_: Exception) {}
            if (!::connectionManager.isInitialized) {
                connectionManager = ConnectionManager(this)
            }
            if (!::dialEngine.isInitialized) {
                dialEngine = DialEngine(this, callLogDb)
            }
            ensureListenerRegistered()
            try { connectionManager.registerNetworkMonitor() } catch (_: Exception) {}
            try { registerCallStateListener() } catch (_: Exception) {}
            try { registerScreenOnReceiver() } catch (_: Exception) {}
            try { registerSimSelectFallbackReceiver() } catch (_: Exception) {}
            try { connectionManager.loadSavedConfig() } catch (_: Exception) {}
            // v4.23: 异常恢复路径补上数据同步（正常路径在 try 内已调用，此处幂等）
            try { startDataSync() } catch (_: Exception) {}
            try { scheduleKeepAliveWatchdog() } catch (_: Exception) {}
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            if (!::connectionManager.isInitialized) {
                connectionManager = ConnectionManager(this)
            }
            if (!::dialEngine.isInitialized) {
                dialEngine = DialEngine(this, callLogDb)
            }
            ensureListenerRegistered()

            when (intent?.action) {
                ACTION_EXECUTE_PENDING_DIAL -> {
                    val pending = Companion.pendingBackgroundDialNumber
                    if (pending != null) {
                        Companion.pendingBackgroundDialNumber = null
                        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                        nm.cancel(1002)
                        if (::dialEngine.isInitialized) {
                            dialEngine.dialNumber(pending)
                        }
                    }
                }
                "CONNECT" -> {
                    // 防御：带 "://" 的是云服务器地址，不是局域网 IP。放行会被写进
                    // prefs["ip"] 并成为 lastLanIp，导致局域网直连尝试连到非法主机。
                    val ipRaw = intent.getStringExtra("ip") ?: ""
                    val ip = if (ipRaw.contains("://")) "" else ipRaw
                    val pin = intent.getStringExtra("pin") ?: ""
                    if (pin.isNotEmpty()) {
                        val connPrefs = getSharedPreferences("autodial", MODE_PRIVATE)
                        lastPin = pin
                        // 只有确实带了合法 IP 时才覆盖 LAN IP，否则保留原值
                        // （此前无条件覆盖：传空值或云地址都会清掉/污染已保存的局域网 IP）
                        if (ip.isNotEmpty()) {
                            lastIp = ip
                            connPrefs.edit().putString("ip", ip).putString("pin", pin).apply()
                        } else {
                            connPrefs.edit().putString("pin", pin).apply()
                        }
                        manualConnecting = true
                        val strategy = ConnectionStrategy.readFromPrefs(connPrefs)
                        connectionManager.connect(pin, ip, strategy)
                    }
                }
                "DISCONNECT" -> {
                    manualConnecting = false
                    getSharedPreferences("autodial", MODE_PRIVATE).edit()
                        .putBoolean("was_connected", false).apply()
                    connectionManager.disconnect()
                    updateNotification("运行中")
                }
                "DIAL_WITH_SIM" -> {
                    val number = intent.getStringExtra("number") ?: return START_STICKY
                    val simSlot = intent.getIntExtra("sim_slot", 0)
                    pendingDialNumber = null
                    dialEngine.broadcastDialSimInfo(number, simSlot)
                    dialEngine.performDial(number, simSlot)
                }
                "DIAL_CANCELLED" -> {
                    pendingDialNumber = null
                    val number = intent.getStringExtra("number") ?: return START_STICKY
                    _sendResultToPC(number, "cancelled")
                }
                "DIAL" -> {
                    // v4.23: App 内手动拨号（拨号盘/通话详情"立即拨号"）统一走 DialEngine——
                    // 具备选卡弹层、本地记录、PC 回执，不再绕过主拨号链路
                    val number = intent.getStringExtra("number") ?: ""
                    if (number.isNotEmpty() && ::dialEngine.isInitialized) {
                        dialEngine.dialNumber(number)
                    }
                }
            }
        } catch (e: Exception) { e.printStackTrace() }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        try {
            val tm = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                telephonyCallback?.let { try { tm.unregisterTelephonyCallback(it) } catch (_: Exception) {} }
                telephonyCallback = null
            } else {
                phoneStateListener?.let { try { @Suppress("DEPRECATION") tm.listen(it, PhoneStateListener.LISTEN_NONE) } catch (_: Exception) {} }
            }
            unregisterScreenOnReceiver()
            unregisterSimSelectFallbackReceiver()
            if (::connectionManager.isInitialized) connectionManager.cleanup()
            FileLogger.shutdown()
            isRunning = false
            wakeLock?.release(); wakeLock = null
            // v4.23: 服务正常销毁时撤销保活闹钟（由下次 onCreate 重新调度）
            try {
                val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
                am.cancel(android.app.PendingIntent.getBroadcast(this, 2001,
                    Intent(this, KeepAliveReceiver::class.java),
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE))
            } catch (_: Exception) {}
            syncRunnable?.let { handler.removeCallbacks(it) }
            syncRunnable = null
            executor.shutdown()
            pendingDialQueue.clear()
            _instance = null
        } catch (_: Exception) {}
    }

    // ==================== send methods ====================

    private fun sendToPC(msg: JSONObject) {
        if (::connectionManager.isInitialized) {
            val sent = connectionManager.send(msg)
            FileLogger.logMessage("SEND", msg.optString("type", "?"), msg.toString())
            if (!sent) FileLogger.w("DialService", "sendToPC failed: ${msg.optString("type", "?")}")
        }
    }

    private fun _sendResultToPC(number: String, status: String) {
        try {
            FileLogger.i("DialService", "\u62e8\u53f7\u7ed3\u679c: $number \u2192 $status")
            sendToPC(JSONObject().apply {
                put("type", "dial_result"); put("number", number); put("status", status)
            })
        } catch (_: Exception) {}
    }

    private fun _sendSmsResultToPC(number: String, status: String) {
        try {
            FileLogger.i("DialService", "\u77ed\u4fe1\u7ed3\u679c: $number \u2192 $status")
            sendToPC(JSONObject().apply {
                put("type", "sms_result"); put("number", number); put("status", status)
            })
            // v4.21: logEvent 接线——短信结果也上报云端行为日志
            logEvent("sms", "$number:$status")
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

    // ==================== call state listener ====================

    private fun registerCallStateListener() {
        try {
            val tm = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                telephonyCallback = object : android.telephony.TelephonyCallback(),
                    android.telephony.TelephonyCallback.CallStateListener {
                    override fun onCallStateChanged(state: Int) {
                        if (state == TelephonyManager.CALL_STATE_IDLE) {
                            Log.d(TAG, "\u901a\u8bdd\u7ed3\u675f\uff0c\u901a\u77e5\u5237\u65b0\u901a\u8bdd\u8bb0\u5f55")
                            notifyCallEnded()
                        }
                    }
                }
                tm.registerTelephonyCallback(mainExecutor, telephonyCallback!!)
                Log.d(TAG, "\u5df2\u6ce8\u518c\u901a\u8bdd\u72b6\u6001\u76d1\u542c (TelephonyCallback)")
            } else {
                @Suppress("DEPRECATION")
                phoneStateListener = object : PhoneStateListener() {
                    override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                        if (state == TelephonyManager.CALL_STATE_IDLE) {
                            Log.d(TAG, "\u901a\u8bdd\u7ed3\u675f\uff0c\u901a\u77e5\u5237\u65b0\u901a\u8bdd\u8bb0\u5f55")
                            notifyCallEnded()
                        }
                    }
                }
                @Suppress("DEPRECATION")
                tm.listen(phoneStateListener, PhoneStateListener.LISTEN_CALL_STATE)
                Log.d(TAG, "\u5df2\u6ce8\u518c\u901a\u8bdd\u72b6\u6001\u76d1\u542c (PhoneStateListener)")
            }
        } catch (e: Exception) {
            Log.e(TAG, "\u6ce8\u518c\u901a\u8bdd\u72b6\u6001\u76d1\u542c\u5931\u8d25: ${e.message}")
        }
    }

    private fun notifyCallEnded() {
        try {
            val intent = Intent(ACTION_CALL_ENDED).apply { setPackage(packageName) }
            sendBroadcast(intent)
        } catch (_: Exception) {}
        // v4.59: 只有拨号前 App 在前台，通话结束才拉回来；在桌面/其他 app 时不打扰
        try {
            if (Companion.wasActivityVisibleBeforeDial) {
                Companion.wasActivityVisibleBeforeDial = false
                val launchIntent = Intent(this, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                }
                startActivity(launchIntent)
            }
        } catch (_: Exception) {}
    }

    // ==================== screen on health check ====================

    private fun registerScreenOnReceiver() {
        unregisterScreenOnReceiver()
        screenOnReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action == Intent.ACTION_SCREEN_ON
                    || intent?.action == Intent.ACTION_USER_PRESENT) {
                    Log.d(TAG, "\u5c4f\u5e55\u4eae\u8d77\uff0c\u89e6\u53d1\u8fde\u63a5\u5065\u5eb7\u68c0\u67e5")
                    FileLogger.i(TAG, "\u4eae\u5c4f\u5065\u5eb7\u68c0\u67e5")
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
        // E2修复: Android 14+ (targetSdk 34) 两参 registerReceiver 必抛 SecurityException，须指定导出标志
        ContextCompat.registerReceiver(this, screenOnReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        Log.d(TAG, "\u5df2\u6ce8\u518c\u4eae\u5c4f\u5e7f\u64ad")
    }

    private fun unregisterScreenOnReceiver() {
        screenOnReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
            screenOnReceiver = null
        }
    }

    // ==================== v4.15: 选卡请求兜底接收器 ====================
    // 此前 ACTION_SHOW_SIM_SELECT 只有 MainActivity 注册，用户划掉 App 后
    // 无悬浮窗权限时拨号请求会"发进真空"——PC 永远等不到回执，客户没人打。

    private var simSelectFallbackReceiver: BroadcastReceiver? = null

    private fun registerSimSelectFallbackReceiver() {
        unregisterSimSelectFallbackReceiver()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent?.action != ACTION_SHOW_SIM_SELECT) return
                // 界面可见时由 MainActivity 处理（应用内选卡/引导开权限），避免双重弹窗
                if (isActivityVisible) return
                val number = intent.getStringExtra("number") ?: return
                val lastSimSlot = intent.getIntExtra("last_sim_slot", -1)
                val lastDialTime = intent.getLongExtra("last_dial_time", 0L)
                if (SimSelectOverlay.hasPermission(this@DialService)) {
                    SimSelectOverlay.show(this@DialService, number, lastSimSlot, lastDialTime)
                } else {
                    // 无悬浮窗权限且界面不可见：给 PC 回执取消，并发提醒通知，不让拨号凭空消失
                    _sendResultToPC(number, "cancelled")
                    showSimSelectPermissionNotification(number)
                }
            }
        }
        simSelectFallbackReceiver = receiver
        ContextCompat.registerReceiver(
            this, receiver,
            IntentFilter(ACTION_SHOW_SIM_SELECT),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    private fun unregisterSimSelectFallbackReceiver() {
        simSelectFallbackReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
            simSelectFallbackReceiver = null
        }
    }

    private fun showSimSelectPermissionNotification(number: String) {
        try {
            val intent = Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }
            val pi = PendingIntent.getActivity(this, 1005, intent, flags)
            val n = NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("收到拨号请求，需要选卡")
                .setContentText("号码 $number：请开启\"悬浮窗\"权限后再试")
                .setSmallIcon(android.R.drawable.ic_menu_call)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build()
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(1005, n)
        } catch (_: Exception) {}
    }

    // ==================== SIM info ====================

    private fun getSimInfoList(): List<SubscriptionInfo> {
        return dialEngine.getSimInfoList()
    }

    private fun getPhoneAccountHandle(simSlot: Int): PhoneAccountHandle? {
        return dialEngine.getPhoneAccountHandle(simSlot)
    }

    // ==================== dial delegate ====================

    private fun resolveSimSlot(number: String): Int {
        return dialEngine.resolveSimSlot(number)
    }

    private fun getLastDialHintForPopup(number: String): Pair<Int, Long>? {
        return dialEngine.getLastDialHintForPopup(number)
    }

    internal fun dialNumber(number: String) {
        dialEngine.dialNumber(number)
    }

    private fun performDial(number: String, simSlot: Int) {
        dialEngine.performDial(number, simSlot)
    }

    private fun onDialSuccess(number: String, simSlot: Int) {
        dialEngine.onDialSuccessAfterPlaceCall(number, simSlot)
    }

    private fun copyNumberToClipboard(number: String) {
        // moved to DialEngine
    }

    private fun showDialAnimation() {
        // moved to DialEngine
    }

    private fun broadcastDialSimInfo(number: String, simSlot: Int) {
        dialEngine.broadcastDialSimInfo(number, simSlot)
    }

    private fun notifyLastCallHint(number: String) {
        // moved to DialEngine
    }

    // ==================== notification UI ====================

    private fun notifyConnectionChange(connected: Boolean, reason: String?) {
        lastDisconnectReason = if (connected) null else reason
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

    // ==================== notification bar ====================

    private fun createNotificationChannel() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                // v9: 提高到 IMPORTANCE_DEFAULT，系统才把前台服务当回事，降低被杀概率
                val channel = NotificationChannel(CHANNEL_ID, "\u8de8\u5c4f\u62e8\u53f7 \u670d\u52a1", NotificationManager.IMPORTANCE_DEFAULT)
                    .apply {
                        description = "\u4fdd\u6301\u62e8\u53f7\u8fde\u63a5"
                        setVibrationPattern(longArrayOf(0))
                        enableVibration(false)
                        setShowBadge(false)
                    }
                getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
            }
        } catch (_: Exception) {}
    }

    private fun buildNotification(text: String): Notification {
        var titleLine = "Auto融鑫汇"
        var bodyLine = text
        try {
            val today = callLogDb.getTodayCount(this)
            val stats = callLogDb.getDailyDurationStats(this, 1)
            if (stats.isNotEmpty()) {
                val mins = (stats[0].totalDurationSec + 30) / 60
                val connected = callLogDb.getTodayConnectedCount(this)
                val rate = if (today > 0) connected * 100 / today else 0
                titleLine = "Auto融鑫汇         今日财运：+$today"
                bodyLine = "$text           接通$connected · $rate%"
            }
        } catch (_: Exception) {}
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(titleLine).setContentText(bodyLine)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true).setSilent(true)
            .setVibrate(longArrayOf(0))
            .build()
    }

    private fun updateNotification(text: String) {
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(NOTIFICATION_ID, buildNotification(text))
        } catch (_: Exception) {}
    }

    /** v8: 后台短信通知 — 通过通知栏提示用户确认发送 */
    private fun showSmsNotification(number: String, content: String) {
        val intent = Intent(this, SmsConfirmActivity::class.java).apply {
            putExtra("number", number)
            putExtra("content", content)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 2001, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("AutoDial 短信确认")
            .setContentText("发给 $number: ${content.take(30)}...")
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(2001, notification)
        } catch (_: Exception) {}
        FileLogger.i("DialService", "已发送后台短信通知: $number")
    }

    // ==================== 云中转数据同步 ====================

    private fun startDataSync() {
        // v4.23: 幂等保护——异常恢复路径也会调用，避免重复 post 导致同步链路翻倍
        if (syncRunnable != null) return
        lastSyncedCallId = getSharedPreferences("autodial", MODE_PRIVATE).getLong("last_synced_call_id", 0)
        syncRunnable = object : Runnable {
            override fun run() {
                if (!isConnected) { scheduleNextSync(); return }
                executor.execute { syncCallRecords(); syncDailyStats(); scheduleNextSync() }
            }
        }
        handler.post(syncRunnable!!)
    }

    private fun scheduleNextSync() {
        syncRunnable?.let { handler.postDelayed(it, 5 * 60 * 1000L) }  // 每5分钟
    }

    private fun syncCallRecords() {
        try {
            if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.READ_CALL_LOG)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                // v4.21: 权限缺失不再裸 return——打日志（此前完全无痕，云端 calls=0 无从排查）
                FileLogger.w("DialService", "syncCallRecords 跳过：READ_CALL_LOG 权限未授予，请在系统设置授权")
                return
            }
            val prefs = getSharedPreferences("autodial", MODE_PRIVATE)
            val deviceId = PrefCtrl(this@DialService).getDeviceId()
            val pin = prefs.getString("pin", "") ?: return
            val serverUrl = prefs.getString("cloud_server", "") ?: return
            if (serverUrl.isEmpty()) return
            val baseUrl = normalizeHttpUrl(serverUrl)

            // ===== 双向水位线 =====
            // 修复：旧逻辑在 DESC 排序下把"本批最小 id"当水位线，查询条件却是 `_ID > 水位线`。
            // 水位线落到 81 后，下一轮 `_ID > 81` 又把最近 20 条（82..100）捞回来，每轮只前移
            // 1 条 —— 永远在"最近 20 条"里打转，id <= 80 的老记录一条都传不上去。
            // 正确做法是两条水位线各自朝"未覆盖的方向"单调推进：
            //   highId  已上报的最新 id：_ID >  highId  ASC ，向上补新
            //   floorId 回填边界       ：_ID <  floorId DESC，向下补旧
            // 云端 call_records_raw 以 (device_id, local_id) 为主键且 INSERT OR IGNORE，
            // 重复上报是幂等的，因此版本升级后少量重报不会产生脏数据。
            var highId = prefs.getLong("last_synced_call_id", -1L)
            var floorId = prefs.getLong("sync_floor_call_id", -1L)
            if (highId < 0L || floorId < 0L) {
                val maxId = currentMaxCallLogId()
                // 首次（含旧版本升级）：从"当前最新"向两侧扩张。floorId 取 maxId + 1，
                // 保证 id == maxId 的那条也在第一轮回填范围内。
                if (highId < 0L) highId = maxId
                if (floorId < 0L) floorId = maxId + 1L
                prefs.edit()
                    .putLong("last_synced_call_id", highId)
                    .putLong("sync_floor_call_id", floorId)
                    .apply()
            }
            lastSyncedCallId = highId

            // 1) 向上补新：每轮最多 20 条新产生的记录
            val (newBatch, newHigh) = readCallLogBatch(highId, ascending = true)
            if (newBatch.length() > 0 && uploadCallBatch(baseUrl, deviceId, pin, newBatch)) {
                highId = newHigh
                lastSyncedCallId = highId
                prefs.edit().putLong("last_synced_call_id", highId).apply()
            }

            // 2) 向下补旧：每轮最多 20 条历史记录，逐轮把更老的补齐，直到 _ID < 1 触底
            if (floorId > 0L) {
                val (oldBatch, newFloor) = readCallLogBatch(floorId, ascending = false)
                if (oldBatch.length() > 0 && uploadCallBatch(baseUrl, deviceId, pin, oldBatch)) {
                    floorId = newFloor
                    prefs.edit().putLong("sync_floor_call_id", floorId).apply()
                }
            }
        } catch (e: Exception) {
            FileLogger.e("DialService", "syncCallRecords 异常: ${e.message}")
        }
    }

    /** 查询通话记录的最大 _ID（无记录返回 0），用于首次确定水位线起点 */
    private fun currentMaxCallLogId(): Long {
        try {
            contentResolver.query(
                android.provider.CallLog.Calls.CONTENT_URI,
                arrayOf(android.provider.CallLog.Calls._ID),
                null, null,
                "${android.provider.CallLog.Calls._ID} DESC LIMIT 1"
            )?.use { c -> if (c.moveToFirst()) return c.getLong(0) }
        } catch (e: Exception) {
            FileLogger.w("DialService", "查询最大通话记录 id 失败: ${e.message}")
        }
        return 0L
    }

    /**
     * 读取一批通话记录（每批最多 20 条，避免 URL 超长：20 条约 2KB，上限约 4KB）。
     *
     * @param anchor    水位线锚点
     * @param ascending true = 向上补新（_ID > anchor，ASC）；false = 向下补旧（_ID < anchor，DESC）
     * @return Pair(本批记录, 推进后的水位线)。空批时水位线不变。
     */
    private fun readCallLogBatch(anchor: Long, ascending: Boolean): Pair<JSONArray, Long> {
        val idCol = android.provider.CallLog.Calls._ID
        val selection = if (ascending) "$idCol > ?" else "$idCol < ?"
        val order = if (ascending) "$idCol ASC LIMIT 20" else "$idCol DESC LIMIT 20"
        val records = JSONArray()
        var boundary = anchor
        val cursor = contentResolver.query(
            android.provider.CallLog.Calls.CONTENT_URI,
            arrayOf(idCol, android.provider.CallLog.Calls.NUMBER,
                android.provider.CallLog.Calls.DATE, android.provider.CallLog.Calls.DURATION,
                android.provider.CallLog.Calls.TYPE, android.provider.CallLog.Calls.PHONE_ACCOUNT_ID),
            selection, arrayOf(anchor.toString()), order
        ) ?: return Pair(records, boundary)
        while (cursor.moveToNext()) {
            val id = cursor.getLong(0)
            // ASC 取本批最大 id、DESC 取本批最小 id —— 两个方向都朝未覆盖区域推进
            if (ascending) { if (id > boundary) boundary = id } else { if (id < boundary) boundary = id }
            val simSlot = try {
                val accountId = cursor.getString(5) ?: ""
                if (accountId.contains("@0")) 0 else if (accountId.contains("@1")) 1 else 0
            } catch (_: Exception) { 0 }
            records.put(JSONObject().apply {
                put("local_id", id)
                put("number", cursor.getString(1) ?: "")
                put("dial_time", cursor.getLong(2))
                put("duration", cursor.getLong(3))
                put("call_type", cursor.getInt(4))
                put("sim_slot", simSlot)
            })
        }
        cursor.close()
        return Pair(records, boundary)
    }

    /**
     * 上报一批通话记录，成功返回 true（失败保留水位线，下轮重试）。
     * v4.23: 优先 POST body——device_id/pin/记录不再进 URL（访问日志、代理都会记录 URL）。
     * 若云端尚未升级到支持 POST 的版本，自动回退一次 GET，两种部署顺序下都能工作。
     */
    private fun uploadCallBatch(baseUrl: String, deviceId: String, pin: String, records: JSONArray): Boolean {
        if (records.length() == 0) return true
        return try {
            val body = JSONObject().apply {
                put("device_id", deviceId)
                put("pin", pin)
                put("data", records)
            }.toString()
            val conn = java.net.URL("$baseUrl/api/v1/calls/batch").openConnection() as java.net.HttpURLConnection
            conn.requestMethod = "POST"
            conn.connectTimeout = 5000; conn.readTimeout = 5000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val ok = conn.responseCode in 200..299
            conn.disconnect()
            if (ok) true else uploadCallBatchGet(baseUrl, deviceId, pin, records)
        } catch (e: Exception) {
            FileLogger.e("DialService", "syncCallRecords POST 上报异常: ${e.message}")
            uploadCallBatchGet(baseUrl, deviceId, pin, records)
        }
    }

    /** 旧版 GET 通道（兼容未升级的云端），仅作回退使用 */
    private fun uploadCallBatchGet(baseUrl: String, deviceId: String, pin: String, records: JSONArray): Boolean {
        return try {
            val dataStr = java.net.URLEncoder.encode(records.toString(), "UTF-8")
            val urlStr = "$baseUrl/api/v1/calls/batch?device_id=${java.net.URLEncoder.encode(deviceId, "UTF-8")}" +
                "&pin=${java.net.URLEncoder.encode(pin, "UTF-8")}&data=$dataStr"
            val conn = java.net.URL(urlStr).openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 5000; conn.readTimeout = 5000
            val ok = conn.responseCode in 200..299
            if (!ok) {
                // 上报失败不再无痕——记录状态码便于排查（限流/未注册等）
                FileLogger.w("DialService", "syncCallRecords 上报失败: HTTP ${conn.responseCode}")
            }
            conn.disconnect()
            ok
        } catch (e: Exception) {
            FileLogger.e("DialService", "syncCallRecords 上报异常: ${e.message}")
            false
        }
    }

    // ==================== 保活自查（v4.23） ====================

    /**
     * 调度一次 15 分钟后的"保活自查"闹钟（由 KeepAliveReceiver 接力续期，自循环）。
     * 场景：国产 ROM 杀后台后 START_STICKY 迟迟不重启服务，也无开机重启机会——
     * 闹钟兜底拉起服务。即使系统策略拦截后台启动（Android 12+ 限制），也只退化为
     * 原有的"不自愈"，不会产生副作用。
     */
    private fun scheduleKeepAliveWatchdog() {
        try {
            val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pi = android.app.PendingIntent.getBroadcast(
                this, 2001,
                Intent(this, KeepAliveReceiver::class.java),
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                // exact + allow-idle：Android 12+ 后台启动 FGS 的豁免条件之一；doze 下每 15 分钟一次在其限流内
                am.setExactAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    android.os.SystemClock.elapsedRealtime() + 15 * 60 * 1000L, pi)
            } else {
                am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    android.os.SystemClock.elapsedRealtime() + 15 * 60 * 1000L, pi)
            }
        } catch (e: Exception) {
            FileLogger.w("DialService", "保活自查调度失败: ${e.message}")
        }
    }

    private fun syncDailyStats() {
        try {
            val prefs = getSharedPreferences("autodial", MODE_PRIVATE)
            val deviceId = PrefCtrl(this@DialService).getDeviceId()
            val pin = prefs.getString("pin", "") ?: return
            val serverUrl = prefs.getString("cloud_server", "") ?: return
            if (serverUrl.isEmpty()) return
            val baseUrl = normalizeHttpUrl(serverUrl)
            val today = callLogDb.getTodayCount(this)
            val stats = callLogDb.getDailyDurationStats(this, 1)
            val dur = if (stats.isNotEmpty()) stats[0].totalDurationSec else 0L
            val connected = callLogDb.getTodayConnectedCount(this)
            val model = android.os.Build.MODEL ?: ""
            val urlStr = "$baseUrl/api/v1/stats/report?device_id=${java.net.URLEncoder.encode(deviceId, "UTF-8")}" +
                "&pin=${java.net.URLEncoder.encode(pin, "UTF-8")}&count=$today&duration=$dur&connected=$connected" +
                "&model=${java.net.URLEncoder.encode(model, "UTF-8")}&version=2.1"
            val conn = java.net.URL(urlStr).openConnection() as java.net.HttpURLConnection
            conn.connectTimeout = 5000; conn.readTimeout = 5000
            conn.connect(); conn.disconnect()
        } catch (_: Exception) {}
    }

    fun logEvent(eventType: String, detail: String = "") {
        executor.execute {
            try {
                val prefs = getSharedPreferences("autodial", MODE_PRIVATE)
                val deviceId = PrefCtrl(this@DialService).getDeviceId()
                val pin = prefs.getString("pin", "") ?: return@execute
                val serverUrl = prefs.getString("cloud_server", "") ?: return@execute
                if (serverUrl.isEmpty()) return@execute
                val baseUrl = normalizeHttpUrl(serverUrl)
                val urlStr = "$baseUrl/api/v1/events/log?device_id=${java.net.URLEncoder.encode(deviceId, "UTF-8")}" +
                    "&event_type=${java.net.URLEncoder.encode(eventType, "UTF-8")}" +
                    "&pin=${java.net.URLEncoder.encode(pin, "UTF-8")}" +
                    "&detail=${java.net.URLEncoder.encode(detail, "UTF-8")}"
                val conn = java.net.URL(urlStr).openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 5000; conn.readTimeout = 5000
                conn.connect(); conn.disconnect()
            } catch (_: Exception) {}
        }
    }

    private fun normalizeHttpUrl(wsUrl: String): String {
        return when {
            wsUrl.startsWith("wss://") -> wsUrl.replace("wss://", "https://")
            wsUrl.startsWith("ws://") -> wsUrl.replace("ws://", "http://")
            else -> "http://$wsUrl"
        }.removeSuffix("/")
    }
}
