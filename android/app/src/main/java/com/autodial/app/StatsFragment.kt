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
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import java.text.SimpleDateFormat
import java.util.*

class StatsFragment : Fragment() {

    private lateinit var todayCount: TextView
    private lateinit var totalCount: TextView
    private lateinit var todayDuration: TextView
    private lateinit var totalDuration: TextView
    private lateinit var todayLuck: TextView
    private lateinit var totalLuck: TextView
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

    private val refreshHandler = Handler(Looper.getMainLooper())
    private val refreshRunnable = Runnable { refreshIfNeeded() }

    private val dayOfWeekFormat = SimpleDateFormat("E", Locale.getDefault())

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
        chartContainer = view.findViewById(R.id.statsChartContainer)
        dateLabels = view.findViewById(R.id.statsDateLabels)

        // 注册新拨号广播
        try {
            ContextCompat.registerReceiver(requireActivity(), newDialReceiver,
                IntentFilter("com.autodial.NEW_DIAL"),
                ContextCompat.RECEIVER_EXPORTED
            )
        } catch (_: Exception) {}

        // 注册通话结束广播
        try {
            ContextCompat.registerReceiver(requireActivity(), callEndedReceiver,
                IntentFilter("com.autodial.CALL_ENDED"),
                ContextCompat.RECEIVER_EXPORTED
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
            todayCount.text = today.toString()

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
            totalCount.text = weeklyCount.toString()
            totalDuration.text = formatMinutes(weeklySec)

            // 本月财运/财气
            loadMonthlyStats(db)

            buildChart(stats)
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
        todayLuck.text = monthCount.toString()
        totalLuck.text = formatMinutes(monthSec)
    }

    private fun buildChart(stats: List<CallLogDb.DayStats>) {
        chartContainer.removeAllViews()
        dateLabels.removeAllViews()

        val colors = ThemeManager.getColors(requireContext())
        val maxCount = (stats.maxOfOrNull { it.count } ?: 1).coerceAtLeast(1)

        val barColors = intArrayOf(
            Color.parseColor(colors.gold),
            Color.parseColor(colors.goldLight),
            Color.parseColor(colors.gold),
            Color.parseColor(colors.green),
            Color.parseColor(colors.gold),
            Color.parseColor(colors.goldLight),
            Color.parseColor("#4F8EF7")   // 今日用蓝色突出
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

    private fun applyTheme() {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        ThemeManager.applyToView(requireView(), colors)
    }
}
