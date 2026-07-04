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
import androidx.appcompat.app.AlertDialog
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
    private lateinit var etManagerName: EditText
    private lateinit var tvVisitType: TextView
    private lateinit var btnSubmit: TextView

    private var pin: String = ""
    private var managerName: String = ""
    private var brand: String = "1833"

    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())

    private var isSubmitting: Boolean = false
    private var isSuccessCooldown: Boolean = false

    // CRM 顾问列表缓存
    private val advisorList = mutableListOf<Pair<String, String>>() // (name, kid)

    private val themeListener: () -> Unit = {
        if (isAdded) {
            applyTheme()
            refreshButtonState()
        }
    }

    companion object {
        private const val API_URL = "https://guwen.zhudaicms.com/bserve/saoma_indb.html"
        private const val VISIT_TYPE = "贷款咨询"
        private const val PENDING_SYNCS_KEY = "pending_cloud_syncs"

        /**
         * 将云中继地址转为 HTTP 基地址（兼容 ws:// / wss:// / http:// / 纯IP:PORT）
         */
        private fun toHttpBase(serverUrl: String): String {
            var url = serverUrl.trim()
            if (url.startsWith("wss://")) url = url.replace("wss://", "https://")
            else if (url.startsWith("ws://")) url = url.replace("ws://", "http://")
            else if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
            return url.removeSuffix("/")
        }

        /**
         * 将本地登记写入 visit_records JSON（供统计页详情弹窗使用）
         */
        fun saveVisitRecord(name: String, mobile: String, prefs: android.content.SharedPreferences) {
            try {
                val existingJson = prefs.getString("visit_records", "[]") ?: "[]"
                val arr = org.json.JSONArray(existingJson)
                val obj = org.json.JSONObject().apply {
                    put("name", name)
                    put("mobile", mobile)
                    put("created_at", java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.getDefault())
                        .format(java.util.Date()))
                    put("timestamp", System.currentTimeMillis())
                }
                arr.put(obj)
                // 最多保留 200 条
                while (arr.length() > 200) {
                    arr.remove(0)
                }
                prefs.edit().putString("visit_records", arr.toString()).apply()
            } catch (_: Exception) {}
        }

        /**
         * 云端同步失败时暂存记录，等重连后补推。
         */
        fun savePendingVisit(name: String, mobile: String, managerName: String, pin: String, context: Context) {
            val prefs = context.applicationContext.getSharedPreferences("autodial", Context.MODE_PRIVATE)
            val json = prefs.getString(PENDING_SYNCS_KEY, "[]") ?: "[]"
            val arr = org.json.JSONArray(json)
            arr.put(org.json.JSONObject().apply {
                put("name", name); put("mobile", mobile)
                put("kefu_tel", managerName); put("pin", pin)
                put("visit_type", VISIT_TYPE); put("source", "phone_retry")
            })
            prefs.edit().putString(PENDING_SYNCS_KEY, arr.toString()).apply()
        }

        /**
         * 云端 WebSocket 重连后调用，补推积压的登记记录。
         */
        fun flushPendingSyncs(context: Context) {
            val prefs = context.applicationContext.getSharedPreferences("autodial", Context.MODE_PRIVATE)
            val serverUrl = prefs.getString("cloud_server", "") ?: ""
            if (serverUrl.isEmpty()) return

            val json = prefs.getString(PENDING_SYNCS_KEY, "[]") ?: "[]"
            if (json == "[]") return
            val arr = org.json.JSONArray(json)
            val remaining = org.json.JSONArray()

            val baseUrl = toHttpBase(serverUrl)
            val executor = java.util.concurrent.Executors.newSingleThreadExecutor()
            executor.execute {
                for (i in 0 until arr.length()) {
                    val item = arr.getJSONObject(i)
                    try {
                        val params = "name=${URLEncoder.encode(item.optString("name"), "UTF-8")}" +
                                "&mobile=${URLEncoder.encode(item.optString("mobile"), "UTF-8")}" +
                                "&kefu_tel=${URLEncoder.encode(item.optString("kefu_tel"), "UTF-8")}" +
                                "&visit_type=${URLEncoder.encode(item.optString("visit_type"), "UTF-8")}" +
                                "&source=${URLEncoder.encode(item.optString("source"), "UTF-8")}"
                        val url = java.net.URL("$baseUrl/api/v1/visit?$params")
                        val conn = url.openConnection() as java.net.HttpURLConnection
                        conn.requestMethod = "GET"
                        conn.connectTimeout = 8000
                        conn.readTimeout = 8000
                        conn.setRequestProperty("X-AutoDial-PIN", item.optString("pin"))
                        if (conn.responseCode in 200..299) continue // 成功，不加入 remaining
                        conn.disconnect()
                    } catch (_: Exception) {}
                    remaining.put(item) // 失败，保留
                }
                if (remaining.length() > 0) {
                    prefs.edit().putString(PENDING_SYNCS_KEY, remaining.toString()).apply()
                } else {
                    prefs.edit().remove(PENDING_SYNCS_KEY).apply()
                }
            }
        }
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
        etManagerName = view.findViewById(R.id.etManagerName)
        tvVisitType = view.findViewById(R.id.tvVisitType)
        btnSubmit = view.findViewById(R.id.btnSubmit)

        // 读取 SharedPreferences
        val prefs = requireContext().getSharedPreferences("autodial", Context.MODE_PRIVATE)
        pin = prefs.getString("pin", "") ?: ""
        brand = prefs.getString("brand", "1833") ?: "1833"
        managerName = prefs.getString("manager_name", "") ?: ""

        // 设置输入提示
        etManagerName.hint = "点击选择接待顾问"
        etManagerName.isFocusable = false
        etManagerName.isClickable = true
        etManagerName.setOnClickListener { showAdvisorPicker() }

        // 如果本地没有姓名但 PIN 已设置，异步从云中继查询
        if (managerName.isEmpty() && pin.isNotEmpty()) {
            executor.execute {
                val nameFromCloud = fetchManagerNameFromCloud(pin)
                if (nameFromCloud != null) {
                    managerName = nameFromCloud
                    prefs.edit().putString("manager_name", nameFromCloud).apply()
                    handler.post {
                        if (isAdded) {
                            etManagerName.setText(nameFromCloud)
                        }
                    }
                }
            }
        }

        // 后台加载 CRM 顾问列表（无论本地是否有姓名，提供备选）
        if (pin.isNotEmpty()) {
            executor.execute { fetchAdvisorListFromCrm() }
        }

        // 设置接待顾问姓名
        etManagerName.setText(managerName)

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
        etManagerName.setTextColor(Color.parseColor(colors.text))
    }

    // ===== CRM 顾问列表 =====

    /**
     * 从 CRM 拉取全部顾问姓名列表，缓存到 advisorList。
     */
    private fun fetchAdvisorListFromCrm() {
        var connection: HttpURLConnection? = null
        try {
            val url = URL("https://guwen.zhudaicms.com/bserve/search")
            connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.doInput = true
            connection.connectTimeout = 10000
            connection.readTimeout = 10000
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            connection.setRequestProperty("Origin", "https://guwen.zhudaicms.com")
            connection.setRequestProperty("Referer", "https://guwen.zhudaicms.com/bserve/saoma.html?brand=$brand")

            val body = "keyword=&brand=$brand"
            val writer = OutputStreamWriter(connection.outputStream, "UTF-8")
            writer.write(body)
            writer.flush()
            writer.close()

            if (connection.responseCode != 200) return
            val respBody = connection.inputStream.bufferedReader().readText()
            val json = org.json.JSONObject(respBody)
            if (json.optInt("code", -1) != 1) return

            val data = json.optJSONArray("data") ?: return
            advisorList.clear()
            for (i in 0 until data.length()) {
                val item = data.getJSONObject(i)
                val name = item.optString("name", "")
                val kid = item.optString("id", "")
                if (name.isNotEmpty()) {
                    advisorList.add(Pair(name, kid))
                }
            }
        } catch (_: Exception) {} finally {
            connection?.disconnect()
        }
    }

    /**
     * 弹出顾问姓名选择器。
     */
    private fun showAdvisorPicker() {
        if (!isAdded) return
        if (advisorList.isEmpty()) {
            Toast.makeText(requireContext(), "正在加载顾问列表，请稍后再试...", Toast.LENGTH_SHORT).show()
            // 触发重新加载
            executor.execute { fetchAdvisorListFromCrm() }
            return
        }
        val names = advisorList.map { it.first }.toTypedArray<CharSequence>()
        AlertDialog.Builder(requireContext())
            .setTitle("选择接待顾问")
            .setItems(names) { _, which ->
                val selected = advisorList[which]
                managerName = selected.first
                etManagerName.setText(managerName)
                val prefs = requireContext().getSharedPreferences("autodial", Context.MODE_PRIVATE)
                prefs.edit().putString("manager_name", managerName).apply()
            }
            .setNegativeButton("关闭", null)
            .show()
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
        val mgrName = etManagerName.text.toString().trim()

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

        // 验证顾问姓名
        if (mgrName.isEmpty()) {
            Toast.makeText(requireContext(), "请填写接待顾问姓名", Toast.LENGTH_SHORT).show()
            return
        }

        // 更新缓存的经理姓名
        managerName = mgrName

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
     * 通过 /bserve/search 接口将顾问姓名转换为 CRM 内部 kid。
     * 返回 kid 字符串，失败返回 null。
     */
    private fun lookupKid(managerName: String, brand: String): String? {
        var connection: HttpURLConnection? = null
        try {
            val url = URL("https://guwen.zhudaicms.com/bserve/search")
            connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.doInput = true
            connection.connectTimeout = 10000
            connection.readTimeout = 10000
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            connection.setRequestProperty("Origin", "https://guwen.zhudaicms.com")
            connection.setRequestProperty("Referer", "https://guwen.zhudaicms.com/bserve/saoma.html?brand=$brand")

            val searchParams = "keyword=${URLEncoder.encode(managerName, "UTF-8")}&brand=$brand"
            val writer = OutputStreamWriter(connection.outputStream, "UTF-8")
            writer.write(searchParams)
            writer.flush()
            writer.close()

            if (connection.responseCode != 200) return null
            val body = connection.inputStream.bufferedReader().readText()
            val json = org.json.JSONObject(body)
            if (json.optInt("code", -1) == 1) {
                val data = json.optJSONArray("data") ?: return null
                // 优先精确匹配
                for (i in 0 until data.length()) {
                    val item = data.getJSONObject(i)
                    if (item.optString("name") == managerName) {
                        return item.optString("id")
                    }
                }
                // 兜底取第一个
                if (data.length() > 0) {
                    return data.getJSONObject(0).optString("id")
                }
            }
        } catch (_: Exception) {} finally {
            connection?.disconnect()
        }
        return null
    }

    /**
     * 执行 HTTP POST 表单提交到登记 API。
     * 新版 CRM 要求 kid (顾问ID) 而非 kefu_tel (姓名)。
     */
    private fun submitRegistration(name: String, mobile: String): SubmitResult {
        var connection: HttpURLConnection? = null
        try {
            // 1) 先将顾问姓名转换为 kid
            val kid = lookupKid(managerName, brand)
            if (kid == null) {
                return SubmitResult(success = false, message = "未找到顾问「$managerName」，请确认姓名正确")
            }

            val url = URL(API_URL)
            connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.doOutput = true
            connection.doInput = true
            connection.connectTimeout = 15000
            connection.readTimeout = 15000
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Origin", "https://guwen.zhudaicms.com")
            connection.setRequestProperty("Referer", "https://guwen.zhudaicms.com/bserve/saoma.html?brand=$brand")

            // 构建表单参数（使用 kid 替代 kefu_tel）
            val params = linkedMapOf(
                "brand" to brand,
                "name" to name,
                "mobile" to mobile,
                "kid" to kid,
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

            // 也写入 visit_records JSON，供统计页详情弹窗使用
            saveVisitRecord(visitorName, visitorMobile, prefs)

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
     * 从云中继查询 PIN 对应的顾问姓名。返回 null 表示查询失败或未找到。
     */
    private fun fetchManagerNameFromCloud(pin: String): String? {
        try {
            val ctx = requireContext().applicationContext
            val prefs = ctx.getSharedPreferences("autodial", Context.MODE_PRIVATE)
            val serverUrl = prefs.getString("cloud_server", "") ?: ""
            if (serverUrl.isEmpty()) return null

            val baseUrl = toHttpBase(serverUrl)
            val url = URL("$baseUrl/api/v1/advisor/name?pin=${URLEncoder.encode(pin, "UTF-8")}")
            val conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            val code = conn.responseCode
            if (code != 200) {
                conn.disconnect()
                return null
            }
            val body = conn.inputStream.bufferedReader().readText()
            conn.disconnect()
            val json = org.json.JSONObject(body)
            if (json.optBoolean("ok", false)) {
                val name = json.optString("name", "")
                return name.ifEmpty { null }
            }
        } catch (_: Exception) {}
        return null
    }

    /**
     * 将本地登记同步到云中继的 /api/v1/visit 接口，确保云端也存一份。
     * 失败时存入待同步队列，等云端重连后自动补推。
     */
    private fun syncToCloudRelay(name: String, mobile: String) {
        executor.execute {
            try {
                val ctx = requireContext().applicationContext
                val prefs = ctx.getSharedPreferences("autodial", Context.MODE_PRIVATE)
                val serverUrl = prefs.getString("cloud_server", "") ?: ""
                if (serverUrl.isEmpty()) return@execute

                val baseUrl = toHttpBase(serverUrl)
                val params = "name=${URLEncoder.encode(name, "UTF-8")}" +
                        "&mobile=${URLEncoder.encode(mobile, "UTF-8")}" +
                        "&kefu_tel=${URLEncoder.encode(managerName, "UTF-8")}" +
                        "&visit_type=${URLEncoder.encode("贷款咨询", "UTF-8")}" +
                        "&source=phone"
                val fullUrl = "$baseUrl/api/v1/visit?$params"

                val url = URL(fullUrl)
                val conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "GET"
                conn.connectTimeout = 10000
                conn.readTimeout = 10000
                conn.setRequestProperty("X-AutoDial-PIN", pin)
                val code = conn.responseCode
                if (code in 200..299) {
                    val body = conn.inputStream.bufferedReader().readText()
                    conn.disconnect()
                    val json = org.json.JSONObject(body)
                    if (json.optBoolean("ok", false)) return@execute
                } else {
                    conn.disconnect()
                }
            } catch (_: Exception) {}
            // 同步失败 → 存入队列，等云端重连后补推
            savePendingVisit(name, mobile, managerName, pin, requireContext())
        }
    }

    private data class SubmitResult(
        val success: Boolean,
        val message: String
    )
}
