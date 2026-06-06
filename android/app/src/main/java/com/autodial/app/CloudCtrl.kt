package com.autodial.app

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.*
import java.net.URL

/**
 * v5: 云服务器配置管理 — 纯CRUD + 测试，不再管理连接
 */
class CloudCtrl(private val context: Context) {
    companion object { private const val TAG = "CloudCtrl" }
    private val prefs = context.getSharedPreferences("autodial", Context.MODE_PRIVATE)

    // 回调：ConnectFragment 注入，服务器列表变化时通知
    var onServerListChanged: (() -> Unit)? = null

    // ==================== 服务器列表 ====================

    fun getServerList(): MutableList<String> {
        val json = prefs.getString("cloud_servers", null)
        return if (json != null) {
            try {
                org.json.JSONArray(json).let { arr ->
                    val list = mutableListOf<String>()
                    for (i in 0 until arr.length()) list.add(arr.getString(i))
                    list
                }
            } catch (_: Exception) {
                val old = prefs.getString("cloud_server", "") ?: ""
                if (old.isNotEmpty()) mutableListOf(old) else mutableListOf()
            }
        } else {
            val old = prefs.getString("cloud_server", "") ?: ""
            if (old.isNotEmpty()) mutableListOf(old) else mutableListOf()
        }
    }

    fun saveServerList(list: List<String>) {
        prefs.edit().putString("cloud_servers",
            org.json.JSONArray().apply { list.forEach { put(it) } }.toString()).apply()
        if (list.isNotEmpty()) {
            prefs.edit().putString("cloud_server", list[0]).apply()
        }
    }

    fun stripCloudPrefix(addr: String) = addr.removePrefix("ws://").removePrefix("wss://").removeSuffix("/")

    fun currentServerLabel(): String = stripCloudPrefix(prefs.getString("cloud_server", "") ?: "")

    // ==================== 服务器管理弹窗 ====================

    fun showManagementDialog(activity: Activity) {
        val servers = getServerList().toMutableList()
        val connected = DialService.isCloudConnected
        val connectedServer = prefs.getString("cloud_server", "") ?: ""

        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(48, 32, 48, 16)
        }

        val titleView = TextView(activity).apply {
            text = "云服务器列表"; textSize = 18f
            setTextColor(Color.parseColor("#E8DCC8")); setPadding(0, 0, 0, 24)
        }
        container.addView(titleView)

        val serverListContainer = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        container.addView(serverListContainer)

        fun refreshServerList() {
            serverListContainer.removeAllViews()
            if (servers.isEmpty()) {
                serverListContainer.addView(TextView(activity).apply {
                    text = "暂无服务器，点击下方添加"; textSize = 14f
                    setTextColor(Color.parseColor("#605040")); setPadding(0, 16, 0, 16)
                })
                return
            }
            servers.forEachIndexed { i, server ->
                val isCurrent = server == connectedServer && connected && connectedServer.isNotEmpty()
                val row = LinearLayout(activity).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = android.view.Gravity.CENTER_VERTICAL
                    setPadding(0, 8, 0, 8); minimumHeight = 52
                    if (isCurrent) setBackgroundColor(Color.parseColor("#1F1A0A"))
                }

                row.addView(TextView(activity).apply {
                    text = if (isCurrent) "●" else "○"; textSize = 14f
                    setTextColor(Color.parseColor(if (isCurrent) "#2ECC71" else "#605040"))
                    setPadding(0, 0, 8, 0)
                })

                row.addView(TextView(activity).apply {
                    text = listOf("①","②","③","④","⑤").getOrElse(i) { "${i+1}" }
                    textSize = 16f
                    setTextColor(Color.parseColor(if (i == 0) "#C9A84C" else "#605040"))
                    setPadding(0, 0, 12, 0)
                })

                row.addView(TextView(activity).apply {
                    text = if (isCurrent) "$server ◀已连接" else server
                    textSize = 14f
                    setTextColor(Color.parseColor(if (isCurrent) "#C9A84C" else "#E8DCC8"))
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    isSingleLine = true
                })

                if (i > 0) {
                    row.addView(TextView(activity).apply {
                        text = "↑"; textSize = 18f; setPadding(8, 0, 8, 0)
                        setTextColor(Color.parseColor("#A09070"))
                        setOnClickListener {
                            servers.removeAt(i); servers.add(i - 1, server)
                            saveServerList(servers); refreshServerList()
                        }
                    })
                }

                row.addView(TextView(activity).apply {
                    text = "✕"; textSize = 16f; setPadding(8, 0, 4, 0)
                    setTextColor(Color.parseColor("#E74C3C"))
                    setOnClickListener {
                        servers.removeAt(i); saveServerList(servers); refreshServerList()
                        onServerListChanged?.invoke()
                    }
                })
                serverListContainer.addView(row)
            }
        }
        refreshServerList()

        // 底部按钮
        val buttonRow = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL; setPadding(0, 16, 0, 0)
        }

        buttonRow.addView(TextView(activity).apply {
            text = "+ 添加服务器"; textSize = 14f; setPadding(16, 10, 16, 10)
            setTextColor(Color.parseColor("#111318"))
            setBackgroundColor(Color.parseColor("#C9A84C"))
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            setOnClickListener {
                val input = EditText(activity).apply {
                    hint = "如: 1.2.3.4:35430"; textSize = 15f
                    setTextColor(Color.parseColor("#E8DCC8")); isSingleLine = true
                    setPadding(48, 24, 48, 24)
                }
                AlertDialog.Builder(activity).setTitle("添加云服务器")
                    .setView(input)
                    .setPositiveButton("添加") { _, _ ->
                        val addr = input.text.toString().trim()
                        if (addr.isNotEmpty() && !servers.contains(addr)) {
                            servers.add(addr); saveServerList(servers)
                            refreshServerList(); onServerListChanged?.invoke()
                        } else if (servers.contains(addr))
                            Toast.makeText(activity, "该地址已存在", Toast.LENGTH_SHORT).show()
                    }
                    .setNegativeButton("取消", null).show()
            }
        })

        buttonRow.addView(TextView(activity).apply {
            text = "测试全部"; textSize = 14f; setPadding(16, 10, 16, 10)
            setTextColor(Color.parseColor("#E8DCC8"))
            setBackgroundColor(Color.parseColor("#3A3A3A"))
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            setOnClickListener {
                if (servers.isEmpty()) Toast.makeText(activity, "暂无服务器", Toast.LENGTH_SHORT).show()
                else showTestResultDialog(activity, servers)
            }
        })

        buttonRow.addView(TextView(activity).apply {
            text = "从PC同步"; textSize = 14f; setPadding(16, 10, 16, 10)
            setTextColor(Color.parseColor("#E8DCC8"))
            setBackgroundColor(Color.parseColor("#2A4A2A"))
            (layoutParams as LinearLayout.LayoutParams).leftMargin = 12
            setOnClickListener { dialog?.dismiss(); fetchServersFromPC() }
        })

        container.addView(buttonRow)

        dialog = AlertDialog.Builder(activity).setView(container)
            .setNegativeButton("关闭", null).show()

        try {
            dialog?.window?.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.parseColor("#1A1D24")))
        } catch (_: Exception) {}
    }

    private fun showTestResultDialog(activity: Activity, servers: List<String>) {
        val resultContainer = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(48, 32, 48, 16)
        }
        resultContainer.addView(TextView(activity).apply {
            text = "测试结果"; textSize = 18f
            setTextColor(Color.parseColor("#E8DCC8")); setPadding(0, 0, 0, 24)
        })

        val resultViews = servers.map { server ->
            TextView(activity).apply {
                text = "$server  ${"\u23F3"}"
                textSize = 14f; setTextColor(Color.parseColor("#A09070"))
                setPadding(0, 6, 0, 6)
            }
        }
        resultViews.forEach { resultContainer.addView(it) }

        val resultDialog = AlertDialog.Builder(activity).setView(resultContainer)
            .setNegativeButton("关闭", null).create()
        resultDialog.show()

        // 后台测试
        CoroutineScope(Dispatchers.Main).launch {
            val results = testAllServers(servers)
            results.forEachIndexed { i, (server, ok) ->
                resultViews[i].text = "$server  ${if (ok) "\u2705 可连接" else "\u274C 不可达"}"
                resultViews[i].setTextColor(Color.parseColor(if (ok) "#2ECC71" else "#E74C3C"))
            }
        }
    }

    private fun fetchServersFromPC() {
        CoroutineScope(Dispatchers.Main).launch {
            val list = fetchServerListFromGist()
            if (list != null && list.isNotEmpty()) {
                saveServerList(list.toMutableList())
                onServerListChanged?.invoke()
                toast("已同步 ${list.size} 个服务器")
            } else {
                toast("同步失败或PC端未配置")
            }
        }
    }

    suspend fun testAllServers(servers: List<String>): List<Pair<String, Boolean>> {
        val results = mutableListOf<Pair<String, Boolean>>()
        for (server in servers) {
            try {
                val wsUrl = if (server.startsWith("ws")) server else "ws://$server:35430"
                withContext(Dispatchers.IO) {
                    withTimeout(3000) {
                        URL(wsUrl.replace("ws://", "http://").replace("wss://", "https://"))
                            .openConnection().apply { connectTimeout = 2000; readTimeout = 2000 }
                            .getInputStream().close()
                    }
                }
                results.add(server to true)
            } catch (_: Exception) { results.add(server to false) }
        }
        return results
    }

    suspend fun fetchServerListFromGist(): List<String>? {
        return try {
            withContext(Dispatchers.IO) {
                URL("https://gist.githubusercontent.com/raw/autodial-servers/main/list.txt")
                    .readText().lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
            }
        } catch (_: Exception) { null }
    }

    // ==================== 内部状态 ====================

    private var dialog: AlertDialog? = null

    private fun toast(msg: String) {
        Toast.makeText(context, msg, Toast.LENGTH_SHORT).show()
    }
}
