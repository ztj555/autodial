package com.autodial.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.google.android.material.bottomsheet.BottomSheetDialog
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

class StatsFragment : Fragment() {

    private lateinit var todayCount: TextView
    private lateinit var totalCount: TextView
    private lateinit var todayDuration: TextView
    private lateinit var totalDuration: TextView
    private lateinit var todayLuck: TextView
    private lateinit var totalLuck: TextView
    private lateinit var todayConnect: TextView
    private lateinit var weekConnect: TextView
    private lateinit var monthConnect: TextView
    private lateinit var chartContainer: LinearLayout
    private lateinit var dateLabels: LinearLayout

    // 主题变更监听
    private val themeListener: () -> Unit = {
        if (isAdded) {
            applyTheme()
            loadStats()
        }
    }

    private val newDialReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            refreshIfNeeded()
        }
    }

    // 通话结束时延迟1秒刷新统计
    private val callEndedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            refreshHandler.removeCallbacks(refreshRunnable)
            refreshHandler.postDelayed(refreshRunnable, 1000)
        }
    }

    // 上门登记广播接收器
    private var visitReceiver: BroadcastReceiver? = null

    private val refreshHandler = Handler(Looper.getMainLooper())
    private val refreshRunnable = Runnable { refreshIfNeeded() }

    private val dayOfWeekFormat = SimpleDateFormat("E", Locale.getDefault())
    private val executor = Executors.newSingleThreadExecutor()

    // 上门统计 TextView
    private lateinit var visitToday: TextView
    private lateinit var visitWeek: TextView
    private lateinit var visit7Days: TextView
    private lateinit var visitMonth: TextView
    private lateinit var visitLastMonth: TextView
    private lateinit var visit30Days: TextView
    private lateinit var visitSyncBtn: TextView

    // 缓存的上门记录：[{name, mobile, created_at, timestamp}, ...]
    private var visitRecords: List<VisitRecord> = emptyList()

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.fragment_stats, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        todayCount = view.findViewById(R.id.statsTodayCount)
        totalCount = view.findViewById(R.id.statsTotalCount)
        todayDuration = view.findViewById(R.id.statsTodayDuration)
        totalDuration = view.findViewById(R.id.statsTotalDuration)
        todayLuck = view.findViewById(R.id.statsTodayLuck)
        totalLuck = view.findViewById(R.id.statsTotalLuck)
        todayConnect = view.findViewById(R.id.statsTodayConnect)
        weekConnect = view.findViewById(R.id.statsWeekConnect)
        monthConnect = view.findViewById(R.id.statsMonthConnect)
        chartContainer = view.findViewById(R.id.statsChartContainer)
        dateLabels = view.findViewById(R.id.statsDateLabels)
        visitToday = view.findViewById(R.id.statsVisitToday)
        visitWeek = view.findViewById(R.id.statsVisitWeek)
        visit7Days = view.findViewById(R.id.statsVisit7Days)
        visitMonth = view.findViewById(R.id.statsVisitMonth)
        visitLastMonth = view.findViewById(R.id.statsVisitLastMonth)
        visit30Days = view.findViewById(R.id.statsVisit30Days)
        visitSyncBtn = view.findViewById(R.id.statsVisitSyncBtn)

        // 点击卡片弹每日明细
        val weekCallCard = view.findViewById<LinearLayout>(R.id.statsWeekCallCard)
        val weekDurCard = view.findViewById<LinearLayout>(R.id.statsWeekDurationCard)
        val monthCallCard = view.findViewById<LinearLayout>(R.id.statsMonthCallCard)
        val monthDurCard = view.findViewById<LinearLayout>(R.id.statsMonthDurationCard)

        val weekClick = {
            val db = CallLogDb.getInstance(requireContext())
            showDialDetail("一周详情", db.getDailyDurationStats(requireContext(), 7))
        }
        weekCallCard.setOnClickListener { weekClick() }
        weekDurCard.setOnClickListener { weekClick() }

        val todayDay = Calendar.getInstance().get(Calendar.DAY_OF_MONTH)
        val monthClick = {
            val db = CallLogDb.getInstance(requireContext())
            showDialDetail("本月详情", db.getDailyDurationStats(requireContext(), todayDay))
        }
        monthCallCard.setOnClickListener { monthClick() }
        monthDurCard.setOnClickListener { monthClick() }

        // 同步按钮
        visitSyncBtn.setOnClickListener { syncVisitsFromCloud() }

        // 点击统计数字弹出详情
        setupVisitClickListeners()

        // 注册新拨号广播
        try {
            ContextCompat.registerReceiver(requireActivity(), newDialReceiver,
                IntentFilter("com.autodial.NEW_DIAL"),
                ContextCompat.RECEIVER_NOT_EXPORTED
            )
        } catch (_: Exception) {}

        // 注册通话结束广播
        try {
            ContextCompat.registerReceiver(requireActivity(), callEndedReceiver,
                IntentFilter("com.autodial.CALL_ENDED"),
                ContextCompat.RECEIVER_NOT_EXPORTED
            )
        } catch (_: Exception) {}

        // 注册上门登记广播
        try {
            visitReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    refreshIfNeeded()
                }
            }
            ContextCompat.registerReceiver(requireActivity(), visitReceiver!!,
                IntentFilter("com.autodial.VISIT_RECORDED"),
                ContextCompat.RECEIVER_NOT_EXPORTED
            )
        } catch (_: Exception) {}

        refreshIfNeeded()

        // 应用主题
        applyTheme()

        // 注册主题变更监听
        ThemeManager.addOnThemeChangedListener(themeListener)
    }

    override fun onResume() {
        super.onResume()
        refreshIfNeeded()
    }

    fun onThemeChanged() {
        // 主题变更由 themeListener 处理
        themeListener()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        ThemeManager.removeOnThemeChangedListener(themeListener)
        refreshHandler.removeCallbacks(refreshRunnable)
        try { requireActivity().unregisterReceiver(newDialReceiver) } catch (_: Exception) {}
        try { requireActivity().unregisterReceiver(callEndedReceiver) } catch (_: Exception) {}
        try { visitReceiver?.let { requireActivity().unregisterReceiver(it) } } catch (_: Exception) {}
    }

    fun refreshIfNeeded() {
        if (isAdded && !isDetached) {
            loadStats()
        }
    }

    /** 格式化秒数为分钟字符串 */
    private fun formatMinutes(seconds: Long): String {
        if (seconds <= 0) return "0.0"
        val mins = seconds / 60.0
        return if (mins == mins.toLong().toDouble()) {
            mins.toLong().toString()
        } else {
            String.format("%.1f", mins)
        }
    }

    private fun loadStats() {
        if (!isAdded) return
        val db = CallLogDb.getInstance(requireContext())
        try {
            // 今日数据
            val today = db.getTodayCount(requireContext())
            todayCount.text = "${today}次"

            // 今日接通
            val todayConnected = db.getTodayConnectedCount(requireContext())
            val todayRate = if (today > 0) todayConnected * 100 / today else 0
            todayConnect.text = "接通 $todayConnected · $todayRate%"

            // 近7天统计（含通时）
            val stats = db.getDailyDurationStats(requireContext(), 7)

            // 今日通时
            val todayStr = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())
            val todayStats = stats.find { it.date == todayStr }
            val todaySec = todayStats?.totalDurationSec ?: 0
            todayDuration.text = formatMinutes(todaySec)

            // 一周累计（C:通话次数, D:通话分钟）
            val weeklyCount = stats.sumOf { it.count }
            val weeklySec = stats.sumOf { it.totalDurationSec }
            totalCount.text = "${weeklyCount}次"
            totalDuration.text = formatMinutes(weeklySec)

            // 一周接通
            val weekStart = Calendar.getInstance().apply {
                set(Calendar.DAY_OF_WEEK, Calendar.MONDAY)
                set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
                set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
            }.timeInMillis
            val weekConnected = db.getConnectedCountSince(requireContext(), weekStart)
            val weekRate = if (weeklyCount > 0) weekConnected * 100 / weeklyCount else 0
            weekConnect.text = "接通 $weekConnected · $weekRate%"

            // 本月财运/财气
            loadMonthlyStats(db)

            buildChart(stats)
            loadVisitStats()
        } catch (e: Exception) {
            android.util.Log.e("StatsFragment", "加载统计失败: ${e.message}")
        }
    }

    /** 本月财运(E)和财气(F)：从本月1号0点至今 */
    private fun loadMonthlyStats(db: CallLogDb) {
        if (!isAdded) return
        val cal = Calendar.getInstance().apply {
            set(Calendar.DAY_OF_MONTH, 1)
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        val monthStart = cal.timeInMillis
        val monthSec = db.getDialDurationSince(requireContext(), monthStart)
        val monthCount = db.getDialCountSince(requireContext(), monthStart)
        todayLuck.text = "${monthCount}次"
        totalLuck.text = formatMinutes(monthSec)

        // 本月接通
        val monthConnected = db.getConnectedCountSince(requireContext(), monthStart)
        val monthRate = if (monthCount > 0) monthConnected * 100 / monthCount else 0
        monthConnect.text = "接通 $monthConnected · $monthRate%"
    }

    private fun loadVisitStats() {
        if (!isAdded) return
        val prefs = requireContext().getSharedPreferences("autodial", Context.MODE_PRIVATE)

        // 加载存储的完整记录
        val recordsJson = prefs.getString("visit_records", "[]") ?: "[]"
        try {
            val arr = JSONArray(recordsJson)
            val records = mutableListOf<VisitRecord>()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                records.add(VisitRecord(
                    name = obj.optString("name", ""),
                    mobile = obj.optString("mobile", ""),
                    created_at = obj.optString("created_at", ""),
                    timestamp = obj.optLong("timestamp", 0)
                ))
            }
            visitRecords = records
            android.util.Log.d("StatsFragment", "loadVisitStats: ${records.size} records from visit_records")
        } catch (e: Exception) {
            android.util.Log.e("StatsFragment", "loadVisitStats JSON parse error: ${e.message}")
            visitRecords = emptyList()
        }

        val now = System.currentTimeMillis()
        val cal = Calendar.getInstance()

        // 今日 00:00
        cal.timeInMillis = now
        cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
        val todayStart = cal.timeInMillis

        // 本周一 00:00
        cal.timeInMillis = now
        cal.set(Calendar.DAY_OF_WEEK, Calendar.MONDAY)
        cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
        val weekStart = cal.timeInMillis

        // 近7天
        val sevenDaysAgo = now - 7 * 24 * 3600_000L

        // 当月1号 00:00
        cal.timeInMillis = now
        cal.set(Calendar.DAY_OF_MONTH, 1)
        cal.set(Calendar.HOUR_OF_DAY, 0); cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0); cal.set(Calendar.MILLISECOND, 0)
        val monthStart = cal.timeInMillis

        // 上月1号
        cal.add(Calendar.MONTH, -1)
        val lastMonthStart = cal.timeInMillis

        // 近30天
        val thirtyDaysAgo = now - 30 * 24 * 3600_000L

        // 兼容旧数据：从 registration_timestamps 合并
        val oldTimestamps = (prefs.getString("registration_timestamps", "") ?: "")
            .split(",").mapNotNull { it.toLongOrNull() }

        val allTimestamps = (visitRecords.map { it.timestamp } + oldTimestamps).distinct()

        visitToday.text = allTimestamps.count { it >= todayStart }.toString()
        visitWeek.text = allTimestamps.count { it >= weekStart }.toString()
        visit7Days.text = allTimestamps.count { it >= sevenDaysAgo }.toString()
        visitMonth.text = allTimestamps.count { it >= monthStart }.toString()
        visitLastMonth.text = allTimestamps.count { it in lastMonthStart until monthStart }.toString()
        visit30Days.text = allTimestamps.count { it >= thirtyDaysAgo }.toString()
    }

    // ===== 点击统计数字弹出详情 =====

    private fun setupVisitClickListeners() {
        visitToday.setOnClickListener { showVisitDetail("今日上门") { it.timestamp >= todayStart() } }
        visitWeek.setOnClickListener { showVisitDetail("本周上门") { it.timestamp >= weekStart() } }
        visit7Days.setOnClickListener { showVisitDetail("近7天上门") { it.timestamp >= System.currentTimeMillis() - 7 * 24 * 3600_000L } }
        visitMonth.setOnClickListener { showVisitDetail("当月上门") { it.timestamp >= monthStart() } }
        visitLastMonth.setOnClickListener {
            val ms = monthStart() - 1
            val cal = Calendar.getInstance().apply {
                timeInMillis = ms
                set(Calendar.DAY_OF_MONTH, 1)
                set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
                set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
            }
            val lastMonthStart = cal.timeInMillis
            showVisitDetail("上月上门") { it.timestamp in lastMonthStart until (monthStart()) }
        }
        visit30Days.setOnClickListener { showVisitDetail("近30天上门") { it.timestamp >= System.currentTimeMillis() - 30 * 24 * 3600_000L } }
    }

    private fun todayStart(): Long {
        val cal = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        return cal.timeInMillis
    }

    private fun weekStart(): Long {
        val cal = Calendar.getInstance().apply {
            set(Calendar.DAY_OF_WEEK, Calendar.MONDAY)
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        return cal.timeInMillis
    }

    private fun monthStart(): Long {
        val cal = Calendar.getInstance().apply {
            set(Calendar.DAY_OF_MONTH, 1)
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        return cal.timeInMillis
    }

    private fun showVisitDetail(title: String, filter: (VisitRecord) -> Boolean) {
        if (!isAdded) return
        val filtered = visitRecords.filter(filter).sortedByDescending { it.timestamp }
        if (filtered.isEmpty()) {
            Toast.makeText(requireContext(), "暂无上门记录", Toast.LENGTH_SHORT).show()
            return
        }

        val colors = ThemeManager.getColors(requireContext())
        val dp = resources.displayMetrics.density
        val timeFmt = SimpleDateFormat("MM-dd HH:mm", Locale.getDefault())

        val dialog = BottomSheetDialog(requireContext())
        dialog.window?.setBackgroundDrawableResource(android.R.color.transparent)

        val root = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((20 * dp).toInt(), (16 * dp).toInt(), (20 * dp).toInt(), (16 * dp).toInt())
            setBackgroundColor(Color.parseColor(colors.bg))
        }

        root.addView(TextView(requireContext()).apply {
            text = "$title（${filtered.size}条）"
            textSize = 16f
            setTextColor(Color.parseColor(colors.primaryLight))
            setTypeface(null, android.graphics.Typeface.BOLD)
            setPadding(0, 0, 0, (12 * dp).toInt())
        })

        // 可滚动数据区
        val scrollView = android.widget.ScrollView(requireContext()).apply {
            layoutParams = LinearLayout.LayoutParams(-1, 0, 1f)
        }
        val scrollContent = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
        }

        for ((i, r) in filtered.withIndex()) {
            val timeStr = if (r.timestamp > 0) timeFmt.format(Date(r.timestamp)) else r.created_at
            scrollContent.addView(TextView(requireContext()).apply {
                text = "${i + 1}. ${r.name}  ${r.mobile}\n   $timeStr"
                textSize = 14f
                setTextColor(Color.parseColor(colors.text))
                setPadding(0, 0, 0, (8 * dp).toInt())
            })
        }

        scrollView.addView(scrollContent)
        root.addView(scrollView)

        root.addView(TextView(requireContext()).apply {
            text = "关闭"
            textSize = 14f
            setTextColor(Color.parseColor(colors.text2))
            gravity = Gravity.CENTER
            setPadding(0, (12 * dp).toInt(), 0, 0)
            setOnClickListener { dialog.dismiss() }
        })

        dialog.setContentView(root)
        dialog.show()
        dialog.window?.setLayout(
            LinearLayout.LayoutParams.MATCH_PARENT,
            (resources.displayMetrics.heightPixels * 0.6).toInt().coerceAtMost((600 * dp).toInt())
        )
    }

    // ===== 云端同步上门数据 =====

    private fun syncVisitsFromCloud() {
        if (!isAdded) return
        visitSyncBtn.text = "同步中..."
        visitSyncBtn.isEnabled = false

        executor.execute {
            val prefs = requireContext().getSharedPreferences("autodial", Context.MODE_PRIVATE)
            val serverUrl = prefs.getString("cloud_server", "") ?: ""
            val pin = prefs.getString("pin", "") ?: ""

            if (serverUrl.isEmpty() || pin.isEmpty()) {
                refreshHandler.post {
                    if (isAdded) {
                        Toast.makeText(requireContext(), "请先连接云端并设置 PIN", Toast.LENGTH_SHORT).show()
                        resetSyncBtn()
                    }
                }
                return@execute
            }

            // URL 转换 (ws:// → http://)
            var baseUrl = serverUrl.trim()
            if (baseUrl.startsWith("wss://")) baseUrl = baseUrl.replace("wss://", "https://")
            else if (baseUrl.startsWith("ws://")) baseUrl = baseUrl.replace("ws://", "http://")
            else if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://"))
                baseUrl = "http://$baseUrl"
            baseUrl = baseUrl.removeSuffix("/")

            try {
                val url = URL("$baseUrl/api/v1/visits?pin=${URLEncoder.encode(pin, "UTF-8")}")
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.connectTimeout = 10000
                conn.readTimeout = 10000
                conn.setRequestProperty("X-AutoDial-PIN", pin)

                if (conn.responseCode !in 200..299) {
                    refreshHandler.post {
                        if (isAdded) {
                            Toast.makeText(requireContext(), "云端连接失败 (${conn.responseCode})", Toast.LENGTH_SHORT).show()
                            resetSyncBtn()
                        }
                    }
                    conn.disconnect()
                    return@execute
                }

                val body = conn.inputStream.bufferedReader().readText()
                conn.disconnect()

                val arr = JSONArray(body)

                // 以云端为准：直接用云端数据替换本地记录
                val newRecords = JSONArray()
                for (i in 0 until arr.length()) {
                    val item = arr.getJSONObject(i)
                    val ts = parseTimestamp(item.optString("created_at", ""))
                    if (ts > 0) {
                        newRecords.put(JSONObject().apply {
                            put("name", item.optString("name", ""))
                            put("mobile", item.optString("mobile", ""))
                            put("created_at", item.optString("created_at", ""))
                            put("timestamp", ts)
                        })
                    }
                }

                prefs.edit()
                    .putString("visit_records", newRecords.toString())
                    .putString("registration_timestamps", "") // 清理旧格式
                    .apply()

                refreshHandler.post {
                    if (isAdded) {
                        val count = newRecords.length()
                        val msg = if (count > 0) "✅ 同步完成，共 ${count} 条上门记录"
                                  else "📋 云端暂无上门记录"
                        Toast.makeText(requireContext(), msg, Toast.LENGTH_SHORT).show()
                        resetSyncBtn()
                        loadVisitStats()
                    }
                }
            } catch (e: Exception) {
                refreshHandler.post {
                    if (isAdded) {
                        Toast.makeText(requireContext(), "❌ 同步失败，请检查云端连接", Toast.LENGTH_SHORT).show()
                        resetSyncBtn()
                    }
                }
            }
        }
    }

    private fun resetSyncBtn() {
        if (!isAdded) return
        visitSyncBtn.text = "同步"
        visitSyncBtn.isEnabled = true
    }

    /** 解析 created_at (如 "2026-07-01T12:00:00") 为毫秒时间戳 */
    private fun parseTimestamp(createdAt: String): Long {
        if (createdAt.isEmpty()) return 0
        return try {
            val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.getDefault())
            sdf.parse(createdAt)?.time ?: 0
        } catch (_: Exception) { 0 }
    }

    data class VisitRecord(
        val name: String,
        val mobile: String,
        val created_at: String,
        val timestamp: Long
    )

    private fun buildChart(stats: List<CallLogDb.DayStats>) {
        chartContainer.removeAllViews()
        dateLabels.removeAllViews()

        val colors = ThemeManager.getColors(requireContext())
        val maxCount = (stats.maxOfOrNull { it.count } ?: 1).coerceAtLeast(1)

        val barColors = intArrayOf(
            Color.parseColor("#FF4444"),   // 红
            Color.parseColor("#FF8C00"),   // 橙
            Color.parseColor("#FFD700"),   // 黄
            Color.parseColor("#4CAF50"),   // 绿
            Color.parseColor("#00BCD4"),   // 青
            Color.parseColor("#2196F3"),   // 蓝
            Color.parseColor("#9C27B0")    // 紫
        )

        val maxBarHeightPx = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, 90f, resources.displayMetrics).toInt()
        val barWidthPx = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, 24f, resources.displayMetrics).toInt()
        val minHeightPx = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, 4f, resources.displayMetrics).toInt()
        val chartHeightPx = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, 140f, resources.displayMetrics).toInt()

        for (i in stats.indices) {
            val s = stats[i]

            // 柱子
            val barWrapper = LinearLayout(requireContext()).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(0, chartHeightPx, 1f)
            }

            // 通时标签（柱子上方，如 "12分"）
            val durationLabel = TextView(requireContext()).apply {
                text = if (s.totalDurationSec > 0) formatMinutes(s.totalDurationSec) + "分" else ""
                textSize = 9f
                setTextColor(Color.parseColor(colors.text2))
                gravity = Gravity.CENTER_HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = 2 }
            }
            barWrapper.addView(durationLabel)

            // 数量标签
            val countLabel = TextView(requireContext()).apply {
                text = if (s.count > 0) s.count.toString() else ""
                textSize = 11f
                setTextColor(Color.parseColor(colors.text2))
                gravity = Gravity.CENTER_HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = 4 }
            }
            barWrapper.addView(countLabel)

            // 柱子本身
            val actualBarHeight = if (s.count > 0) {
                ((s.count.toFloat() / maxCount) * maxBarHeightPx).toInt().coerceAtLeast(barWidthPx)
            } else {
                minHeightPx
            }
            val bar = View(requireContext()).apply {
                layoutParams = LinearLayout.LayoutParams(barWidthPx, actualBarHeight).apply {
                    gravity = Gravity.CENTER_HORIZONTAL
                }
                setBackgroundColor(if (s.count > 0) barColors[i] else Color.parseColor(colors.bg3))
            }
            barWrapper.addView(bar)

            chartContainer.addView(barWrapper)

            // 日期标签
            val dateLabel = TextView(requireContext()).apply {
                val cal = Calendar.getInstance()
                cal.add(Calendar.DAY_OF_MONTH, -(6 - i))
                val dayOfWeek = dayOfWeekFormat.format(cal.time)
                val dateStr = s.date.substring(5) // MM-dd
                text = "$dayOfWeek\n$dateStr"
                textSize = 10f
                setTextColor(Color.parseColor(colors.text2))
                gravity = Gravity.CENTER_HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    .apply { topMargin = 8 }
                setPadding(0, 0, 0, 0)
            }
            dateLabels.addView(dateLabel)
        }
    }

    /** 弹窗展示每日拨号明细（全宽卡片式，仿拨号模式选择器风格） */
    private fun showDialDetail(title: String, dailyStats: List<CallLogDb.DayStats>) {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        val dp = resources.displayMetrics.density

        val dialog = BottomSheetDialog(requireContext())
        dialog.window?.setBackgroundDrawableResource(android.R.color.transparent)

        val root = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((16 * dp).toInt(), (14 * dp).toInt(), (16 * dp).toInt(), (16 * dp).toInt())
            setBackgroundColor(Color.parseColor(colors.bg))
        }

        // 标题
        root.addView(TextView(requireContext()).apply {
            text = title
            textSize = 18f
            setTextColor(Color.parseColor(colors.primaryLight))
            setTypeface(null, android.graphics.Typeface.BOLD)
            setPadding(0, 0, 0, (10 * dp).toInt())
        })

        // 列名小标题
        root.addView(LinearLayout(requireContext()).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding((12 * dp).toInt(), 0, (12 * dp).toInt(), (6 * dp).toInt())
            val hdrs = arrayOf("日期", "呼出", "接通", "接通率", "通时")
            val hdrWeights = floatArrayOf(1.5f, 1f, 1f, 1f, 1.2f)
            for (i in hdrs.indices) {
                addView(TextView(requireContext()).apply {
                    text = hdrs[i]
                    textSize = 11f
                    setTextColor(Color.parseColor(colors.text2))
                    gravity = i == 0 ? Gravity.START or Gravity.CENTER_VERTICAL else Gravity.CENTER
                    layoutParams = LinearLayout.LayoutParams(0, -2, hdrWeights[i])
                })
            }
        })

        // 可滚动数据区
        val scrollView = android.widget.ScrollView(requireContext()).apply {
            layoutParams = LinearLayout.LayoutParams(-1, 0, 1f)
            setPadding(0, 0, 0, 0)
        }
        val scrollContent = LinearLayout(requireContext()).apply {
            orientation = LinearLayout.VERTICAL
        }

        // 每日卡片行（单行，列宽自适应全屏，近→远）
        for (s in dailyStats.reversed()) {
            val rate = if (s.count > 0) s.connectedCount * 100 / s.count else 0
            val timeStr = "${formatMinutes(s.totalDurationSec)}分"

            scrollContent.addView(LinearLayout(requireContext()).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
                background = android.graphics.drawable.GradientDrawable().apply {
                    setColor(Color.parseColor(colors.bg2))
                    cornerRadius = 12 * dp
                }
                layoutParams = LinearLayout.LayoutParams(-1, -2).apply {
                    bottomMargin = (6 * dp).toInt()
                }

                // 日期
                addView(TextView(requireContext()).apply {
                    text = s.date.substring(5)
                    textSize = 13f
                    setTextColor(Color.parseColor(colors.text2))
                    layoutParams = LinearLayout.LayoutParams(0, -2, 1.5f)
                })
                // 呼出
                addView(TextView(requireContext()).apply {
                    text = s.count.toString()
                    textSize = 13f
                    setTextColor(Color.parseColor(colors.text))
                    gravity = Gravity.CENTER
                    layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
                })
                // 接通
                addView(TextView(requireContext()).apply {
                    text = s.connectedCount.toString()
                    textSize = 13f
                    setTextColor(Color.parseColor(colors.text))
                    gravity = Gravity.CENTER
                    layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
                })
                // 接通率
                addView(TextView(requireContext()).apply {
                    text = "$rate%"
                    textSize = 13f
                    setTextColor(Color.parseColor(colors.primary))
                    gravity = Gravity.CENTER
                    layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
                })
                // 通时
                addView(TextView(requireContext()).apply {
                    text = timeStr
                    textSize = 13f
                    setTextColor(Color.parseColor(colors.text))
                    gravity = Gravity.CENTER
                    layoutParams = LinearLayout.LayoutParams(0, -2, 1.2f)
                })
            })
        }

        scrollView.addView(scrollContent)
        root.addView(scrollView)

        // 关闭按钮
        root.addView(TextView(requireContext()).apply {
            text = "关闭"
            textSize = 14f
            setTextColor(Color.parseColor(colors.text2))
            gravity = Gravity.CENTER
            setPadding(0, (12 * dp).toInt(), 0, 0)
            setOnClickListener { dialog.dismiss() }
        })

        dialog.setContentView(root)
        dialog.show()
        // 限制弹窗最大高度为屏幕 60%，超出的内容在 ScrollView 内滚动
        val screenHeight = resources.displayMetrics.heightPixels
        dialog.window?.setLayout(
            LinearLayout.LayoutParams.MATCH_PARENT,
            (screenHeight * 0.6).toInt().coerceAtMost((600 * dp).toInt())
        )
    }

    private fun applyTheme() {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        ThemeManager.applyToView(requireView(), colors)

        // 保留“鸿运当头、紫气东来”的固定寓意色，不随主题覆盖。
        todayCount.setTextColor(Color.parseColor("#E53935"))
        todayDuration.setTextColor(Color.parseColor("#7B2CBF"))
    }
}
