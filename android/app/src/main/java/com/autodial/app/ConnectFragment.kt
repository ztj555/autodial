package com.autodial.app

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

class ConnectFragment : Fragment() {

    private lateinit var statusDot: ImageView
    private lateinit var statusText: TextView
    private lateinit var connectionMode: TextView
    private lateinit var connectionBanner: LinearLayout
    private lateinit var bannerText: TextView
    private lateinit var pinInput: EditText
    private lateinit var connectBtn: View
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
    private lateinit var themeCurrentName: TextView
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
    private lateinit var cloudStatusText: TextView
    private lateinit var connectionStrategyRow: View
    private lateinit var connectionStrategyDesc: TextView
    // 延迟显示（连接通道模块内联）
    private lateinit var lanLatencyInline: TextView
    private lateinit var cloudLatencyInline: TextView
    private lateinit var autoCopySwitch: TextView
    private lateinit var copyToastSwitch: TextView
    private lateinit var dialAnimationSwitch: TextView
    private lateinit var dialAnimationDesc: TextView
    private lateinit var dialAnimationTextPreview: TextView
    private lateinit var exportLogInfo: TextView
    // v7: 通道状态面板
    private lateinit var lanStatusText: TextView
    private lateinit var lanStatusDot: ImageView
    private lateinit var cloudStatusDot: ImageView
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

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            try {
                val connected = intent?.getBooleanExtra("connected", false) ?: return
                val reason = intent.getStringExtra("reason")
                updateConnectionUI(connected, reason)
            } catch (_: Exception) {}
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.fragment_connect, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        try {
            statusDot = view.findViewById(R.id.statusDot)
            statusText = view.findViewById(R.id.statusText)
            connectionBanner = view.findViewById(R.id.connectionBanner)
            bannerText = view.findViewById(R.id.bannerText)
            pinInput = view.findViewById(R.id.pinInput)
            connectBtn = view.findViewById(R.id.connectBtn)
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
            themeCurrentName = view.findViewById(R.id.themeCurrentName)
            previewGold = view.findViewById(R.id.previewGold)
            previewBg = view.findViewById(R.id.previewBg)
            previewBg2 = view.findViewById(R.id.previewBg2)
            previewText = view.findViewById(R.id.previewText)

            connectBtn.setOnClickListener { handleConnectClick() }
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

            // v7: 新UI元素绑定（必须在所有使用前完成）
            lanStatusText = view.findViewById(R.id.lanStatusText)
            lanStatusDot = view.findViewById(R.id.lanStatusDot)
            advancedHeader = view.findViewById(R.id.advancedSectionHeader)
            advancedContent = view.findViewById(R.id.advancedSectionContent)
            advancedArrow = view.findViewById(R.id.advancedArrow)
            otherHeader = view.findViewById(R.id.otherSectionHeader)
            otherContent = view.findViewById(R.id.otherSectionContent)
            otherArrow = view.findViewById(R.id.otherArrow)
            // v8: 内联延迟 + 使用说明折叠 + 励志语
            lanLatencyInline = view.findViewById(R.id.lanLatencyInline)
            cloudLatencyInline = view.findViewById(R.id.cloudLatencyInline)
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
                advancedArrow.text = if (show) "▾" else "▸"
            }
            otherHeader.setOnClickListener {
                val show = otherContent.visibility != View.VISIBLE
                otherContent.visibility = if (show) View.VISIBLE else View.GONE
                otherArrow.text = if (show) "▾" else "▸"
            }
            // v8: 使用说明折叠（默认折叠）
            usageGuideContent.visibility = View.GONE
            usageGuideArrow.text = "▸"
            usageGuideHeader.setOnClickListener {
                val show = usageGuideContent.visibility != View.VISIBLE
                usageGuideContent.visibility = if (show) View.VISIBLE else View.GONE
                usageGuideArrow.text = if (show) "▾" else "▸"
            }
            // v8: 每日励志语
            motivationalText.text = getDailyMotivationalQuote()

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

            // v7: 拨号模式预填
            dialModeCurrent.text = DialMode.fromKey(prefCtrl.getDialModeKey()).label
            dialModeRow.setOnClickListener { showDialModeDialog() }

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
                    ContextCompat.RECEIVER_NOT_EXPORTED  // D6修复: 应用内广播不应 EXPORTED
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
            guideView.text = "① 电脑端打开 跨屏拨号.exe，获取 4 位配对码\n" +
                "② 输入配对码，点击「连接」\n" +
                "③ 连接成功后在电脑上点号码即可拨号\n\n" +
                "💡 不在同一WiFi？高级设置→连接策略→自动\n" +
                "💡 切换SIM卡？设置→拨号模式\n" +
                "💡 连不上？检查电脑防火墙放行端口 35432"

            // v7: 云服务器内联列表（纯配置UI，无连接动作）
            cloudServerListContainer = view.findViewById(R.id.cloudServerListContainer)
            cloudServerAddBtn = view.findViewById(R.id.cloudServerAddBtn)
            cloudServerTestBtn = view.findViewById(R.id.cloudServerTestBtn)
            cloudServerSyncBtn = view.findViewById(R.id.cloudServerSyncBtn)
            cloudServerFetchBtn = view.findViewById(R.id.cloudServerFetchBtn)
            cloudServerCurrentText = view.findViewById(R.id.cloudServerCurrentText)
            cloudStatusText = view.findViewById(R.id.cloudStatusText)
            cloudStatusDot = view.findViewById(R.id.cloudStatusDot)

            updateCloudServerCurrentText()
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

            // 应用主题
            applyTheme()
            updateThemePreview()
            updateChannelSection()

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
                            discoveryHint.text = "🔍 请输入配对码开始搜索"
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
            } else if (!connected && connectionBanner.visibility == View.VISIBLE) {
                updateConnectionUI(false, null)
            }
        } catch (_: Exception) {}
        if (isAdded) updateBatteryOptUI()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        ThemeManager.removeOnThemeChangedListener(themeListener)
        try { requireActivity().unregisterReceiver(receiver) } catch (_: Exception) {}
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
        val pin = pinInput.text.toString().trim()
        if (pin.length != 4) {
            Toast.makeText(requireActivity(), "请输入4位配对码", Toast.LENGTH_SHORT).show()
            return
        }
        prefCtrl.setManuallyDisconnected(false)
        doConnect(discoveredIP, pin)
    }

    /** 重连：保持当前 PIN，重置连接 */
    private fun handleReconnectClick() {
        prefCtrl.setManuallyDisconnected(false)
        val pin = pinInput.text.toString().trim()
        if (pin.length != 4) {
            Toast.makeText(requireActivity(), "配对码为空，请输入4位配对码", Toast.LENGTH_SHORT).show()
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
        if (!DialService.isConnected && !connecting) return  // 未连接时无操作
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
        statusText.setTextColor(Color.parseColor(colors.goldLight))
        statusDot.setImageResource(R.drawable.dot_gray)

        lifecycleScope.launch {
            delay(3000)
            if (!DialService.isConnected && isAdded) {
                val colors2 = ThemeManager.getColors(requireContext())
                statusText.text = "连接中，请稍候...（若长时间连不上，可能是电脑防火墙拦截）"
                statusText.setTextColor(Color.parseColor(colors2.gold))
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
                connectBtnText.setTextColor(Color.parseColor("#00B5AD"))
                connectBtnText.background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                    setStroke(1, Color.parseColor("#00B5AD"))
                    cornerRadius = 6f * resources.displayMetrics.density
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
        if (enabled) {
            autoConnectSwitch.text = "开"
            autoConnectSwitch.setBackgroundColor(Color.parseColor(colors.gold))
        } else {
            autoConnectSwitch.text = "关"
            autoConnectSwitch.setBackgroundColor(Color.parseColor(colors.bg3))
        }
    }

    private fun updateAutoCopyUI(enabled: Boolean) {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        if (enabled) {
            autoCopySwitch.text = "开"
            autoCopySwitch.setBackgroundColor(Color.parseColor(colors.gold))
            autoCopySwitch.setTextColor(Color.parseColor(colors.bg))
        } else {
            autoCopySwitch.text = "关"
            autoCopySwitch.setBackgroundColor(Color.parseColor(colors.bg3))
            autoCopySwitch.setTextColor(Color.parseColor("#888888"))
        }
    }

    private fun updateCopyToastUI(enabled: Boolean) {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        if (enabled) {
            copyToastSwitch.text = "开"
            copyToastSwitch.setBackgroundColor(Color.parseColor(colors.gold))
            copyToastSwitch.setTextColor(Color.parseColor(colors.bg))
        } else {
            copyToastSwitch.text = "关"
            copyToastSwitch.setBackgroundColor(Color.parseColor(colors.bg3))
            copyToastSwitch.setTextColor(Color.parseColor("#888888"))
        }
    }

    /** 弹窗列表选择动画效果 */
    private fun showAnimationListDialog() {
        if (!isAdded) return
        val currentMode = prefCtrl.getDialAnimationMode()
        val modes = listOf(
            DialAnimationOverlay.MODE_OFF, DialAnimationOverlay.MODE_BOUNCE,
            DialAnimationOverlay.MODE_FIREWORK, DialAnimationOverlay.MODE_COMBINE,
            DialAnimationOverlay.MODE_PULSE, DialAnimationOverlay.MODE_SPARKLE,
            DialAnimationOverlay.MODE_SLIDE_UP, DialAnimationOverlay.MODE_FADE_SCALE,
            DialAnimationOverlay.MODE_SHAKE, DialAnimationOverlay.MODE_FLIP_IN,
            DialAnimationOverlay.MODE_HEARTBEAT
        )
        val labels = modes.map { DialAnimationOverlay.MODE_LABELS[it] ?: "未知" }.toTypedArray()
        val currentIdx = modes.indexOf(currentMode).coerceAtLeast(0)

        AlertDialog.Builder(requireActivity())
            .setTitle("拨号动画效果")
            .setSingleChoiceItems(labels, currentIdx) { dialog, which ->
                val selected = modes[which]
                prefCtrl.setDialAnimationMode(selected)
                updateDialAnimationUI(selected)
                if (selected != DialAnimationOverlay.MODE_OFF) {
                    DialAnimationOverlay.show(requireActivity())
                }
                dialog.dismiss()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun updateDialAnimationUI(mode: Int) {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        val label = DialAnimationOverlay.MODE_LABELS[mode] ?: "未知"
        dialAnimationSwitch.text = label
        if (mode == DialAnimationOverlay.MODE_OFF) {
            dialAnimationSwitch.setBackgroundColor(Color.parseColor(colors.bg3))
            dialAnimationSwitch.setTextColor(Color.parseColor("#888888"))
        } else {
            dialAnimationSwitch.setBackgroundColor(Color.parseColor(colors.gold))
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

    /** 首次启动时如未设置电池优化，弹窗引导 */
    private fun checkBatteryOptFirstTime() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        if (!isAdded) return
        val prefs = requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE)
        if (prefs.getBoolean("battery_opt_prompted", false)) return // 已提示过
        prefs.edit().putBoolean("battery_opt_prompted", true).apply()
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
            pinInput.isEnabled = !connected

            if (connected) {
                connecting = false
                statusDot.setImageResource(R.drawable.dot_green)
                statusText.text = "已连接"
                statusText.setTextColor(Color.parseColor(colors.green))
                val mode = DialService.transportMode
                connectionMode.text = when {
                    mode.contains("lan") && mode.contains("cloud") -> "LAN + Cloud"
                    mode.contains("lan") -> "局域网"
                    mode.contains("cloud") -> "云中转"
                    else -> ""
                }
                connectionMode.visibility = View.VISIBLE
                connectionBanner.visibility = View.VISIBLE
                bannerText.text = "✅ 已连接到电脑！等待拨号指令..."
                discoveryHint.visibility = View.GONE
                foundPCInfo.visibility = View.GONE
                updateBtnState("connected")
                connectBtn.visibility = View.GONE
            } else {
                statusDot.setImageResource(R.drawable.dot_gray)
                val manual = prefCtrl.isManuallyDisconnected()
                statusText.text = if (manual) "已手动断开" else "未连接电脑"
                statusText.setTextColor(Color.parseColor(if (manual) "#FF4D4F" else colors.text2))
                connectionMode.visibility = View.GONE
                connectionBanner.visibility = View.GONE
                foundPCInfo.visibility = View.GONE
                updateBtnState(if (manual) "manual_disconnect" else "disconnected")
                connectBtn.visibility = View.GONE

                when (reason) {
                    "pin_wrong" -> {
                        statusText.text = "配对码错误"
                        statusText.setTextColor(Color.parseColor(colors.red))
                        Toast.makeText(requireActivity(), "配对码不正确，请重新输入！", Toast.LENGTH_LONG).show()
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
                        Toast.makeText(requireActivity(), "无法连接到电脑，请检查：\n1. 电脑端是否已打开\n2. 手机和电脑是否在同一WiFi\n3. 电脑防火墙是否放行了端口", Toast.LENGTH_LONG).show()
                        discoveryHint.text = "⚠️ 连接失败，请检查电脑端是否已打开且在同一网络"
                        discoveryHint.visibility = View.VISIBLE
                    }
                    "disconnected" -> {
                        statusText.text = "连接已断开"
                        statusText.setTextColor(Color.parseColor(colors.gold))
                    }
                    else -> {
                        statusText.text = "未连接电脑"
                        statusText.setTextColor(Color.parseColor(colors.text2))
                    }
                }
            }
            updateChannelSection()
        } catch (e: Exception) {
            e.printStackTrace()
        }
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
        val list = cloudCtrl.getServerList()
        cloudServerCurrentText.text = if (list.isEmpty()) "未配置" else "${list.size} 台 · ${cloudCtrl.stripCloudPrefix(list.first())}"
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
                cloudCtrl.saveServerList(servers)
            }
        }
    }

    /** 渲染服务器内联列表，每行带连通状态和测试结果 */
    private fun refreshCloudServerList() {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        cloudServerListContainer.removeAllViews()
        val servers = cloudCtrl.getServerList()
        sortServers(servers)  // 上次用的排到第一
        val connectedServer = requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE)
            .getString("cloud_server", "") ?: ""
        val isCloudOk = DialService.isCloudConnected

        if (servers.isEmpty()) {
            cloudServerListContainer.addView(TextView(requireContext()).apply {
                text = "未配置服务器，点击「+ 添加」"
                textSize = 13f; setTextColor(Color.parseColor(colors.text2))
                setPadding(0, 8, 0, 8)
            })
            return
        }

        servers.forEachIndexed { i, server ->
            val isCurrent = server == connectedServer && isCloudOk

            val row = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                setPadding(0, 7, 0, 7)
            }

            // 连接状态指示灯
            row.addView(TextView(requireContext()).apply {
                text = if (isCurrent) "\u25CF" else "\u25CB"
                textSize = 10f; setPadding(0, 0, 6, 0)
                setTextColor(Color.parseColor(if (isCurrent) colors.green else colors.text2))
            })

            // 序号 (A/B/C/D/E...)
            row.addView(TextView(requireContext()).apply {
                text = serverLabel(i)
                textSize = 13f; setPadding(0, 0, 8, 0)
                setTextColor(Color.parseColor(if (i == 0) colors.gold else colors.text2))
            })

            // 地址（可长按复制）
            val disp = cloudCtrl.stripCloudPrefix(server)
            val addrView = TextView(requireContext()).apply {
                text = disp; textSize = 12f; isSingleLine = true
                setTextColor(Color.parseColor(if (isCurrent) colors.gold else colors.text))
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                setOnLongClickListener {
                    val clip = requireActivity().getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                    clip.setPrimaryClip(android.content.ClipData.newPlainText("server", server))
                    Toast.makeText(requireActivity(), "已复制: $server", Toast.LENGTH_SHORT).show()
                    true
                }
            }
            row.addView(addrView)

            // 测试按钮（单台）
            val testBtn = TextView(requireContext()).apply {
                text = "\u26A1"; textSize = 12f; setPadding(6, 0, 6, 0)
                setTextColor(Color.parseColor(colors.text2))
                setOnClickListener { testSingleServer(server, this) }
            }
            row.addView(testBtn)

            // 上移
            if (i > 0) row.addView(TextView(requireContext()).apply {
                text = "\u2191"; textSize = 13f; setPadding(4, 0, 4, 0)
                setTextColor(Color.parseColor(colors.text2))
                setOnClickListener {
                    servers.removeAt(i); servers.add(i - 1, server)
                    cloudCtrl.saveServerList(servers)
                    refreshCloudServerList(); updateCloudServerCurrentText()
                }
            })

            // 删除
            row.addView(TextView(requireContext()).apply {
                text = "\u2715"; textSize = 12f; setPadding(4, 0, 2, 0)
                setTextColor(Color.parseColor(colors.red))
                setOnClickListener {
                    servers.removeAt(i)
                    cloudCtrl.saveServerList(servers)
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
                val list = cloudCtrl.getServerList()
                val normSet = list.map { cloudCtrl.stripCloudPrefix(it) }.toSet()
                if (normSet.contains(cloudCtrl.stripCloudPrefix(addr))) {
                    Toast.makeText(requireActivity(), "该地址已存在", Toast.LENGTH_SHORT).show()
                } else {
                    list.add(addr); cloudCtrl.saveServerList(list)
                    refreshCloudServerList(); updateCloudServerCurrentText()
                }
            }
            .setNegativeButton("取消", null).show()
    }

    /** 测试全部服务器，在内联列表中更新状态 */
    private fun testAllServers() {
        if (!isAdded) return
        val servers = cloudCtrl.getServerList()
        if (servers.isEmpty()) {
            Toast.makeText(requireActivity(), "暂无服务器", Toast.LENGTH_SHORT).show()
            return
        }
        Toast.makeText(requireActivity(), "正在测试 ${servers.size} 台...", Toast.LENGTH_SHORT).show()
        lifecycleScope.launch {
            val results = cloudCtrl.testAllServers(servers)
            if (!isAdded) return@launch
            refreshCloudServerListWithResults(results.toMap())
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
        val servers = cloudCtrl.getServerList()
        val connectedServer = requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE)
            .getString("cloud_server", "") ?: ""
        val isCloudOk = DialService.isCloudConnected

        servers.forEachIndexed { i, server ->
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
                text = when (testOk) {
                    true -> "\u2705"
                    false -> "\u274C"
                    null -> "\u23F3"
                }
                textSize = 11f; setPadding(0, 0, 6, 0)
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

            // 删除
            row.addView(TextView(requireContext()).apply {
                text = "\u2715"; textSize = 12f; setPadding(4, 0, 2, 0)
                setTextColor(Color.parseColor(colors.text2))
                setOnClickListener {
                    servers.removeAt(i)
                    cloudCtrl.saveServerList(servers)
                    refreshCloudServerList(); updateCloudServerCurrentText()
                }
            })
            cloudServerListContainer.addView(row)
        }
    }

    /** 打开app自动测试服务器，仅在服务器列表有变化时执行 */
    private var lastTestedServerCount = 0

    private fun autoTestServersOnStart() {
        val servers = cloudCtrl.getServerList()
        if (servers.isEmpty()) return
        if (servers.size == lastTestedServerCount) return
        lastTestedServerCount = servers.size
        lifecycleScope.launch {
            if (!isAdded) return@launch
            val results = cloudCtrl.testAllServers(servers)
            if (!isAdded) return@launch
            refreshCloudServerListWithResults(results.toMap())
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
                cloudCtrl.saveServerList(list)
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
                cloudCtrl.saveServerList(list)
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
        val parent = root.findViewById<View>(R.id.exportLogRow).parent as? ViewGroup ?: return
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
                btn.setTextColor(Color.parseColor(if (sel) colors.bg else colors.gold))
                btn.setBackgroundColor(Color.parseColor(if (sel) colors.gold else colors.bg3))
            }
        }

        for (v in values) {
            val btn = TextView(requireContext()).apply {
                text = if (v == 0) "关" else "$v%"
                textSize = 11f; setPadding(10, 5, 10, 5)
                (layoutParams as? android.widget.LinearLayout.LayoutParams)?.marginStart = 6
                setOnClickListener {
                    prefCtrl.setCardOpacity(v)
                    ThemeManager.applyToView(requireView(), colors)
                    refreshButtons()
                }
            }
            row.addView(btn)
        }
        refreshButtons()
        parent.addView(row)
    }

    private fun applyTheme() {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        ThemeManager.applyToView(requireView(), colors)
    }

    private fun updateThemePreview() {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        val theme = ThemeManager.getThemeById(ThemeManager.loadThemeId(requireContext()))
        val mode = ThemeManager.loadMode(requireContext())
        val modeName = ThemeManager.MODES.find { it.key == mode }?.name ?: "暗夜"
        themeCurrentName.text = "${theme.name} · $modeName"
        previewGold.setBackgroundColor(Color.parseColor(colors.gold))
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

    /** v7: 更新通道状态面板 */
    private fun updateChannelSection() {
        if (!isAdded) return
        try {
            val colors = ThemeManager.getColors(requireContext())
            val mode = DialService.transportMode
            val lanOk = mode.contains("lan")
            val cloudOk = DialService.isCloudConnected

            lanStatusText.text = if (lanOk) "已连接" else "未连接"
            lanStatusText.setTextColor(Color.parseColor(if (lanOk) colors.green else "#605040"))
            lanStatusDot.setImageResource(if (lanOk) R.drawable.dot_green else R.drawable.dot_gray)

            cloudStatusText.text = if (cloudOk) "已连接" else "未连接"
            cloudStatusText.setTextColor(Color.parseColor(if (cloudOk) colors.green else "#605040"))
            cloudStatusDot.setImageResource(if (cloudOk) R.drawable.dot_green else R.drawable.dot_gray)

            // v8: 延迟内联显示（连接通道模块内）
            val mgr = DialService._instance?.connectionManager
            val lanLat = mgr?.lanLatencyMs ?: -1
            val cloudLat = mgr?.cloudLatencyMs ?: -1

            if (lanOk && lanLat >= 0) {
                lanLatencyInline.text = "${lanLat}ms"
                lanLatencyInline.setTextColor(Color.parseColor(colors.green))
                lanLatencyInline.visibility = View.VISIBLE
            } else {
                lanLatencyInline.visibility = View.GONE
            }

            if (cloudOk && cloudLat >= 0) {
                cloudLatencyInline.text = "${cloudLat}ms"
                cloudLatencyInline.setTextColor(Color.parseColor(colors.green))
                cloudLatencyInline.visibility = View.VISIBLE
            } else {
                cloudLatencyInline.visibility = View.GONE
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
                    (requireActivity() as MainActivity).syncDialModeUI()
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
}
