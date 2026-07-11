package com.autodial.app

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.ContentObserver
import android.database.Cursor
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import java.text.SimpleDateFormat
import java.util.*

data class PhoneCallRecord(
    val number: String,
    val time: Long,
    val duration: Long,
    val type: Int,     // CallLog.Calls.TYPE_OUTGOING = 2, INCOMING = 1, MISSED = 3
    val simSlot: Int   // 0=卡1, 1=卡2
)

class CallLogAdapter(
    private var records: List<PhoneCallRecord>,
    private val colors: ThemeColors,
    private val onLongClick: (PhoneCallRecord) -> Unit
) :
    RecyclerView.Adapter<CallLogAdapter.ViewHolder>() {

    private val timeFormat = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())

    fun updateData(newRecords: List<PhoneCallRecord>) {
        records = newRecords
        notifyDataSetChanged()
    }

    class ViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val number: TextView = view.findViewById(R.id.itemCallNumber)
        val time: TextView = view.findViewById(R.id.itemCallTime)
        val callType: TextView = view.findViewById(R.id.itemCallType)
        val simSlot: TextView = view.findViewById(R.id.itemSimSlot)
        val callStatus: TextView = view.findViewById(R.id.itemCallStatus)
        val root: View = view
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_call_log, parent, false)
        // 应用主题到 item 的根布局
        ThemeManager.applyToView(view, colors)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val record = records[position]

        // 号码脱敏
        val num = record.number
        holder.number.text = if (num.length > 7) {
            num.substring(0, 3) + "****" + num.substring(num.length - 4)
        } else {
            num
        }

        // 时间
        holder.time.text = timeFormat.format(Date(record.time))

        // 通话类型：图标 + 文字标签
        val accentColor = android.graphics.Color.parseColor(colors.primaryLight)
        val (typeText, iconRes, tintColor) = when (record.type) {
            CallLog.Calls.OUTGOING_TYPE -> Triple("拨出", R.drawable.ic_ph_phone_outgoing, accentColor)
            CallLog.Calls.INCOMING_TYPE -> Triple("来电", R.drawable.ic_ph_phone_incoming, accentColor)
            CallLog.Calls.MISSED_TYPE -> Triple("未接", R.drawable.ic_ph_phone_x, android.graphics.Color.parseColor(colors.red))
            else -> Triple("", R.drawable.ic_ph_phone_outgoing, accentColor)
        }
        holder.callType.text = typeText
        val d = androidx.core.content.ContextCompat.getDrawable(holder.itemView.context, iconRes)
        d?.setTint(tintColor)
        holder.callType.setCompoundDrawablesWithIntrinsicBounds(d, null, null, null)
        holder.callType.setTextColor(tintColor)

        // 通话状态文字 + 颜色
        val textColor = android.graphics.Color.parseColor(colors.text)
        when (record.type) {
            CallLog.Calls.OUTGOING_TYPE -> {
                if (record.duration > 0) {
                    holder.callStatus.text = formatDuration(record.duration)
                    holder.callStatus.setTextColor(textColor)
                } else {
                    holder.callStatus.text = "未接通"
                    holder.callStatus.setTextColor(android.graphics.Color.parseColor(colors.red))
                }
            }
            CallLog.Calls.INCOMING_TYPE -> {
                if (record.duration > 0) {
                    holder.callStatus.text = formatDuration(record.duration)
                    holder.callStatus.setTextColor(textColor)
                } else {
                    holder.callStatus.text = "未接听"
                    holder.callStatus.setTextColor(android.graphics.Color.parseColor(colors.red))
                }
            }
            CallLog.Calls.MISSED_TYPE -> {
                holder.callStatus.text = "未接"
                holder.callStatus.setTextColor(android.graphics.Color.parseColor(colors.red))
            }
            else -> {
                holder.callStatus.text = "-"
                holder.callStatus.setTextColor(android.graphics.Color.parseColor(colors.text2))
            }
        }

        // SIM卡标识
        holder.simSlot.text = "卡${record.simSlot + 1}"
        holder.simSlot.setTextColor(android.graphics.Color.parseColor(if (record.simSlot == 1) colors.primaryLight else colors.text2))

        // v3: 彩色状态条
        val statusBar = holder.root.findViewById<View>(R.id.itemStatusBar)
        val barColor = when {
            record.duration > 0 -> android.graphics.Color.parseColor(colors.green)
            record.type == CallLog.Calls.MISSED_TYPE -> android.graphics.Color.parseColor(colors.red)
            else -> android.graphics.Color.parseColor(colors.bg3)
        }
        statusBar.setBackgroundColor(barColor)

        // 长按弹出操作菜单
        holder.root.setOnLongClickListener {
            onLongClick(record)
            true
        }
    }

    private fun formatDuration(seconds: Long): String {
        return when {
            seconds < 60 -> "${seconds}s"
            else -> "${seconds / 60}m${seconds % 60}s"
        }
    }

    override fun getItemCount(): Int = records.size
}

/**
 * RecyclerView item animator: items slide up with staggered delay on add.
 */
class SlideUpItemAnimator : DefaultItemAnimator() {
    override fun animateAdd(holder: RecyclerView.ViewHolder?): Boolean {
        holder?.itemView?.apply {
            translationY = 100f
            alpha = 0f
            animate()
                .translationY(0f)
                .alpha(1f)
                .setDuration(400)
                .setStartDelay((holder.adapterPosition * 50L).coerceAtMost(400L))
                .setInterpolator(DecelerateInterpolator())
                .start()
        }
        dispatchAddFinished(holder)
        return false
    }
}

class CallLogFragment : Fragment() {

    companion object {
        private const val TAG = "CallLogFragment"
    }

    private lateinit var recyclerView: RecyclerView
    private var callLogAdapter: CallLogAdapter? = null
    private lateinit var emptyView: View
    private lateinit var permissionHint: View
    private lateinit var lastCallHintBanner: View
    private lateinit var lastCallHintText: TextView
    private lateinit var emptyDialBtn: TextView

    // v3 UI: 财运横幅 (inline badge)
    private lateinit var fortuneLuck: TextView
    private lateinit var fortuneQi: TextView

    // v3 UI: 筛选芯片
    private lateinit var filterAll: TextView
    private lateinit var filterOk: TextView
    private lateinit var filterMiss: TextView
    private var currentFilter: String = "all"

    // v3 UI: FAB 手动拨号
    private lateinit var dialFab: TextView

    // 完整记录列表（未筛选），用于筛选后恢复
    private var allRecords: List<PhoneCallRecord> = emptyList()

    // 连接状态
    private lateinit var connectionStatusDot: ImageView
    private lateinit var connectionStatusText: TextView
    private lateinit var topReconnectBtn: TextView
    private var connecting = false

    // 财运统计
    private lateinit var todayLuckText: TextView
    private lateinit var todayFortuneText: TextView
    // 当前显示的数据指纹，用于去重刷新
    private var lastDataFingerprint: String = ""

    // 防报：最短刷新间隔（毫秒）
    private var lastRefreshTime: Long = 0
    private val MIN_REFRESH_INTERVAL = 300L

    // 拨号模式按钮
    private lateinit var dialModeButtons: List<TextView>
    private lateinit var dialModeKeys: List<String>

    // 主题变更监听
    private val themeListener: () -> Unit = {
        if (isAdded) {
            applyTheme()
            updateDialModeBarUI()
            forceLoadCallLog()
        }
    }

    // 连接状态变更广播监听
    private val connectionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val connected = intent?.getBooleanExtra("connected", false) ?: false
            val mode = intent?.getStringExtra("mode") ?: ""
            if (isAdded) updateConnectionStatus(connected, mode)
        }
    }

    // 通话结束广播：多段延迟刷新
    private val callEndedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            Log.d(TAG, "收到通话结束广播，启动多段延迟刷新")
            cancelPendingRefreshes()
            scheduleRefresh(1000)
            scheduleRefresh(3000)
            scheduleRefresh(5000)
        }
    }

    // APP 拨号完成广播：立即刷新
    private val newDialReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            Log.d(TAG, "收到APP拨号完成广播，立即刷新")
            cancelPendingRefreshes()
            scheduleRefresh(500)
            scheduleRefresh(3000)
        }
    }

    // 拨号前提示广播：显示上次使用哪张卡
    private val lastCallHintReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val hint = intent?.getStringExtra("hint") ?: return
            if (isAdded) {
                lastCallHintText.text = hint
                lastCallHintBanner.visibility = View.VISIBLE
                // 自动隐藏时间可通过设置页配置（默认10秒，0=一直显示）
                val prefs = requireContext().getSharedPreferences("autodial", Context.MODE_PRIVATE)
                val durationSec = prefs.getInt("last_call_hint_duration", 10)
                if (durationSec > 0) {
                    refreshHandler.postDelayed({
                        if (isAdded) lastCallHintBanner.visibility = View.GONE
                    }, durationSec * 1000L)
                }
            }
        }
    }

    // ==================== ContentObserver：监听系统通话记录数据库变化 ====================
    private val callLogObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) {
            Log.d(TAG, "通话记录数据库变化，延迟0.5秒刷新")
            scheduleRefresh(500)
            scheduleRefresh(3000)
        }
    }

    private val refreshHandler = Handler(Looper.getMainLooper())
    private val refreshRunnable = Runnable { smartLoadCallLog() }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.fragment_call_log, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        recyclerView = view.findViewById(R.id.callLogRecyclerView)
        emptyView = view.findViewById(R.id.callLogEmpty)
        permissionHint = view.findViewById(R.id.callLogPermissionHint)
        lastCallHintBanner = view.findViewById(R.id.lastCallHintBanner)
        lastCallHintText = view.findViewById(R.id.lastCallHintText)
        connectionStatusDot = view.findViewById(R.id.connectionStatusDot)
        connectionStatusText = view.findViewById(R.id.connectionStatusText)
        topReconnectBtn = view.findViewById(R.id.topReconnectBtn)
        todayLuckText = view.findViewById(R.id.todayLuckText)
        todayFortuneText = view.findViewById(R.id.todayFortuneText)
        emptyDialBtn = view.findViewById(R.id.emptyDialBtn)
        fortuneLuck = view.findViewById(R.id.fortuneLuck)
        fortuneQi = view.findViewById(R.id.fortuneQi)
        filterAll = view.findViewById(R.id.filterAll)
        filterOk = view.findViewById(R.id.filterOk)
        filterMiss = view.findViewById(R.id.filterMiss)
        dialFab = view.findViewById(R.id.dialFab)

        // v3 UI: 筛选芯片点击
        filterAll.setOnClickListener { setFilter("all") }
        filterOk.setOnClickListener { setFilter("ok") }
        filterMiss.setOnClickListener { setFilter("miss") }

        // v3 UI: FAB 手动拨号
        dialFab.setOnClickListener {
            if (!isAdded) return@setOnClickListener
            DialPadSheet.show(requireActivity()) { number ->
                try {
                    val intent = Intent(Intent.ACTION_CALL).apply {
                        data = Uri.parse("tel:$number")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(intent)
                } catch (e: Exception) {
                    Toast.makeText(requireContext(), "拨号失败: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }

        // v6: 顶部小按钮 — 状态和连接页保持一致
        topReconnectBtn.setOnClickListener {
            if (!isAdded) return@setOnClickListener
            val prefs = requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE)
            when {
                DialService.isConnected -> {
                    // 重连
                    val pin = prefs.getString("pin", "") ?: ""
                    if (pin.length == 4) {
                        requireActivity().startService(Intent(requireActivity(), DialService::class.java).apply {
                            action = "CONNECT"; putExtra("pin", pin)
                        })
                        NotifyHelper.connToast(requireActivity(), "正在重连...", Toast.LENGTH_SHORT)
                    } else {
                        Toast.makeText(requireActivity(), "请先在连接页输入配对码", Toast.LENGTH_SHORT).show()
                    }
                }
                connecting -> {
                    // 取消
                    connecting = false
                    requireActivity().startService(Intent(requireActivity(), DialService::class.java).apply {
                        action = "DISCONNECT"
                    })
                    Toast.makeText(requireActivity(), "已取消连接", Toast.LENGTH_SHORT).show()
                    updateConnectionStatus(false, "")
                }
                else -> {
                    // 发起连接
                    val pin = prefs.getString("pin", "") ?: ""
                    if (pin.length >= 4) {
                        connecting = true
                        updateBtnStateUI()
                        requireActivity().startService(Intent(requireActivity(), DialService::class.java).apply {
                            action = "CONNECT"; putExtra("pin", pin)
                        })
                        NotifyHelper.connToast(requireActivity(), "正在连接...", Toast.LENGTH_SHORT)
                    } else {
                        Toast.makeText(requireActivity(), "请先在连接页输入配对码", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }

        recyclerView.layoutManager = LinearLayoutManager(requireContext())
        recyclerView.itemAnimator = SlideUpItemAnimator()

        // 空状态「立即拨号」按钮
        emptyDialBtn.setOnClickListener {
            val intent = Intent(Intent.ACTION_DIAL)
            startActivity(intent)
        }

        // 初始化连接状态（根据 DialService 当前状态）
        updateConnectionStatus(DialService.isConnected, DialService._instance?.connectionMode ?: "")

        // 拨号模式按钮
        dialModeButtons = listOf(
            view.findViewById(R.id.dialModePopup),
            view.findViewById(R.id.dialModeRoundSelect),
            view.findViewById(R.id.dialModeOpposite),
            view.findViewById(R.id.dialModeSim1),
            view.findViewById(R.id.dialModeSim2),
            view.findViewById(R.id.dialModeAlternate),
            view.findViewById(R.id.dialModeSystem)
        )
        dialModeKeys = listOf(
            DialMode.POPUP.key,
            DialMode.ROUND_SELECT.key,
            DialMode.OPPOSITE.key,
            DialMode.SIM1.key,
            DialMode.SIM2.key,
            DialMode.ALTERNATE.key,
            DialMode.SYSTEM.key
        )

        dialModeButtons.forEachIndexed { index, btn ->
            btn.setOnClickListener {
                requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE)
                    .edit().putString("dial_mode", dialModeKeys[index]).apply()
                updateDialModeBarUI()
                // 显示模式说明 2 秒 — 放在第一条记录上方
                val mode = DialMode.fromKey(dialModeKeys[index])
                showDialModeHint(mode.desc)
            }
        }

        // 注册广播
        ContextCompat.registerReceiver(
            requireContext(),
            callEndedReceiver,
            IntentFilter("com.autodial.CALL_ENDED"),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        ContextCompat.registerReceiver(
            requireContext(),
            newDialReceiver,
            IntentFilter("com.autodial.NEW_DIAL"),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        ContextCompat.registerReceiver(
            requireContext(),
            lastCallHintReceiver,
            IntentFilter("com.autodial.LAST_CALL_HINT"),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        ContextCompat.registerReceiver(
            requireContext(),
            connectionReceiver,
            IntentFilter("com.autodial.CONNECTION_CHANGE"),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )

        // 注册 ContentObserver
        try {
            requireContext().contentResolver.registerContentObserver(
                CallLog.Calls.CONTENT_URI,
                true,
                callLogObserver
            )
            Log.d(TAG, "已注册通话记录 ContentObserver")
        } catch (e: Exception) {
            Log.e(TAG, "注册 ContentObserver 失败: ${e.message}")
        }

        // 主题监听
        ThemeManager.addOnThemeChangedListener(themeListener)

        applyTheme()
        updateDialModeBarUI()
        forceLoadCallLog()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        cancelPendingRefreshes()
        ThemeManager.removeOnThemeChangedListener(themeListener)
        try { requireContext().unregisterReceiver(callEndedReceiver) } catch (_: Exception) {}
        try { requireContext().unregisterReceiver(newDialReceiver) } catch (_: Exception) {}
        try { requireContext().unregisterReceiver(lastCallHintReceiver) } catch (_: Exception) {}
        try { requireContext().unregisterReceiver(connectionReceiver) } catch (_: Exception) {}
        try { requireContext().contentResolver.unregisterContentObserver(callLogObserver) } catch (_: Exception) {}
        // 重置状态，避免 ViewPager 切回时因指纹匹配而跳过 adapter 绑定导致空白
        lastDataFingerprint = ""
        callLogAdapter = null
    }

    fun refreshIfNeeded() {
        if (isAdded) {
            updateConnectionStatus(DialService.isConnected, DialService._instance?.connectionMode ?: "")
            loadCallLog()
        }
    }

    // ==================== 刷新调度 ====================

    private fun scheduleRefresh(delayMs: Long) {
        refreshHandler.postDelayed(refreshRunnable, delayMs)
    }

    private fun cancelPendingRefreshes() {
        refreshHandler.removeCallbacks(refreshRunnable)
    }

    private fun smartLoadCallLog() {
        if (!isAdded) return
        val now = System.currentTimeMillis()
        if (now - lastRefreshTime < MIN_REFRESH_INTERVAL) {
            refreshHandler.postDelayed(refreshRunnable, MIN_REFRESH_INTERVAL)
            return
        }
        loadCallLog()
    }

    private fun forceLoadCallLog() {
        if (!isAdded) return
        loadCallLog()
    }

    // ==================== 连接状态 ====================

    private fun updateConnectionStatus(connected: Boolean, mode: String = "") {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        if (connected) {
            connecting = false
            connectionStatusDot.setImageResource(R.drawable.dot_green)
            connectionStatusText.text = "已连接"
        } else {
            connectionStatusDot.setImageResource(R.drawable.dot_gray)
            connectionStatusText.text = "未连接电脑"
        }
        updateBtnStateUI()
    }

    /** 顶部小按钮状态：和连接页保持一致 */
    private fun updateBtnStateUI() {
        if (!isAdded) return
        val density = resources.displayMetrics.density
        when {
            connecting -> {
                topReconnectBtn.text = "取消"
                topReconnectBtn.setTextColor(Color.parseColor("#666666"))
                topReconnectBtn.background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                    setStroke((2 * density).toInt(), Color.parseColor("#D9D9D9"))
                    cornerRadius = 4f * density
                    setColor(Color.TRANSPARENT)
                }
            }
            DialService.isConnected -> {
                topReconnectBtn.text = "重连"
                topReconnectBtn.setTextColor(Color.parseColor("#00B5AD"))
                topReconnectBtn.background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                    setStroke((2 * density).toInt(), Color.parseColor("#00B5AD"))
                    cornerRadius = 4f * density
                    setColor(Color.TRANSPARENT)
                }
            }
            else -> {
                topReconnectBtn.text = "连接"
                topReconnectBtn.setTextColor(Color.parseColor("#FFFFFF"))
                topReconnectBtn.background = android.graphics.drawable.GradientDrawable().apply {
                    shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                    setColor(Color.parseColor("#1677FF"))
                    cornerRadius = 4f * density
                }
            }
        }
        topReconnectBtn.visibility = View.VISIBLE
    }

    // ==================== 长按操作菜单 ====================

    private fun showCallRecordMenu(record: PhoneCallRecord) {
        if (!isAdded) return
        CallDetailSheet.show(requireActivity(), record)
    }

    // ==================== 通话记录加载 ====================

    fun loadCallLog() {
        if (!isAdded) return
        val ctx = requireContext()

        val hasPermission = ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_CALL_LOG) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED

        if (!hasPermission) {
            permissionHint.visibility = View.VISIBLE
            recyclerView.visibility = View.GONE
            emptyView.visibility = View.GONE
            loadTodayLuckStats()
            return
        }

        permissionHint.visibility = View.GONE

        val records = mutableListOf<PhoneCallRecord>()

        try {
            val cursor: Cursor? = ctx.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(
                    CallLog.Calls.NUMBER,
                    CallLog.Calls.DATE,
                    CallLog.Calls.DURATION,
                    CallLog.Calls.TYPE,
                    CallLog.Calls.PHONE_ACCOUNT_ID
                ),
                null, null,
                "${CallLog.Calls.DATE} DESC"
            )

            cursor?.use {
                val numIdx = it.getColumnIndex(CallLog.Calls.NUMBER)
                val dateIdx = it.getColumnIndex(CallLog.Calls.DATE)
                val durIdx = it.getColumnIndex(CallLog.Calls.DURATION)
                val typeIdx = it.getColumnIndex(CallLog.Calls.TYPE)
                val subIdIdx = it.getColumnIndex(CallLog.Calls.PHONE_ACCOUNT_ID)
                // D3修复: 检查列索引有效性，防止部分 ROM 上崩溃（含 subIdIdx）
                if (numIdx < 0 || dateIdx < 0 || durIdx < 0 || typeIdx < 0 || subIdIdx < 0) return@use

                // 获取 SIM 卡订阅列表（用于 subId → slotIndex 映射）
                val simList = try {
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP_MR1) {
                        val sm = ctx.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as? android.telephony.SubscriptionManager
                        sm?.activeSubscriptionInfoList?.filterNotNull() ?: emptyList()
                    } else emptyList()
                } catch (_: Exception) { emptyList() }

                // 复用 CallLogDb 单例，避免高频创建/销毁
                val callLogDb = CallLogDb.getInstance(ctx)

                while (it.moveToNext() && records.size < 200) {
                    val num = it.getString(numIdx) ?: continue
                    val date = it.getLong(dateIdx)
                    val dur = it.getLong(durIdx)
                    val type = it.getInt(typeIdx)
                    val subId = it.getString(subIdIdx)

                    var simSlot = 0
                    try {
                        for (info in simList) {
                            if (info.subscriptionId.toString() == subId) {
                                simSlot = info.simSlotIndex
                                break
                            }
                        }
                    } catch (_: Exception) {}
                    // v7: 系统查询失败时用APP自己的sim_cache纠正
                    if (simSlot == 0) {
                        try {
                            val cachedSlot = callLogDb.getCachedSimSlot(num)
                            if (cachedSlot >= 0) simSlot = cachedSlot
                        } catch (_: Exception) {}
                    }

                    records.add(PhoneCallRecord(num, date, dur, type, simSlot))
                }
            }
        } catch (e: Exception) {
            Toast.makeText(ctx, "读取通话记录失败", Toast.LENGTH_SHORT).show()
        }

        val fingerprint = buildFingerprint(records)
        if (fingerprint == lastDataFingerprint && fingerprint.isNotEmpty()) {
            Log.d(TAG, "数据未变化，跳过UI刷新")
            lastRefreshTime = System.currentTimeMillis()
            return
        }
        lastDataFingerprint = fingerprint
        lastRefreshTime = System.currentTimeMillis()

        val colors = ThemeManager.getColors(ctx)
        loadTodayLuckStats()

        // 保存全部记录
        allRecords = records

        // 应用筛选后渲染
        if (records.isEmpty()) {
            recyclerView.visibility = View.GONE
            emptyView.visibility = View.VISIBLE
            ThemeManager.applyToView(emptyView, colors)
        } else {
            recyclerView.visibility = View.VISIBLE
            emptyView.visibility = View.GONE
            val filtered = applyFilterToList(records)
            if (callLogAdapter == null) {
                callLogAdapter = CallLogAdapter(filtered, colors) { record ->
                    showCallRecordMenu(record)
                }
                recyclerView.adapter = callLogAdapter
                recyclerView.adapter?.notifyDataSetChanged()
            } else {
                callLogAdapter!!.updateData(filtered)
            }
        }
        updateFilterChipUI()
    }

    private fun buildFingerprint(records: List<PhoneCallRecord>): String {
        if (records.isEmpty()) return ""
        val sb = StringBuilder()
        val count = minOf(records.size, 10)
        for (i in 0 until count) {
            val r = records[i]
            sb.append(r.number).append("|").append(r.time).append("|")
                .append(r.duration).append("|").append(r.type).append(";")
        }
        return sb.toString()
    }

    // ==================== 筛选 ====================

    private fun setFilter(filter: String) {
        currentFilter = filter
        updateFilterChipUI()
        applyFilterAndRender()
    }

    private fun updateFilterChipUI() {
        val colors = ThemeManager.getColors(requireContext())
        val activeBg = android.graphics.Color.parseColor(colors.primary)
        val activeText = android.graphics.Color.parseColor(colors.bg)
        val inactiveBg = android.graphics.Color.parseColor(colors.bg2)
        val inactiveText = android.graphics.Color.parseColor(colors.text2)

        fun applyChip(chip: TextView, active: Boolean) {
            if (active) {
                chip.setBackgroundColor(activeBg); chip.setTextColor(activeText)
            } else {
                chip.setBackgroundColor(inactiveBg); chip.setTextColor(inactiveText)
            }
        }
        applyChip(filterAll, currentFilter == "all")
        applyChip(filterOk, currentFilter == "ok")
        applyChip(filterMiss, currentFilter == "miss")
    }

    private fun applyFilterAndRender() {
        if (!isAdded) return
        val filtered = when (currentFilter) {
            "ok" -> allRecords.filter { r -> r.duration > 0 && r.type != android.provider.CallLog.Calls.MISSED_TYPE }
            "miss" -> allRecords.filter { r -> r.duration == 0L || r.type == android.provider.CallLog.Calls.MISSED_TYPE }
            else -> allRecords
        }
        val colors = ThemeManager.getColors(requireContext())
        if (filtered.isEmpty()) {
            recyclerView.visibility = View.GONE
            emptyView.visibility = View.VISIBLE
        } else {
            recyclerView.visibility = View.VISIBLE
            emptyView.visibility = View.GONE
            callLogAdapter?.updateData(filtered)
        }
    }

    private fun applyFilterToList(records: List<PhoneCallRecord>): List<PhoneCallRecord> {
        return when (currentFilter) {
            "ok" -> records.filter { r -> r.duration > 0 && r.type != android.provider.CallLog.Calls.MISSED_TYPE }
            "miss" -> records.filter { r -> r.duration == 0L || r.type == android.provider.CallLog.Calls.MISSED_TYPE }
            else -> records
        }
    }

    // ==================== 今日财运/财气 ====================

    /** 从数据库查询今日拨号次数和通时分钟数 */
    private fun loadTodayLuckStats() {
        if (!isAdded) return
        val callLogDb = CallLogDb.getInstance(requireContext())
        try {
            val todayCount = callLogDb.getTodayCount(requireContext())
            val dayStats = callLogDb.getDailyDurationStats(requireContext(), 1)

            if (dayStats.isNotEmpty()) {
                val today = dayStats[0]
                val minutes = (today.totalDurationSec + 30) / 60
                todayLuckText.text = todayCount.toString()
                todayFortuneText.text = "${minutes}分"
                // v3: 同步更新 fortune strip
                fortuneLuck.text = todayCount.toString()
                fortuneQi.text = "${minutes}分"
            }
        } catch (_: Exception) {}
    }

    // ==================== 拨号模式 UI ====================

    fun updateDialModeBarUI() {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        val prefs = requireActivity().getSharedPreferences("autodial", Context.MODE_PRIVATE)
        val currentMode = prefs.getString("dial_mode", DialMode.ROUND_SELECT.key) ?: DialMode.ROUND_SELECT.key

        dialModeButtons.forEachIndexed { index, btn ->
            val isSelected = dialModeKeys[index] == currentMode
            if (isSelected) {
                btn.setBackgroundColor(android.graphics.Color.parseColor(colors.primary))
                btn.setTextColor(android.graphics.Color.parseColor(colors.bg))
            } else {
                btn.setBackgroundColor(android.graphics.Color.parseColor(colors.bg))
                btn.setTextColor(android.graphics.Color.parseColor(colors.text))
            }
        }
    }

    // ==================== 主题 ====================

    fun onThemeChanged() {
        themeListener()
    }

    private fun applyTheme() {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        ThemeManager.applyToView(requireView(), colors)
        updateConnectionStatus(DialService.isConnected, DialService._instance?.connectionMode ?: "")
    }

    private fun showDialModeHint(text: String) {
        val activity = activity ?: return
        val colors = ThemeManager.getColors(requireContext())
        val hint = TextView(activity).apply {
            this.text = text
            textSize = 15f
            setTextColor(Color.parseColor(colors.bg))
            setBackgroundColor(Color.parseColor(colors.primaryLight))
            setPadding(dpToPx(16), dpToPx(10), dpToPx(16), dpToPx(10))
            gravity = android.view.Gravity.CENTER
            alpha = 0.95f
        }
        val root = activity.window.decorView as android.widget.FrameLayout
        val params = android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
            android.widget.FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            gravity = android.view.Gravity.TOP or android.view.Gravity.CENTER_HORIZONTAL
            topMargin = dpToPx(300)
        }
        root.addView(hint, params)
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            try { root.removeView(hint) } catch (_: Exception) {}
        }, 2000)
    }

    private fun dpToPx(dp: Int): Int = (dp * resources.displayMetrics.density).toInt()
}