package com.maglev.engine.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.util.Locale

/** Aggregate view of the torrent list used for the ongoing notification and service decisions. */
data class TransferSummary(
    val downloading: Int = 0,
    val seeding: Int = 0,
    val queued: Int = 0,
    val pausedByUser: Int = 0,
    /** Aggregate progress of unfinished transfers, 0..100, or -1 when nothing is downloading. */
    val progressPct: Int = -1,
    val downBps: Long = 0,
    val upBps: Long = 0,
    /** Torrents waiting on Wi-Fi, battery or charging rules. */
    val pausedByRules: Int = 0,
    val checking: Int = 0,
    /** Torrents still fetching metadata. Dropped to 0 after 10 minutes with nothing else going on. */
    val initializing: Int = 0,
) {
    val active: Int get() = downloading + seeding

    /** Active plus torrents that are queued, initializing or checking. Counts as real work. */
    val busy: Int get() = active + queued + checking + initializing

    val lookingForInfo: Boolean get() = active + queued + checking == 0 && initializing > 0
}

object Notifications {
    const val CH_TRANSFERS = "transfers"
    const val CH_COMPLETED = "completed"
    const val ID_ONGOING = 4101
    const val ID_TIMEOUT = 4102

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val transfers = NotificationChannel(CH_TRANSFERS, "Transfers", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Ongoing downloads and seeding"
            setShowBadge(false)
        }
        val completed = NotificationChannel(CH_COMPLETED, "Completed", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Finished downloads and alerts"
        }
        nm.createNotificationChannel(transfers)
        nm.createNotificationChannel(completed)
    }

    private fun contentIntent(context: Context): PendingIntent? {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(
            context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun serviceAction(context: Context, action: String, code: Int): PendingIntent {
        val i = Intent(context, MaglevTorrentService::class.java).setAction(action)
        return PendingIntent.getService(context, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun title(s: TransferSummary): String =
        if (s.busy == 0 && s.pausedByUser == 0 && s.pausedByRules > 0) "Waiting \u00B7 ${s.pausedByRules} torrents"
        else if (s.busy == 0 && s.pausedByUser > 0) "Paused · ${s.pausedByUser} torrents"
        else "Downloading ${s.downloading} · Seeding ${s.seeding}"

    fun text(s: TransferSummary): String = when {
        s.lookingForInfo -> "Looking for torrent info\u2026"
        s.active == 0 && s.checking > 0 -> "Checking files\u2026"
        s.active == 0 && s.queued > 0 -> "Waiting for a free slot"
        s.active == 0 && s.pausedByUser == 0 -> "Paused by Wi-Fi, battery or charging rules"
        s.active == 0 -> "Tap Resume all to continue"
        else -> "\u2193 ${speed(s.downBps)} \u00B7 \u2191 ${speed(s.upBps)}"
    }

    fun speed(bps: Long): String {
        val v = bps.toDouble()
        return when {
            v >= 1024.0 * 1024 * 1024 -> String.format(Locale.US, "%.1f GB/s", v / (1024.0 * 1024 * 1024))
            v >= 1024.0 * 1024 -> String.format(Locale.US, "%.1f MB/s", v / (1024.0 * 1024))
            v >= 1024.0 -> String.format(Locale.US, "%.0f KB/s", v / 1024.0)
            else -> "$bps B/s"
        }
    }

    fun ongoing(context: Context, s: TransferSummary): Notification {
        val b = NotificationCompat.Builder(context, CH_TRANSFERS)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title(s))
            .setContentText(text(s))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(contentIntent(context))
        if (s.progressPct >= 0) b.setProgress(100, s.progressPct, false)
        if (s.busy > 0) {
            b.addAction(0, "Pause all", serviceAction(context, MaglevTorrentService.ACTION_PAUSE_ALL, 1))
        } else if (s.pausedByUser > 0) {
            b.addAction(0, "Resume all", serviceAction(context, MaglevTorrentService.ACTION_RESUME_ALL, 2))
        }
        b.addAction(0, "Shut down", serviceAction(context, MaglevTorrentService.ACTION_SHUTDOWN, 3))
        return b.build()
    }

    fun notifyCompleted(context: Context, id: String, name: String) {
        post(
            context, 5000 + (id.hashCode() and 0xFFFF),
            NotificationCompat.Builder(context, CH_COMPLETED)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Download complete: $name")
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setContentIntent(contentIntent(context))
                .build(),
        )
    }

    fun notifyTimeout(context: Context) {
        post(
            context, ID_TIMEOUT,
            NotificationCompat.Builder(context, CH_COMPLETED)
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentTitle("Paused after 6 hours in the background. Open Maglev to continue.")
                .setAutoCancel(true)
                .setContentIntent(contentIntent(context))
                .build(),
        )
    }

    fun cancel(context: Context, id: Int) {
        try {
            NotificationManagerCompat.from(context).cancel(id)
        } catch (_: Exception) {
        }
    }

    fun update(context: Context, notification: Notification) = post(context, ID_ONGOING, notification)

    private fun post(context: Context, id: Int, n: Notification) {
        try {
            ensureChannels(context)
            val nm = NotificationManagerCompat.from(context)
            if (nm.areNotificationsEnabled()) nm.notify(id, n)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted
        }
    }
}
