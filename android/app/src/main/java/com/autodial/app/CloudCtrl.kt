package com.autodial.app

import android.content.Context
import kotlinx.coroutines.*
import java.net.HttpURLConnection
import java.net.URL

/**
 * v5: 云服务器配置管理 — 纯后端 CRUD + 连通测试 + Gist同步
 * UI 全部由 ConnectFragment 负责，CloudCtrl 只提供数据和操作
 */
class CloudCtrl(private val context: Context) {
    companion object { private const val TAG = "CloudCtrl" }
    private val prefs = context.getSharedPreferences("autodial", Context.MODE_PRIVATE)

    var onServerListChanged: (() -> Unit)? = null

    // ==================== 服务器列表 CRUD ====================

    fun getServerList(): MutableList<String> {
        val json = prefs.getString("cloud_servers", null)
        val list = if (json != null) {
            try {
                org.json.JSONArray(json).let { arr ->
                    val l = mutableListOf<String>()
                    for (i in 0 until arr.length()) l.add(arr.getString(i))
                    l
                }
            } catch (_: Exception) {
                fallbackOld()
            }
        } else fallbackOld()

        // 首次使用：填充默认云服务器
        if (list.isEmpty()) {
            val defaultServer = "ws://262ao85kz470.vicp.fun:55535"
            list.add(defaultServer)
            saveServerList(list)
        }
        return list
    }

    private fun fallbackOld(): MutableList<String> {
        val old = prefs.getString("cloud_server", "") ?: ""
        return if (old.isNotEmpty()) mutableListOf(old) else mutableListOf()
    }

    fun saveServerList(list: List<String>) {
        prefs.edit().putString("cloud_servers",
            org.json.JSONArray().apply { list.forEach { put(it) } }.toString()).apply()
        if (list.isNotEmpty()) {
            prefs.edit().putString("cloud_server", list[0]).apply()
        }
    }

    // ==================== 连通性测试 ====================

    /**
     * 测试单个服务器是否可达
     * @return Pair<server, reachable: Boolean?>
     *   true=可达, false=不可达, null=未测试
     */
    suspend fun testServer(server: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val httpUrl = when {
                server.startsWith("wss://") -> server.replace("wss://", "https://")
                server.startsWith("ws://") -> server.replace("ws://", "http://")
                server.contains("://") -> server  // 其他协议，保持原样
                else -> "http://$server"
            }
            withTimeout(4000) {
                val conn = URL(httpUrl).openConnection() as HttpURLConnection
                conn.connectTimeout = 2000
                conn.readTimeout = 2000
                conn.requestMethod = "GET"
                conn.connect()
                val code = conn.responseCode
                conn.disconnect()
                code in 200..499  // relay 返回 200 的 JSON 健康检查
            }
        } catch (_: Exception) { false }
    }

    /** 并发测试所有服务器 */
    suspend fun testAllServers(servers: List<String>): List<Pair<String, Boolean>> =
        coroutineScope {
            servers.map { server ->
                async { server to testServer(server) }
            }.awaitAll()
        }

    // ==================== 地址规范化 ====================

    fun stripCloudPrefix(addr: String) =
        addr.removePrefix("ws://").removePrefix("wss://").removeSuffix("/")

    fun currentServerLabel(): String = stripCloudPrefix(prefs.getString("cloud_server", "") ?: "")

    /** 将用户输入规范化为可用的服务器地址 */
    fun normalizeServer(input: String): String {
        val trimmed = input.trim().removeSuffix("/")
        if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed
        // 自动补 ws:// 前缀
        return "ws://$trimmed"
    }

    // ==================== Gist 同步 ====================

    suspend fun fetchServerListFromGist(): List<String>? = withContext(Dispatchers.IO) {
        val sources = listOf(
            "https://gist.githubusercontent.com/ztj555/cb6a6bb0ddbe3d4e651d5bb3411777d5/raw/AutoDialservers.txt",
            "https://gitee.com/zuo-tingjun/AutoDialserverslist/raw/master/servers.txt"
        )
        val allServers = mutableSetOf<String>()
        for (url in sources) {
            try {
                val lines = URL(url).readText().lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
                allServers.addAll(lines)
            } catch (_: Exception) { }
        }
        if (allServers.isEmpty()) null else allServers.toList()
    }
}
