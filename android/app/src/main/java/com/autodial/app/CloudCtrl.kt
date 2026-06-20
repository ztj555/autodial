package com.autodial.app

import android.content.Context
import kotlinx.coroutines.*
import java.net.HttpURLConnection
import java.net.URL

/**
 * v5: 云服务器配置管理 — 纯后端 CRUD + 连通测试 + Gist同步
 * UI 全部由 ConnectFragment 负责，CloudCtrl 只提供数据和操作
 *
 * 服务器列表格式规范（用于 Gist/Gitee 维护）：
 * ```
 * [old]
 * ws://262ao85kz470.vicp.fun:55535
 * ws://backup.example.com:35430
 *
 * [new]
 * ws://your-server.com:35440
 * ```
 * - [old]: 4位PIN配对的老云端（端口通常35430）
 * - [new]: 11位手机号JWT认证的新云端（端口通常35440）
 * - 无 [old]/[new] 标签的旧格式文件，全部默认归类为 [old]
 */
class CloudCtrl(private val context: Context) {
    companion object { private const val TAG = "CloudCtrl" }
    private val prefs = context.getSharedPreferences("autodial", Context.MODE_PRIVATE)

    var onServerListChanged: (() -> Unit)? = null

    // ==================== 服务器条目 ====================

    data class ServerEntry(val url: String, val type: String) {
        val isOld get() = type != "new"
        val isNew get() = type == "new"
    }

    // ==================== 服务器列表 CRUD ====================

    fun getServerList(): List<ServerEntry> {
        return loadServerEntries().ifEmpty {
            val default = listOf(ServerEntry("ws://192.168.3.75:35440", "new"))
            saveServerEntries(default)
            default
        }
    }

    /** 根据输入长度排序：4位→old排前面，11位→new排前面 */
    fun getServersSortedBy(input: String): List<ServerEntry> {
        val all = getServerList()
        val prioritizeNew = input.length >= 5
        return all.sortedWith(object : Comparator<ServerEntry> {
            override fun compare(a: ServerEntry, b: ServerEntry): Int {
                // 相同类型按原顺序
                if (a.type == b.type) return 0
                return if (prioritizeNew) {
                    if (a.isNew) -1 else 1    // new在前
                } else {
                    if (a.isOld) -1 else 1    // old在前
                }
            }
        })
    }

    fun getOldServers() = getServerList().filter { it.isOld }
    fun getNewServers() = getServerList().filter { it.isNew }

    fun setServerList(entries: List<ServerEntry>) {
        saveServerEntries(entries)
        onServerListChanged?.invoke()
    }

    fun addServer(entry: ServerEntry) {
        val list = getServerList().toMutableList()
        if (list.none { it.url == entry.url }) {
            list.add(entry)
            saveServerEntries(list)
            onServerListChanged?.invoke()
        }
    }

    fun removeServer(url: String) {
        val list = getServerList().filter { it.url != url }
        saveServerEntries(list)
        onServerListChanged?.invoke()
    }

    // ==================== 持久化 ====================

    private fun loadServerEntries(): List<ServerEntry> {
        val json = prefs.getString("cloud_servers_v5", null)
        if (json != null) {
            try {
                val arr = org.json.JSONArray(json)
                val list = mutableListOf<ServerEntry>()
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    list.add(ServerEntry(obj.getString("url"), obj.optString("type", "old")))
                }
                if (list.isNotEmpty()) return list
            } catch (_: Exception) {}
        }
        // 兼容旧格式
        return migrateOldFormat()
    }

    private fun saveServerEntries(entries: List<ServerEntry>) {
        val arr = org.json.JSONArray()
        for (e in entries) {
            arr.put(org.json.JSONObject().apply {
                put("url", e.url)
                put("type", e.type)
            })
        }
        prefs.edit().putString("cloud_servers_v5", arr.toString()).apply()
    }

    /** 兼容旧版 cloud_servers (JSONArray of strings) → 全部归类 old */
    private fun migrateOldFormat(): List<ServerEntry> {
        val oldJson = prefs.getString("cloud_servers", null) ?: return emptyList()
        return try {
            val arr = org.json.JSONArray(oldJson)
            val list = mutableListOf<ServerEntry>()
            for (i in 0 until arr.length()) {
                list.add(ServerEntry(arr.getString(i), "old"))
            }
            saveServerEntries(list) // 迁移后写入新格式
            list
        } catch (_: Exception) { emptyList() }
    }

    /** 向后兼容：仅返回 URL 列表（可变） */
    fun getServerUrls(): MutableList<String> = getServerList().map { it.url }.toMutableList()

    /** 向后兼容：保存 URL 列表（全部归类为 old） */
    fun saveServerUrls(urls: List<String>) {
        setServerList(urls.map { ServerEntry(it, "old") })
    }

    // ==================== 连通性测试 ====================

    suspend fun testServer(server: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val httpUrl = when {
                server.startsWith("wss://") -> server.replace("wss://", "https://")
                server.startsWith("ws://") -> server.replace("ws://", "http://")
                server.contains("://") -> server
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
                code in 200..499
            }
        } catch (_: Exception) { false }
    }

    suspend fun testAllServers(servers: List<ServerEntry>): List<Pair<ServerEntry, Boolean>> =
        coroutineScope {
            servers.map { entry ->
                async { entry to testServer(entry.url) }
            }.awaitAll()
        }

    /** 向后兼容：String 列表 */
    suspend fun testAllServerUrls(servers: List<String>): Map<String, Boolean> {
        val entries = servers.map { ServerEntry(it, "old") }
        return testAllServers(entries).associate { (entry, ok) -> entry.url to ok }
    }

    // ==================== 地址规范化 ====================

    fun stripCloudPrefix(addr: String) =
        addr.removePrefix("ws://").removePrefix("wss://").removeSuffix("/")

    fun currentServerLabel(): String = stripCloudPrefix(
        prefs.getString("cloud_server", "") ?: ""
    )

    fun normalizeServer(input: String): String {
        val trimmed = input.trim().removeSuffix("/")
        if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed
        return "ws://$trimmed"
    }

    // ==================== Gist 同步 ====================

    /**
     * 从 Gist/Gitee 拉取服务器列表，支持 [old]/[new] 分区标签。
     * 格式范例：
     *   [old]
     *   ws://262ao85kz470.vicp.fun:55535
     *   [new]
     *   ws://your-server.com:35440
     */
    suspend fun fetchServerListFromGist(): List<ServerEntry>? = withContext(Dispatchers.IO) {
        val sources = listOf(
            "https://gist.githubusercontent.com/ztj555/cb6a6bb0ddbe3d4e651d5bb3411777d5/raw/AutoDialservers.txt",
            "https://gitee.com/zuo-tingjun/AutoDialserverslist/raw/master/servers.txt"
        )
        val allServers = mutableListOf<ServerEntry>()
        for (url in sources) {
            try {
                val lines = URL(url).readText().lines()
                var currentType = "old" // 默认老云端
                for (line in lines) {
                    val trimmed = line.trim()
                    if (trimmed.isEmpty() || trimmed.startsWith("#")) continue
                    if (trimmed.equals("[old]", ignoreCase = true)) { currentType = "old"; continue }
                    if (trimmed.equals("[new]", ignoreCase = true)) { currentType = "new"; continue }
                    // 支持旧格式: "URL 标签" 如 "ws://x.x.x.x 新云端"
                    val tag = when {
                        trimmed.contains("新云端") || trimmed.contains("[new]") -> "new"
                        trimmed.contains("老云端") || trimmed.contains("[old]") -> "old"
                        else -> currentType
                    }
                    val serverUrl = trimmed
                        .replace("新云端", "").replace("老云端", "")
                        .replace("[new]", "").replace("[old]", "")
                        .trim()
                    if (serverUrl.isNotEmpty()) {
                        // 自动补 ws:// 前缀
                        val fullUrl = if (serverUrl.startsWith("ws://") || serverUrl.startsWith("wss://")) serverUrl
                        else "ws://$serverUrl"
                        allServers.add(ServerEntry(fullUrl, tag))
                    }
                }
            } catch (_: Exception) {}
        }
        if (allServers.isEmpty()) null else allServers.distinctBy { it.url }
    }
}
