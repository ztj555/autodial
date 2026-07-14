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
            addView(action("＋ 添加") { showAdd() }); addView(action("全部测速") { testAll() })
        })
        root.addView(LinearLayout(activity).apply {
            orientation=LinearLayout.HORIZONTAL; gravity=Gravity.CENTER
            addView(action("PC 同步") { fetchServers("正在从 PC 同步...") }); addView(action("网络获取") { fetchServers("正在从网络获取...") })
        })
        setContentView(root); render()
    }
    private fun action(label:String, click:()->Unit)=TextView(activity).apply {
        text=label; textSize=12f; gravity=Gravity.CENTER; setTextColor(Color.parseColor(this@CloudServerSheet.colors.primary)); setPadding((12*dp).toInt(),(10*dp).toInt(),(12*dp).toInt(),(10*dp).toInt()); layoutParams=LinearLayout.LayoutParams(0,-2,1f).apply{marginStart=(4*dp).toInt();marginEnd=(4*dp).toInt()}; background=android.graphics.drawable.GradientDrawable().apply{setColor(Color.parseColor(this@CloudServerSheet.colors.bg2));cornerRadius=12*dp;setStroke((1*dp).toInt(),Color.parseColor(this@CloudServerSheet.colors.primary))}; setOnClickListener{click()}
    }
    private fun render(results:Map<String,Boolean> = emptyMap()) {
        list.removeAllViews(); val current=activity.getSharedPreferences("autodial",0).getString("cloud_server","")
        ctrl.getServerList().forEach { entry ->
            list.addView(LinearLayout(activity).apply {
                orientation=LinearLayout.VERTICAL; setPadding((12*dp).toInt(),(10*dp).toInt(),(12*dp).toInt(),(10*dp).toInt()); layoutParams=LinearLayout.LayoutParams(-1,-2).apply{bottomMargin=(8*dp).toInt()}; background=android.graphics.drawable.GradientDrawable().apply{setColor(Color.parseColor(this@CloudServerSheet.colors.bg2));cornerRadius=12*dp;if(entry.url==current)setStroke((2*dp).toInt(),Color.parseColor(this@CloudServerSheet.colors.primary))}
                addView(TextView(activity).apply{text=ctrl.stripCloudPrefix(entry.url);textSize=13f;setTypeface(null,1);setTextColor(Color.parseColor(colors.text))})
                addView(TextView(activity).apply{text=when(results[entry.url]){true->"在线";false->"连接失败";null->if(entry.url==current)"当前服务器" else if(entry.isNew)"新云端" else "老云端"};textSize=10f;setTextColor(Color.parseColor(when(results[entry.url]){true->colors.green;false->colors.red;null->colors.text2}));setPadding(0,(4*dp).toInt(),0,(6*dp).toInt())})
                addView(LinearLayout(activity).apply{orientation=LinearLayout.HORIZONTAL;addView(action("设为当前"){activity.getSharedPreferences("autodial",0).edit().putString("cloud_server",entry.url).apply();onChanged();render()});addView(action("测速"){scope.launch{render(mapOf(entry.url to ctrl.testServer(entry.url)))}});addView(action("删除"){ctrl.removeServer(entry.url);onChanged();render()})})
            })
        }
    }
    private fun showAdd(){ val input=EditText(activity).apply{hint="ws://server:port"}; android.app.AlertDialog.Builder(activity).setTitle("添加云服务器").setView(input).setPositiveButton("添加"){_,_->val v=input.text.toString().trim();if(v.isNotEmpty()){ctrl.addServer(CloudCtrl.ServerEntry(ctrl.normalizeServer(v),"new"));onChanged();render()}}.setNegativeButton("取消",null).show() }
    private fun testAll(){scope.launch{val r=ctrl.testAllServers(ctrl.getServerList()).associate{it.first.url to it.second};render(r);Toast.makeText(activity,"测速完成",Toast.LENGTH_SHORT).show()}}
    private fun fetchServers(message:String){Toast.makeText(activity,message,Toast.LENGTH_SHORT).show();scope.launch{val servers=ctrl.fetchServerListFromGist();if(!servers.isNullOrEmpty()){ctrl.setServerList(servers);onChanged();render();Toast.makeText(activity,"已获取 ${servers.size} 台服务器",Toast.LENGTH_SHORT).show()}else Toast.makeText(activity,"获取失败，请检查网络",Toast.LENGTH_SHORT).show()}}
    override fun dismiss() { scope.cancel(); super.dismiss() }
}

