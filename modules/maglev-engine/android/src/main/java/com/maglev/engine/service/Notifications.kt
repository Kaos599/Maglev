package com.maglev.engine.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
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
    /** Name of the primary torrent: highest down_bps while downloading, else the most recently added. */
    val primaryName: String? = null,
    /** ETA of the primary downloading torrent in seconds, -1 when unknown. */
    val primaryEtaSecs: Long = -1,
    /** Aggregate progress of DOWNLOADING torrents only, 0..100, or -1. */
    val downloadingPct: Int = -1,
    /** Id when exactly one torrent is downloading (or, with nothing downloading, exactly one is seeding). */
    val singleTorrentId: String? = null,
    /** Governance reason of rule-paused torrents: "wifi_only", "battery", "charging_only", or null. */
    val ruleReason: String? = null,
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

    /** Opens the app. With a torrent id, deep-links to maglev://torrent/<id> (app.json scheme "maglev"). */
    private fun contentIntent(context: Context, torrentId: String? = null): PendingIntent? {
        val intent = if (torrentId != null) {
            Intent(Intent.ACTION_VIEW, Uri.parse("maglev://torrent/" + Uri.encode(torrentId))).setPackage(context.packageName)
        } else {
            context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        // Different data makes a distinct PendingIntent, so one request code is enough.
        return PendingIntent.getActivity(
            context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun serviceAction(context: Context, action: String, code: Int): PendingIntent {
        val i = Intent(context, MaglevTorrentService::class.java).setAction(action)
        return PendingIntent.getService(context, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun rulesOnly(s: TransferSummary) = s.busy == 0 && s.pausedByUser == 0 && s.pausedByRules > 0

    private fun reasonLabel(reason: String?): String = when (reason) {
        "battery" -> "battery"
        "charging_only" -> "charging"
        else -> "Wi-Fi"
    }

    /** Contract section 10.4 table. */
    fun title(s: TransferSummary): String {
        val name = s.primaryName?.takeIf { it.isNotBlank() } ?: "Torrent"
        return when {
            s.downloading == 1 -> name
            s.downloading > 1 -> "$name +${s.downloading - 1} more"
            s.seeding > 0 -> if (s.seeding == 1) "Seeding 1 torrent" else "Seeding ${s.seeding} torrents"
            rulesOnly(s) -> "Paused: waiting for ${reasonLabel(s.ruleReason)}"
            s.busy == 0 && s.pausedByUser > 0 -> "Paused \u00B7 ${s.pausedByUser} torrents"
            else -> "Maglev"
        }
    }

    /** Empty string means no content text. */
    fun text(s: TransferSummary): String = when {
        s.downloading == 1 -> listOfNotNull(
            if (s.downloadingPct >= 0) "${s.downloadingPct}%" else null,
            "\u2193 ${speed(s.downBps)}",
            eta(s.primaryEtaSecs)?.let { "$it left" },
        ).joinToString(" \u00B7 ")
        s.downloading > 1 -> "${s.downloading} downloading \u00B7 \u2193 ${speed(s.downBps)}"
        s.seeding > 0 -> "\u2191 ${speed(s.upBps)}"
        rulesOnly(s) -> ""
        s.lookingForInfo -> "Looking for torrent info\u2026"
        s.checking > 0 -> "Checking files\u2026"
        s.queued > 0 -> "Waiting for a free slot"
        s.pausedByUser > 0 -> "Tap Resume all to continue"
        else -> ""
    }

    /** "12 min left" style, without the word "left". Null when unknown. */
    fun eta(secs: Long): String? = when {
        secs < 0 -> null
        secs < 60 -> "under 1 min"
        secs < 3600 -> "${(secs + 59) / 60} min"
        secs < 86_400 -> {
            val h = secs / 3600
            val m = (secs % 3600) / 60
            if (m == 0L) "$h h" else "$h h $m min"
        }
        else -> "${secs / 86_400} d ${(secs % 86_400) / 3600} h"
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

    /**
     * Content comes from [s] (latest telemetry). While something downloads the notification asks for promotion
     * (Live Updates, API 36+) with a ProgressStyle and a short chip text. Never colorized, no RemoteViews,
     * and the channel is IMPORTANCE_LOW (above MIN). Below API 36 the same builder is a standard notification.
     */
    fun ongoing(context: Context, s: TransferSummary): Notification {
        val b = NotificationCompat.Builder(context, CH_TRANSFERS)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title(s))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(contentIntent(context, s.singleTorrentId))
        val text = text(s)
        if (text.isNotEmpty()) b.setContentText(text)
        if (s.downloading > 0) {
            val pct = s.downloadingPct
            val style = NotificationCompat.ProgressStyle()
                .addProgressSegment(NotificationCompat.ProgressStyle.Segment(100))
            if (pct >= 0) style.setProgress(pct) else style.setProgressIndeterminate(true)
            b.setStyle(style)
            b.setRequestPromotedOngoing(true)
            if (pct >= 0) b.setShortCriticalText("$pct%")
        } else if (s.progressPct >= 0) {
            b.setProgress(100, s.progressPct, false)
        }
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
