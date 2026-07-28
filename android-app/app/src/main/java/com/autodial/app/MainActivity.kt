package com.autodial.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.PorterDuff
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.fragment.app.Fragment
import androidx.viewpager2.widget.ViewPager2

class MainActivity : AppCompatActivity() {

    private lateinit var viewPager: ViewPager2
    private lateinit var bottomNavContainer: LinearLayout
    private lateinit var tabConnect: LinearLayout
    private lateinit var tabCallLog: LinearLayout
    private lateinit var tabStats: LinearLayout
    private lateinit var tabRegister: LinearLayout
    private lateinit var tabConnectLabel: TextView
    private lateinit var tabCallLogLabel: TextView
    private lateinit var tabStatsLabel: TextView
    private lateinit var tabRegisterLabel: TextView
    private lateinit var tabConnectIcon: ImageView
    private lateinit var tabCallLogIcon: ImageView
    private lateinit var tabStatsIcon: ImageView
    private lateinit var tabRegisterIcon: ImageView

    private val fragments = listOf<Fragment>(
        CallLogFragment(),
        RegisterFragment(),
        StatsFragment(),
        ConnectFragment()
    )

    private val connectionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
        }
    }

    private val simSelectReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val number = intent?.getStringExtra("number") ?: return
            val lastSimSlot = intent.getIntExtra("last_sim_slot", -1)
            val lastDialTime = intent.getLongExtra("last_dial_time", 0L)
            showSimSelectSheet(number, lastSimSlot, lastDialTime)
        }
    }

    private val smsConfirmReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val number = intent?.getStringExtra("number") ?: return
            val content = intent?.getStringExtra("content") ?: ""
            startActivity(Intent(this@MainActivity, SmsConfirmActivity::class.java).apply {
                putExtra("number", number)
                putExtra("content", content)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        }
    }

    private val themeListener: () -> Unit = {
        applyTheme()
        switchTab(viewPager.currentItem)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        getSharedPreferences("autodial", MODE_PRIVATE).edit()
            .putBoolean("manual_disconnect", false).apply()

        viewPager = findViewById(R.id.viewPager)
        bottomNavContainer = findViewById(R.id.bottomNavContainer)
        tabConnect = findViewById(R.id.tabConnect)
        tabCallLog = findViewById(R.id.tabCallLog)
        tabStats = findViewById(R.id.tabStats)
        tabRegister = findViewById(R.id.tabRegister)
        tabConnectLabel = findViewById(R.id.tabConnectLabel)
        tabCallLogLabel = findViewById(R.id.tabCallLogLabel)
        tabStatsLabel = findViewById(R.id.tabStatsLabel)
        tabRegisterLabel = findViewById(R.id.tabRegisterLabel)
        tabConnectIcon = findViewById(R.id.tabConnectIcon)
        tabCallLogIcon = findViewById(R.id.tabCallLogIcon)
        tabStatsIcon = findViewById(R.id.tabStatsIcon)
        tabRegisterIcon = findViewById(R.id.tabRegisterIcon)

        ThemeManager.addOnThemeChangedListener(themeListener)

        viewPager.adapter = ViewPagerAdapter(this, fragments)
        viewPager.isUserInputEnabled = false
        applyNavigationOrder()

        tabCallLog.setOnClickListener { switchTab(0) }
        tabRegister.setOnClickListener { switchTab(1) }
        tabStats.setOnClickListener { switchTab(2) }
        tabConnect.setOnClickListener { switchTab(3) }

        ContextCompat.registerReceiver(this, connectionReceiver,
            IntentFilter("com.autodial.CONNECTION_CHANGE"),
            ContextCompat.RECEIVER_EXPORTED
        )
        ContextCompat.registerReceiver(this, simSelectReceiver,
            IntentFilter(DialService.ACTION_SHOW_SIM_SELECT),
            ContextCompat.RECEIVER_EXPORTED
        )
        ContextCompat.registerReceiver(this, smsConfirmReceiver,
            IntentFilter(DialService.ACTION_SHOW_SMS_CONFIRM),
            ContextCompat.RECEIVER_EXPORTED
        )

        startService(DialService.newIntent(this))


        applyTheme()
        switchTab(0)

        // 延迟到界面渲染后请求权限，避免华为等机型吞掉权限对话框
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            requestPermissions()
        }, 800)
    }

    // ==================== background dial support ====================

    override fun onResume() {
        super.onResume()
        DialService.isActivityVisible = true
        // Execute any pending background dial
        val pending = DialService.pendingBackgroundDialNumber
        if (pending != null) {
            DialService.pendingBackgroundDialNumber = null
            DialService._instance?.dialNumber(pending)
        }
    }

    override fun onPause() {
        super.onPause()
        DialService.isActivityVisible = false
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == DialService.ACTION_EXECUTE_PENDING_DIAL) {
            val pending = DialService.pendingBackgroundDialNumber
            if (pending != null) {
                DialService.pendingBackgroundDialNumber = null
                DialService._instance?.dialNumber(pending)
            }
        }
    }

    private fun applyTheme() {
        val colors = ThemeManager.getColors(this)
        val bgColor = Color.parseColor(colors.bg)
        window.statusBarColor = bgColor
        window.navigationBarColor = bgColor
        val isLight = ThemeManager.isLightMode(this)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = isLight
            isAppearanceLightNavigationBars = isLight
        }
        ThemeManager.applyToView(findViewById<View>(android.R.id.content), colors)
    }

    fun notifyFragmentsThemeChanged() {
    }

    fun syncDialModeUI() {
        (fragments.getOrNull(0) as? CallLogFragment)?.updateDialModeBarUI()
    }

    fun applyNavigationOrder() {
        val prefCtrl = PrefCtrl(this)
        val orderedTabs = if (prefCtrl.getNavigationOrder() == "settings_first") {
            listOf(tabConnect, tabCallLog, tabStats, tabRegister)
        } else {
            listOf(tabCallLog, tabRegister, tabStats, tabConnect)
        }
        orderedTabs.forEach { tab ->
            (tab.parent as? LinearLayout)?.removeView(tab)
            bottomNavContainer.addView(tab)
        }
        switchTab(viewPager.currentItem)
    }

    override fun onDestroy() {
        super.onDestroy()
        ThemeManager.removeOnThemeChangedListener(themeListener)
        try { unregisterReceiver(connectionReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(simSelectReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(smsConfirmReceiver) } catch (_: Exception) {}
    }

    private fun showSimSelectSheet(number: String, lastSimSlot: Int, lastDialTime: Long) {
        try {
            if (SimSelectOverlay.hasPermission(this)) {
                SimSelectOverlay.show(this, number, lastSimSlot, lastDialTime)
            } else {
                Toast.makeText(this, "\u8bf7\u5f00\u542f\u60ac\u6d6e\u7a97\u6743\u9650\u4ee5\u663e\u793a\u9009\u5361\u5f39\u7a97", Toast.LENGTH_LONG).show()
                startActivity(Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                ))
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun switchTab(index: Int) {
        viewPager.currentItem = index
        val colors = ThemeManager.getColors(this)
        val inactiveColor = Color.parseColor(colors.text2)
        val activeColor = Color.parseColor(colors.primaryLight)

        val tabs = listOf(tabCallLog, tabRegister, tabStats, tabConnect)
        tabs.forEach { tab ->
            tab.background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                setColor(Color.TRANSPARENT)
                cornerRadius = resources.displayMetrics.density * 17f
            }
        }

        tabConnectLabel.setTextColor(inactiveColor)
        tabCallLogLabel.setTextColor(inactiveColor)
        tabStatsLabel.setTextColor(inactiveColor)
        tabRegisterLabel.setTextColor(inactiveColor)

        tabConnectIcon.setColorFilter(inactiveColor, PorterDuff.Mode.SRC_IN)
        tabCallLogIcon.setColorFilter(inactiveColor, PorterDuff.Mode.SRC_IN)
        tabStatsIcon.setColorFilter(inactiveColor, PorterDuff.Mode.SRC_IN)
        tabRegisterIcon.setColorFilter(inactiveColor, PorterDuff.Mode.SRC_IN)

        when (index) {
            0 -> {
                setActiveTabBackground(tabCallLog, colors)
                tabCallLogLabel.setTextColor(activeColor)
                tabCallLogIcon.setColorFilter(activeColor, PorterDuff.Mode.SRC_IN)
                (fragments.getOrNull(0) as? CallLogFragment)?.refreshIfNeeded()
                (fragments.getOrNull(0) as? CallLogFragment)?.updateDialModeBarUI()
            }
            1 -> {
                setActiveTabBackground(tabRegister, colors)
                tabRegisterLabel.setTextColor(activeColor)
                tabRegisterIcon.setColorFilter(activeColor, PorterDuff.Mode.SRC_IN)
            }
            2 -> {
                setActiveTabBackground(tabStats, colors)
                tabStatsLabel.setTextColor(activeColor)
                tabStatsIcon.setColorFilter(activeColor, PorterDuff.Mode.SRC_IN)
                (fragments.getOrNull(2) as? StatsFragment)?.refreshIfNeeded()
            }
            3 -> {
                setActiveTabBackground(tabConnect, colors)
                tabConnectLabel.setTextColor(activeColor)
                tabConnectIcon.setColorFilter(activeColor, PorterDuff.Mode.SRC_IN)
            }
        }
    }

    private fun setActiveTabBackground(tab: View, colors: ThemeColors) {
        tab.background = android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.RECTANGLE
            setColor(Color.parseColor(colors.bg3))
            cornerRadius = resources.displayMetrics.density * 17f
        }
    }

    private fun requestPermissions() {
        val perms = mutableListOf(
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.SEND_SMS
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            perms.add(Manifest.permission.ANSWER_PHONE_CALLS)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            perms.add(Manifest.permission.READ_PHONE_NUMBERS)
        }

        val needed = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toTypedArray(), 100)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            // 华为等机型可能拦截 Settings 跳转，弹窗引导手动开启
            try {
                startActivity(Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                ))
            } catch (_: Exception) {}
            // 弹窗说明：防止华为直接吞掉跳转
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                if (!Settings.canDrawOverlays(this)) {
                    androidx.appcompat.app.AlertDialog.Builder(this)
                        .setTitle("需要悬浮窗权限")
                        .setMessage("请在 设置 → 应用 → Auto融鑫汇 → 显示在其他应用上层 中手动开启。\n\n此权限用于电话拨出时弹出选卡窗口。")
                        .setPositiveButton("去设置") { _, _ ->
                            try {
                                startActivity(Intent(
                                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                    Uri.parse("package:$packageName")
                                ))
                            } catch (_: Exception) {}
                        }
                        .setNegativeButton("稍后", null)
                        .show()
                }
            }, 1500)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 100) {
            startService(DialService.newIntent(this))
            (fragments.getOrNull(1) as? CallLogFragment)?.refreshIfNeeded()
        }
    }
}
