package com.autodial.app

import android.Manifest
import android.content.*
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.util.Log

class DialEngine(
    private val service: DialService,
    private val callLogDb: CallLogDb
) {
    companion object {
        private const val TAG = "DialEngine"
    }

    // ==================== SIM ====================

    fun getSimInfoList(): List<SubscriptionInfo> {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
                val sm = service.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as? SubscriptionManager
                sm?.activeSubscriptionInfoList?.filterNotNull() ?: emptyList()
            } else emptyList()
        } catch (_: Exception) { emptyList() }
    }

    fun getPhoneAccountHandle(simSlot: Int): PhoneAccountHandle? {
        return try {
            val telecomManager = service.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
            val simList = getSimInfoList()
            val targetInfo = simList.find { it.simSlotIndex == simSlot } ?: return null
            val subId = targetInfo.subscriptionId
            val iccId = targetInfo.iccId
            val handles = telecomManager.callCapablePhoneAccounts
            val subIdKeys = arrayOf("subscriptionId", "subscription", "sim_id", "simId", "phone_id", "phoneId", "slot_id", "slotId", "sub_id", "subId")
            for (handle in handles) {
                val acc = telecomManager.getPhoneAccount(handle) ?: continue
                if (!acc.hasCapabilities(android.telecom.PhoneAccount.CAPABILITY_CALL_PROVIDER)) continue
                val extras = acc.extras ?: continue
                for (key in subIdKeys) {
                    if (extras.getInt(key, -1) == subId) return handle
                }
            }
            if (iccId != null && iccId.isNotEmpty()) {
                for (handle in handles) {
                    if (handle.id == iccId) return handle
                    val acc = telecomManager.getPhoneAccount(handle) ?: continue
                    val accIcc = acc.extras?.getString("iccId") ?: acc.extras?.getString("icc_id")
                    if (accIcc == iccId) return handle
                }
            }
            val subIdStr = subId.toString()
            for (handle in handles) { if (handle.id == subIdStr) return handle }
            if (simSlot >= 0 && simSlot < handles.size) return handles[simSlot]
            val knownComponents = listOf(
                ComponentName("com.android.phone", "com.android.services.telephony.TelephonyConnectionService"),
                ComponentName("com.android.phone", "com.android.phone.MiuiTelephonyConnectionService"),
                ComponentName("com.android.phone", "com.mediatek.telephony.TelephonyConnectionService"),
                ComponentName("com.android.phone", "com.android.phone.HwTelephonyConnectionService"),
            )
            for (comp in knownComponents) {
                val handle = PhoneAccountHandle(comp, subIdStr)
                try {
                    val acc = telecomManager.getPhoneAccount(handle)
                    if (acc != null && acc.hasCapabilities(android.telecom.PhoneAccount.CAPABILITY_CALL_PROVIDER)) return handle
                } catch (_: Exception) {}
            }
            null
        } catch (e: Exception) { null }
    }

    // ==================== SIM selection ====================

    fun resolveSimSlot(number: String): Int {
        val prefs = service.getSharedPreferences("autodial", Context.MODE_PRIVATE)
        val modeKey = prefs.getString("dial_mode", DialMode.ROUND_SELECT.key) ?: DialMode.ROUND_SELECT.key
        val mode = DialMode.fromKey(modeKey)
        return when (mode) {
            DialMode.SIM1 -> 0
            DialMode.SIM2 -> 1
            DialMode.SYSTEM -> -2
            DialMode.POPUP -> -1
            DialMode.ALTERNATE -> { val l = callLogDb.getLastSimSlotGlobal(); if (l >= 0) 1 - l else 0 }
            DialMode.OPPOSITE -> {
                val d = callLogDb.getLastDialInfo(number, service)
                if (d != null && d.first >= 0) {
                    val twoDaysAgo = System.currentTimeMillis() - 2 * 24 * 60 * 60 * 1000L
                    if (d.second >= twoDaysAgo) 1 - d.first
                    else { val g = callLogDb.getLastSimSlotGlobal(); if (g >= 0) 1 - g else 0 }
                }
                else { val g = callLogDb.getLastSimSlotGlobal(); if (g >= 0) 1 - g else 0 }
            }
            DialMode.ROUND_SELECT -> {
                val d = callLogDb.getLastDialInfo(number, service)
                val tenDaysAgo = System.currentTimeMillis() - 10 * 24 * 60 * 60 * 1000L
                if (d != null && d.first >= 0 && d.second >= tenDaysAgo) -1
                else { val g = callLogDb.getLastSimSlotGlobal(); if (g >= 0) 1 - g else 0 }
            }
        }
    }

    fun getLastDialHintForPopup(number: String): Pair<Int, Long>? {
        return try { callLogDb.getLastDialInfo(number, service) } catch (_: Exception) { null }
    }

    // ==================== dial entry ====================

    fun dialNumber(number: String) {
        try {
            // If app is in background, bring it to foreground first via fullScreenIntent
            if (!DialService.isActivityVisible) {
                Log.w(TAG, "App in background, requesting foreground dial: $number")
                service.requestDialInForeground(number)
                return
            }

            notifyLastCallHint(number)
            if (androidx.core.content.ContextCompat.checkSelfPermission(service, Manifest.permission.CALL_PHONE)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                Log.e(TAG, "no CALL_PHONE permission")
                service.onDialResult(number, "error")
                return
            }
            val simSlot = resolveSimSlot(number)
            if (simSlot == -2) {
                val intent = Intent(Intent.ACTION_CALL).apply {
                    data = Uri.fromParts("tel", number, null)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                service.startActivity(intent)
                onDialSuccess(number, -1)
                return
            }
            if (simSlot >= 0) {
                broadcastDialSimInfo(number, simSlot)
                performDial(number, simSlot)
            } else {
                service.setPendingDialNumber(number)
                val lastHint = getLastDialHintForPopup(number)
                if (SimSelectOverlay.hasPermission(service)) {
                    SimSelectOverlay.show(service, number, lastHint?.first ?: -1, lastHint?.second ?: 0L)
                } else {
                    val intent = Intent(DialService.ACTION_SHOW_SIM_SELECT).apply {
                        putExtra("number", number)
                        putExtra("last_sim_slot", lastHint?.first ?: -1)
                        putExtra("last_dial_time", lastHint?.second ?: 0L)
                        setPackage(service.packageName)
                    }
                    service.sendBroadcast(intent)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "dialNumber failed: ${e.message}")
            service.onDialResult(number, "error")
        }
    }

    // ==================== dial execution ====================

    fun performDial(number: String, simSlot: Int) {
        try {
            val isXiaomi = Build.MANUFACTURER.equals("Xiaomi", ignoreCase = true)
            val telecomManager = service.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
            val handle = getPhoneAccountHandle(simSlot)
            val uri = Uri.fromParts("tel", number, null)
            val isShortCode = number.length <= 3 && !number.contains("*") && !number.contains("#")

            if ((isShortCode || !isXiaomi) && handle != null) {
                try {
                    val extras = Bundle()
                    extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
                    telecomManager.placeCall(uri, extras)
                    Log.d(TAG, "dialed(placeCall, SIM${simSlot + 1})")
                    onDialSuccess(number, simSlot)
                    return
                } catch (e: SecurityException) { Log.e(TAG, "placeCall denied: ${e.message}") }
                catch (e: Exception) { Log.e(TAG, "placeCall failed: ${e.message}") }
            }
            try {
                val intent = Intent(Intent.ACTION_CALL).apply {
                    data = uri
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    if (handle != null) putExtra(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
                }
                if (isXiaomi) DialAccessibilityService.expectSimPicker(simSlot)
                service.startActivity(intent)
                Log.d(TAG, "dialed(ACTION_CALL, SIM${simSlot + 1})")
                onDialSuccess(number, simSlot)
                return
            } catch (e: Exception) { Log.e(TAG, "ACTION_CALL failed: ${e.message}") }
            service.onDialResult(number, "error")
            callLogDb.insertDial(number, "error", simSlot)
        } catch (e: Exception) {
            service.onDialResult(number, "error")
        }
    }

    fun onDialSuccess(number: String, simSlot: Int) {
        service.onDialResult(number, "ok")
        callLogDb.insertDial(number, "ok", simSlot)
        notifyNewDial(number)
        copyNumberToClipboard(number)
        showDialAnimation()
    }

    fun endCall() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val tm = service.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
                tm.endCall()
            }
        } catch (_: Exception) {}
    }

    // ==================== helpers ====================

    private fun copyNumberToClipboard(number: String) {
        val prefs = service.getSharedPreferences("autodial", Context.MODE_PRIVATE)
        if (!prefs.getBoolean("auto_copy_number", true)) return
        try {
            val clipboard = service.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            clipboard.setPrimaryClip(android.content.ClipData.newPlainText("phone_number", number))
        } catch (_: Exception) {}
    }

    private fun showDialAnimation() {
        try {
            val prefs = service.getSharedPreferences("autodial", Context.MODE_PRIVATE)
            if (prefs.getInt("dial_animation_mode", DialAnimationOverlay.MODE_BOUNCE) == DialAnimationOverlay.MODE_OFF) return
            android.os.Handler(android.os.Looper.getMainLooper()).post { DialAnimationOverlay.show(service) }
        } catch (_: Exception) {}
    }

    fun broadcastDialSimInfo(number: String, simSlot: Int) {
        try {
            val intent = Intent("com.autodial.LAST_CALL_HINT").apply {
                putExtra("number", number); putExtra("hint", "\u672c\u6b21\u4f7f\u7528\uff1a\u5361${simSlot + 1}")
                setPackage(service.packageName)
            }
            service.sendBroadcast(intent)
        } catch (_: Exception) {}
    }

    fun notifyNewDial(number: String) {
        try {
            val intent = Intent("com.autodial.NEW_DIAL").apply {
                putExtra("number", number); setPackage(service.packageName)
            }
            service.sendBroadcast(intent)
        } catch (_: Exception) {}
    }

    private fun notifyLastCallHint(number: String) {
        try {
            if (androidx.core.content.ContextCompat.checkSelfPermission(service, Manifest.permission.READ_CALL_LOG)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) return
            @Suppress("DEPRECATION")
            val cursor = service.contentResolver.query(
                android.provider.CallLog.Calls.CONTENT_URI,
                arrayOf(android.provider.CallLog.Calls.NUMBER, android.provider.CallLog.Calls.DATE, android.provider.CallLog.Calls.PHONE_ACCOUNT_ID),
                "${android.provider.CallLog.Calls.NUMBER} = ?", arrayOf(number),
                "${android.provider.CallLog.Calls.DATE} DESC"
            ) ?: return
            cursor.use {
                if (it.moveToFirst()) {
                    val date = it.getLong(it.getColumnIndex(android.provider.CallLog.Calls.DATE))
                    val subId = it.getString(it.getColumnIndex(android.provider.CallLog.Calls.PHONE_ACCOUNT_ID))
                    var simSlot = 0
                    try {
                        val simList = getSimInfoList()
                        if (subId != null) for (info in simList) {
                            if (info.subscriptionId.toString() == subId) { simSlot = info.simSlotIndex; break }
                        }
                    } catch (_: Exception) {}
                    val dateStr = java.text.SimpleDateFormat("MM-dd", java.util.Locale.getDefault()).format(java.util.Date(date))
                    val today = java.text.SimpleDateFormat("MM-dd", java.util.Locale.getDefault()).format(java.util.Calendar.getInstance().time)
                    val hint = "\u4e0a\u6b21\uff1a\u5361${simSlot + 1}  ${if (dateStr == today) "\u4eca\u5929" else dateStr}"
                    val intent = Intent("com.autodial.LAST_CALL_HINT").apply {
                        putExtra("number", number); putExtra("hint", hint); setPackage(service.packageName)
                    }
                    service.sendBroadcast(intent)
                }
            }
        } catch (_: Exception) {}
    }
}
