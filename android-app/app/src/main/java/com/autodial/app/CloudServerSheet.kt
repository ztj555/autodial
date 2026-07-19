package com.autodial.app

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.bottomsheet.BottomSheetDialog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class CloudServerSheet(private val activity: Activity, private val onChanged: () -> Unit) : BottomSheetDialog(activity) {
    private val ctrl = CloudCtrl(activity)
    private lateinit var list: LinearLayout
    private lateinit var colors: ThemeColors
    private var dp = 1f
    private val scope = CoroutineScope(Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState); colors = ThemeManager.getColors(activity); dp = activity.resources.displayMetrics.density
        val root = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding((16*dp).toInt(),(14*dp).toInt(),(16*dp).toInt(),(24*dp).toInt()); setBackgroundColor(Color.parseColor(colors.bg)) }
        root.addView(TextView(activity).apply { text="云服务器管理"; textSize=18f; setTypeface(null,1); setTextColor(Color.parseColor(colors.text)); setPadding(0,0,0,(10*dp).toInt()) })
        list = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }; root.addView(list)
        root.addView(LinearLayout(activity).apply {
            orientation=LinearLayout.HORIZONTAL; gravity=Gravity.CENTER
            addView(action("＋ 添加") { showAdd() }); addView(action("全部测试") { testAll() })
        })
        root.addView(LinearLayout(activity).apply {
            orientation=LinearLayout.HORIZONTAL; gravity=Gravity.CENTER
            addView(action("恢复默认") { resetToDefault() }); addView(action("网络获取") { fetchServers("正在从网络获取...") })
        })
        setContentView(root); render()
    }
    private fun render(results:Map<String,Boolean> = emptyMap()) {
        list.removeAllViews()
        val current = activity.getSharedPreferences("autodial",0).getString("cloud_server","")
        val cloudConnected = DialService.isCloudConnected
        ctrl.getServerList().forEach { entry ->
            val isCurrent = entry.url == current
            val display = if (entry.alias.isNotEmpty()) "⭐ ${entry.alias} · ${ctrl.stripCloudPrefix(entry.url)}"
                else if (isCurrent) "⭐ ${ctrl.stripCloudPrefix(entry.url)}"
                else "${ctrl.stripCloudPrefix(entry.url)}"
            
            list.addView(LinearLayout(activity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding((12*dp).toInt(), (10*dp).toInt(), (12*dp).toInt(), (10*dp).toInt())
                layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = (8*dp).toInt() }
                background = android.graphics.drawable.GradientDrawable().apply {
                    setColor(Color.parseColor(if (isCurrent && cloudConnected) blend(this@CloudServerSheet.colors.bg2, this@CloudServerSheet.colors.green, 15) else this@CloudServerSheet.colors.bg2))
                    cornerRadius = 12 * dp
                    if (isCurrent) setStroke((2*dp).toInt(), Color.parseColor(if (cloudConnected) this@CloudServerSheet.colors.green else this@CloudServerSheet.colors.primary))
                }
                
                // Line 1: Title
                addView(TextView(activity).apply {
                    text = display; textSize = 13f; setTypeface(null, 1)
                    setTextColor(Color.parseColor(this@CloudServerSheet.colors.text))
                })
                
                // Line 2: Status + [别名]
                addView(LinearLayout(activity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    addView(TextView(activity).apply {
                        text = if (isCurrent) "当前服务器" else "未使用"
                        textSize = 11f; setTextColor(Color.parseColor(this@CloudServerSheet.colors.text2))
                        layoutParams = LinearLayout.LayoutParams(0, -2, 1f)
                        setPadding(0, (4*dp).toInt(), 0, (4*dp).toInt())
                    })
                    addView(TextView(activity).apply {
                        text = "点击修改别名"; textSize = 11f
                        setTextColor(Color.parseColor(this@CloudServerSheet.colors.primary))
                        setPadding((8*dp).toInt(), (3*dp).toInt(), (8*dp).toInt(), (3*dp).toInt())
                        background = android.graphics.drawable.GradientDrawable().apply {
                            setColor(Color.parseColor(this@CloudServerSheet.colors.bg2)); cornerRadius = 6 * dp
                        }
                        setOnClickListener { showAliasEdit(entry.url, entry.alias) }
                    })
                })
                
                // Line 3: Action buttons
                addView(LinearLayout(activity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    if (isCurrent) {
                        val connLabel = if (cloudConnected) "🟢 已连接" else "🔴 未连接"
                        val connColor = if (cloudConnected) this@CloudServerSheet.colors.green else this@CloudServerSheet.colors.red
                        addView(action(connLabel, connColor) { /* no-op, status display */ })
                    } else {
                        addView(action("设为当前") {
                            activity.getSharedPreferences("autodial",0).edit().putString("cloud_server", entry.url).apply()
                            onChanged(); render()
                        })
                    }
                    addView(action("测试") {
                        Toast.makeText(activity, "正在测试 ${entry.alias.ifEmpty { ctrl.stripCloudPrefix(entry.url) }} ...", Toast.LENGTH_SHORT).show()
                        scope.launch {
                            val ok = ctrl.testServer(entry.url)
                            render(mapOf(entry.url to ok))
                        }
                    })
                    addView(action("删除") {
                        android.app.AlertDialog.Builder(activity)
                            .setTitle("删除服务器")
                            .setMessage("确定删除 ${entry.alias.ifEmpty { ctrl.stripCloudPrefix(entry.url) }}？")
                            .setPositiveButton("删除") { _, _ ->
                                ctrl.removeServer(entry.url); onChanged(); render()
                            }
                            .setNegativeButton("取消", null)
                            .show()
                    })
                })

                // Line 4: 测试结果
                val testResult = results[entry.url]
                if (testResult != null) {
                    val resultLabel = if (testResult) "✅ 可达" else "❌ 不可达"
                    val resultColor = if (testResult) this@CloudServerSheet.colors.green else this@CloudServerSheet.colors.red
                    addView(TextView(activity).apply {
                        text = resultLabel; textSize = 11f
                        setTextColor(Color.parseColor(resultColor))
                        setPadding(0, (4*dp).toInt(), 0, 0)
                    })
                }
            })
        }
    }
    
    private fun showAliasEdit(url: String, currentAlias: String) {
        val input = EditText(activity).apply {
            setText(currentAlias); hint = "服务器别名（留空则不设别名）"
        }
        android.app.AlertDialog.Builder(activity)
            .setTitle("设置别名")
            .setView(input)
            .setPositiveButton("保存") { _, _ ->
                ctrl.updateAlias(url, input.text.toString())
                onChanged(); render()
            }
            .setNegativeButton("取消", null)
            .show()
    }
    
    private fun blend(hex1: String, hex2: String, percent: Int): String {
        val c1 = Color.parseColor(hex1); val c2 = Color.parseColor(hex2)
        val r = (Color.red(c1) + (Color.red(c2) - Color.red(c1)) * percent / 100).coerceIn(0, 255)
        val g = (Color.green(c1) + (Color.green(c2) - Color.green(c1)) * percent / 100).coerceIn(0, 255)
        val b = (Color.blue(c1) + (Color.blue(c2) - Color.blue(c1)) * percent / 100).coerceIn(0, 255)
        return String.format("#%02X%02X%02X", r, g, b)
    }

    private fun action(label:String, click:()->Unit) = action(label, this@CloudServerSheet.colors.primary, click)
    
    private fun action(label:String, color: String, click:()->Unit)=TextView(activity).apply {
        text=label; textSize=12f; gravity=Gravity.CENTER; setTextColor(Color.parseColor(color))
        setPadding((12*dp).toInt(),(10*dp).toInt(),(12*dp).toInt(),(10*dp).toInt())
        layoutParams=LinearLayout.LayoutParams(0,-2,1f).apply{marginStart=(4*dp).toInt();marginEnd=(4*dp).toInt()}
        background=android.graphics.drawable.GradientDrawable().apply{
            setColor(Color.parseColor(this@CloudServerSheet.colors.bg2));cornerRadius=12*dp
            setStroke((1*dp).toInt(),Color.parseColor(color))
        }
        setOnClickListener{click()}
    }
    private fun showAdd(){
        val container = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding((24*dp).toInt(),(16*dp).toInt(),(24*dp).toInt(),(8*dp).toInt())
        }
        container.addView(TextView(activity).apply {
            text = "格式：IP或域名:端口，无需加 ws://"
            textSize = 12f
            setTextColor(Color.parseColor(this@CloudServerSheet.colors.text2))
        })
        container.addView(TextView(activity).apply {
            text = "示例：101.34.65.254:35430"
            textSize = 11f
            setTextColor(Color.parseColor(this@CloudServerSheet.colors.text2))
            setPadding(0, (4*dp).toInt(), 0, (8*dp).toInt())
        })
        val urlInput = EditText(activity).apply {
            hint = "IP或域名:端口"; inputType = android.text.InputType.TYPE_TEXT_URI
        }
        val aliasInput = EditText(activity).apply {
            hint = "别名（可选）"; inputType = android.text.InputType.TYPE_CLASS_TEXT
            setPadding(0, (12*dp).toInt(), 0, 0)
        }
        container.addView(urlInput)
        container.addView(aliasInput)
        android.app.AlertDialog.Builder(activity)
            .setTitle("添加云服务器")
            .setView(container)
            .setPositiveButton("添加") { _, _ ->
                val v = urlInput.text.toString().trim()
                val alias = aliasInput.text.toString().trim()
                if (v.isNotEmpty()) {
                    val tag = if (v.contains(":")) "new" else "old"   // 域名/域名:端口为新云端，4位PIN为老
                    ctrl.addServer(CloudCtrl.ServerEntry(ctrl.normalizeServer(v), tag, alias))
                    onChanged(); render()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }
    private fun testAll(){scope.launch{val r=ctrl.testAllServers(ctrl.getServerList()).associate{it.first.url to it.second};render(r);Toast.makeText(activity,"测试完成",Toast.LENGTH_SHORT).show()}}
    private fun resetToDefault(){
        android.app.AlertDialog.Builder(activity)
            .setTitle("恢复默认")
            .setMessage("将清除当前服务器列表，恢复为软件默认。确定？")
            .setPositiveButton("确定") { _, _ ->
                ctrl.resetToDefault()
                onChanged(); render()
                Toast.makeText(activity, "已恢复默认", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("取消", null)
            .show()
    }
    private fun fetchServers(message:String){Toast.makeText(activity,message,Toast.LENGTH_SHORT).show();scope.launch{val servers=ctrl.fetchServerListFromGist();if(!servers.isNullOrEmpty()){ctrl.setServerList(servers);onChanged();render();Toast.makeText(activity,"已获取 ${servers.size} 台服务器",Toast.LENGTH_SHORT).show()}else Toast.makeText(activity,"获取失败，请检查网络",Toast.LENGTH_SHORT).show()}}
    override fun dismiss() { scope.cancel(); super.dismiss() }
}

