package com.autodial.app

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * 拨号动画效果选择 BottomSheet — 网格展示 11 种动画
 * 参考 ThemeDialog 的 BottomSheetDialog + Grid 模式
 */
class AnimationSheet(private val activity: Activity) : BottomSheetDialog(activity) {

    data class AnimOption(val key: Int, val name: String, val desc: String)

    private val animations = listOf(
        AnimOption(DialAnimationOverlay.MODE_OFF, "关闭", "不显示动画"),
        AnimOption(DialAnimationOverlay.MODE_BOUNCE, "弹跳飞入", "文字飞入并跳动"),
        AnimOption(DialAnimationOverlay.MODE_FIREWORK, "烟花绽放", "文字弹出并伴随粒子"),
        AnimOption(DialAnimationOverlay.MODE_COMBINE, "弹跳+烟花", "两种效果组合"),
        AnimOption(DialAnimationOverlay.MODE_PULSE, "脉冲扩散", "多层同心圆波纹"),
        AnimOption(DialAnimationOverlay.MODE_SPARKLE, "闪烁星光", "光晕与随机星点"),
        AnimOption(DialAnimationOverlay.MODE_SLIDE_UP, "向上滑入", "从屏幕底部升起"),
        AnimOption(DialAnimationOverlay.MODE_FADE_SCALE, "缩放淡入", "由小变大并淡入"),
        AnimOption(DialAnimationOverlay.MODE_SHAKE, "左右抖动", "趣味横向抖动"),
        AnimOption(DialAnimationOverlay.MODE_FLIP_IN, "翻转进入", "水平翻转出现"),
        AnimOption(DialAnimationOverlay.MODE_HEARTBEAT, "心跳脉冲", "连续缩放心跳")
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val colors = ThemeManager.getColors(activity)
        window?.setBackgroundDrawableResource(android.R.color.transparent)

        val dp = activity.resources.displayMetrics.density
        val prefs = activity.getSharedPreferences("autodial", Context.MODE_PRIVATE)
        val currentAnim = prefs.getInt("dial_animation_mode", DialAnimationOverlay.MODE_BOUNCE)

        val root = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((16 * dp).toInt(), (12 * dp).toInt(), (16 * dp).toInt(), (24 * dp).toInt())
            setBackgroundColor(Color.parseColor(colors.bg))
        }

        // 标题
        root.addView(TextView(activity).apply {
            text = "选择拨号动画"
            textSize = 18f
            setTextColor(Color.parseColor(colors.primaryLight))
            setTypeface(null, android.graphics.Typeface.BOLD)
            setPadding(0, 0, 0, (12 * dp).toInt())
        })

        // 网格: 2 列
        val columnCount = 2
        val rows = (animations.size + columnCount - 1) / columnCount

        for (row in 0 until rows) {
            val rowLayout = LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                )
            }
            for (col in 0 until columnCount) {
                val index = row * columnCount + col
                if (index >= animations.size) break

                val anim = animations[index]
                val card = createAnimCard(activity, anim, dp, colors)
                card.layoutParams = LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f
                ).apply {
                    marginStart = (3 * dp).toInt()
                    marginEnd = (3 * dp).toInt()
                    bottomMargin = (8 * dp).toInt()
                }

                if (anim.key == currentAnim) {
                    highlightCard(card, colors, dp)
                }

                card.setOnClickListener {
                    prefs.edit().putInt("dial_animation_mode", anim.key).apply()
                    dismiss()
                }

                rowLayout.addView(card)
            }
            root.addView(rowLayout)
        }

        // 预览按钮
        root.addView(TextView(activity).apply {
            text = "预览当前动画"
            textSize = 14f
            setTextColor(Color.parseColor(colors.primaryLight))
            gravity = Gravity.CENTER
            setPadding(0, (14 * dp).toInt(), 0, (14 * dp).toInt())
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = (8 * dp).toInt()
            }
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = 12 * dp
                setStroke((1.5f * dp).toInt(), Color.parseColor(colors.primary))
                setColor(Color.TRANSPARENT)
            }
            setOnClickListener {
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    DialAnimationOverlay.show(activity)
                }
            }
        })

        setContentView(root)
    }

    private fun createAnimCard(
        ctx: Context,
        anim: AnimOption,
        dp: Float,
        colors: ThemeColors
    ): LinearLayout {
        return LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt())
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                setColor(Color.parseColor(colors.bg2))
                cornerRadius = 10 * dp
            }
            addView(TextView(ctx).apply {
                text = anim.name
                textSize = 13f
                setTextColor(Color.parseColor(colors.text))
                setTypeface(null, android.graphics.Typeface.BOLD)
            })
            addView(TextView(ctx).apply {
                text = anim.desc
                textSize = 10f
                setTextColor(Color.parseColor(colors.text2))
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = (4 * dp).toInt() }
            })
        }
    }

    private fun highlightCard(card: LinearLayout, colors: ThemeColors, dp: Float) {
        card.background = android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.RECTANGLE
            setColor(Color.parseColor(colors.bg2))
            cornerRadius = 10 * dp
            setStroke((2 * dp).toInt(), Color.parseColor(colors.primary))
        }
    }

    companion object {
        fun show(activity: Activity) {
            val dialog = AnimationSheet(activity)
            dialog.show()
            dialog.window?.setLayout(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
    }
}
