package com.autodial.app

import android.content.Context
import android.graphics.*
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import java.util.Random

/**
 * 拨号成功后的视觉反馈动画悬浮窗
 *
 * 五种模式：
 * - MODE_BOUNCE (2): 弹性弹跳 - 文字从左侧弹性飞入，跳动两下后稳定居中 [默认]
 * - MODE_FIREWORK (1): 烟花绽放 - 文字从中心放大弹出，粒子火花四溅
 * - MODE_COMBINE (3): 结合 - 弹性飞入 + 烟花绽放
 * - MODE_PULSE (4): 脉冲扩散 - 多层同心圆向外扩散
 * - MODE_SPARKLE (5): 闪烁星光 - 文字亮起，星点随机闪烁
 *
 * 使用 WindowManager 全屏悬浮窗
 */
object DialAnimationOverlay {

    private const val TAG = "DialAnimation"
    private var windowManager: WindowManager? = null
    private var overlayView: OverlayView? = null
    private val handler = Handler(Looper.getMainLooper())
    private val dismissRunnable = Runnable { dismissInternal() }

    const val MODE_OFF = 0
    const val MODE_FIREWORK = 1
    const val MODE_BOUNCE = 2
    const val MODE_COMBINE = 3
    const val MODE_PULSE = 4
    const val MODE_SPARKLE = 5
    const val MODE_SLIDE_UP = 6
    const val MODE_FADE_SCALE = 7
    const val MODE_SHAKE = 8
    const val MODE_FLIP_IN = 9
    const val MODE_HEARTBEAT = 10

    /** 所有效果标签 */
    val MODE_LABELS = mapOf(
        MODE_OFF to "关闭",
        MODE_BOUNCE to "弹跳飞入",
        MODE_FIREWORK to "烟花绽放",
        MODE_COMBINE to "弹跳+烟花",
        MODE_PULSE to "脉冲扩散",
        MODE_SPARKLE to "闪烁星光",
        MODE_SLIDE_UP to "向上滑入",
        MODE_FADE_SCALE to "缩放淡入",
        MODE_SHAKE to "左右抖动",
        MODE_FLIP_IN to "翻转进入",
        MODE_HEARTBEAT to "心跳脉冲"
    )

    /** 从 SharedPreferences 读取动画模式 */
    fun loadMode(context: Context): Int {
        return context.getSharedPreferences("autodial", Context.MODE_PRIVATE)
            .getInt("dial_animation_mode", MODE_BOUNCE)
    }

    /** 从 SharedPreferences 读取自定义文字 */
    fun loadText(context: Context): String {
        return context.getSharedPreferences("autodial", Context.MODE_PRIVATE)
            .getString("dial_animation_text", "财运+1") ?: "财运+1"
    }

    /**
     * 显示动画（仅当模式不为 OFF 时）
     * @param context Context
     */
    fun show(context: Context) {
        val mode = loadMode(context)
        if (mode == MODE_OFF) return

        val text = loadText(context)
        show(context, text, mode)
    }

    /**
     * 显示动画
     * @param context Context
     * @param text 显示文字
     * @param mode 动画模式 (MODE_FIREWORK / MODE_BOUNCE / MODE_COMBINE)
     */
    fun show(context: Context, text: String, mode: Int) {
        handler.post {
            try {
                // 先移除已有的
                dismissInternal()
                windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager

                val params = WindowManager.LayoutParams().apply {
                    width = WindowManager.LayoutParams.MATCH_PARENT
                    height = WindowManager.LayoutParams.MATCH_PARENT
                    gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
                    flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                    format = PixelFormat.TRANSLUCENT

                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    } else {
                        @Suppress("DEPRECATION")
                        type = WindowManager.LayoutParams.TYPE_SYSTEM_ALERT
                    }
                }

                overlayView = OverlayView(context, text, mode)
                windowManager?.addView(overlayView, params)

                // 1.8秒后自动消失
                handler.postDelayed(dismissRunnable, 1800)

                Log.d(TAG, "动画已显示 (mode=$mode, text=$text)")
            } catch (e: Exception) {
                Log.e(TAG, "显示动画失败: ${e.message}")
            }
        }
    }

    /**
     * 移除动画
     */
    fun dismiss() {
        handler.post { dismissInternal() }
    }

    private fun dismissInternal() {
        handler.removeCallbacks(dismissRunnable)
        try {
            overlayView?.let {
                windowManager?.removeView(it)
            }
        } catch (_: Exception) {}
        overlayView = null
        windowManager = null  // D4修复: 置空防止 Context 引用泄漏
    }

    // ==================== 自定义绘制 View ====================

    private class OverlayView(
        context: Context,
        private val text: String,
        private val mode: Int
    ) : android.view.View(context) {

        private val dp = context.resources.displayMetrics.density
        private val random = Random()
        private val startTime = System.currentTimeMillis()
        private val totalDuration = 1500L // 1.5秒总时长

        // 渐变着色器
        private val textShader: LinearGradient = LinearGradient(
            0f, 0f, 200 * dp, 0f,
            intArrayOf(Color.parseColor("#FFD700"), Color.parseColor("#FF8C00"), Color.parseColor("#FF4500")),
            null, Shader.TileMode.CLAMP
        )

        private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = textShader
            textSize = 42 * dp
            typeface = Typeface.DEFAULT_BOLD
            textAlign = Paint.Align.CENTER
            // 轻微阴影增加光泽感
            setShadowLayer(6 * dp, 0f, 2 * dp, Color.parseColor("#55330000"))
        }

        // 粒子系统
        private val particles = mutableListOf<Particle>()
        private var particlesInitialized = false

        init {
            // 生成粒子
            initParticles()
        }

        private fun initParticles() {
            particles.clear()
            if (mode == MODE_FIREWORK || mode == MODE_COMBINE) {
                // 生成 40 个粒子
                for (i in 0 until 40) {
                    val angle = random.nextFloat() * Math.PI * 2
                    val speed = (2f + random.nextFloat() * 4f) * dp
                    particles.add(Particle(
                        x = 0f,
                        y = 0f,
                        vx = (Math.cos(angle) * speed).toFloat(),
                        vy = (Math.sin(angle) * speed).toFloat(),
                        size = (2 + random.nextFloat() * 4) * dp,
                        life = 0.4f + random.nextFloat() * 0.4f, // 生命周期 40%~80%
                        delay = random.nextFloat() * 0.1f, // 延迟 0~10%
                        color = when (random.nextInt(5)) {
                            0 -> Color.parseColor("#FFD700")
                            1 -> Color.parseColor("#FFA500")
                            2 -> Color.parseColor("#FF6347")
                            3 -> Color.parseColor("#FFEC8B")
                            else -> Color.parseColor("#FF4500")
                        }
                    ))
                }
            }
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)

            val elapsed = (System.currentTimeMillis() - startTime).toFloat()
            val progress = (elapsed / totalDuration).coerceIn(0f, 1f)
            val w = width.toFloat()
            val h = height.toFloat()
            val cx = w / 2f
            val cy = h * 2f / 3f  // 屏幕从下往上2/3处

            canvas.save()

            when (mode) {
                MODE_FIREWORK -> drawFirework(canvas, cx, cy, progress)
                MODE_BOUNCE -> drawBounce(canvas, cx, cy, w, progress)
                MODE_COMBINE -> drawCombined(canvas, cx, cy, w, progress)
                MODE_PULSE -> drawPulse(canvas, cx, cy, w, h, progress)
                MODE_SPARKLE -> drawSparkle(canvas, cx, cy, w, h, progress)
                MODE_SLIDE_UP -> drawSlideUp(canvas, cx, cy, h, progress)
                MODE_FADE_SCALE -> drawFadeScale(canvas, cx, cy, progress)
                MODE_SHAKE -> drawShake(canvas, cx, cy, progress)
                MODE_FLIP_IN -> drawFlipIn(canvas, cx, cy, progress)
                MODE_HEARTBEAT -> drawHeartbeat(canvas, cx, cy, progress)
            }

            canvas.restore()

            // 继续动画
            if (progress < 1f) {
                postInvalidateOnAnimation()
            }
        }

        // ==================== 烟花绽放效果 ====================
        private fun drawFirework(canvas: Canvas, cx: Float, cy: Float, progress: Float) {
            // 阶段划分：
            // 0~20%: 文字从 0 缩放到 1.2 (overshoot)
            // 20~35%: 文字从 1.2 回弹到 1.0
            // 35~75%: 文字保持，粒子扩散
            // 75~100%: 全体淡出

            val textAlpha: Int
            val textScale: Float

            when {
                progress < 0.2f -> {
                    val t = progress / 0.2f
                    val eased = easeOutBack(t)
                    textScale = eased * 1.2f
                    textAlpha = 255
                }
                progress < 0.35f -> {
                    val t = (progress - 0.2f) / 0.15f
                    textScale = 1.2f - 0.2f * easeOutQuad(t)
                    textAlpha = 255
                }
                progress < 0.75f -> {
                    textScale = 1.0f
                    textAlpha = 255
                }
                else -> {
                    val t = (progress - 0.75f) / 0.25f
                    textScale = 1.0f
                    textAlpha = (255 * (1f - easeInQuad(t))).toInt()
                }
            }

            // 绘制文字
            textPaint.alpha = textAlpha.coerceIn(0, 255)
            canvas.save()
            canvas.translate(cx, cy)
            canvas.scale(textScale, textScale, 0f, 0f)
            val textY = -(textPaint.fontMetrics.ascent + textPaint.fontMetrics.descent) / 2f
            canvas.drawText(text, 0f, textY, textPaint)
            canvas.restore()

            // 绘制粒子
            drawParticles(canvas, cx, cy, progress)
        }

        // ==================== 弹性弹跳效果 ====================
        private fun drawBounce(canvas: Canvas, cx: Float, cy: Float, w: Float, progress: Float) {
            // 阶段划分：
            // 0~25%: 从左侧 -w 飞到 cx
            // 25~40%: 第一次跳动 (向上)
            // 40~55%: 第二次跳动 (向上，幅度小)
            // 55~85%: 稳定居中
            // 85~100%: 淡出

            val textX: Float
            val textY: Float
            val textAlpha: Int

            when {
                progress < 0.25f -> {
                    val t = progress / 0.25f
                    val eased = easeOutCubic(t)
                    textX = -w / 2f + (w) * eased
                    textY = cy
                    textAlpha = 255
                }
                progress < 0.40f -> {
                    val t = (progress - 0.25f) / 0.15f
                    textX = cx
                    textY = cy - 30 * dp * easeOutQuad(t) * (1f - t)
                    textAlpha = 255
                }
                progress < 0.55f -> {
                    val t = (progress - 0.40f) / 0.15f
                    textX = cx
                    textY = cy - 15 * dp * easeOutQuad(t) * (1f - t)
                    textAlpha = 255
                }
                progress < 0.85f -> {
                    textX = cx
                    textY = cy
                    textAlpha = 255
                }
                else -> {
                    val t = (progress - 0.85f) / 0.15f
                    textX = cx
                    textY = cy
                    textAlpha = (255 * (1f - easeInQuad(t))).toInt()
                }
            }

            // 绘制文字
            textPaint.alpha = textAlpha.coerceIn(0, 255)
            val baselineY = textY - (textPaint.fontMetrics.ascent + textPaint.fontMetrics.descent) / 2f
            canvas.drawText(text, textX, baselineY, textPaint)
        }

        // ==================== 结合效果 ====================
        private fun drawCombined(canvas: Canvas, cx: Float, cy: Float, w: Float, progress: Float) {
            // 阶段划分：
            // 0~25%: 弹性飞入 (从左到中)
            // 25~40%: 弹跳一次
            // 40~55%: 烟花绽放 (放大 + 粒子)
            // 55~75%: 文字保持，粒子扩散
            // 75~100%: 淡出

            val textX: Float
            val textY: Float
            val textScale: Float
            val textAlpha: Int

            when {
                progress < 0.25f -> {
                    val t = progress / 0.25f
                    val eased = easeOutCubic(t)
                    textX = -w / 2f + w * eased
                    textY = cy
                    textScale = 0.8f + 0.2f * eased
                    textAlpha = 255
                }
                progress < 0.40f -> {
                    val t = (progress - 0.25f) / 0.15f
                    textX = cx
                    textY = cy - 25 * dp * easeOutQuad(t) * (1f - t)
                    textScale = 1.0f
                    textAlpha = 255
                }
                progress < 0.55f -> {
                    val t = (progress - 0.40f) / 0.15f
                    val eased = easeOutBack(t)
                    textX = cx
                    textY = cy
                    textScale = 1.0f + 0.3f * eased
                    textAlpha = 255
                }
                progress < 0.75f -> {
                    val t = (progress - 0.55f) / 0.20f
                    textX = cx
                    textY = cy
                    textScale = 1.3f - 0.3f * easeOutQuad(t)
                    textAlpha = 255
                }
                else -> {
                    val t = (progress - 0.75f) / 0.25f
                    textX = cx
                    textY = cy
                    textScale = 1.0f
                    textAlpha = (255 * (1f - easeInQuad(t))).toInt()
                }
            }

            // 绘制文字
            textPaint.alpha = textAlpha.coerceIn(0, 255)
            canvas.save()
            canvas.translate(textX, textY)
            canvas.scale(textScale, textScale, 0f, 0f)
            val textBaseline = -(textPaint.fontMetrics.ascent + textPaint.fontMetrics.descent) / 2f
            canvas.drawText(text, 0f, textBaseline, textPaint)
            canvas.restore()

            // 粒子（延迟到 40% 后才出现）
            if (progress > 0.40f) {
                drawParticles(canvas, cx, cy, progress, delayOffset = 0.40f)
            }
        }

        // ==================== 脉冲扩散效果 ====================
        private fun drawPulse(canvas: Canvas, cx: Float, cy: Float, w: Float, h: Float, progress: Float) {
            // 3层同心圆向外扩散，文字居中缩放
            val pulsePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 3 * dp }
            val maxRadius = maxOf(w, h) * 0.6f

            for (layer in 0 until 3) {
                val delay = layer * 0.12f
                val adj = ((progress - delay) / 0.6f).coerceIn(0f, 1f)
                val radius = maxRadius * easeOutCubic(adj)
                val alpha = (80 * (1f - adj)).toInt().coerceIn(0, 80)
                pulsePaint.color = when (layer) {
                    0 -> Color.parseColor("#FFD700")
                    1 -> Color.parseColor("#FF8C00")
                    else -> Color.parseColor("#FF6347")
                }
                pulsePaint.alpha = alpha.coerceIn(0, 255)
                canvas.drawCircle(cx, cy, radius, pulsePaint)
            }

            // 文字居中，轻微缩放
            val textScale = 1.0f + 0.15f * ((progress / 0.3f).coerceIn(0f, 1f) * (1f - progress / 0.8f).coerceIn(0f, 1f))
            val textAlpha = if (progress > 0.7f) (255 * (1f - (progress - 0.7f) / 0.3f)).toInt() else 255
            textPaint.alpha = textAlpha.coerceIn(0, 255)
            canvas.save()
            canvas.translate(cx, cy)
            canvas.scale(textScale, textScale, 0f, 0f)
            val yOff = -(textPaint.fontMetrics.ascent + textPaint.fontMetrics.descent) / 2f
            canvas.drawText(text, 0f, yOff, textPaint)
            canvas.restore()
        }

        // ==================== 闪烁星光效果 ====================
        private fun drawSparkle(canvas: Canvas, cx: Float, cy: Float, w: Float, h: Float, progress: Float) {
            // 文字从暗到亮渐入，周围随机星点闪烁
            val textAlpha = ((progress / 0.25f).coerceIn(0f, 1f) * 255).toInt().coerceIn(30, 255)
            val textScale = 0.6f + 0.4f * ((progress / 0.3f).coerceIn(0f, 1f))

            // 光晕背景
            val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG)
            val glowRadius = 80 * dp * (0.5f + 0.5f * Math.sin(progress * Math.PI * 3).toFloat())
            bgPaint.shader = RadialGradient(cx, cy, glowRadius,
                intArrayOf(Color.parseColor("#88FFD700"), Color.parseColor("#00FFD700")),
                floatArrayOf(0f, 1f), Shader.TileMode.CLAMP)
            canvas.drawCircle(cx, cy, glowRadius, bgPaint)

            // 文字
            textPaint.alpha = textAlpha.coerceIn(0, 255)
            canvas.save()
            canvas.translate(cx, cy)
            canvas.scale(textScale, textScale, 0f, 0f)
            val yOff = -(textPaint.fontMetrics.ascent + textPaint.fontMetrics.descent) / 2f
            canvas.drawText(text, 0f, yOff, textPaint)
            canvas.restore()

            // 随机星点（用时间做伪随机种子）
            val sparkPaint = Paint(Paint.ANTI_ALIAS_FLAG)
            val baseSeed = (startTime / 50).toInt()
            for (i in 0 until 12) {
                val angle = ((baseSeed + i * 31) % 360).toFloat() * Math.PI.toFloat() / 180f
                val dist = (50f * dp + 120f * dp * Math.sin((baseSeed + i * 17) * 0.3).toFloat()).let {
                    if (it < 0) -it else it
                }
                val sx = cx + Math.cos((angle.toDouble())).toFloat() * dist
                val sy = cy + Math.sin((angle.toDouble())).toFloat() * dist
                val sparkAlpha = (150 + (105 * Math.sin((baseSeed + i * 7) * 0.5)).toInt()).coerceIn(30, 255)
                sparkPaint.color = when (i % 3) {
                    0 -> Color.parseColor("#FFD700")
                    1 -> Color.parseColor("#FFA500")
                    else -> Color.parseColor("#FFEC8B")
                }
                sparkPaint.alpha = sparkAlpha.coerceIn(0, 255)
                canvas.drawCircle(sx, sy, 3 * dp, sparkPaint)
            }
        }

        // ==================== 上滑淡入 ====================
        private fun drawSlideUp(canvas: Canvas, cx: Float, cy: Float, h: Float, progress: Float) {
            val textAlpha = ((progress / 0.2f).coerceIn(0f, 1f) * 255).toInt()
            val textY = cy + h * 0.3f * (1f - easeOutCubic((progress / 0.6f).coerceIn(0f, 1f)))
            if (progress > 0.7f) textPaint.alpha = ((1f - (progress - 0.7f) / 0.3f) * 255).toInt().coerceIn(0, 255)
            else textPaint.alpha = textAlpha.coerceIn(0, 255)
            val yOff = textY - (textPaint.fontMetrics.ascent + textPaint.fontMetrics.descent) / 2f
            canvas.drawText(text, cx, yOff, textPaint)
        }

        // ==================== 缩放淡入 ====================
        private fun drawFadeScale(canvas: Canvas, cx: Float, cy: Float, progress: Float) {
            val t = (progress / 0.4f).coerceIn(0f, 1f)
            val scale = 0.3f + 0.7f * easeOutBack(t)
            val alpha = if (progress > 0.7f) ((1f - (progress - 0.7f) / 0.3f) * 255).toInt() else (t * 255).toInt()
            textPaint.alpha = alpha.coerceIn(0, 255)
            canvas.save()
            canvas.translate(cx, cy)
            canvas.scale(scale, scale)
            val yOff = -(textPaint.fontMetrics.ascent + textPaint.fontMetrics.descent) / 2f
            canvas.drawText(text, 0f, yOff, textPaint)
            canvas.restore()
        }

        // ==================== 左右抖动 ====================
        private fun drawShake(canvas: Canvas, cx: Float, cy: Float, progress: Float) {
            val shakeAmplitude = (20 * dp * (1f - (progress / 0.5f).coerceIn(0f, 1f)))
            val shakeX = cx + shakeAmplitude * Math.sin(progress * 30).toFloat()
            val shakeY = cy + shakeAmplitude * 0.3f * Math.cos(progress * 35).toFloat()
            val alpha = if (progress > 0.7f) ((1f - (progress - 0.7f) / 0.3f) * 255).toInt() else 255
            textPaint.alpha = alpha.coerceIn(0, 255)
            val yOff = shakeY - (textPaint.fontMetrics.ascent + textPaint.fontMetrics.descent) / 2f
            canvas.drawText(text, shakeX, yOff, textPaint)
        }

        // ==================== 翻转进入 ====================
        private fun drawFlipIn(canvas: Canvas, cx: Float, cy: Float, progress: Float) {
            val t = (progress / 0.5f).coerceIn(0f, 1f)
            val scaleX = Math.cos((1f - t) * Math.PI).toFloat().let { if (it < 0) -it else it }.coerceIn(0.1f, 1f)
            val alpha = if (progress > 0.7f) ((1f - (progress - 0.7f) / 0.3f) * 255).toInt() else (t * 255).toInt()
            textPaint.alpha = alpha.coerceIn(0, 255)
            canvas.save()
            canvas.translate(cx, cy)
            canvas.scale(scaleX, 1f)
            val yOff = -(textPaint.fontMetrics.ascent + textPaint.fontMetrics.descent) / 2f
            canvas.drawText(text, 0f, yOff, textPaint)
            canvas.restore()
        }

        // ==================== 心跳脉冲 ====================
        private fun drawHeartbeat(canvas: Canvas, cx: Float, cy: Float, progress: Float) {
            val beat = 0.7f + 0.3f * Math.sin(progress * Math.PI * 4).toFloat()
            val scale = 1f + 0.2f * beat * (1f - (progress / 0.8f).coerceIn(0f, 1f))
            val alpha = if (progress > 0.7f) ((1f - (progress - 0.7f) / 0.3f) * 255).toInt() else 255
            textPaint.alpha = alpha.coerceIn(0, 255)
            canvas.save()
            canvas.translate(cx, cy)
            canvas.scale(scale, scale)
            val yOff = -(textPaint.fontMetrics.ascent + textPaint.fontMetrics.descent) / 2f
            canvas.drawText(text, 0f, yOff, textPaint)
            canvas.restore()
        }
        private fun drawParticles(canvas: Canvas, cx: Float, cy: Float, progress: Float, delayOffset: Float = 0f) {
            val particlePaint = Paint(Paint.ANTI_ALIAS_FLAG)

            for (p in particles) {
                val adjustedProgress = ((progress - delayOffset - p.delay) / (1f - delayOffset))
                if (adjustedProgress <= 0f) continue
                if (adjustedProgress > p.life) continue

                val t = adjustedProgress / p.life
                val alpha = (255 * (1f - easeInQuad(t))).toInt()
                if (alpha <= 0) continue

                // 粒子位置 = 起点 + 速度 * 时间 * 减速因子
                val damping = 1f - 0.3f * t
                val px = cx + p.vx * adjustedProgress * totalDuration / 1000f * damping
                val py = cy + p.vy * adjustedProgress * totalDuration / 1000f * damping + 50 * dp * t * t // 轻微重力

                // 粒子大小随生命衰减
                val size = p.size * (1f - 0.6f * t)

                particlePaint.color = p.color
                particlePaint.alpha = alpha.coerceIn(0, 255)
                canvas.drawCircle(px, py, size, particlePaint)
            }
        }

        // ==================== 缓动函数 ====================

        private fun easeOutBack(t: Float): Float {
            val c1 = 1.70158f
            val c3 = c1 + 1f
            return 1f + c3 * (t - 1f).let { it * it * it } + c1 * (t - 1f).let { it * it }
        }

        private fun easeOutCubic(t: Float): Float {
            return 1f - (1f - t).let { it * it * it }
        }

        private fun easeOutQuad(t: Float): Float {
            return 1f - (1f - t) * (1f - t)
        }

        private fun easeInQuad(t: Float): Float {
            return t * t
        }

        // ==================== 粒子数据类 ====================
        private data class Particle(
            val x: Float,
            val y: Float,
            val vx: Float,
            val vy: Float,
            val size: Float,
            val life: Float,
            val delay: Float,
            val color: Int
        )
    }
}
