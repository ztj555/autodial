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
        const val ACTION_CLOUD_STATUS = "com.autodial.CLOUD_STATUS"
        const val ACTION_EXECUTE_PENDING_DIAL = "com.autodial.EXECUTE_PENDING_DIAL"

        var isRunning = false
            private set
        @Volatile var isActivityVisible = false
        var pendingBackgroundDialNumber: String? = null
        val isConnected: Boolean get() = _instance?.connectionManager?.isConnected ?: false
        val serverAddress: String get() = ""
        val isCloudConnected: Boolean get() = _instance?.connectionManager?.isCloudConnected ?: false
        val isLanConnected: Boolean get() = _instance?.connectionManager?.isLanConnected ?: false
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
    private var screenOnReceiver: BroadcastReceiver? = null

    private val pendingDialQueue = ArrayDeque<String>()
    private var pendingDialNumber: String?
        get() = pendingDialQueue.firstOrNull()
        set(value) {
            if (value == null) { pendingDialQueue.removeFirstOrNull() }
            else pendingDialQueue.addLast(value)
        }

    private var listenerRegistered = false

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
                    updateNotification("\u5df2\u8fde\u63a5\u5230\u7535\u8111(${connectionMode})")
                    getSharedPreferences("autodial", MODE_PRIVATE)
                        .edit().putBoolean("was_connected", true).apply()
                    notifyConnectionChange(true, null)
                    notifyCloudStatus(null)
                }
                ConnectionManager.ConnectionState.DISCONNECTED -> {
                    if (oldState == ConnectionManager.ConnectionState.CONNECTED) {
                        updateNotification("\u8fde\u63a5\u5df2\u65ad\u5f00")
                        notifyConnectionChange(false, "disconnected")
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
                        FileLogger.i("DialService", "\u6536\u5230\u77ed\u4fe1\u8bf7\u6c42: $number, \u5185\u5bb9\u957f\u5ea6=${content.length}")
                        if (number.isNotEmpty()) {
                            Log.d(TAG, "\u77ed\u4fe1\u8bf7\u6c42: $number, \u5185\u5bb9\u957f\u5ea6=${content.length}")
                            val intent = Intent(ACTION_SHOW_SMS_CONFIRM).apply {
                                putExtra("number", number)
                                putExtra("content", content)
                                setPackage(packageName)
                            }
                            sendBroadcast(intent)
                        }
                    }
                    "hangup" -> {
                        FileLogger.i("DialService", "\u6536\u5230\u6302\u65ad\u6307\u4ee4")
                        Log.d(TAG, "\u6536\u5230\u6302\u65ad\u6307\u4ee4")
                        if (::dialEngine.isInitialized) dialEngine.endCall()
                    }
                }
            } catch (e: Exception) { Log.e(TAG, "\u6d88\u606f\u5904\u7406\u5931\u8d25: ${e.message}") }
        }

        override fun onError(error: ConnectionManager.ConnectionError) {
            when (error) {
                is ConnectionManager.ConnectionError.AuthFailed -> {
                    updateNotification("\u914d\u5bf9\u7801\u9519\u8bef")
                    notifyConnectionChange(false, "pin_wrong")
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
            startForeground(NOTIFICATION_ID, buildNotification("\u8de8\u5c4f\u62e8\u53f7 \u8fd0\u884c\u4e2d"))

            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "autodial:wake").apply {
                setReferenceCounted(false)
                acquire(12 * 60 * 60 * 1000L)
            }

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

            connectionManager.loadSavedConfig()

        } catch (e: Exception) {
            Log.e(TAG, "Service onCreate error: ${e.message}", e)
            isRunning = true
            callLogDb = CallLogDb.getInstance(this)
            createNotificationChannel()
            try { startForeground(NOTIFICATION_ID, buildNotification("\u8de8\u5c4f\u62e8\u53f7 \u8fd0\u884c\u4e2d")) } catch (_: Exception) {}
            if (!::connectionManager.isInitialized) {
                connectionManager = ConnectionManager(this)
            }
            if (!::dialEngine.isInitialized) {
                dialEngine = DialEngine(this, callLogDb)
            }
            ensureListenerRegistered()
            try { connectionManager.registerNetworkMonitor() } catch (_: Exception) {}
            try { connectionManager.loadSavedConfig() } catch (_: Exception) {}
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
                    val ip = intent.getStringExtra("ip") ?: ""
                    val pin = intent.getStringExtra("pin") ?: ""
                    if (pin.isNotEmpty()) {
                        lastPin = pin
                        lastIp = ip
                        manualConnecting = true
                        getSharedPreferences("autodial", MODE_PRIVATE).edit()
                            .putString("ip", ip).putString("pin", pin).apply()
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
                    updateNotification("\u8de8\u5c4f\u62e8\u53f7 \u8fd0\u884c\u4e2d")
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
            if (::connectionManager.isInitialized) connectionManager.cleanup()
            FileLogger.shutdown()
            isRunning = false
            wakeLock?.release(); wakeLock = null
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
        registerReceiver(screenOnReceiver, filter)
        Log.d(TAG, "\u5df2\u6ce8\u518c\u4eae\u5c4f\u5e7f\u64ad")
    }

    private fun unregisterScreenOnReceiver() {
        screenOnReceiver?.let {
            try { unregisterReceiver(it) } catch (_: Exception) {}
            screenOnReceiver = null
        }
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
        dialEngine.onDialSuccess(number, simSlot)
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
                val channel = NotificationChannel(CHANNEL_ID, "\u8de8\u5c4f\u62e8\u53f7 \u670d\u52a1", NotificationManager.IMPORTANCE_LOW)
                    .apply {
                        description = "\u4fdd\u6301\u62e8\u53f7\u8fde\u63a5"
                        setVibrationPattern(longArrayOf(0))
                        enableVibration(false)
                    }
                getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
            }
        } catch (_: Exception) {}
    }

    private fun buildNotification(text: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("\u8de8\u5c4f\u62e8\u53f7").setContentText(text)
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
}
