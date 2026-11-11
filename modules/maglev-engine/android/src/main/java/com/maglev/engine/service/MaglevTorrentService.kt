package com.maglev.engine.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.ServiceCompat
import com.maglev.engine.EngineHost

/**
 * Foreground service (type dataSync) that keeps the process alive while torrents run.
 * Started and stopped by [EngineHost] from telemetry; JS never manages it.
 */
class MaglevTorrentService : Service() {

    companion object {
        const val ACTION_START = "com.maglev.engine.action.START"
        const val ACTION_UPDATE = "com.maglev.engine.action.UPDATE"
        const val ACTION_PAUSE_ALL = "com.maglev.engine.action.PAUSE_ALL"
        const val ACTION_RESUME_ALL = "com.maglev.engine.action.RESUME_ALL"
        const val ACTION_SHUTDOWN = "com.maglev.engine.action.SHUTDOWN"

        /**
         * API 34+ foreground type. specialUse has no 6-hour cap (dataSync does on Android 15).
         * Google Play requires a written specialUse justification, so a Play build should set this to false.
         * When false, API 34+ falls back to dataSync, which is also declared in the manifest.
         */
        const val USE_SPECIAL_USE_FGS = true

        private const val TAG = "MaglevService"
        private const val NOTIFY_MIN_INTERVAL_MS = 2000L
        private const val LOCK_TIMEOUT_MS = 15 * 60 * 1000L
        private const val LOCK_REFRESH_MS = 10 * 60 * 1000L

        @Volatile
        var instance: MaglevTorrentService? = null
            private set
    }

    private val handler = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var lockAcquiredAt = 0L
    private var lastKey: String? = null
    private var lastNotifyAt = 0L
    private var summary = TransferSummary()

    /** True once startForeground succeeded. [EngineHost] only stops a service that reached this state. */
    @Volatile
    var isForeground: Boolean = false
        private set

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        EngineHost.attach(applicationContext)
        Notifications.ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForegroundService() obliges us to call startForeground() for every start, whatever the action.
        if (!enterForeground()) {
            stopSelf()
            return START_NOT_STICKY
        }
        // A null intent means Android restarted us after the process died. No JS is running.
        if (intent == null) {
            EngineHost.headlessStart()
            return START_STICKY
        }
        when (intent.action) {
            ACTION_PAUSE_ALL -> EngineHost.pauseAllFromNotification()
            ACTION_RESUME_ALL -> EngineHost.resumeAllFromNotification()
            ACTION_SHUTDOWN -> EngineHost.shutdownFromNotification()
            else -> Unit
        }
        // Sticky so Android restarts us after a kill. EngineHost stops the service itself when nothing is wanted.
        return START_STICKY
    }

    /** The type argument is ignored below API 29 by ServiceCompat. */
    private fun foregroundType(): Int = when {
        Build.VERSION.SDK_INT >= 34 && USE_SPECIAL_USE_FGS -> ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        else -> 0
    }

    private fun enterForeground(): Boolean {
        return try {
            val n = Notifications.ongoing(this, summary)
            ServiceCompat.startForeground(this, Notifications.ID_ONGOING, n, foregroundType())
            isForeground = true
            true
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException (API 31+), SecurityException for a missing type permission, and similar.
            Log.w(TAG, "startForeground refused: ${e.javaClass.simpleName}: ${e.message}")
            EngineHost.onServiceStartBlocked(e.message ?: e.javaClass.simpleName)
            false
        }
    }

    /** Called from the engine poller. Thread-safe. */
    fun onSummary(s: TransferSummary) {
        handler.post {
            summary = s
            updateLocks(s.busy > 0)
            val key = listOf(
                Notifications.title(s), Notifications.text(s), s.downloadingPct, s.progressPct,
                s.downloading > 0, s.busy > 0, s.singleTorrentId,
            ).joinToString("|")
            val now = SystemClock.elapsedRealtime()
            // At most one update every 2 s, and only when the content changed. A skipped change is
            // picked up by the next 1 s poll because lastKey is not advanced.
            if (isForeground && key != lastKey && now - lastNotifyAt >= NOTIFY_MIN_INTERVAL_MS) {
                lastKey = key
                lastNotifyAt = now
                Notifications.update(this, Notifications.ongoing(this, s))
            }
        }
    }

    /** Android 15 dataSync timeout. Must stop within seconds. Contract-compatible: pause via governance, tell the user. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "foreground service timeout, type=$fgsType")
        EngineHost.onFgsTimeout()
        Notifications.notifyTimeout(this)
        stopSelf()
    }

    @Suppress("DEPRECATION")
    private fun updateLocks(active: Boolean) {
        val now = SystemClock.elapsedRealtime()
        if (active) {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Maglev:transfer").apply { setReferenceCounted(false) }
            }
            if (wifiLock == null) {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                wifiLock = wm?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Maglev:wifi")?.apply { setReferenceCounted(false) }
            }
            val stale = now - lockAcquiredAt >= LOCK_REFRESH_MS
            if (wakeLock?.isHeld != true || stale) {
                try {
                    wakeLock?.acquire(LOCK_TIMEOUT_MS)
                    if (wifiLock?.isHeld != true) wifiLock?.acquire()
                    lockAcquiredAt = now
                } catch (e: Exception) {
                    Log.w(TAG, "lock acquire failed: ${e.message}")
                }
            }
        } else {
            releaseLocks()
        }
    }

    private fun releaseLocks() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (_: Exception) {
        }
        lockAcquiredAt = 0L
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        releaseLocks()
        isForeground = false
        instance = null
        EngineHost.markCleanStop()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
