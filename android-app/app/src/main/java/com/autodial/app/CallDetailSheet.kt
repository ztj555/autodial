package com.autodial.app

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.CallLog
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.bottomsheet.BottomSheetDialog
import java.text.SimpleDateFormat
import java.util.*

/**
 * 通话详情 BottomSheet — 替代 AlertDialog
 * 显示号码/时间/时长/通话类型/SIM卡 + 立即拨号按钮
 */
class CallDetailSheet(
    private val activity: Activity,
    private val record: PhoneCallRecord
) : BottomSheetDialog(activity) {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val colors = ThemeManager.getColors(activity)
        window?.setBackgroundDrawableResource(android.R.color.transparent)

        val dp = activity.resources.displayMetrics.density

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((20 * dp).toInt(), (16 * dp).toInt(), (20 * dp).toInt(), (28 * dp).toInt())
            setBackgroundColor(Color.parseColor(colors.bg))
        }

        // 号码（完整显示，不脱敏）
        root.addView(TextView(activity).apply {
            text = record.number
            textSize = 22f
            setTextColor(Color.parseColor(colors.text))
            setTypeface(null, android.graphics.Typeface.BOLD)
            setPadding(0, 0, 0, (12 * dp).toInt())
        })

        // 时间
        val timeFmt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
        addDetailRow(root, activity, colors, dp, "时间", timeFmt.format(Date(record.time)))

        // 通话类型
        val typeText = when (record.type) {
            CallLog.Calls.OUTGOING_TYPE -> "拨出"
            CallLog.Calls.INCOMING_TYPE -> "来电"
            CallLog.Calls.MISSED_TYPE -> "未接"
            else -> "其他"
        }
        addDetailRow(root, activity, colors, dp, "类型", typeText)

        // 通话时长
        val durationText = formatDuration(record.duration)
        addDetailRow(root, activity, colors, dp, "时长", durationText)

        // SIM 卡
        addDetailRow(root, activity, colors, dp, "SIM 卡", "卡${record.simSlot + 1}")

        // 分割线
        root.addView(android.view.View(activity).apply {
            setBackgroundColor(Color.parseColor(colors.bg3))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, (1 * dp).toInt()
            ).apply {
                topMargin = (16 * dp).toInt()
                bottomMargin = (16 * dp).toInt()
            }
        })

        // 立即拨号按钮
        root.addView(TextView(activity).apply {
            text = "立即拨号"
            textSize = 16f
            setTextColor(Color.parseColor(colors.bg))
            gravity = Gravity.CENTER
            setPadding(0, (14 * dp).toInt(), 0, (14 * dp).toInt())
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                setColor(Color.parseColor(colors.primary))
                cornerRadius = 14 * dp
            }
            setOnClickListener {
                try {
                    val intent = Intent(Intent.ACTION_CALL).apply {
                        data = Uri.parse("tel:${record.number}")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    activity.startActivity(intent)
                } catch (e: Exception) {
                    Toast.makeText(activity, "拨号失败: ${e.message}", Toast.LENGTH_SHORT).show()
                }
                dismiss()
            }
        })

        // 关闭按钮
        root.addView(TextView(activity).apply {
            text = "关闭"
            textSize = 14f
            setTextColor(Color.parseColor(colors.text2))
            gravity = Gravity.CENTER
            setPadding(0, (12 * dp).toInt(), 0, 0)
            setOnClickListener { dismiss() }
        })

        setContentView(root)
    }

    private fun addDetailRow(
        root: LinearLayout,
        ctx: Context,
        colors: ThemeColors,
        dp: Float,
        label: String,
        value: String
    ) {
        root.addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = (8 * dp).toInt()
            }
            addView(TextView(ctx).apply {
                text = label
                textSize = 14f
                setTextColor(Color.parseColor(colors.text2))
                layoutParams = LinearLayout.LayoutParams(
                    (80 * dp).toInt(),
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
            })
            addView(TextView(ctx).apply {
                text = value
                textSize = 14f
                setTextColor(Color.parseColor(colors.text))
                setTypeface(null, android.graphics.Typeface.BOLD)
            })
        })
    }

    private fun formatDuration(seconds: Long): String {
        return when {
            seconds <= 0 -> "-"
            seconds < 60 -> "${seconds}秒"
            else -> "${seconds / 60}分${seconds % 60}秒"
        }
    }

    companion object {
        fun show(activity: Activity, record: PhoneCallRecord) {
            val dialog = CallDetailSheet(activity, record)
            dialog.show()
            dialog.window?.setLayout(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
    }
}
