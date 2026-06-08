package com.autodial.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
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
    private lateinit var tabConnect: LinearLayout
    private lateinit var tabCallLog: LinearLayout
    private lateinit var tabStats: LinearLayout
    private lateinit var tabConnectLabel: TextView
    private lateinit var tabCallLogLabel: TextView
    private lateinit var tabStatsLabel: TextView

    private val fragments = listOf<Fragment>(
        ConnectFragment(),
        CallLogFragment(),
        StatsFragment()
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
        tabConnect = findViewById(R.id.tabConnect)
        tabCallLog = findViewById(R.id.tabCallLog)
        tabStats = findViewById(R.id.tabStats)
        tabConnectLabel = findViewById(R.id.tabConnectLabel)
        tabCallLogLabel = findViewById(R.id.tabCallLogLabel)
        tabStatsLabel = findViewById(R.id.tabStatsLabel)

        ThemeManager.addOnThemeChangedListener(themeListener)

        viewPager.adapter = ViewPagerAdapter(this, fragments)
        viewPager.isUserInputEnabled = false

        tabConnect.setOnClickListener { switchTab(0) }
        tabCallLog.setOnClickListener { switchTab(1) }
        tabStats.setOnClickListener { switchTab(2) }

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

        requestPermissions()

        applyTheme()
        switchTab(0)
    }

    // ==================== background dial support ====================

    override fun onResume() {
        super.onResume()
        DialService.isActivityVisible = true
        // Execute any pending background dial
        val pending = DialService.pendingBackgroundDialNumber
        if (pending != null) {
            DialService.pendingBackgroundDialNumber = null
            DialService._instance?.let {
                if (it::dialEngine.isInitialized) {
                    it.dialEngine.dialNumber(pending)
                }
            }
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
                DialService._instance?.let {
                    if (it::dialEngine.isInitialized) {
                        it.dialEngine.dialNumber(pending)
                    }
                }
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
        (fragments.getOrNull(1) as? CallLogFragment)?.updateDialModeBarUI()
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
        val activeColor = Color.parseColor(colors.goldLight)

        tabConnectLabel.setTextColor(inactiveColor)
        tabCallLogLabel.setTextColor(inactiveColor)
        tabStatsLabel.setTextColor(inactiveColor)

        when (index) {
            0 -> tabConnectLabel.setTextColor(activeColor)
            1 -> {
                tabCallLogLabel.setTextColor(activeColor)
                (fragments.getOrNull(1) as? CallLogFragment)?.refreshIfNeeded()
                (fragments.getOrNull(1) as? CallLogFragment)?.updateDialModeBarUI()
            }
            2 -> {
                tabStatsLabel.setTextColor(activeColor)
                (fragments.getOrNull(2) as? StatsFragment)?.refreshIfNeeded()
            }
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
            Toast.makeText(this, "\u5f39\u7a97\u9009\u5361\u9700\u8981\u60ac\u6d6e\u7a97\u6743\u9650\uff0c\u8bf7\u5141\u8bb8", Toast.LENGTH_LONG).show()
            try {
                startActivity(Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                ))
            } catch (_: Exception) {}
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
