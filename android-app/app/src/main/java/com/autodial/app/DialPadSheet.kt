package com.autodial.app

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * 手动拨号键盘 BottomSheet
 * 数字键盘 + 输入框 + 拨号按钮
 */
class DialPadSheet(private val activity: Activity) : BottomSheetDialog(activity) {

    private var onDial: ((String) -> Unit)? = null

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

        // 输入框 + 删除按钮 横排
        val inputRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val input = EditText(activity).apply {
            hint = "输入电话号码"
            textSize = 22f
            inputType = android.text.InputType.TYPE_CLASS_PHONE
            showSoftInputOnFocus = false
            gravity = Gravity.CENTER_VERTICAL
            setTextColor(Color.parseColor(colors.text))
            setHintTextColor(Color.parseColor(colors.text2))
            setBackgroundColor(Color.parseColor(colors.bg2))
            setPadding((16 * dp).toInt(), (14 * dp).toInt(), (16 * dp).toInt(), (14 * dp).toInt())
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                setColor(Color.parseColor(colors.bg2))
                cornerRadius = 14 * dp
            }
        }
        inputRow.addView(input, LinearLayout.LayoutParams(
            0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f
        ))

        val deleteBtn = TextView(activity).apply {
            text = "⌫"
            textSize = 20f
            setTextColor(Color.parseColor(colors.text2))
            gravity = Gravity.CENTER
            setPadding((12 * dp).toInt(), (10 * dp).toInt(), (12 * dp).toInt(), (10 * dp).toInt())
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                marginStart = (8 * dp).toInt()
            }
            setOnClickListener {
                val text = input.text
                if (text.isNotEmpty()) {
                    text.delete(text.length - 1, text.length)
                }
            }
        }
        inputRow.addView(deleteBtn)
        root.addView(inputRow)

        // 数字键盘
        val keys = listOf(
            listOf("1", "2", "3"),
            listOf("4", "5", "6"),
            listOf("7", "8", "9"),
            listOf("*", "0", "#")
        )

        for (row in keys) {
            root.addView(LinearLayout(activity).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply {
                    topMargin = (8 * dp).toInt()
                }
                for (key in row) {
                    addView(TextView(activity).apply {
                        text = key
                        textSize = 20f
                        setTextColor(Color.parseColor(colors.text))
                        gravity = Gravity.CENTER
                        setPadding(0, (16 * dp).toInt(), 0, (16 * dp).toInt())
                        layoutParams = LinearLayout.LayoutParams(
                            0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f
                        ).apply {
                            marginStart = (4 * dp).toInt()
                            marginEnd = (4 * dp).toInt()
                        }
                        background = android.graphics.drawable.GradientDrawable().apply {
                            shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                            setColor(Color.parseColor(colors.bg2))
                            cornerRadius = 12 * dp
                        }
                        setOnClickListener { input.append(key) }
                    })
                }
            })
        }

        // 拨号按钮
        root.addView(TextView(activity).apply {
            text = "立即拨号"
            textSize = 16f
            setTextColor(Color.parseColor(colors.bg))
            gravity = Gravity.CENTER
            setPadding(0, (14 * dp).toInt(), 0, (14 * dp).toInt())
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = (12 * dp).toInt()
            }
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                setColor(Color.parseColor(colors.primary))
                cornerRadius = 14 * dp
            }
            setOnClickListener {
                val number = input.text.toString().trim()
                if (number.isEmpty()) {
                    Toast.makeText(activity, "请输入电话号码", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                onDial?.invoke(number)
                dismiss()
            }
        })

        setContentView(root)
    }

    fun setOnDialListener(listener: (String) -> Unit) {
        onDial = listener
    }

    companion object {
        fun show(activity: Activity, onDial: (String) -> Unit) {
            val dialog = DialPadSheet(activity)
            dialog.setOnDialListener(onDial)
            dialog.show()
            dialog.window?.setLayout(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
    }
}
