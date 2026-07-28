package com.autodial.app

import android.content.Context
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * v5: 云服务器配置管理 — 纯后端 CRUD + 连通测试 + Gist同步
 * UI 全部由 ConnectFragment 负责，CloudCtrl 只提供数据和操作
 *
 * 服务器列表格式规范（纯 IP:PORT，不带协议前缀，代码自动补全 ws://）：
 * ```
 * [old]
 * 262ao85kz470.vicp.fun:55535
 * backup.example.com:35430
 *
 * [new]
 * your-server.com:35440
 * ```
 * - [old]: 4位PIN配对的老云端（端口通常35430）
 * - [new]: 11位PIN的新云端（端口通常35430，JWT已废弃）
 * - 无 [old]/[new] 标签的旧格式文件，全部默认归类为 [old]
 */
class CloudCtrl(private val context: Context) {
    companion object { private const val TAG = "CloudCtrl" }
    private val prefs = context.getSharedPreferences("autodial", Context.MODE_PRIVATE)

    var onServerListChanged: (() -> Unit)? = null

    // ==================== 服务器条目 ====================

    data class ServerEntry(val url: String, val type: String, val alias: String = "") {
        val isOld get() = type != "new"
        val isNew get() = type == "new"
    }

    // ==================== 服务器列表 CRUD ====================

    fun getServerList(): List<ServerEntry> {
        val list = loadServerEntries().ifEmpty {
            val default = listOf(ServerEntry("101.34.65.254:35430", "new", "融鑫汇腾讯云专线"))
            saveServerEntries(default)
            default
        }
        // 如果 cloud_server 未设置，默认选第一个
        if (prefs.getString("cloud_server", "")?.isEmpty() != false && list.isNotEmpty()) {
            prefs.edit().putString("cloud_server", list.first().url).apply()
        }
        return list
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

    /** 恢复为默认服务器列表（清除已保存的，回退到代码内置默认） */
    fun resetToDefault() {
        saveServerEntries(emptyList())
        onServerListChanged?.invoke()
    }
    fun updateAlias(url: String, alias: String) {
        val list = getServerList().map {
            if (it.url == url) it.copy(alias = alias.trim()) else it
        }
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
                    list.add(ServerEntry(
                        obj.getString("url"),
                        obj.optString("type", "old"),
                        obj.optString("alias", "")
                    ))
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
                if (e.alias.isNotEmpty()) put("alias", e.alias)
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
            val wsUrl = when {
                server.startsWith("ws://") || server.startsWith("wss://") -> server
                else -> "ws://$server"
            }
            kotlinx.coroutines.suspendCancellableCoroutine { cont ->
                val client = OkHttpClient.Builder()
                    .connectTimeout(3, TimeUnit.SECONDS)
                    .readTimeout(3, TimeUnit.SECONDS)
                    .build()
                val request = Request.Builder().url(wsUrl).build()
                var resolved = false
                client.newWebSocket(request, object : WebSocketListener() {
                    override fun onOpen(ws: WebSocket, response: Response) {
                        ws.send(JSONObject().apply {
                            put("type", "auth")
                            put("pin", "0000")   // 假PIN触发auth_fail，但证明链路通
                            put("role", "phone")
                            put("deviceName", "CloudTest")
                        }.toString())
                    }
                    override fun onMessage(ws: WebSocket, text: String) {
                        if (resolved) return
                        val msg = JSONObject(text)
                        val type = msg.optString("type", "")
                        // auth_ok 或 auth_fail 都说明服务器功能正常
                        if (type == "auth_ok" || type == "auth_fail") {
                            resolved = true
                            cont.resume(true) {}
                            ws.close(1000, null)
                        }
                    }
                    override fun onFailure(ws: WebSocket, t: Throwable, r: Response?) {
                        if (!resolved) { resolved = true; cont.resume(false) {} }
                    }
                    override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                        if (!resolved) { resolved = true; cont.resume(false) {} }
                    }
                })
                cont.invokeOnCancellation {
                    if (!resolved) { resolved = true; client.dispatcher.executorService.shutdown() }
                }
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
                    // 提取标签 + 别名
                    val tag = when {
                        trimmed.contains("新云端") || trimmed.contains("[new]") -> "new"
                        trimmed.contains("老云端") || trimmed.contains("[old]") -> "old"
                        else -> currentType
                    }
                    var remain = trimmed
                        .replace("新云端", "").replace("老云端", "")
                        .replace("[new]", "").replace("[old]", "")
                        .trim()
                    // 提取别名：URL 后面的空格后面的部分
                    var alias = ""
                    val spaceIdx = remain.indexOf(' ')
                    if (spaceIdx > 0) {
                        val urlPart = remain.substring(0, spaceIdx).trim()
                        val aliasPart = remain.substring(spaceIdx + 1).trim()
                        // 如果第一部分像是URL（含 . 或 :），拆分为URL+别名
                        if (urlPart.contains(".") || urlPart.contains(":")) {
                            remain = urlPart
                            alias = aliasPart
                        }
                    }
                    if (remain.isNotEmpty()) {
                        // 没有端口号则默认补 35430
                        var url = remain
                        if (!url.contains(":")) url = "$url:35430"
                        // 自动补 ws:// 前缀
                        val fullUrl = if (url.startsWith("ws://") || url.startsWith("wss://")) url
                        else "ws://$url"
                        allServers.add(ServerEntry(fullUrl, tag, alias))
                    }
                }
            } catch (_: Exception) {}
        }
        if (allServers.isEmpty()) null else allServers.distinctBy { it.url }
    }
}
