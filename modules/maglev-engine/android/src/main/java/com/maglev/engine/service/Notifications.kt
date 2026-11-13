package com.maglev.engine.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.maglev.engine.R
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
    /** Governance reason of rule-paused torrents: "wifi_only", "battery", "charging_only", "network_unvalidated", "vpn_required", "seed_metered", or null. */
    val ruleReason: String? = null,
    /** Torrents paused by the schedule (not counted in [pausedByRules], so they never keep the service alive). */
    val pausedBySchedule: Int = 0,
    /** "HH:MM" when the schedule next changes, for the scheduled-pause notification. */
    val scheduleResumeAt: String? = null,
    /** Contract section 21: a player was fed stream bytes in the last 60 s. Counts as real work. */
    val streaming: Boolean = false,
) {
    val active: Int get() = downloading + seeding

    /** Active plus torrents that are queued, initializing or checking, plus a live stream. Counts as real work. */
    val busy: Int get() = active + queued + checking + initializing + (if (streaming) 1 else 0)

    val lookingForInfo: Boolean get() = active + queued + checking == 0 && initializing > 0 && !streaming
}

object Notifications {
    const val CH_TRANSFERS = "transfers"
    const val CH_COMPLETED = "completed"
    const val ID_ONGOING = 4101
    const val ID_TIMEOUT = 4102
    const val CH_REMINDERS = "maglev_reminders"
    const val ID_SCHEDULE_READY = 4103
    const val GROUP_COMPLETED = "maglev_completed"
    const val ID_COMPLETED_SUMMARY = 4999

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
        val reminders = NotificationChannel(CH_REMINDERS, "Reminders", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Scheduled downloads and new feed matches that need a tap to start"
        }
        nm.createNotificationChannel(transfers)
        nm.createNotificationChannel(completed)
        nm.createNotificationChannel(reminders)
    }

    /** Opens the app. With a torrent id, deep-links to maglev://torrent/<id> (app.json scheme "maglev"). */
    private fun contentIntent(context: Context, torrentId: String? = null, route: String? = null): PendingIntent? {
        val intent = if (route != null) {
            Intent(Intent.ACTION_VIEW, Uri.parse("maglev://$route")).setPackage(context.packageName)
        } else if (torrentId != null) {
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

    /**
     * Tapping a notification is an exempt user action, so this may start the foreground service
     * (https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).
     */
    private fun serviceStart(context: Context, action: String, code: Int): PendingIntent {
        val i = Intent(context, MaglevTorrentService::class.java).setAction(action)
        val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(context, code, i, flags)
        } else {
            PendingIntent.getService(context, code, i, flags)
        }
    }

    private fun rulesOnly(s: TransferSummary) = s.busy == 0 && s.pausedByUser == 0 && s.pausedByRules > 0

    private fun reasonLabel(reason: String?): String = when (reason) {
        "battery" -> "battery"
        "charging_only" -> "charging"
        "storage_full" -> "free space"
        "storage_unavailable" -> "the SD card"
        "network_unvalidated" -> "internet"
        "vpn_required" -> "VPN"
        else -> "Wi-Fi"
    }

    /** Contract section 10.4 table. */
    fun title(s: TransferSummary): String {
        val name = s.primaryName?.takeIf { it.isNotBlank() } ?: "Torrent"
        return when {
            s.downloading == 1 -> name
            s.downloading > 1 -> "$name +${s.downloading - 1} more"
            s.seeding > 0 -> if (s.seeding == 1) "Seeding 1 torrent" else "Seeding ${s.seeding} torrents"
            rulesOnly(s) && s.ruleReason == "seed_metered" -> "Paused: seeding waits for Wi-Fi"
            rulesOnly(s) && s.ruleReason == "storage_full" -> StorageGuard.PAUSED_TITLE
            rulesOnly(s) -> "Paused: waiting for ${reasonLabel(s.ruleReason)}"
            s.busy == 0 && s.pausedBySchedule > 0 -> "Scheduled pause"
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
        rulesOnly(s) && s.ruleReason == "storage_full" -> StorageGuard.PAUSED_TEXT
        rulesOnly(s) -> ""
        s.busy == 0 && s.pausedBySchedule > 0 -> s.scheduleResumeAt?.let { "Resumes $it" } ?: ""
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
            .setSmallIcon(R.drawable.ic_tile_maglev)
            .setContentTitle(title(s))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(
                if (rulesOnly(s) && s.ruleReason == "storage_full") contentIntent(context, route = "free-space")
                else contentIntent(context, s.singleTorrentId),
            )
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

    /** Opens one file with the system viewer. The grant flag lets the viewer read the FileProvider/SAF URI. */
    fun openFileAction(context: Context, torrentId: String, uri: Uri, mime: String): PendingIntent {
        // setClipData is a void Java setter, so it can't sit in a builder chain.
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mime)
            clipData = ClipData.newRawUri("", uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return PendingIntent.getActivity(
            context, 20 + (torrentId.hashCode() and 0xFFFF), intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    /**
     * "Download finished" (contract 13.2). [openFile] is non-null only for a single-file torrent.
     * Two or more showing at once get a group summary.
     */
    fun notifyCompleted(context: Context, id: String, name: String, sizeBytes: Long, openFile: PendingIntent?) {
        val nid = 5000 + (id.hashCode() and 0xFFFF)
        val b = NotificationCompat.Builder(context, CH_COMPLETED)
            .setSmallIcon(R.drawable.ic_tile_maglev)
            .setContentTitle(name)
            .setContentText(CompletionPolicy.body(sizeBytes))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setGroup(GROUP_COMPLETED)
            .setContentIntent(contentIntent(context, id))
        if (openFile != null) b.addAction(0, "Open", openFile)
        post(context, nid, b.build())
        postCompletedSummary(context, nid, name)
    }

    private fun postCompletedSummary(context: Context, newId: Int, newName: String) {
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // The notify() above may not be in activeNotifications yet, so count the others and add this one.
            val others = nm.activeNotifications.filter {
                it.notification.group == GROUP_COMPLETED && it.id != ID_COMPLETED_SUMMARY && it.id != newId
            }
            if (others.isEmpty()) return
            val names = others.mapNotNull { it.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() } + newName
            val count = others.size + 1
            val inbox = NotificationCompat.InboxStyle().setBigContentTitle(CompletionPolicy.summaryTitle(count))
            names.take(5).forEach { inbox.addLine(it) }
            if (names.size > 5) inbox.setSummaryText("+${names.size - 5} more")
            post(
                context, ID_COMPLETED_SUMMARY,
                NotificationCompat.Builder(context, CH_COMPLETED)
                    .setSmallIcon(R.drawable.ic_tile_maglev)
                    .setContentTitle(CompletionPolicy.summaryTitle(count))
                    .setContentText(names.joinToString(", "))
                    .setStyle(inbox)
                    .setGroup(GROUP_COMPLETED)
                    .setGroupSummary(true)
                    .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                    .setAutoCancel(true)
                    .setCategory(NotificationCompat.CATEGORY_STATUS)
                    .setContentIntent(contentIntent(context))
                    .build(),
            )
        } catch (_: Exception) {
            // The summary is cosmetic. Never let it break completion handling.
        }
    }

    /** Opens the system settings page for a channel, or the app notification page below API 26. Null on success. */
    fun openChannelSettings(context: Context, channel: String): String? {
        ensureChannels(context)
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                .putExtra(Settings.EXTRA_CHANNEL_ID, channel)
        } else {
            // Literals of Settings.ACTION_APP_NOTIFICATION_SETTINGS and EXTRA_APP_PACKAGE (both API 26).
            Intent("android.settings.APP_NOTIFICATION_SETTINGS").putExtra("android.provider.extra.APP_PACKAGE", context.packageName)
        }
        return try {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            null
        } catch (e: Exception) {
            e.message ?: "Notification settings are not available"
        }
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

    /** Background-start refused for a schedule resume (contract 11.5). */
    fun notifyScheduleReady(context: Context) {
        post(
            context, ID_SCHEDULE_READY,
            NotificationCompat.Builder(context, CH_REMINDERS)
                .setSmallIcon(R.drawable.ic_tile_maglev)
                .setContentTitle("Scheduled downloads are ready")
                .setContentText("Tap to start them.")
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setContentIntent(serviceStart(context, MaglevTorrentService.ACTION_SCHEDULE_RESUME, 10))
                .build(),
        )
    }

    /** Background-start refused for a feed drain (contract 11.6). One notification per rule. */
    fun notifyFeedMatches(context: Context, ruleId: String, ruleName: String, count: Int) {
        post(
            context, 6000 + (ruleId.hashCode() and 0xFFFF),
            NotificationCompat.Builder(context, CH_REMINDERS)
                .setSmallIcon(R.drawable.ic_tile_maglev)
                .setContentTitle("$count new from $ruleName")
                .setContentText("Tap to download.")
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setContentIntent(serviceStart(context, MaglevTorrentService.ACTION_DRAIN_FEED_ADDS, 11))
                .build(),
        )
    }

    const val ID_STORAGE_FULL = 4104
    const val ID_SD_REMOVED = 4105
    const val ID_CONTINUE = 4106
    const val ID_NEEDS_LINK = 4107
    const val GROUP_ERRORS = "maglev_errors"
    const val ID_ERRORS_SUMMARY = 4998

    /** SM-33: "Storage full · 2 downloads paused" and "SD card removed · 2 downloads paused". Tap opens the app. */
    fun notifyStorage(context: Context, id: Int, title: String) {
        post(
            context, id,
            NotificationCompat.Builder(context, CH_REMINDERS)
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentTitle(title)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setContentIntent(contentIntent(context, route = if (id == ID_STORAGE_FULL) "free-space" else null))
                .build(),
        )
    }

    /** SM-34: the background start was not possible. Tapping opens the app, which starts the service. */
    fun notifyContinue(context: Context, count: Int) {
        post(
            context, ID_CONTINUE,
            NotificationCompat.Builder(context, CH_REMINDERS)
                .setSmallIcon(R.drawable.ic_tile_maglev)
                .setContentTitle(com.maglev.engine.RestartEntryPolicy.reminderTitle(count))
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setContentIntent(contentIntent(context))
                .build(),
        )
    }

    /**
     * Link downloads that lost their link after a restart. A normal, dismissible notification (not the foreground
     * one). Tapping opens the app on Transfers, where each download offers a new link. Same id, so the count updates in place.
     */
    fun notifyNeedsLink(context: Context, count: Int) {
        val title = if (count == 1) "1 download needs a new link" else "$count downloads need a new link"
        post(
            context, ID_NEEDS_LINK,
            NotificationCompat.Builder(context, CH_REMINDERS)
                .setSmallIcon(R.drawable.ic_tile_maglev)
                .setContentTitle(title)
                .setContentText("Open Maglev to paste the link again.")
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setContentIntent(contentIntent(context))
                .build(),
        )
    }

    /** SM-36: "{name} stopped: {message}" on the Completed channel, grouped. Tap opens the torrent. */
    fun notifyTorrentError(context: Context, id: String, title: String) {
        val nid = 7000 + (id.hashCode() and 0xFFFF)
        post(
            context, nid,
            NotificationCompat.Builder(context, CH_COMPLETED)
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentTitle(title)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_ERROR)
                .setGroup(GROUP_ERRORS)
                .setContentIntent(contentIntent(context, id))
                .build(),
        )
        try {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val count = nm.activeNotifications.count {
                it.notification.group == GROUP_ERRORS && it.id != ID_ERRORS_SUMMARY && it.id != nid
            } + 1
            if (count < 2) return
            post(
                context, ID_ERRORS_SUMMARY,
                NotificationCompat.Builder(context, CH_COMPLETED)
                    .setSmallIcon(android.R.drawable.stat_sys_warning)
                    .setContentTitle("$count downloads stopped")
                    .setGroup(GROUP_ERRORS)
                    .setGroupSummary(true)
                    .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                    .setAutoCancel(true)
                    .setContentIntent(contentIntent(context))
                    .build(),
            )
        } catch (_: Exception) {
            // The summary is cosmetic.
        }
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
