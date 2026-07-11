package com.autodial.app

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.material.bottomsheet.BottomSheetDialog

class ConnectionStrategySheet(
    private val activity: Activity,
    private val onSelected: (ConnectionStrategy) -> Unit
) : BottomSheetDialog(activity) {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val palette = ThemeManager.getColors(activity)
        val dp = activity.resources.displayMetrics.density
        val current = PrefCtrl(activity).getConnectionStrategy()
        val descriptions = mapOf(
            ConnectionStrategy.AUTO to "局域网优先，局域网不可用时自动使用云中转",
            ConnectionStrategy.LAN_ONLY to "仅连接同一局域网内的电脑，不启用云中转",
            ConnectionStrategy.CLOUD_ONLY to "仅通过云服务器连接，适合不同网络环境"
        )

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((16 * dp).toInt(), (14 * dp).toInt(), (16 * dp).toInt(), (24 * dp).toInt())
            setBackgroundColor(Color.parseColor(palette.bg))
        }
        root.addView(TextView(activity).apply {
            text = "连接策略"
            textSize = 18f
            setTypeface(null, android.graphics.Typeface.BOLD)
            setTextColor(Color.parseColor(palette.text))
            setPadding(0, 0, 0, (10 * dp).toInt())
        })

        ConnectionStrategy.entries.forEach { strategy ->
            root.addView(LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding((12 * dp).toInt(), (11 * dp).toInt(), (12 * dp).toInt(), (11 * dp).toInt())
                background = android.graphics.drawable.GradientDrawable().apply {
                    setColor(Color.parseColor(palette.bg2))
                    cornerRadius = 12 * dp
                    if (strategy == current) {
                        setStroke((2 * dp).toInt(), Color.parseColor(palette.primary))
                    }
                }
                layoutParams = LinearLayout.LayoutParams(-1, -2).apply {
                    bottomMargin = (8 * dp).toInt()
                }
                addView(LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
                    addView(TextView(activity).apply {
                        text = strategy.label
                        textSize = 14f
                        setTypeface(null, android.graphics.Typeface.BOLD)
                        setTextColor(Color.parseColor(palette.text))
                    })
                    addView(TextView(activity).apply {
                        text = descriptions.getValue(strategy)
                        textSize = 11f
                        setTextColor(Color.parseColor(palette.text2))
                        setPadding(0, (4 * dp).toInt(), 0, 0)
                    })
                })
                addView(TextView(activity).apply {
                    text = if (strategy == current) "✓" else ""
                    textSize = 18f
                    setTextColor(Color.parseColor(palette.primary))
                })
                setOnClickListener {
                    onSelected(strategy)
                    dismiss()
                }
            })
        }
        setContentView(root)
    }
}
