package com.maglev.engine.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.maglev.engine.MaglevEngineModule

class MaglevTorrentService : Service() {

    companion object {
        const val CHANNEL_ID = "maglev_transfers_channel"
        const val NOTIFICATION_ID = 9001

        const val ACTION_UPDATE_TELEMETRY = "com.maglev.engine.ACTION_UPDATE_TELEMETRY"
        const val ACTION_STOP_SERVICE = "com.maglev.engine.ACTION_STOP_SERVICE"
        const val ACTION_PAUSE_ALL = "com.maglev.engine.ACTION_PAUSE_ALL"

        const val EXTRA_ACTIVE_DOWNLOADS = "extra_active_downloads"
        const val EXTRA_ACTIVE_UPLOADS = "extra_active_uploads"
        const val EXTRA_DOWN_SPEED = "extra_down_speed"
        const val EXTRA_UP_SPEED = "extra_up_speed"

        private var wakeLock: PowerManager.WakeLock? = null

        fun updateService(
            context: Context,
            activeDown: Int,
            activeUp: Int,
            downSpeedBytes: Long,
            upSpeedBytes: Long
        ) {
            val totalActive = activeDown + activeUp
            if (totalActive <= 0) {
                stopService(context)
                return
            }

            val intent = Intent(context, MaglevTorrentService::class.java).apply {
                action = ACTION_UPDATE_TELEMETRY
                putExtra(EXTRA_ACTIVE_DOWNLOADS, activeDown)
                putExtra(EXTRA_ACTIVE_UPLOADS, activeUp)
                putExtra(EXTRA_DOWN_SPEED, downSpeedBytes)
                putExtra(EXTRA_UP_SPEED, upSpeedBytes)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopService(context: Context) {
            val stopIntent = Intent(context, MaglevTorrentService::class.java).apply {
                action = ACTION_STOP_SERVICE
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(stopIntent)
            } else {
                context.startService(stopIntent)
            }
        }
    }

    private val notificationManager by lazy {
        getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) return START_NOT_STICKY

        when (intent.action) {
            ACTION_STOP_SERVICE -> {
                // SLA CONTRACT: When active count is 0 or stop requested,
                // immediately release WakeLock and satisfy Android 8+ foreground service
                // requirements before stopping self
                releaseWakeLock()
                val notification = buildTelemetryNotification(0, 0, 0L, 0L)
                startForeground(NOTIFICATION_ID, notification)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
                stopSelf()
                return START_NOT_STICKY
            }

            ACTION_PAUSE_ALL -> {
                MaglevEngineModule.onPauseAllRequested()
                releaseWakeLock()
                val notification = buildTelemetryNotification(0, 0, 0L, 0L)
                startForeground(NOTIFICATION_ID, notification)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                } else {
                    @Suppress("DEPRECATION")
                    stopForeground(true)
                }
                stopSelf()
                return START_NOT_STICKY
            }

            ACTION_UPDATE_TELEMETRY -> {
                val activeDown = intent.getIntExtra(EXTRA_ACTIVE_DOWNLOADS, 0)
                val activeUp = intent.getIntExtra(EXTRA_ACTIVE_UPLOADS, 0)
                val totalActive = activeDown + activeUp

                if (totalActive <= 0) {
                    // SLA CONTRACT: When active count is 0, immediately release WakeLock
                    // and remove foreground notification without leaving idle clutter
                    releaseWakeLock()
                    val notification = buildTelemetryNotification(0, 0, 0L, 0L)
                    startForeground(NOTIFICATION_ID, notification)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                        stopForeground(STOP_FOREGROUND_REMOVE)
                    } else {
                        @Suppress("DEPRECATION")
                        stopForeground(true)
                    }
                    stopSelf()
                    return START_NOT_STICKY
                }

                // Transfers active: acquire Partial WakeLock to prevent CPU sleep
                acquireWakeLock()

                val downSpeed = intent.getLongExtra(EXTRA_DOWN_SPEED, 0L)
                val upSpeed = intent.getLongExtra(EXTRA_UP_SPEED, 0L)
                val notification = buildTelemetryNotification(activeDown, activeUp, downSpeed, upSpeed)
                startForeground(NOTIFICATION_ID, notification)
            }
        }

        return START_STICKY
    }

    private fun acquireWakeLock() {
        if (wakeLock == null) {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "Maglev::TransferWakeLock"
            ).apply {
                setReferenceCounted(false)
            }
        }
        wakeLock?.let {
            if (!it.isHeld) {
                it.acquire(60 * 60 * 1000L) // 1 hr max safety timeout
            }
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) {
                it.release()
            }
        }
        wakeLock = null
    }

    private fun buildTelemetryNotification(
        activeDown: Int,
        activeUp: Int,
        downSpeedBytes: Long,
        upSpeedBytes: Long
    ): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val downFormatted = formatSpeed(downSpeedBytes)
        val upFormatted = formatSpeed(upSpeedBytes)
        val content = "↓ $downFormatted  •  ↑ $upFormatted  ($activeDown active)"

        val pauseAllIntent = Intent(this, MaglevTorrentService::class.java).apply {
            action = ACTION_PAUSE_ALL
        }
        val pauseAllPendingIntent = PendingIntent.getService(
            this,
            1,
            pauseAllIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopAllIntent = Intent(this, MaglevTorrentService::class.java).apply {
            action = ACTION_STOP_SERVICE
        }
        val stopAllPendingIntent = PendingIntent.getService(
            this,
            2,
            stopAllIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Maglev Transfers")
            .setContentText(content)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pendingIntent)
            .addAction(android.R.drawable.ic_media_pause, "Pause All", pauseAllPendingIntent)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop All", stopAllPendingIntent)
            .build()
    }

    private fun formatSpeed(bytesPerSec: Long): String {
        return when {
            bytesPerSec >= 1024 * 1024 -> String.format("%.1f MB/s", bytesPerSec / (1024.0 * 1024.0))
            bytesPerSec >= 1024 -> String.format("%.0f KB/s", bytesPerSec / 1024.0)
            else -> "$bytesPerSec B/s"
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Active Transfers",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Maglev BitTorrent transfer speeds and activity"
                setShowBadge(false)
            }
            notificationManager.createNotificationChannel(channel)
        }
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
