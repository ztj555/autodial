package com.autodial.app

import android.animation.ValueAnimator
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.net.URL
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.*
import java.io.File
import java.text.SimpleDateFormat
import java.util.*
import okhttp3.MediaType.Companion.toMediaType

class ConnectFragment : Fragment() {

    private lateinit var statusDot: ImageView
    private lateinit var pulseRing: ImageView
    private lateinit var statusText: TextView
    private lateinit var connectionMode: TextView
    private lateinit var connectionBanner: LinearLayout
    private lateinit var bannerText: TextView
    private lateinit var pinInput: EditText
    private lateinit var connectBtnText: TextView
    private lateinit var disconnectBtn: TextView
    private lateinit var discoveryHint: TextView
    private lateinit var foundPCInfo: LinearLayout
    private lateinit var foundPCText: TextView
    private lateinit var autoConnectSwitch: TextView
    private lateinit var batteryOptStatus: TextView
    private lateinit var batteryOptBtn: TextView
    private lateinit var batteryOptOk: TextView
    private lateinit var themeSettingRow: View
    private lateinit var previewGold: View
    private lateinit var previewBg: View
    private lateinit var previewBg2: View
    private lateinit var previewText: View
    private lateinit var cloudServerCurrentText: TextView
    private lateinit var cloudServerListContainer: LinearLayout
    private lateinit var cloudServerAddBtn: TextView
    private lateinit var cloudServerTestBtn: TextView
    private lateinit var cloudServerSyncBtn: TextView
    private lateinit var cloudServerFetchBtn: TextView
    private lateinit var connectionStrategyRow: View
    private lateinit var connectionStrategyDesc: TextView
    private lateinit var lanChannelStatus: TextView
    private lateinit var cloudChannelStatus: TextView
    private lateinit var autoCopySwitch: TextView
    private lateinit var copyToastSwitch: TextView
    private lateinit var dialAnimationSwitch: TextView
    private lateinit var dialAnimationDesc: TextView
    private lateinit var dialAnimationTextPreview: TextView
    private lateinit var exportLogInfo: TextView
    // v7: 折叠卡片
    private lateinit var advancedHeader: View
    private lateinit var advancedContent: View
    private lateinit var advancedArrow: TextView
    private lateinit var otherHeader: View
    private lateinit var otherContent: View
    private lateinit var otherArrow: TextView
    // v8: 使用说明折叠 + 励志语
    private lateinit var usageGuideHeader: View
    private lateinit var usageGuideContent: View
    private lateinit var usageGuideArrow: TextView
    private lateinit var motivationalText: TextView
    // v7: 拨号模式
    private lateinit var dialModeRow: View
    private lateinit var dialModeCurrent: TextView

    // v4: 拆出的模块
    private lateinit var cloudCtrl: CloudCtrl
    private lateinit var prefCtrl: PrefCtrl

    companion object {
        private const val REQUEST_CODE_EXPORT_LOG = 10001
    }

    private val themeListener: () -> Unit = {
        if (isAdded && ::prefCtrl.isInitialized) {
            applyTheme()
            updateThemePreview()
            updateConnectionUI(DialService.isConnected, null)
            updateAutoConnectUI(prefCtrl.isAutoConnectEnabled())
            updateAutoCopyUI(prefCtrl.isAutoCopyEnabled())
            updateCopyToastUI(prefCtrl.isCopyToastEnabled())
            updateBatteryOptUI()
        }
    }

    private var discoveredIP = ""
    private var discoveryJob: Job? = null

    // v9: 定时刷新通道状态（云已通但PC/扩展在线状态尚未确认时）
    private var waitingForPcRefreshRunnable: Runnable? = null
    private val WAITING_FOR_PC_REFRESH_MS = 3000L

    // 脉冲动画
    private var pulseAnimator: ValueAnimator? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            try {
                val connected = intent?.getBooleanExtra("connected", false) ?: return
                val reason = intent.getStringExtra("reason")
                updateConnectionUI(connected, reason)
                // v9: 收到连接状态广播后立即检查是否卡在「等待PC上线」
                scheduleWaitingForPcRefresh()
            } catch (_: Exception) {}
        }
    }

    /** v9: 云已连通但通道未确认时启动定时刷新 */
    private fun scheduleWaitingForPcRefresh() {
        cancelWaitingForPcRefresh()
        if (!DialService.isConnected) return
        if (DialService.isLanConnected) return
        if (!DialService.isCloudConnected) return
        if (DialService.isPcReachable || DialService.isExtOnline) return
        waitingForPcRefreshRunnable = object : Runnable {
            override fun run() {
                if (!isAdded) return
                if (DialService.isPcReachable || DialService.isExtOnline) {
                    updateConnectionUI(true, null)
                    cancelWaitingForPcRefresh()
                } else if (!DialService.isConnected || DialService.isLanConnected) {
                    cancelWaitingForPcRefresh()
                } else {
                    waitingForPcRefreshRunnable?.let {
                        view?.postDelayed(it, WAITING_FOR_PC_REFRESH_MS)
                    }
                }
            }
        }
        view?.postDelayed(waitingForPcRefreshRunnable!!, WAITING_FOR_PC_REFRESH_MS)
    }

    private fun cancelWaitingForPcRefresh() {
        waitingForPcRefreshRunnable?.let { view?.removeCallbacks(it) }
        waitingForPcRefreshRunnable = null
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.fragment_connect, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        try {
            statusDot = view.findViewById(R.id.statusDot)
            pulseRing = view.findViewById(R.id.pulseRing)
            statusText = view.findViewById(R.id.statusText)
            connectionBanner = view.findViewById(R.id.connectionBanner)
            bannerText = view.findViewById(R.id.bannerText)
            pinInput = view.findViewById(R.id.pinInput)
            connectBtnText = view.findViewById(R.id.connectBtnText)
            connectionMode = view.findViewById(R.id.connectionMode)
            discoveryHint = view.findViewById(R.id.discoveryHint)
            foundPCInfo = view.findViewById(R.id.foundPCInfo)
            foundPCText = view.findViewById(R.id.foundPCText)
            autoConnectSwitch = view.findViewById(R.id.autoConnectSwitch)
            batteryOptStatus = view.findViewById(R.id.batteryOptStatus)
            batteryOptBtn = view.findViewById(R.id.batteryOptBtn)
            batteryOptOk = view.findViewById(R.id.batteryOptOk)
            themeSettingRow = view.findViewById(R.id.themeSettingRow)
            previewGold = view.findViewById(R.id.previewGold)
            previewBg = view.findViewById(R.id.previewBg)
            previewBg2 = view.findViewById(R.id.previewBg2)
            previewText = view.findViewById(R.id.previewText)

            connectBtnText.setOnClickListener { handleConnectClick() }

            // v6: 断开按钮（红色描边）
            disconnectBtn = view.findViewById(R.id.disconnectBtn)
            disconnectBtn.background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                setStroke(1, Color.parseColor("#FF4D4F"))
                cornerRadius = 6f * resources.displayMetrics.density
                setColor(Color.TRANSPARENT)
            }
            disconnectBtn.setOnClickListener { handleDisconnectClick() }

            rebuildV3ConnectionHeader(view)

            // v7: 折叠面板绑定
            advancedHeader = view.findViewById(R.id.advancedSectionHeader)
            advancedContent = view.findViewById(R.id.advancedSectionContent)
            advancedArrow = view.findViewById(R.id.advancedArrow)
            otherHeader = view.findViewById(R.id.otherSectionHeader)
            otherContent = view.findViewById(R.id.otherSectionContent)
            otherArrow = view.findViewById(R.id.otherArrow)
            // v8: 使用说明折叠 + 励志语
            usageGuideHeader = view.findViewById(R.id.usageGuideHeader)
            usageGuideContent = view.findViewById(R.id.usageGuideContent)
            usageGuideArrow = view.findViewById(R.id.usageGuideArrow)
            motivationalText = view.findViewById(R.id.motivationalText)
            dialModeRow = view.findViewById(R.id.dialModeRow)
            dialModeCurrent = view.findViewById(R.id.dialModeCurrent)

            // v7: 折叠面板
            advancedHeader.setOnClickListener {
                val show = advancedContent.visibility != View.VISIBLE
                advancedContent.visibility = if (show) View.VISIBLE else View.GONE
                advancedArrow.text = if (show) "⌄" else "›"
            }
            otherHeader.setOnClickListener {
                val show = otherContent.visibility != View.VISIBLE
                otherContent.visibility = if (show) View.VISIBLE else View.GONE
                otherArrow.text = if (show) "⌄" else "›"
            }
            // v8: 使用说明折叠（默认折叠）
            usageGuideContent.visibility = View.GONE
            usageGuideArrow.text = "›"
            usageGuideHeader.setOnClickListener {
                val show = usageGuideContent.visibility != View.VISIBLE
                usageGuideContent.visibility = if (show) View.VISIBLE else View.GONE
                usageGuideArrow.text = if (show) "⌄" else "›"
            }
            // 主题/弹窗折叠（默认折叠）
            val themeHeader = view.findViewById<View>(R.id.themeSectionHeader)
            val themeArrow = view.findViewById<TextView>(R.id.themeSectionArrow)
            val themeContent = view.findViewById<View>(R.id.themeSectionContent)
            themeContent.visibility = View.GONE
            themeArrow.text = "›"
            themeHeader.setOnClickListener {
                val show = themeContent.visibility != View.VISIBLE
                themeContent.visibility = if (show) View.VISIBLE else View.GONE
                themeArrow.text = if (show) "⌄" else "›"
            }
            // v8: 每日励志语
            motivationalText.text = getDailyMotivationalQuote()

            // === 页面结构重组 ===
            rearrangeSections(view)

            // 主题设置入口
            themeSettingRow.setOnClickListener {
                showThemeDialog()
            }

            // v4: 模块初始化（必须在所有使用之前）
            cloudCtrl = CloudCtrl(requireContext())
            prefCtrl = PrefCtrl(requireContext())

            // 读取保存的配对码
            pinInput.setText(prefCtrl.getPin())

            // v4: 绑定云管理回调
            cloudCtrl.onServerListChanged = { updateCloudServerCurrentText() }

            // v5: 输入变化时自动排序服务器列表（4位→old优先，11位→new优先）
            pinInput.addTextChangedListener(object : android.text.TextWatcher {
                override fun afterTextChanged(s: android.text.Editable?) {
                    updateCloudServerCurrentText()
                }
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            })

            // v7: 拨号模式预填
            dialModeCurrent.text = DialMode.fromKey(prefCtrl.getDialModeKey()).label
            dialModeRow.setOnClickListener {
                DialModeSheet(requireActivity()) { selected ->
                    prefCtrl.setDialModeKey(selected.key)
                    dialModeCurrent.text = selected.label
                    (requireActivity() as? MainActivity)?.syncDialModeUI()
                }.show()
            }

            // 初始化自动连接开关状态
            updateAutoConnectUI(prefCtrl.isAutoConnectEnabled())

            // 自动连接开关点击
            view.findViewById<View>(R.id.autoConnectRow).setOnClickListener {
                val current = prefCtrl.isAutoConnectEnabled()
                val newValue = !current
                prefCtrl.setAutoConnect(newValue)
                updateAutoConnectUI(newValue)
            }

            // 电池优化检测
            updateBatteryOptUI()
            checkBatteryOptFirstTime()
            view.findViewById<View>(R.id.batteryOptRow).setOnClickListener {
                requestIgnoreBatteryOptimization()
            }

            // 注册广播
            try {
                ContextCompat.registerReceiver(requireActivity(), receiver,
                    IntentFilter("com.autodial.CONNECTION_CHANGE"),
                    ContextCompat.RECEIVER_NOT_EXPORTED
                )
                // v9: 同时监听 CLOUD_STATUS 广播（pc_online/pc_offline 事件）
                ContextCompat.registerReceiver(requireActivity(), cloudStatusReceiver,
                    IntentFilter("com.autodial.CLOUD_STATUS"),
                    ContextCompat.RECEIVER_NOT_EXPORTED
                )
            } catch (_: Exception) {}

            // 检查当前连接状态
            updateConnectionUI(DialService.isConnected, null)

            // v7: 连接策略选择器
            connectionStrategyRow = view.findViewById(R.id.connectionStrategyRow)
            connectionStrategyDesc = view.findViewById(R.id.connectionStrategyDesc)
            updateStrategyDesc()

            connectionStrategyRow.setOnClickListener {
                showStrategyDialog()
            }

            // 使用说明书
            val guideView = view.findViewById<TextView>(R.id.usageGuideText)
            guideView.text = "① 输入 11 位手机号（推荐）或 4 位配对码\n" +
                "② 点击「连接」开始使用\n" +
                "③ 可按个人习惯切换弹窗、轮选、系统等拨号模式\n" +
                "④ 连不上时检查电脑防火墙是否放行端口 35432"

            // v7: 云服务器内联列表（纯配置UI，无连接动作）
            cloudServerListContainer = view.findViewById(R.id.cloudServerListContainer)
            cloudServerAddBtn = view.findViewById(R.id.cloudServerAddBtn)
            cloudServerTestBtn = view.findViewById(R.id.cloudServerTestBtn)
            cloudServerSyncBtn = view.findViewById(R.id.cloudServerSyncBtn)
            cloudServerFetchBtn = view.findViewById(R.id.cloudServerFetchBtn)
            cloudServerCurrentText = view.findViewById(R.id.cloudServerCurrentText)
            lanChannelStatus = view.findViewById(R.id.lanChannelStatus)
            cloudChannelStatus = view.findViewById(R.id.cloudChannelStatus)
            updateCloudServerCurrentText()
            view.findViewById<View>(R.id.cloudServerManageRow).setOnClickListener {
                CloudServerSheet(requireActivity()) {
                    updateCloudServerCurrentText()
                    refreshCloudServerList()
                }.show()
            }
            cloudServerAddBtn.setOnClickListener { addCloudServer() }
            cloudServerTestBtn.setOnClickListener { testAllServers() }
            cloudServerSyncBtn.setOnClickListener { syncFromPC() }
            cloudServerFetchBtn.setOnClickListener { fetchServersFromNetwork() }
            refreshCloudServerList()
            autoTestServersOnStart()

            // 拨号自动复制号码开关
            autoCopySwitch = view.findViewById(R.id.autoCopySwitch)
            copyToastSwitch = view.findViewById(R.id.copyToastSwitch)
            updateAutoCopyUI(prefCtrl.isAutoCopyEnabled())
            updateCopyToastUI(prefCtrl.isCopyToastEnabled())

            view.findViewById<View>(R.id.autoCopyRow).setOnClickListener {
                val current = prefCtrl.isAutoCopyEnabled()
                val newValue = !current
                prefCtrl.setAutoCopy(newValue)
                updateAutoCopyUI(newValue)
                if (!newValue && prefCtrl.isCopyToastEnabled()) {
                    prefCtrl.setCopyToast(false)
                    updateCopyToastUI(false)
                }
            }

            view.findViewById<View>(R.id.copyToastRow).setOnClickListener {
                if (!prefCtrl.isAutoCopyEnabled()) return@setOnClickListener
                val current = prefCtrl.isCopyToastEnabled()
                val newValue = !current
                prefCtrl.setCopyToast(newValue)
                updateCopyToastUI(newValue)
            }

            // ===== 拨号动画效果 =====
            dialAnimationSwitch = view.findViewById(R.id.dialAnimationSwitch)
            dialAnimationDesc = view.findViewById(R.id.dialAnimationDesc)
            dialAnimationTextPreview = view.findViewById(R.id.dialAnimationTextPreview)
            updateDialAnimationUI(prefCtrl.getDialAnimationMode())
            dialAnimationTextPreview.text = prefCtrl.getDialAnimationText()

            view.findViewById<View>(R.id.dialAnimationRow).setOnClickListener {
                showAnimationListDialog()
            }

            view.findViewById<View>(R.id.dialAnimationTextRow).setOnClickListener {
                val currentText = prefCtrl.getDialAnimationText()
                val editText = EditText(requireActivity()).apply {
                    setText(currentText)
                    setTextSize(20f)
                    setTextColor(android.graphics.Color.parseColor("#E8DCC8"))
                    setPadding((48).toInt(), (32).toInt(), (48).toInt(), (32).toInt())
                    setSingleLine(true)
                    setHint("输入显示文字")
                }
                AlertDialog.Builder(requireActivity())
                    .setTitle("动画显示文字")
                    .setView(editText)
                    .setPositiveButton("确定") { _, _ ->
                        val newText = editText.text.toString().trim()
                        val finalText = if (newText.isEmpty()) "财运+1" else newText
                        prefCtrl.setDialAnimationText(finalText)
                        dialAnimationTextPreview.text = finalText
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }

            // ===== 导出日志 =====
            exportLogInfo = view.findViewById(R.id.exportLogInfo)
            updateExportLogInfo()
            view.findViewById<View>(R.id.exportLogRow).setOnClickListener {
                exportLogs()
            }

            // v4: 卡片透明度调节
            addCardOpacityRow(view)
            addCardBorderRow(view)
            addNavigationOrderRow(view)
            addNotifySection(view)

            // 应用主题
            applyTheme()
            updateThemePreview()
            updateChannelStatus()

            // 注册主题变更监听
            ThemeManager.addOnThemeChangedListener(themeListener)

            // 配对码输入变化时自动扫描
            pinInput.addTextChangedListener(object : android.text.TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: android.text.Editable?) {
                    val pin = s.toString().trim()
                    if (pin.length == 4) {
                        startDiscovery(pin)
                    } else {
                        stopDiscovery()
                        discoveredIP = ""
                        foundPCInfo.visibility = View.GONE
                        if (pin.isEmpty()) {
                            discoveryHint.text = "🔍 输入4位配对码或11位手机号开始搜索"
                        }
                    }
                }
            })
        } catch (e: Exception) {
            Toast.makeText(requireActivity(), "初始化失败: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    override fun onResume() {
        super.onResume()
        try {
            val connected = DialService.isConnected
            if (connected && statusText.text.toString() != "已连接") {
                updateConnectionUI(true, null)
                scheduleWaitingForPcRefresh()
            } else if (!connected) {
                updateConnectionUI(false, null)
            }
        } catch (_: Exception) {}
        if (isAdded) {
            updateBatteryOptUI()
            // v3: 刷新动画 UI（AnimationSheet 直接写 prefs，需手动刷新）
            try { updateDialAnimationUI(prefCtrl.getDialAnimationMode()) } catch (_: Exception) {}
        }
    }

    // v9: 独立 receiver 仅监听 ACTION_CLOUD_STATUS（pc_online/pc_offline）
    private val cloudStatusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            try {
                if (DialService.isConnected && DialService.isCloudConnected) {
                    updateConnectionUI(true, null)
                    scheduleWaitingForPcRefresh()
                }
            } catch (_: Exception) {}
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        ThemeManager.removeOnThemeChangedListener(themeListener)
        try { requireActivity().unregisterReceiver(receiver) } catch (_: Exception) {}
        try { requireActivity().unregisterReceiver(cloudStatusReceiver) } catch (_: Exception) {}
        cancelWaitingForPcRefresh()
        stopPulseAnimation()
        stopDiscovery()
    }

    // ==================== UDP 局域网发现 ====================

    private fun startDiscovery(pin: String) {
        stopDiscovery()
        discoveryHint.text = "🔍 正在扫描局域网..."
        discoveryHint.visibility = View.VISIBLE
        foundPCInfo.visibility = View.GONE
        discoveredIP = ""

        discoveryJob = CoroutineScope(Dispatchers.IO).launch {
            var socket: java.net.DatagramSocket? = null
            try {
                socket = java.net.DatagramSocket(null)
                socket.reuseAddress = true
                socket.bind(java.net.InetSocketAddress(0))

                val discoverMsg = """{"type":"discover","pin":"$pin"}""".toByteArray()
                val broadcastAddr = java.net.InetAddress.getByName("255.255.255.255")
                val packet = java.net.DatagramPacket(discoverMsg, discoverMsg.size, broadcastAddr, 35433)

                var found = false
                repeat(3) {
                    if (found) return@repeat
                    try { socket.send(packet) } catch (_: Exception) {}
                }

                socket.soTimeout = 5000
                val buffer = ByteArray(1024)
                val startTime = System.currentTimeMillis()

                while (System.currentTimeMillis() - startTime < 4000 && !found && isActive) {
                    try {
                        val recvPacket = java.net.DatagramPacket(buffer, buffer.size)
                        socket.receive(recvPacket)
                        val data = String(recvPacket.data, 0, recvPacket.length)
                        val json = try { org.json.JSONObject(data) } catch (_: Exception) { continue }
                        val type = json.optString("type", "")
                        val responsePin = json.optString("pin", "")
                        if ((type == "found" || type == "announce") && responsePin == pin) {
                            val ip = json.optString("ip", "")
                            if (ip.isNotEmpty() && !ip.startsWith("127.")) {
                                discoveredIP = ip
                                found = true
                                withContext(Dispatchers.Main) {
                                    discoveryHint.text = "✅ 已找到电脑"
                                    foundPCText.text = "💻 发现电脑: $ip"
                                    foundPCInfo.visibility = View.VISIBLE
                                }
                            }
                        }
                    } catch (_: java.net.SocketTimeoutException) {}
                    catch (_: Exception) {}
                }

                if (!found && isActive) {
                    withContext(Dispatchers.Main) {
                        discoveryHint.text = "⚠️ 未发现电脑，请确认在同一WiFi下"
                    }
                }
            } catch (_: Exception) {
                withContext(Dispatchers.Main) {
                    discoveryHint.text = "⚠️ 扫描出错，请重试"
                }
            } finally {
                try { socket?.close() } catch (_: Exception) {}
            }
        }
    }

    private fun stopDiscovery() {
        discoveryJob?.cancel()
        discoveryJob = null
    }

    // ==================== 连接控制 ====================

    private fun rebuildV3ConnectionHeader(root: View) {
        val dp = resources.displayMetrics.density
        val topBar = root.findViewById<LinearLayout>(R.id.settingsTopBar)
        val legacyPin = root.findViewById<View>(R.id.legacyPinContainer)

        (disconnectBtn.parent as? ViewGroup)?.removeView(disconnectBtn)
        disconnectBtn.layoutParams = LinearLayout.LayoutParams(
            (64 * dp).toInt(), (34 * dp).toInt()
        )
        disconnectBtn.visibility = View.VISIBLE
        topBar.addView(disconnectBtn)
        topBar.tag = null
        topBar.background = null

        (pinInput.parent as? ViewGroup)?.removeView(pinInput)
        (connectBtnText.parent as? ViewGroup)?.removeView(connectBtnText)
        (statusDot.parent?.parent as? ViewGroup)?.let { icon ->
            (icon.parent as? ViewGroup)?.removeView(icon)
        }
        (statusText.parent as? ViewGroup)?.let { textGroup ->
            (textGroup.parent as? ViewGroup)?.removeView(textGroup)
        }

        statusDashboard.removeAllViews()
        statusDashboard.orientation = LinearLayout.VERTICAL
        statusDashboard.gravity = android.view.Gravity.CENTER_VERTICAL
        statusDashboard.minimumHeight = (150 * dp).toInt()
        statusDashboard.setPadding((16*dp).toInt(),(14*dp).toInt(),(16*dp).toInt(),(12*dp).toInt())
        statusDashboard.tag = "heroCard"

        val statusRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
        }
        val iconBox = android.widget.FrameLayout(requireContext()).apply {
            layoutParams = LinearLayout.LayoutParams((44*dp).toInt(), (44*dp).toInt())
        }
        (pulseRing.parent as? ViewGroup)?.removeView(pulseRing)
        (statusDot.parent as? ViewGroup)?.removeView(statusDot)
        iconBox.addView(pulseRing, android.widget.FrameLayout.LayoutParams((44*dp).toInt(),(44*dp).toInt(), android.view.Gravity.CENTER))
        iconBox.addView(statusDot, android.widget.FrameLayout.LayoutParams((28*dp).toInt(),(28*dp).toInt(), android.view.Gravity.CENTER))
        statusRow.addView(iconBox)

        val statusCopy = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply { marginStart=(12*dp).toInt() }
        }
        (statusText.parent as? ViewGroup)?.removeView(statusText)
        (connectionMode.parent as? ViewGroup)?.removeView(connectionMode)
        statusCopy.addView(statusText)
        statusCopy.addView(connectionMode)
        statusRow.addView(statusCopy)
        statusDashboard.addView(statusRow, LinearLayout.LayoutParams(-1,-2))

        val inputRow = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(-1,(44*dp).toInt()).apply { topMargin=(12*dp).toInt() }
        }
        pinInput.layoutParams = LinearLayout.LayoutParams(0,(44*dp).toInt(),1f)
        pinInput.gravity = android.view.Gravity.CENTER_VERTICAL
        pinInput.textSize = 15f
        pinInput.letterSpacing = 0f
        pinInput.hint = "请输入系统手机号"
        pinInput.tag = "inputField"
        inputRow.addView(pinInput)
        connectBtnText.layoutParams = LinearLayout.LayoutParams((78*dp).toInt(),(44*dp).toInt()).apply { marginStart=(8*dp).toInt() }
        inputRow.addView(connectBtnText)
        statusDashboard.addView(inputRow)

        (discoveryHint.parent as? ViewGroup)?.removeView(discoveryHint)
        discoveryHint.text = "你的系统手机号 · 与电脑端保持一致"
        discoveryHint.textSize = 10f
        discoveryHint.visibility = View.VISIBLE
        statusDashboard.addView(discoveryHint, LinearLayout.LayoutParams(-2,-2).apply { topMargin=(8*dp).toInt() })

        legacyPin.visibility = View.GONE
        connectionBanner.visibility = View.GONE
        root.findViewById<View>(R.id.foundPCInfo).visibility = View.GONE
    }

    // ==================== v6: 按钮三态逻辑 ====================

    private var connecting = false

    /** 状态条按钮点击 — 根据当前状态分发 */
    private fun handleConnectClick() {
        if (!isAdded) return
        try {
            when {
                connecting -> handleCancelClick()
                DialService.isConnected -> handleReconnectClick()
                else -> handleStartConnect()
            }
        } catch (e: Exception) {
            Toast.makeText(requireActivity(), "操作失败: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    /** 发起新连接 */
    private fun handleStartConnect() {
        val input = pinInput.text.toString().trim()
        val is4Digit = input.length == 4 && input.all { it.isDigit() }
        val is11Phone = input.length == 11 && input.startsWith("1") && input.all { it.isDigit() }

        if (!is4Digit && !is11Phone) {
            Toast.makeText(requireActivity(), "请输入4位配对码或11位手机号", Toast.LENGTH_SHORT).show()
            return
        }
        prefCtrl.setManuallyDisconnected(false)
        doConnect(discoveredIP, input)
    }

    /** 重连：保持当前 PIN，重置连接 */
    private fun handleReconnectClick() {
        prefCtrl.setManuallyDisconnected(false)
        val pin = pinInput.text.toString().trim()
        val is4Digit = pin.length == 4 && pin.all { it.isDigit() }
        val is11Phone = pin.length == 11 && pin.startsWith("1") && pin.all { it.isDigit() }
        if (!is4Digit && !is11Phone) {
            Toast.makeText(requireActivity(), "请重新输入4位配对码或11位手机号", Toast.LENGTH_SHORT).show()
            return
        }
        sendDisconnectCommand()
        doConnect(discoveredIP, pin)
    }

    /** 取消正在进行的连接 */
    private fun handleCancelClick() {
        connecting = false
        pinInput.isEnabled = true
        updateConnectionUI(false, null)
    }

    /** 手动断开：标记手动断开，暂停所有自动行为 */
    private fun handleDisconnectClick() {
        if (connecting) {
            connecting = false
            pinInput.isEnabled = true
        }
        prefCtrl.setManuallyDisconnected(true)
        sendDisconnectCommand()
    }

    private fun doConnect(ip: String, pin: String) {
        if (connecting) return
        val colors = ThemeManager.getColors(requireContext())
        pinInput.isEnabled = false
        connecting = true
        updateBtnState("connecting")
        statusText.text = if (ip.isNotEmpty()) "正在连接 $ip ..." else "正在搜索并连接..."
        statusText.setTextColor(Color.parseColor(colors.primaryLight))
        statusDot.setImageResource(R.drawable.dot_gray)

        lifecycleScope.launch {
            delay(3000)
            if (!DialService.isConnected && isAdded) {
                val colors2 = ThemeManager.getColors(requireContext())
                statusText.text = "连接中，请稍候...（若长时间连不上，可能是电脑防火墙拦截）"
                statusText.setTextColor(Color.parseColor(colors2.primary))
            }
        }

        val intent = Intent(requireActivity(), DialService::class.java).apply {
            action = "CONNECT"
            putExtra("ip", ip)
            putExtra("pin", pin)
        }
        requireActivity().startService(intent)

        prefCtrl.setPin(pin)
        requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE).edit()
            .putString("ip", ip).apply()
    }

    private fun sendDisconnectCommand() {
        try {
            connecting = false
            val intent = Intent(requireActivity(), DialService::class.java).apply {
                action = "DISCONNECT"
            }
            requireActivity().startService(intent)
            updateConnectionUI(false, null)
        } catch (_: Exception) {}
    }

    /** 更新状态条按钮的文本和颜色 */
    private fun updateBtnState(state: String) {
        if (!isAdded) return
        when (state) {
            "connected" -> {
                connectBtnText.text = "重连"
                connectBtnText.setTextColor(Color.parseColor("#2B6CC4"))
                connectBtnText.background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                    setStroke(1, Color.parseColor("#2B6CC4"))
                    cornerRadius = 12f * resources.displayMetrics.density
                    setColor(Color.TRANSPARENT)
                }
            }
            "reconnect" -> {
                connectBtnText.text = "重连"
                connectBtnText.setTextColor(Color.parseColor("#2B6CC4"))
                connectBtnText.background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                    setStroke(1, Color.parseColor("#2B6CC4"))
                    cornerRadius = 8f * resources.displayMetrics.density
                    setColor(Color.TRANSPARENT)
                }
            }
            "disconnected", "manual_disconnect" -> {
                connectBtnText.text = "连接"
                connectBtnText.setTextColor(Color.parseColor("#FFFFFF"))
                connectBtnText.background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                    setColor(Color.parseColor("#1677FF"))
                    cornerRadius = 8f * resources.displayMetrics.density
                }
            }
            "connecting" -> {
                connectBtnText.text = "取消"
                connectBtnText.setTextColor(Color.parseColor("#666666"))
                connectBtnText.background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                    setStroke(1, Color.parseColor("#D9D9D9"))
                    cornerRadius = 6f * resources.displayMetrics.density
                    setColor(Color.TRANSPARENT)
                }
            }
        }
    }

    private fun updateAutoConnectUI(enabled: Boolean) {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        renderSwitch(autoConnectSwitch, enabled, colors)
    }

    private fun updateAutoCopyUI(enabled: Boolean) {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        renderSwitch(autoCopySwitch, enabled, colors)
    }

    private fun updateCopyToastUI(enabled: Boolean) {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        renderSwitch(copyToastSwitch, enabled, colors)
    }

    private fun renderSwitch(view: TextView, enabled: Boolean, colors: ThemeColors) {
        val dp = resources.displayMetrics.density
        view.text = if (enabled) "●" else "●"
        view.gravity = if (enabled) android.view.Gravity.END or android.view.Gravity.CENTER_VERTICAL
                       else android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL
        view.setPadding((3 * dp).toInt(), 0, (3 * dp).toInt(), 0)
        view.setTextColor(Color.WHITE)
        view.background = android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.RECTANGLE
            setColor(Color.parseColor(if (enabled) colors.primary else colors.bg3))
            cornerRadius = 99 * dp
            if (!enabled) setStroke((1 * dp).toInt(), Color.parseColor(colors.text2))
        }
    }

    /** 弹窗列表选择动画效果 — 使用 AnimationSheet BottomSheet */
    private fun showAnimationListDialog() {
        if (!isAdded) return
        AnimationSheet.show(requireActivity())
    }

    private fun updateDialAnimationUI(mode: Int) {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        val label = DialAnimationOverlay.MODE_LABELS[mode] ?: "未知"
        dialAnimationSwitch.text = if (mode == DialAnimationOverlay.MODE_OFF) "关闭" else "选择 ›"
        if (mode == DialAnimationOverlay.MODE_OFF) {
            dialAnimationSwitch.setBackgroundColor(Color.parseColor(colors.bg3))
            dialAnimationSwitch.setTextColor(Color.parseColor("#888888"))
        } else {
            dialAnimationSwitch.setBackgroundColor(Color.parseColor(colors.primary))
            dialAnimationSwitch.setTextColor(Color.parseColor(colors.bg))
        }
        dialAnimationDesc.text = when (mode) {
            DialAnimationOverlay.MODE_OFF -> "拨通电话时显示动画"
            DialAnimationOverlay.MODE_BOUNCE -> "弹跳飞入 - 文字飞入+跳动"
            DialAnimationOverlay.MODE_FIREWORK -> "烟花绽放 - 文字弹出+粒子"
            DialAnimationOverlay.MODE_COMBINE -> "弹跳飞入 + 烟花绽放"
            DialAnimationOverlay.MODE_PULSE -> "脉冲扩散 - 同心圆波纹"
            DialAnimationOverlay.MODE_SPARKLE -> "闪烁星光 - 光晕+星点"
            DialAnimationOverlay.MODE_SLIDE_UP -> "向上滑入 - 底部升起"
            DialAnimationOverlay.MODE_FADE_SCALE -> "缩放淡入 - 由小变大"
            DialAnimationOverlay.MODE_SHAKE -> "左右抖动 - 趣味抖动"
            DialAnimationOverlay.MODE_FLIP_IN -> "翻转进入 - 水平翻转"
            DialAnimationOverlay.MODE_HEARTBEAT -> "心跳脉冲 - 缩放心跳"
            else -> "拨通电话时显示动画"
        }
    }

    /** 每次启动时如未设置电池优化，弹窗引导直到设置好为止 */
    private fun checkBatteryOptFirstTime() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (!isAdded) return
        val pm = requireActivity().getSystemService(Context.POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(requireActivity().packageName)) return
        AlertDialog.Builder(requireActivity())
            .setTitle("电池优化建议")
            .setMessage("建议将电池优化设为「无限制」，避免后台连接被系统中断。\n\n是否现在设置？")
            .setPositiveButton("去设置") { _, _ -> requestIgnoreBatteryOptimization() }
            .setNegativeButton("稍后", null)
            .show()
    }

    private fun updateBatteryOptUI() {
        if (!isAdded) return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val pm = requireActivity().getSystemService(Context.POWER_SERVICE) as PowerManager
                val ignored = pm.isIgnoringBatteryOptimizations(requireActivity().packageName)
                if (ignored) {
                    batteryOptStatus.text = "无限制，后台连接更稳定"
                    batteryOptBtn.visibility = View.GONE
                    batteryOptOk.visibility = View.VISIBLE
                } else {
                    batteryOptStatus.text = "受限，可能导致后台断连"
                    batteryOptBtn.visibility = View.VISIBLE
                    batteryOptOk.visibility = View.GONE
                }
            } else {
                batteryOptStatus.text = "当前系统版本无需设置"
                batteryOptBtn.visibility = View.GONE
                batteryOptOk.visibility = View.VISIBLE
            }
        } catch (_: Exception) {}
    }

    private fun requestIgnoreBatteryOptimization() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val pm = requireActivity().getSystemService(Context.POWER_SERVICE) as PowerManager
                if (!pm.isIgnoringBatteryOptimizations(requireActivity().packageName)) {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:${requireActivity().packageName}")
                    }
                    startActivity(intent)
                } else {
                    Toast.makeText(requireActivity(), "已设置为无限制", Toast.LENGTH_SHORT).show()
                }
            }
        } catch (e: Exception) {
            // 部分机型不支持直接跳转，退到应用设置页
            try {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:${requireActivity().packageName}")
                }
                startActivity(intent)
                Toast.makeText(requireActivity(), "请在「电量」中选择「无限制」", Toast.LENGTH_LONG).show()
            } catch (_: Exception) {}
        }
    }

    private fun updateConnectionUI(connected: Boolean, reason: String?) {
        try {
            if (!isAdded) return
            val colors = ThemeManager.getColors(requireContext())
            pinInput.isEnabled = !connecting

            if (connected) {
                connecting = false
                val lanOk = DialService.isLanConnected
                val cloudOk = DialService.isCloudConnected
                val pcOk = DialService.isPcReachable
                val extOk = DialService.isExtOnline

                if (lanOk || pcOk) {
                    statusDot.setImageResource(R.drawable.dot_green)
                    startPulseAnimation()
                    statusText.text = "PC就绪"
                    statusText.setTextColor(Color.parseColor(colors.green))
                    connectionMode.text = "🖥 已连接"
                } else if (extOk) {
                    statusDot.setImageResource(R.drawable.dot_green)
                    startPulseAnimation()
                    statusText.text = "已就绪"
                    statusText.setTextColor(Color.parseColor(colors.green))
                    connectionMode.text = "🌐 浏览器在线"
                } else {
                    statusDot.setImageResource(R.drawable.dot_orange)
                    stopPulseAnimation()
                    statusText.text = "云端已连接，等待拨号"
                    statusText.setTextColor(Color.parseColor("#FF9800"))
                    connectionMode.text = "请在电脑上点击拨打"
                }
                connectionMode.visibility = View.VISIBLE
                discoveryHint.text = "你的系统手机号 · 与电脑端保持一致"
                discoveryHint.visibility = View.VISIBLE
                foundPCInfo.visibility = View.GONE
                updateBtnState("connected")
                connectBtnText.visibility = View.VISIBLE
                disconnectBtn.visibility = View.VISIBLE
            } else {
                statusDot.setImageResource(R.drawable.dot_gray)
                stopPulseAnimation()
                val manual = prefCtrl.isManuallyDisconnected()
                statusText.text = if (manual) "已手动断开" else "未连接电脑"
                statusText.setTextColor(Color.parseColor(if (manual) "#FF4D4F" else colors.text2))
                connectionMode.visibility = View.GONE
                foundPCInfo.visibility = View.GONE
                discoveryHint.text = "你的系统手机号 · 与电脑端保持一致"
                discoveryHint.visibility = View.VISIBLE
                updateBtnState(if (reason == "disconnected" && !manual) "reconnect" else if (manual) "manual_disconnect" else "disconnected")
                connectBtnText.visibility = View.VISIBLE
                disconnectBtn.visibility = View.VISIBLE

                when (reason) {
                    "pin_wrong" -> {
                        statusText.text = "配对码错误"
                        statusText.setTextColor(Color.parseColor(colors.red))
                        NotifyHelper.connToast(requireActivity(), "配对码不正确，请重新输入！", Toast.LENGTH_LONG)
                        discoveryHint.text = "⚠️ 配对码错误，请重新输入"
                        discoveryHint.visibility = View.VISIBLE
                    }
                    "kicked" -> {
                        statusText.text = "已被踢下线"
                        statusText.setTextColor(Color.parseColor(colors.red))
                        Toast.makeText(requireActivity(), "有其他手机连接了该电脑", Toast.LENGTH_LONG).show()
                    }
                    "connection_failed" -> {
                        statusText.text = "连接失败"
                        statusText.setTextColor(Color.parseColor(colors.red))
                        NotifyHelper.connToast(requireActivity(), "无法连接到电脑，请检查：\n1. 电脑端是否已打开\n2. 手机和电脑是否在同一WiFi\n3. 电脑防火墙是否放行了端口", Toast.LENGTH_LONG)
                        discoveryHint.text = "⚠️ 连接失败，请检查电脑端是否已打开且在同一网络"
                        discoveryHint.visibility = View.VISIBLE
                    }
                    "disconnected" -> {
                        statusText.text = "连接已断开"
                        statusText.setTextColor(Color.parseColor(colors.primary))
                    }
                    else -> {
                        statusText.text = "未连接电脑"
                        statusText.setTextColor(Color.parseColor(colors.text2))
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // ==================== 脉冲动画 ====================

    private fun startPulseAnimation() {
        if (pulseAnimator?.isRunning == true) return
        pulseAnimator = ValueAnimator.ofFloat(1f, 2.5f).apply {
            duration = 2000
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.RESTART
            interpolator = DecelerateInterpolator()
            addUpdateListener {
                val scale = it.animatedValue as Float
                val alpha = (1f - (scale - 1f) / 1.5f).coerceIn(0f, 1f)
                pulseRing.scaleX = scale
                pulseRing.scaleY = scale
                pulseRing.alpha = alpha
            }
            start()
        }
    }

    private fun stopPulseAnimation() {
        pulseAnimator?.cancel()
        pulseAnimator = null
        pulseRing.animate().scaleX(1f).scaleY(1f).alpha(0f).setDuration(150).start()
    }

    // ==================== v7: 连接策略 & 通道状态 ====================

    private fun updateStrategyDesc() {
        if (!isAdded) return
        connectionStrategyDesc.text = prefCtrl.getConnectionStrategy().label
    }

    private fun showStrategyDialog() {
        if (!isAdded) return
        val strategies = ConnectionStrategy.entries
        val labels = strategies.map { it.label }.toTypedArray()
        val current = prefCtrl.getConnectionStrategy()
        val currentIndex = strategies.indexOf(current)

        AlertDialog.Builder(requireActivity())
            .setTitle("连接策略")
            .setSingleChoiceItems(labels, currentIndex) { dialog, which ->
                val selected = strategies[which]
                prefCtrl.setConnectionStrategy(selected)
                updateStrategyDesc()
                dialog.dismiss()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ==================== 云服务器管理 ====================

    private fun updateCloudServerCurrentText() {
        if (!isAdded) return
        val input = pinInput.text?.toString() ?: ""
        val list = cloudCtrl.getServersSortedBy(input)
        if (list.isEmpty()) {
            cloudServerCurrentText.text = "未配置"
        } else {
            val first = list.first()
            cloudServerCurrentText.text = "已保存 ${list.size} 台 · ${cloudCtrl.stripCloudPrefix(first.url)}"
        }
    }

    /** 服务器标签: A/B/C/D/E/... */
    private fun serverLabel(i: Int) = ('A' + i).toString()

    /** 排序：上次连接的服务器排到第一 */
    private fun sortServers(servers: MutableList<String>) {
        val lastServer = requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE)
            .getString("cloud_server", "") ?: ""
        if (lastServer.isNotEmpty()) {
            val idx = servers.indexOf(lastServer)
            if (idx > 0) {
                servers.removeAt(idx)
                servers.add(0, lastServer)
                cloudCtrl.saveServerUrls(servers)
            }
        }
    }

    /** 渲染服务器内联列表，每行带连通状态、手动连接和操作按钮 */
    private fun refreshCloudServerList() {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        cloudServerListContainer.removeAllViews()
        val servers = cloudCtrl.getServerUrls()
        sortServers(servers)
        val connectedServer = requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE)
            .getString("cloud_server", "") ?: ""
        val isCloudOk = DialService.isCloudConnected

        if (servers.isEmpty()) {
            cloudServerListContainer.addView(TextView(requireContext()).apply {
                text = "未配置服务器，点击「+ 添加」"
                textSize = 14f; setTextColor(Color.parseColor(colors.text2))
                setPadding(0, 10, 0, 10)
            })
            return
        }

        servers.forEachIndexed { i, server ->
            val isCurrent = server == connectedServer && isCloudOk
            val isConfigured = server == connectedServer
            val row = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                setPadding(0, 8, 0, 8)
            }

            // 连接状态指示灯
            row.addView(TextView(requireContext()).apply {
                text = "●"
                textSize = 9f; setPadding(0, 0, 8, 0)
                setTextColor(Color.parseColor(if (isCurrent) colors.green else colors.text2))
            })

            // 地址（可长按复制）
            val disp = cloudCtrl.stripCloudPrefix(server)
            val addrView = TextView(requireContext()).apply {
                text = disp; textSize = 12f; isSingleLine = true
                setTextColor(Color.parseColor(if (isCurrent) colors.primary else colors.text))
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                setOnLongClickListener {
                    val clip = requireActivity().getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    clip.setPrimaryClip(android.content.ClipData.newPlainText("server", server))
                    Toast.makeText(requireActivity(), "已复制: $server", Toast.LENGTH_SHORT).show()
                    true
                }
            }
            row.addView(addrView)

            // 当前服务器标签
            if (isConfigured) {
                row.addView(TextView(requireContext()).apply {
                    text = "当前"; textSize = 10f
                    setTextColor(Color.parseColor(if (isCurrent) colors.green else colors.red))
                    setPadding(4, 1, 4, 1)
                })
            }

            // 手动连接按钮
            row.addView(TextView(requireContext()).apply {
                text = "连接"; textSize = 10f; setPadding(9, 5, 9, 5)
                setTextColor(Color.parseColor(colors.bg))
                setBackgroundColor(Color.parseColor(colors.primary))
                setOnClickListener {
                    if (!DialService.isConnected || !DialService.isLanConnected) {
                        // 当前没有局域网连接，尝试连接此云服务器
                        val pin = requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE)
                            .getString("pin", "") ?: ""
                        if (pin.isEmpty()) {
                            Toast.makeText(requireActivity(), "请先在连接页输入配对码", Toast.LENGTH_SHORT).show()
                            return@setOnClickListener
                        }
                        requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE).edit()
                            .putString("cloud_server", server)
                            .putString("connection_strategy", "auto")
                            .apply()
                        val intent = DialService.newIntent(requireContext()).apply {
                            action = "CONNECT"; putExtra("ip", server); putExtra("pin", pin)
                        }
                        requireActivity().startService(intent)
                        Toast.makeText(requireActivity(), "正在连接 $server ...", Toast.LENGTH_SHORT).show()
                    } else {
                        // 已有 LAN 连接，只作为云中继备用
                        requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE).edit()
                            .putString("cloud_server", server)
                            .apply()
                        Toast.makeText(requireActivity(), "$server 已设为云中继", Toast.LENGTH_SHORT).show()
                    }
                }
            })
            row.addView(TextView(requireContext()).apply { text = " "; textSize = 6f })

            // 测试按钮
            row.addView(TextView(requireContext()).apply {
                text = "测速"; textSize = 10f; setPadding(8, 5, 8, 5)
                tag = "primaryBtnText"
                ThemeManager.applyToView(this, colors)
                setOnClickListener { testSingleServer(server, this) }
            })
            row.addView(TextView(requireContext()).apply { text = " "; textSize = 4f })

            // 上移
            if (i > 0) row.addView(TextView(requireContext()).apply {
                text = "\u2191"; textSize = 15f; setPadding(4, 0, 4, 0)
                setTextColor(Color.parseColor(colors.text2))
                setOnClickListener {
                    servers.removeAt(i); servers.add(i - 1, server)
                    cloudCtrl.saveServerUrls(servers)
                    refreshCloudServerList(); updateCloudServerCurrentText()
                }
            })

            // 删除
            row.addView(TextView(requireContext()).apply {
                text = "删除"; textSize = 10f; setPadding(8, 5, 2, 5)
                setTextColor(Color.parseColor(colors.red))
                setOnClickListener {
                    servers.removeAt(i)
                    cloudCtrl.saveServerUrls(servers)
                    refreshCloudServerList(); updateCloudServerCurrentText()
                }
            })
            cloudServerListContainer.addView(row)
        }
    }

    /** 添加服务器：提示 ws://1.2.3.4:35430 */
    private fun addCloudServer() {
        if (!isAdded) return
        val input = EditText(requireActivity()).apply {
            hint = "如: ws://1.2.3.4:35430"; textSize = 15f
            setTextColor(Color.parseColor("#E8DCC8")); isSingleLine = true
            setPadding(48, 24, 48, 24)
        }
        AlertDialog.Builder(requireActivity())
            .setTitle("添加云服务器")
            .setMessage("支持 ws:// 或 wss:// 开头\n不写协议默认为 ws://")
            .setView(input)
            .setPositiveButton("添加") { _, _ ->
                val raw = input.text.toString().trim()
                if (raw.isEmpty()) return@setPositiveButton
                val addr = cloudCtrl.normalizeServer(raw)
                val list = cloudCtrl.getServerUrls()
                val normSet = list.map { cloudCtrl.stripCloudPrefix(it) }.toSet()
                if (normSet.contains(cloudCtrl.stripCloudPrefix(addr))) {
                    Toast.makeText(requireActivity(), "该地址已存在", Toast.LENGTH_SHORT).show()
                } else {
                    list.add(addr); cloudCtrl.saveServerUrls(list)
                    refreshCloudServerList(); updateCloudServerCurrentText()
                }
            }
            .setNegativeButton("取消", null).show()
    }

    /** 测试全部服务器，在内联列表中更新状态 */
    private fun testAllServers() {
        if (!isAdded) return
        val servers = cloudCtrl.getServerUrls()
        if (servers.isEmpty()) {
            Toast.makeText(requireActivity(), "暂无服务器", Toast.LENGTH_SHORT).show()
            return
        }
        Toast.makeText(requireActivity(), "正在测试 ${servers.size} 台...", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            val results = cloudCtrl.testAllServerUrls(servers)
            if (!isAdded) return@launch
            refreshCloudServerListWithResults(results)
        }
    }

    /** 单台测试 */
    private fun testSingleServer(server: String, indicator: TextView) {
        indicator.text = "\u23F3"
        lifecycleScope.launch {
            val ok = cloudCtrl.testServer(server)
            if (!isAdded) return@launch
            indicator.text = if (ok) "\u2705" else "\u274C"
            indicator.setTextColor(Color.parseColor(if (ok) "#2ECC71" else "#E74C3C"))
        }
    }

    /** 带测试结果刷新列表 */
    private fun refreshCloudServerListWithResults(results: Map<String, Boolean>) {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        cloudServerListContainer.removeAllViews()
        val input = pinInput.text?.toString() ?: ""
        val servers = cloudCtrl.getServersSortedBy(input).toMutableList()
        val connectedServer = requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE)
            .getString("cloud_server", "") ?: ""
        val isCloudOk = DialService.isCloudConnected

        servers.forEachIndexed { i, entry ->
            val server = entry.url
            val isCurrent = server == connectedServer && isCloudOk
            val testOk = results[server]
            val row = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL
                setPadding(0, 7, 0, 7)
            }

            row.addView(TextView(requireContext()).apply {
                text = if (isCurrent) "\u25CF" else "\u25CB"; textSize = 10f; setPadding(0, 0, 6, 0)
                setTextColor(Color.parseColor(if (isCurrent) colors.green else colors.text2))
            })

            row.addView(TextView(requireContext()).apply {
                text = "●"
                textSize = 9f; setPadding(0, 0, 8, 0)
                setTextColor(Color.parseColor(when (testOk) {
                    true -> colors.green
                    false -> colors.red
                    null -> colors.text2
                }))
            })

            row.addView(TextView(requireContext()).apply {
                text = cloudCtrl.stripCloudPrefix(server); textSize = 12f; isSingleLine = true
                setTextColor(Color.parseColor(when {
                    testOk == true -> colors.green
                    testOk == false -> colors.red
                    else -> colors.text
                }))
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            })

            // 当前服务器标签
            val isConfigured = server == connectedServer
            if (isConfigured) {
                row.addView(TextView(requireContext()).apply {
                    text = "当前"; textSize = 10f
                    setTextColor(Color.parseColor(if (isCloudOk) colors.green else colors.red))
                    setPadding(4, 1, 4, 1)
                })
            }

            // 删除
            row.addView(TextView(requireContext()).apply {
                text = "\u2715"; textSize = 12f; setPadding(4, 0, 2, 0)
                setTextColor(Color.parseColor(colors.text2))
                setOnClickListener {
                    servers.removeAt(i)
                    cloudCtrl.setServerList(servers)
                    refreshCloudServerList(); updateCloudServerCurrentText()
                }
            })
            cloudServerListContainer.addView(row)
        }
    }

    /** 打开app自动测试服务器，仅在服务器列表有变化时执行 */
    private var lastTestedServerCount = 0

    private fun autoTestServersOnStart() {
        val servers = cloudCtrl.getServerUrls()
        if (servers.isEmpty()) return
        if (servers.size == lastTestedServerCount) return
        lastTestedServerCount = servers.size
        lifecycleScope.launch {
            if (!isAdded) return@launch
            val results = cloudCtrl.testAllServerUrls(servers)
            if (!isAdded) return@launch
            refreshCloudServerListWithResults(results)
        }
    }

    /** 从PC/Gist同步服务器列表 */
    private fun syncFromPC() {
        if (!isAdded) return
        Toast.makeText(requireActivity(), "正在同步...", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            val list = cloudCtrl.fetchServerListFromGist()
            if (!isAdded) return@launch
            if (list != null && list.isNotEmpty()) {
                cloudCtrl.setServerList(list)
                updateCloudServerCurrentText()
                refreshCloudServerList()
                lastTestedServerCount = 0
                autoTestServersOnStart()
                Toast.makeText(requireActivity(), "已同步 ${list.size} 台服务器", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(requireActivity(), "同步失败或PC端未配置", Toast.LENGTH_SHORT).show()
            }
        }
    }

    /** 网络获取：从 GitHub/Gitee 拉取云服务器列表 */
    private fun fetchServersFromNetwork() {
        if (!isAdded) return
        Toast.makeText(requireActivity(), "正在从网络获取...", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            val list = cloudCtrl.fetchServerListFromGist()
            if (!isAdded) return@launch
            if (list != null && list.isNotEmpty()) {
                cloudCtrl.setServerList(list)
                updateCloudServerCurrentText()
                refreshCloudServerList()
                lastTestedServerCount = 0
                autoTestServersOnStart()
                Toast.makeText(requireActivity(), "已获取 ${list.size} 台服务器", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(requireActivity(), "获取失败，请检查网络", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // ==================== 主题 ====================

    fun onThemeChanged() {
        themeListener()
    }

    /** v4: 卡片透明度调节行 (0→25→50→75→100) */
    private fun addCardOpacityRow(root: View) {
        val parent = root.findViewById<ViewGroup>(R.id.themeSectionAnchor) ?: return
        val colors = ThemeManager.getColors(requireContext())
        val values = intArrayOf(0, 25, 50, 75, 100)

        val row = android.widget.LinearLayout(requireContext()).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(0, 20, 0, 0)
        }

        val label = TextView(requireContext()).apply {
            text = "卡片透明度"
            textSize = 14f; setTextColor(Color.parseColor(colors.text))
            layoutParams = android.widget.LinearLayout.LayoutParams(0,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        row.addView(label)

        fun refreshButtons() {
            val opacity = prefCtrl.getCardOpacity()
            for (i in 1 until row.childCount) {
                val btn = row.getChildAt(i) as? TextView ?: continue
                val sel = values[i - 1] == opacity
                btn.setTextColor(Color.parseColor(if (sel) colors.bg else colors.primary))
                btn.setBackgroundColor(Color.parseColor(if (sel) colors.primary else colors.bg3))
            }
        }

        for (v in values) {
            val btn = TextView(requireContext()).apply {
                text = if (v == 0) "关" else "$v%"
                textSize = 11f; setPadding(10, 5, 10, 5)
                (layoutParams as? android.widget.LinearLayout.LayoutParams)?.marginStart = 6
                setOnClickListener {
                    prefCtrl.setCardOpacity(v)
                    ThemeManager.notifyRefresh()
                    refreshButtons()
                }
            }
            row.addView(btn)
        }
        refreshButtons()
        parent.addView(row)
    }

    /** 卡片边框开关：开启=显示卡片边框，关闭=隐藏所有卡片边框 */
    private fun addCardBorderRow(root: View) {
        val parent = root.findViewById<ViewGroup>(R.id.themeSectionAnchor) ?: return
        val colors = ThemeManager.getColors(requireContext())

        val row = android.widget.LinearLayout(requireContext()).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(0, 16, 0, 0)
        }

        val label = TextView(requireContext()).apply {
            text = "卡片边框"
            textSize = 14f; setTextColor(Color.parseColor(colors.text))
            layoutParams = android.widget.LinearLayout.LayoutParams(0,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        row.addView(label)

        val toggle = TextView(requireContext()).apply {
            layoutParams = android.widget.LinearLayout.LayoutParams(
                (42 * resources.displayMetrics.density).toInt(),
                (24 * resources.displayMetrics.density).toInt()
            )
            renderSwitch(this, prefCtrl.getCardBorder(), colors)
            setOnClickListener {
                val newVal = !prefCtrl.getCardBorder()
                prefCtrl.setCardBorder(newVal)
                renderSwitch(this, newVal, colors)
                ThemeManager.notifyRefresh()
            }
        }
        row.addView(toggle)
        parent.addView(row)
    }

    /** 底部导航顺序：保留页面索引，仅调整 Tab 的展示顺序。 */
    private fun addNavigationOrderRow(root: View) {
        val parent = root.findViewById<ViewGroup>(R.id.themeSectionAnchor) ?: return
        val colors = ThemeManager.getColors(requireContext())
        val row = android.widget.LinearLayout(requireContext()).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(0, 16, 0, 0)
        }
        row.addView(TextView(requireContext()).apply {
            text = "底部导航顺序"
            textSize = 14f
            setTextColor(Color.parseColor(colors.text))
            layoutParams = android.widget.LinearLayout.LayoutParams(
                0, android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, 1f
            )
        })

        val options = listOf("call_first" to "通话优先", "settings_first" to "设置优先")
        fun refresh() {
            val current = prefCtrl.getNavigationOrder()
            for (i in options.indices) {
                val button = row.getChildAt(i + 1) as? TextView ?: continue
                val active = options[i].first == current
                button.setTextColor(Color.parseColor(if (active) colors.bg else colors.primary))
                button.background = android.graphics.drawable.GradientDrawable().apply {
                    setColor(Color.parseColor(if (active) colors.primary else colors.bg3))
                    cornerRadius = 10 * resources.displayMetrics.density
                }
            }
        }
        options.forEach { (key, label) ->
            row.addView(TextView(requireContext()).apply {
                text = label
                textSize = 11f
                gravity = android.view.Gravity.CENTER
                setPadding(12, 7, 12, 7)
                setOnClickListener {
                    prefCtrl.setNavigationOrder(key)
                    refresh()
                    (activity as? MainActivity)?.applyNavigationOrder()
                }
            })
        }
        refresh()
        parent.addView(row)
    }

    /** 弹窗通知分组 */
    private fun addNotifySection(root: View) {
        val parent = root.findViewById<ViewGroup>(R.id.themeSectionAnchor) ?: return
        val colors = ThemeManager.getColors(requireContext())

        // 分组标题
        val header = TextView(requireContext()).apply {
            text = "通知弹窗"
            textSize = 13f; setTextColor(Color.parseColor(colors.primaryLight))
            setPadding(0, 24, 0, 8)
            setTypeface(null, android.graphics.Typeface.BOLD)
        }
        parent.addView(header)

        // 连接状态通知
        addNotifyToggle(parent, colors, "连接状态通知",
            { prefCtrl.getNotifyConnState() },
            { prefCtrl.setNotifyConnState(it) })

        // 登记结果通知
        addNotifyToggle(parent, colors, "登记结果通知",
            { prefCtrl.getNotifyRegister() },
            { prefCtrl.setNotifyRegister(it) })

        // 上次通话提示时长
        val opts = intArrayOf(5, 10, 30, 0)
        val labels = arrayOf("5秒", "10秒", "30秒", "一直")
        val cur = prefCtrl.getLastCallHintDuration()

        val row = android.widget.LinearLayout(requireContext()).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(0, 12, 0, 0)
        }
        val label = TextView(requireContext()).apply {
            text = "上次通话提示"
            textSize = 14f; setTextColor(Color.parseColor(colors.text))
            layoutParams = android.widget.LinearLayout.LayoutParams(0,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        row.addView(label)

        fun refresh() {
            val sel = prefCtrl.getLastCallHintDuration()
            for (i in 0 until opts.size) {
                val b = row.getChildAt(i + 1) as? TextView ?: continue
                val active = opts[i] == sel
                b.setTextColor(Color.parseColor(if (active) colors.bg else colors.primary))
                b.setBackgroundColor(Color.parseColor(if (active) colors.primary else colors.bg3))
            }
        }
        for (i in opts.indices) {
            val btn = TextView(requireContext()).apply {
                text = labels[i]; textSize = 11f; setPadding(10, 5, 10, 5)
                (layoutParams as? android.widget.LinearLayout.LayoutParams)?.marginStart = 6
                setOnClickListener { prefCtrl.setLastCallHintDuration(opts[i]); refresh() }
            }
            row.addView(btn)
        }
        refresh()
        parent.addView(row)
    }

    private fun addNotifyToggle(parent: ViewGroup, colors: ThemeColors, title: String,
                                 get: () -> Boolean, set: (Boolean) -> Unit) {
        val row = android.widget.LinearLayout(requireContext()).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setPadding(0, 10, 0, 0)
        }
        val label = TextView(requireContext()).apply {
            text = title; textSize = 14f; setTextColor(Color.parseColor(colors.text))
            layoutParams = android.widget.LinearLayout.LayoutParams(0,
                android.widget.LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        row.addView(label)
        val toggle = TextView(requireContext()).apply {
            layoutParams = android.widget.LinearLayout.LayoutParams(
                (42 * resources.displayMetrics.density).toInt(),
                (24 * resources.displayMetrics.density).toInt()
            )
            renderSwitch(this, get(), colors)
            setOnClickListener {
                val v = !get(); set(v)
                renderSwitch(this, v, colors)
            }
        }
        row.addView(toggle)
        parent.addView(row)
    }

    private fun applyTheme() {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        ThemeManager.applyToView(requireView(), colors)
        pinInput.setTextColor(Color.parseColor(colors.text))
    }

    private fun updateThemePreview() {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        val theme = ThemeManager.getThemeById(ThemeManager.loadThemeId(requireContext()))
        previewGold.setBackgroundColor(Color.parseColor(colors.primary))
        previewBg.setBackgroundColor(Color.parseColor(colors.bg))
        previewBg2.setBackgroundColor(Color.parseColor(colors.bg2))
        previewText.setBackgroundColor(Color.parseColor(colors.text))
    }

    private fun showThemeDialog() {
        if (!isAdded) return
        ThemeDialog.show(requireActivity()) {
            if (isAdded) {
                updateConnectionUI(DialService.isConnected, null)
                updateAutoConnectUI(prefCtrl.isAutoConnectEnabled())
            }
        }
    }

    private fun updateExportLogInfo() {
        if (!isAdded) return
        val logFiles = FileLogger.getLogFiles()
        val logDir = FileLogger.getLogDirPath()
        if (logFiles.isEmpty()) {
            exportLogInfo.text = "暂无日志文件"
        } else {
            val totalSize = logFiles.sumOf { it.length() } / 1024
            exportLogInfo.text = "${logFiles.size} 个日志文件 · ${totalSize}KB"
        }
    }

    private fun exportLogs() {
        if (!isAdded) return
        val logFiles = FileLogger.getLogFiles()
        if (logFiles.isEmpty()) {
            Toast.makeText(requireActivity(), "暂无日志文件", Toast.LENGTH_SHORT).show()
            return
        }

        // 方式1: 优先使用 SAF 让用户选择保存位置
        try {
            val dateStr = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "text/plain"
                putExtra(Intent.EXTRA_TITLE, "autodial-log-$dateStr.txt")
            }
            startActivityForResult(intent, REQUEST_CODE_EXPORT_LOG)
        } catch (e: Exception) {
            // SAF 不可用时，回退到分享方式
            exportLogViaShare()
        }
    }

    private fun exportLogViaShare() {
        if (!isAdded) return
        try {
            val content = FileLogger.getAllLogsContent()
            val dateStr = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
            val file = File(requireActivity().cacheDir, "autodial-log-$dateStr.txt")
            file.writeText(content)

            val uri = androidx.core.content.FileProvider.getUriForFile(
                requireActivity(),
                "${requireActivity().packageName}.fileprovider",
                file
            )
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(shareIntent, "分享日志文件"))
        } catch (e: Exception) {
            // 最终回退：复制到剪贴板
            try {
                val content = FileLogger.getAllLogsContent()
                val clipboard = requireActivity().getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText("autodial_log", content))
                Toast.makeText(requireActivity(), "日志已复制到剪贴板（文件导出失败）", Toast.LENGTH_LONG).show()
            } catch (_: Exception) {
                Toast.makeText(requireActivity(), "导出日志失败: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_CODE_EXPORT_LOG && resultCode == android.app.Activity.RESULT_OK) {
            val uri = data?.data ?: return
            try {
                val content = FileLogger.getAllLogsContent()
                requireActivity().contentResolver.openOutputStream(uri)?.use { os ->
                    os.write(content.toByteArray())
                }
                Toast.makeText(requireActivity(), "✅ 日志导出成功", Toast.LENGTH_SHORT).show()
                FileLogger.i("ConnectFragment", "日志导出到: $uri")
            } catch (e: Exception) {
                Toast.makeText(requireActivity(), "导出失败: ${e.message}", Toast.LENGTH_LONG).show()
                FileLogger.e("ConnectFragment", "日志导出失败: ${e.message}")
            }
        }
    }

    /** 页面结构重组：电池移入拨号 */
    private fun rearrangeSections(root: View) {
        try {
            val batteryRow = root.findViewById<View>(R.id.batteryOptRow)
            val otherContent = root.findViewById<LinearLayout>(R.id.otherSectionContent)
            if (batteryRow != null && otherContent != null) {
                (batteryRow.parent as? ViewGroup)?.removeView(batteryRow)
                val insertIdx = otherContent.indexOfChild(root.findViewById(R.id.dialModeRow))
                otherContent.addView(batteryRow, if (insertIdx >= 0) insertIdx + 1 else 0)
            }
        } catch (_: Exception) {}
    }

    /** v7: 拨号模式选择对话框 */
    private fun showDialModeDialog() {
        if (!isAdded) return
        val currentKey = prefCtrl.getDialModeKey()
        val modes = DialMode.entries
        val labels = modes.map { "${it.label}  —  ${it.desc}" }.toTypedArray()
        val currentIndex = modes.indexOfFirst { it.key == currentKey }

        AlertDialog.Builder(requireActivity())
            .setTitle("拨号模式")
            .setSingleChoiceItems(labels, currentIndex) { dialog, which ->
                val selected = modes[which]
                prefCtrl.setDialModeKey(selected.key)
                dialModeCurrent.text = selected.label
                // 同步到CallLogFragment顶栏
                try {
                    (requireActivity() as? MainActivity)?.syncDialModeUI()
                } catch (_: Exception) {}
                dialog.dismiss()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ==================== 每日励志语 ====================

    private val motivationalQuotes = arrayOf(
        "☎ 今天的每一通电话，都是明天的每一个客户。",
        "💪 拒绝不可怕，可怕的是你不敢拨出下一通。",
        "🎯 销售不是说服别人，是帮别人发现问题。",
        "🚀 别人休息时你拨出的电话，就是你超车的弯道。",
        "⏰ 你的电话打得比别人多一秒，机会就比别人多一分。",
        "💰 客户说「贵」的时候，恰恰是你展示价值的最佳时机。",
        "🔥 电销是一场马拉松，坚持到最后的人才能看到终点的风景。",
        "📞 每一通电话都是一次面试——你在面试你的下一个客户。",
        "🎪 人生如戏，全靠演技。电销如战场，全靠毅力。",
        "🍀 幸运不过是努力的另一个名字。",
        "🎤 客户：「我不需要」 你：「让我告诉你为什么需要」",
        "⚡ 被挂电话不可怕，可怕的是你挂了客户的希望。",
        "☕ 如果你觉得电销累，那是因为你在走上坡路。",
        "🏆 销冠和普通销售的区别：一个用心听，一个用嘴说。",
        "🐸 每天先吃那只最丑的青蛙——最难打的电话先打！",
        "💡 客户不买不是因为不需要，是因为你还没让他觉得需要。",
        "🎢 电销就像过山车，有起有落，但别在中途下车。",
        "🌅 每一通电话都是一个新的开始，别让上一通影响你。"
    )

    private fun getDailyMotivationalQuote(): String {
        val dayOfYear = java.util.Calendar.getInstance().get(java.util.Calendar.DAY_OF_YEAR)
        val index = dayOfYear % motivationalQuotes.size
        return motivationalQuotes[index]
    }

    // ========== v3: JWT 代码已移除（2026-07-04），统一使用 PIN 认证 ==========

    /** 将 ws://host:port 转为 http://host:apiPort，保留非标准端口不做替换 */
    private fun wsToHttp(serverUrl: String, wsPort: String = "", apiPort: String = ""): String {
        var url = serverUrl
        // 如果有明确的对端端口号，做精确替换（如 :35440 → :35441）
        if (wsPort.isNotEmpty() && apiPort.isNotEmpty() && url.contains(":$wsPort")) {
            url = url.replace(":$wsPort", ":$apiPort")
        }
        // 协议转换
        when {
            url.startsWith("wss://") -> url = url.replace("wss://", "https://")
            url.startsWith("ws://") -> url = url.replace("ws://", "http://")
            !url.startsWith("http://") && !url.startsWith("https://") -> url = "http://$url"
        }
        return url.removeSuffix("/")
    }

    /** 更新通道状态（局域网/云中转） */
    private fun updateChannelStatus() {
        if (!isAdded) return
        try {
            val colors = ThemeManager.getColors(requireContext())
            val lanOk = DialService.isLanConnected
            val cloudOk = DialService.isCloudConnected
            val pcOk = DialService.isPcReachable
            lanChannelStatus.text = if (lanOk) "已连接" else if (pcOk) "通过PC" else "未连接"
            lanChannelStatus.setTextColor(Color.parseColor(if (lanOk || pcOk) colors.green else "#605040"))
            cloudChannelStatus.text = if (cloudOk) "已连接" else "未连接"
            cloudChannelStatus.setTextColor(Color.parseColor(if (cloudOk) colors.green else "#605040"))
        } catch (_: Exception) {}
    }
}
