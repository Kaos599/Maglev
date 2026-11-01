package com.maglev.engine.power

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

class PowerGovernanceManager(private val context: Context) {

    interface PowerStateListener {
        fun onPowerStateChanged(isCharging: boolean_type, batteryPercent: Int, shouldPause: boolean_type)
        fun onAutoExitTriggered()
    }

    private var listener: PowerStateListener? = null
    private var isReceiverRegistered: Boolean = false

    var downloadOnlyWhileCharging: Boolean = false
        private set
    var batteryCutoffThreshold: Int = 20
        private set
    var autoExitOnComplete: Boolean = false
        private set

    var isCharging: Boolean = true
        private set
    var batteryPercentage: Int = 100
        private set
    var shouldPauseTransfers: Boolean = false
        private set

    private val batteryReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context?, intent: Intent?) {
            if (intent?.action == Intent.ACTION_BATTERY_CHANGED) {
                val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
                val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)

                val pct = if (level >= 0 && scale > 0) {
                    ((level.toFloat() / scale.toFloat()) * 100).toInt()
                } else {
                    100
                }

                val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                        status == BatteryManager.BATTERY_STATUS_FULL ||
                        plugged == BatteryManager.BATTERY_PLUGGED_AC ||
                        plugged == BatteryManager.BATTERY_PLUGGED_USB ||
                        plugged == BatteryManager.BATTERY_PLUGGED_WIRELESS

                evaluatePower(charging, pct)
            }
        }
    }

    fun setListener(listener: PowerStateListener?) {
        this.listener = listener
    }

    fun configure(downloadOnlyWhileCharging: Boolean, batteryCutoffThreshold: Int, autoExitOnComplete: Boolean) {
        this.downloadOnlyWhileCharging = downloadOnlyWhileCharging
        this.batteryCutoffThreshold = batteryCutoffThreshold
        this.autoExitOnComplete = autoExitOnComplete
        evaluatePower(this.isCharging, this.batteryPercentage)
    }

    fun startMonitoring() {
        if (!isReceiverRegistered) {
            val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
            context.registerReceiver(batteryReceiver, filter)
            isReceiverRegistered = true
        }
    }

    fun stopMonitoring() {
        if (isReceiverRegistered) {
            try {
                context.unregisterReceiver(batteryReceiver)
            } catch (e: Exception) {
                // Ignored
            }
            isReceiverRegistered = false
        }
    }

    private fun evaluatePower(charging: Boolean, pct: Int) {
        this.isCharging = charging
        this.batteryPercentage = pct

        var pause = false
        if (!charging) {
            if (downloadOnlyWhileCharging) {
                pause = true
            }
            // CONTRACT-2.3: Battery threshold cutoff (<500ms reaction)
            if (batteryCutoffThreshold > 0 && pct < batteryCutoffThreshold) {
                pause = true
            }
        }

        this.shouldPauseTransfers = pause
        listener?.onPowerStateChanged(charging, pct, pause)
    }
}

typealias boolean_type = Boolean
