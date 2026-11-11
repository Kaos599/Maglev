package com.maglev.engine.power

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

/** Tracks battery level and charging state from the sticky ACTION_BATTERY_CHANGED broadcast. */
class PowerGovernanceManager(context: Context, private val onChanged: () -> Unit) {
    private val appContext = context.applicationContext
    private var receiver: BroadcastReceiver? = null

    @Volatile
    var levelPct: Int = 100
        private set

    @Volatile
    var charging: Boolean = false
        private set

    fun start() {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent != null) apply(intent)
                onChanged()
            }
        }
        val sticky = appContext.registerReceiver(r, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        receiver = r
        if (sticky != null) apply(sticky)
    }

    fun stop() {
        val r = receiver ?: return
        try {
            appContext.unregisterReceiver(r)
        } catch (_: Exception) {
        }
        receiver = null
    }

    private fun apply(i: Intent) {
        val level = i.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = i.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        if (level >= 0 && scale > 0) levelPct = level * 100 / scale
        val status = i.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL ||
            i.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
    }
}
