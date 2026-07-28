package com.autodial.app

import android.content.Context
import android.widget.Toast

/** 弹窗通知辅助：根据设置开关决定是否弹出 Toast */
object NotifyHelper {
    fun connToast(context: Context, msg: String, duration: Int = Toast.LENGTH_SHORT) {
        val prefs = context.getSharedPreferences("autodial", Context.MODE_PRIVATE)
        if (prefs.getBoolean("notify_conn_state", true)) {
            Toast.makeText(context, msg, duration).show()
        }
    }

    fun registerToast(context: Context, msg: String, duration: Int = Toast.LENGTH_SHORT) {
        val prefs = context.getSharedPreferences("autodial", Context.MODE_PRIVATE)
        if (prefs.getBoolean("notify_register", true)) {
            Toast.makeText(context, msg, duration).show()
        }
    }
}
