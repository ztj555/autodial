package com.autodial.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import androidx.core.content.ContextCompat

/**
 * v4.23 保活自查接收器。
 *
 * 背景：DialService 虽是 START_STICKY 前台服务，但在国产 ROM 激进的杀后台策略下，
 * 进程被杀后 sticky 重启可能被延迟到几小时甚至不发生（除非用户重启手机）。
 * 本接收器以 15 分钟为周期自循环（每次触发先续期下一轮），检查：
 *   1) 服务是否存活（DialService.isRunning）
 *   2) 用户是否配置过 PIN 且未手动断开
 * 满足复活条件则以 startForegroundService 拉起服务。
 *
 * 安全边界：
 * - Android 12+ 对后台启动前台服务有限制，exact alarm 触发属于豁免场景之一；
 *   若系统策略仍拦截，startForegroundService 抛异常被捕获，退化为原有行为（不自愈），
 *   不会引入新问题。
 * - 用户「手动断开」后永不复活，尊重用户意图。
 */
class KeepAliveReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        try {
            // 1) 先续期下一轮自查（自循环，不依赖服务存活）
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pi = PendingIntent.getBroadcast(
                context, 2001,
                Intent(context, KeepAliveReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + 15 * 60 * 1000L, pi)
            } else {
                am.setExact(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + 15 * 60 * 1000L, pi)
            }

            // 2) 服务还活着 → 无需处理
            if (DialService.isRunning) return

            // 3) 没配置过 PIN / 用户手动断开 → 不复活
            val prefs = context.getSharedPreferences("autodial", Context.MODE_PRIVATE)
            val hasPin = !prefs.getString("pin", "").isNullOrEmpty()
            val manual = prefs.getBoolean("manual_disconnect", false)
            if (!hasPin || manual) return

            // 4) 复活服务
            ContextCompat.startForegroundService(
                context, Intent(context, DialService::class.java))
        } catch (_: Exception) {
            // 任何异常都不传播：保活是锦上添花，不能成为新的崩溃源
        }
    }
}
