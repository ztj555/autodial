package com.autodial.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

/** 连接策略 */
enum class ConnectionStrategy(val key: String, val label: String) {
    AUTO("auto", "自动(LAN优先)"),
    LAN_ONLY("lan_only", "仅局域网"),
    CLOUD_ONLY("cloud_only", "仅云中转");

    companion object {
        fun fromKey(key: String): ConnectionStrategy =
            entries.find { it.key == key } ?: AUTO

        /** 从 SharedPreferences 读取策略，自动迁移旧 cloud_enabled */
        fun readFromPrefs(prefs: android.content.SharedPreferences): ConnectionStrategy {
            val savedKey = prefs.getString("connection_strategy", null)
            if (savedKey != null) return fromKey(savedKey)
            // 旧版本迁移：cloud_enabled + 有服务器 → AUTO，否则 LAN_ONLY
            val cloudEnabled = prefs.getBoolean("cloud_enabled", false)
            val hasServers = prefs.getString("cloud_servers", null) != null
                || (prefs.getString("cloud_server", "") ?: "").isNotEmpty()
            val strategy = AUTO  // 默认自动（LAN+Cloud）
            prefs.edit().putString("connection_strategy", strategy.key).apply()
            return strategy
        }
    }
}

/**
 * v4: 设置管理 — 从 ConnectFragment 拆出
 */
class PrefCtrl(private val context: Context) {
    private val prefs = context.getSharedPreferences("autodial", Context.MODE_PRIVATE)

    fun getConnectionStrategy(): ConnectionStrategy {
        return ConnectionStrategy.readFromPrefs(prefs)
    }

    fun setConnectionStrategy(strategy: ConnectionStrategy) {
        prefs.edit().putString("connection_strategy", strategy.key).apply()
    }

    fun isAutoConnectEnabled() = prefs.getBoolean("auto_reconnect", true)
    fun setAutoConnect(enabled: Boolean) = prefs.edit().putBoolean("auto_reconnect", enabled).apply()

    fun isAutoCopyEnabled() = prefs.getBoolean("auto_copy_number", true)
    fun setAutoCopy(enabled: Boolean) = prefs.edit().putBoolean("auto_copy_number", enabled).apply()

    fun isCopyToastEnabled() = prefs.getBoolean("copy_toast", false)
    fun setCopyToast(enabled: Boolean) = prefs.edit().putBoolean("copy_toast", enabled).apply()

    fun getDialAnimationMode() = prefs.getInt("dial_animation_mode", DialAnimationOverlay.MODE_BOUNCE)
    fun setDialAnimationMode(mode: Int) = prefs.edit().putInt("dial_animation_mode", mode).apply()
    fun getDialAnimationText() = prefs.getString("dial_animation_text", "财运+1") ?: "财运+1"
    fun setDialAnimationText(text: String) = prefs.edit().putString("dial_animation_text", text).apply()

    fun getDialModeKey() = prefs.getString("dial_mode", DialMode.ROUND_SELECT.key) ?: DialMode.ROUND_SELECT.key
    fun setDialModeKey(key: String) = prefs.edit().putString("dial_mode", key).apply()

    fun getPin() = prefs.getString("pin", "") ?: ""
    fun setPin(pin: String) = prefs.edit().putString("pin", pin).apply()

    // ========== v3: JWT 登录 ==========
    fun getJwtToken() = prefs.getString("jwt_token", "") ?: ""
    fun setJwtToken(token: String) = prefs.edit().putString("jwt_token", token).apply()
    fun getRefreshToken() = prefs.getString("refresh_token", "") ?: ""
    fun setRefreshToken(token: String) = prefs.edit().putString("refresh_token", token).apply()
    fun getLoginPhone() = prefs.getString("login_phone", "") ?: ""
    fun setLoginPhone(phone: String) = prefs.edit().putString("login_phone", phone).apply()
    fun getCloudServer() = prefs.getString("cloud_server", "") ?: ""
    fun setCloudServer(server: String) = prefs.edit().putString("cloud_server", server).apply()

    fun isCloudEnabled() = prefs.getBoolean("cloud_enabled", false)

    fun getCardOpacity(): Int = prefs.getInt("card_opacity", 100)
    fun setCardOpacity(value: Int) = prefs.edit().putInt("card_opacity", value).apply()

    fun isManuallyDisconnected() = prefs.getBoolean("manual_disconnect", false)
    fun setManuallyDisconnected(v: Boolean) = prefs.edit().putBoolean("manual_disconnect", v).apply()

    fun isBatteryOptIgnored(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            return pm.isIgnoringBatteryOptimizations(context.packageName)
        }
        return true
    }

    fun openBatteryOptSettings() {
        try {
            context.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${context.packageName}"); addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        } catch (_: Exception) {}
    }

    fun getLogFileInfo(): String {
        return try {
            val logFile = File(context.getExternalFilesDir(null), "autodial_log.txt")
            if (logFile.exists()) {
                val size = logFile.length()
                val date = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(logFile.lastModified()))
                "日志: ${when { size < 1024 -> "${size}B"; size < 1024 * 1024 -> "${size / 1024}KB"; else -> "${size / (1024 * 1024)}MB" }} ($date)"
            } else "暂无日志"
        } catch (_: Exception) { "导出调试日志" }
    }

    fun getLogFilePath(): File? = try {
        File(context.getExternalFilesDir(null), "autodial_log.txt").takeIf { it.exists() }
    } catch (_: Exception) { null }

    fun createShareIntent(): Intent? {
        val f = getLogFilePath() ?: return null
        return Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_STREAM, androidx.core.content.FileProvider.getUriForFile(
                context, "${context.packageName}.fileprovider", f))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }
}
