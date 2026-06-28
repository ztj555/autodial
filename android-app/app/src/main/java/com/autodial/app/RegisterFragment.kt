package com.autodial.app

import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors
import org.json.JSONObject

class RegisterFragment : Fragment() {

    private lateinit var etCustomerName: EditText
    private lateinit var etCustomerMobile: EditText
    private lateinit var tvAdvisorMobile: TextView
    private lateinit var tvVisitType: TextView
    private lateinit var btnSubmit: TextView

    private var pin: String = ""
    private var brand: String = "1833"

    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())

    private var isSubmitting: Boolean = false
    private var isSuccessCooldown: Boolean = false

    private val themeListener: () -> Unit = {
        if (isAdded) {
            applyTheme()
            refreshButtonState()
        }
    }

    companion object {
        private const val API_URL = "https://guwen.zhudaicms.com/bserve/saoma_indb.html"
        private const val VISIT_TYPE = "贷款咨询"
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View? {
        return inflater.inflate(R.layout.fragment_register, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        etCustomerName = view.findViewById(R.id.etCustomerName)
        etCustomerMobile = view.findViewById(R.id.etCustomerMobile)
        tvAdvisorMobile = view.findViewById(R.id.tvAdvisorMobile)
        tvVisitType = view.findViewById(R.id.tvVisitType)
        btnSubmit = view.findViewById(R.id.btnSubmit)

        // 读取 SharedPreferences
        val prefs = requireContext().getSharedPreferences("autodial", Context.MODE_PRIVATE)
        pin = prefs.getString("pin", "") ?: ""
        brand = prefs.getString("brand", "1833") ?: "1833"

        // 设置顾问手机号
        tvAdvisorMobile.text = pin.ifEmpty { "未设置" }

        // 设置来访事由（固定值）
        tvVisitType.text = VISIT_TYPE

        // 提交按钮点击
        btnSubmit.setOnClickListener {
            if (!isSubmitting && !isSuccessCooldown) {
                handleSubmit()
            }
        }

        // 注册主题监听
        ThemeManager.addOnThemeChangedListener(themeListener)

        // 应用主题
        applyTheme()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        ThemeManager.removeOnThemeChangedListener(themeListener)
        // 清理 pending callbacks
        handler.removeCallbacksAndMessages(null)
    }

    private fun applyTheme() {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        ThemeManager.applyToView(requireView(), colors)
        // EditText text color is not set by tag system, set explicitly
        etCustomerName.setTextColor(Color.parseColor(colors.text))
        etCustomerMobile.setTextColor(Color.parseColor(colors.text))
    }

    /**
     * 根据当前状态刷新按钮外观。
     * 在主题切换时调用，确保按钮颜色正确。
     */
    private fun refreshButtonState() {
        if (!isAdded) return
        val colors = ThemeManager.getColors(requireContext())
        if (isSubmitting) {
            // 保持提交中状态的外观
            btnSubmit.text = "提交中..."
            btnSubmit.isEnabled = false
            btnSubmit.alpha = 0.5f
        } else if (isSuccessCooldown) {
            // 保持成功状态的外观
            btnSubmit.text = "✅登记成功"
            btnSubmit.isEnabled = false
            btnSubmit.alpha = 1.0f
        } else {
            // 恢复默认状态，颜色由 goldBtn tag 通过 ThemeManager 处理
            btnSubmit.text = "完成登记"
            btnSubmit.isEnabled = true
            btnSubmit.alpha = 1.0f
            btnSubmit.setTextColor(Color.parseColor(colors.bg))
            btnSubmit.setBackgroundColor(Color.parseColor(colors.gold))
        }
    }

    private fun handleSubmit() {
        val name = etCustomerName.text.toString().trim()
        val mobile = etCustomerMobile.text.toString().trim()

        // 验证客户称呼
        if (name.isEmpty()) {
            Toast.makeText(requireContext(), "请填写客户称呼", Toast.LENGTH_SHORT).show()
            return
        }

        // 验证手机号：11位数字，1开头
        if (mobile.length != 11 || !mobile.startsWith("1") || !mobile.all { it.isDigit() }) {
            Toast.makeText(requireContext(), "请填写正确的11位手机号（1开头）", Toast.LENGTH_SHORT).show()
            return
        }

        // 设置提交中状态
        setSubmittingState(true)

        executor.execute {
            val result = submitRegistration(name, mobile)
            handler.post {
                handleSubmitResult(result)
            }
        }
    }

    /**
     * 执行 HTTP POST 表单提交到登记 API。
     */
    private fun submitRegistration(name: String, mobile: String): SubmitResult {
        var connection: HttpURLConnection? = null
        try {
            val url = URL(API_URL)
            connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.doInput = true
            connection.connectTimeout = 15000
            connection.readTimeout = 15000
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            connection.setRequestProperty("Accept", "application/json")

            // 构建表单参数
            val params = linkedMapOf(
                "brand" to brand,
                "name" to name,
                "mobile" to mobile,
                "kefu_tel" to pin,
                "visit_type" to VISIT_TYPE
            )
            val postData = params.entries.joinToString("&") { (key, value) ->
                "${URLEncoder.encode(key, "UTF-8")}=${URLEncoder.encode(value, "UTF-8")}"
            }

            val writer = OutputStreamWriter(connection.outputStream, "UTF-8")
            writer.write(postData)
            writer.flush()
            writer.close()

            val responseCode = connection.responseCode
            val responseBody = if (responseCode in 200..299) {
                connection.inputStream.bufferedReader().readText()
            } else {
                connection.errorStream?.bufferedReader()?.readText() ?: ""
            }

            return try {
                val json = org.json.JSONObject(responseBody)
                val code = json.optInt("code", -1)
                val msg = json.optString("msg", "")
                if (code == 1) {
                    SubmitResult(success = true, message = "")
                } else {
                    SubmitResult(success = false, message = msg.ifEmpty { "提交失败，请重试" })
                }
            } catch (e: Exception) {
                SubmitResult(success = false, message = "服务器响应异常，请重试")
            }
        } catch (e: java.net.ConnectException) {
            return SubmitResult(success = false, message = "无法连接服务器，请检查网络")
        } catch (e: java.net.SocketTimeoutException) {
            return SubmitResult(success = false, message = "请求超时，请重试")
        } catch (e: java.net.UnknownHostException) {
            return SubmitResult(success = false, message = "无法解析服务器地址")
        } catch (e: Exception) {
            return SubmitResult(success = false, message = "网络错误: ${e.message}")
        } finally {
            connection?.disconnect()
        }
    }

    private fun handleSubmitResult(result: SubmitResult) {
        if (!isAdded) return

        if (result.success) {
            // 成功：设置成功状态（绿色）
            isSubmitting = false
            isSuccessCooldown = true
            btnSubmit.text = "✅登记成功"
            btnSubmit.isEnabled = false
            btnSubmit.alpha = 1.0f
            btnSubmit.setBackgroundColor(Color.parseColor("#2ECC71"))
            btnSubmit.setTextColor(Color.WHITE)

            // 保存登记时间戳（保留最近66天）
            val prefs = requireContext().getSharedPreferences("autodial", Context.MODE_PRIVATE)
            val existing = prefs.getString("registration_timestamps", "") ?: ""
            val now = System.currentTimeMillis()
            val cutoff = now - 66L * 24 * 3600_000L

            // 过滤旧记录 + 追加新记录
            val recent = if (existing.isEmpty()) {
                listOf(now.toString())
            } else {
                existing.split(",")
                    .mapNotNull { it.toLongOrNull() }
                    .filter { it >= cutoff }
                    .map { it.toString() }
                    .plus(now.toString())
            }
            prefs.edit().putString("registration_timestamps", recent.joinToString(",")).apply()

            // 同步到云中继（在清空输入前读取）
            val visitorName = etCustomerName.text.toString().trim()
            val visitorMobile = etCustomerMobile.text.toString().trim()
            syncToCloudRelay(visitorName, visitorMobile)

            // 清空输入
            etCustomerName.text?.clear()
            etCustomerMobile.text?.clear()

            // 2秒后恢复按钮
            handler.postDelayed({
                if (isAdded) {
                    isSuccessCooldown = false
                    val colors = ThemeManager.getColors(requireContext())
                    btnSubmit.text = "完成登记"
                    btnSubmit.isEnabled = true
                    btnSubmit.alpha = 1.0f
                    btnSubmit.setTextColor(Color.parseColor(colors.bg))
                    btnSubmit.setBackgroundColor(Color.parseColor(colors.gold))
                }
            }, 2000)
        } else {
            // 失败：红色闪一下 + Toast 提示，恢复按钮
            btnSubmit.setBackgroundColor(Color.parseColor("#E74C3C"))
            btnSubmit.setTextColor(Color.WHITE)
            handler.postDelayed({
                if (isAdded) setSubmittingState(false)
            }, 800)
            Toast.makeText(requireContext(), result.message, Toast.LENGTH_LONG).show()
        }
    }

    private fun setSubmittingState(submitting: Boolean) {
        isSubmitting = submitting
        if (!isAdded) return
        if (submitting) {
            btnSubmit.text = "提交中..."
            btnSubmit.isEnabled = false
            btnSubmit.alpha = 0.5f
        } else {
            val colors = ThemeManager.getColors(requireContext())
            btnSubmit.text = "完成登记"
            btnSubmit.isEnabled = true
            btnSubmit.alpha = 1.0f
            btnSubmit.setTextColor(Color.parseColor(colors.bg))
            btnSubmit.setBackgroundColor(Color.parseColor(colors.gold))
        }
    }

    /**
     * 将本地登记同步到云中继的 /api/v1/visit 接口，确保云端也存一份。
     */
    private fun syncToCloudRelay(name: String, mobile: String) {
        executor.execute {
            try {
                val ctx = requireContext().applicationContext
                val prefs = ctx.getSharedPreferences("autodial", Context.MODE_PRIVATE)
                val serverUrl = prefs.getString("cloud_server", "") ?: ""
                if (serverUrl.isEmpty()) return@execute

                val baseUrl = if (serverUrl.startsWith("http")) serverUrl else "http://$serverUrl"
                val params = "name=${URLEncoder.encode(name, "UTF-8")}" +
                        "&mobile=${URLEncoder.encode(mobile, "UTF-8")}" +
                        "&kefu_tel=${URLEncoder.encode(pin, "UTF-8")}" +
                        "&visit_type=${URLEncoder.encode("贷款咨询", "UTF-8")}" +
                        "&source=phone"
                val fullUrl = "$baseUrl/api/v1/visit?$params"

                val url = URL(fullUrl)
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.connectTimeout = 10000
                conn.readTimeout = 10000
                conn.setRequestProperty("X-AutoDial-PIN", pin)
                conn.responseCode  // 触发请求
                conn.disconnect()
            } catch (_: Exception) {
                // 静默失败，本地已存储
            }
        }
    }

    private data class SubmitResult(
        val success: Boolean,
        val message: String
    )
}
