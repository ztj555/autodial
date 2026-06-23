package com.autodial.app

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * HyperOS SIM选择器自动点击服务
 *
 * 工作流程:
 *   1. DialService 拨号前设置 pendingSimSlot
 *   2. 本服务检测到系统SIM选择弹窗
 *   3. 自动点击对应卡槽按钮
 *   4. 清除 pendingSimSlot
 *
 * 需要用户手动在 设置→无障碍 中开启
 */
class DialAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "DialA11y"
        /** 当前等待自动点击的SIM卡槽 (0=卡1, 1=卡2, -1=未等待) */
        @Volatile
        var pendingSimSlot: Int = -1

        /** 超时自动清除 (8秒) */
        private val timeoutHandler = Handler(Looper.getMainLooper())
        private val timeoutRunnable = Runnable {
            if (pendingSimSlot >= 0) {
                Log.w(TAG, "自动点击超时, 清除 pendingSimSlot=$pendingSimSlot")
                pendingSimSlot = -1
            }
        }

        /** DialService 调用此方法通知本服务: 即将弹系统SIM选择器 */
        fun expectSimPicker(simSlot: Int) {
            pendingSimSlot = simSlot
            timeoutHandler.removeCallbacks(timeoutRunnable)
            timeoutHandler.postDelayed(timeoutRunnable, 8000)
            Log.d(TAG, "等待SIM选择器弹出, simSlot=$simSlot")
        }
    }

    override fun onServiceConnected() {
        val info = AccessibilityServiceInfo().apply {
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                         AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            notificationTimeout = 100
            flags = AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
                    AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
        serviceInfo = info
        Log.d(TAG, "无障碍服务已连接")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (pendingSimSlot < 0) return

        val pkg = event.packageName?.toString() ?: return

        // 系统电话相关包名
        if (pkg != "com.android.phone" &&
            pkg != "com.android.server.telecom" &&
            pkg != "com.android.incallui") return

        // 查找并点击对应SIM按钮
        val root = rootInActiveWindow ?: return
        try {
            findAndClickSimButton(root, pendingSimSlot)
        } catch (e: Exception) {
            Log.e(TAG, "自动点击异常: ${e.message}")
        }
    }

    private fun findAndClickSimButton(root: AccessibilityNodeInfo, targetSlot: Int) {
        // HyperOS SIM选择器特征:
        // - 通常有"中国移动""中国联通"等文字
        // - 或者"卡1""卡2"标识
        // - 或者是列表项，每项包含网络名称

        val candidates = mutableListOf<AccessibilityNodeInfo>()

        // 策略1: 查找包含"卡1"/"卡2"文字的节点
        val simLabels = if (targetSlot == 0) arrayOf("卡1", "卡 1", "SIM 1", "sim1") 
                        else arrayOf("卡2", "卡 2", "SIM 2", "sim2")
        
        collectClickableNodes(root, candidates, simLabels)
        
        // 策略2: 按索引位置点击（HyperOS通常按顺序排列卡1、卡2）
        if (candidates.isEmpty()) {
            collectSimListItems(root, candidates)
            if (candidates.isNotEmpty() && targetSlot < candidates.size) {
                val target = candidates[targetSlot]
                Log.d(TAG, "按索引点击: slot=$targetSlot, text=${target.text}")
                performClick(target)
                return
            }
            return
        }

        // 找到文字匹配的节点，点击其父容器
        for (node in candidates) {
            if (node.isClickable) {
                Log.d(TAG, "点击匹配节点: text=${node.text}")
                performClick(node)
                return
            }
            // 向上查找可点击的父节点
            var parent: AccessibilityNodeInfo? = node.parent
            while (parent != null) {
                if (parent.isClickable) {
                    Log.d(TAG, "点击父节点: text=${parent.text}")
                    performClick(parent)
                    return
                }
                parent = parent.parent
            }
        }
    }

    private fun collectClickableNodes(
        node: AccessibilityNodeInfo,
        out: MutableList<AccessibilityNodeInfo>,
        labels: Array<String>
    ) {
        val text = node.text?.toString() ?: ""
        val desc = node.contentDescription?.toString() ?: ""
        for (label in labels) {
            if (text.contains(label) || desc.contains(label)) {
                out.add(node)
                return
            }
        }
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { collectClickableNodes(it, out, labels) }
        }
    }

    private fun collectSimListItems(
        node: AccessibilityNodeInfo,
        out: MutableList<AccessibilityNodeInfo>
    ) {
        // HyperOS SIM选择器里的列表项 (ListView/RecyclerView items)
        if (node.isClickable && node.className?.toString()?.contains("Layout") == true) {
            // 检查子节点是否包含运营商名称关键词
            val simKeywords = arrayOf("移动", "联通", "电信", "China", "中国", "CMCC", "CUCC", "CTCC")
            var found = false
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                val text = child.text?.toString() ?: ""
                val desc = child.contentDescription?.toString() ?: ""
                for (kw in simKeywords) {
                    if (text.contains(kw) || desc.contains(kw)) {
                        found = true
                        break
                    }
                }
                if (found) break
            }
            if (found) out.add(node)
        }
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { collectSimListItems(it, out) }
        }
    }

    private fun performClick(node: AccessibilityNodeInfo) {
        pendingSimSlot = -1  // 清除等待状态
        timeoutHandler.removeCallbacks(timeoutRunnable)
        val success = node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        Log.d(TAG, "执行点击: result=$success, text=${node.text}")
    }

    override fun onInterrupt() {
        pendingSimSlot = -1
    }
}
