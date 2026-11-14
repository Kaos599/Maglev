package com.maglev.engine.update

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.maglev.engine.R

/** The "Updates" notification channel and the three update notices (docs/NATIVE_CONTRACT.md section 27.3 and 27.5). */
object UpdateNotices {
    const val CH_UPDATES = "maglev_updates"
    private const val ID_AVAILABLE = 4201
    private const val ID_READY = 4202
    private const val ID_UPDATED = 4203

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val ch = NotificationChannel(CH_UPDATES, "Updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "New Maglev versions and update results"
        }
        nm.createNotificationChannel(ch)
    }

    /** Opens About, where the update card is. */
    private fun aboutIntent(context: Context): PendingIntent {
        val i = Intent(Intent.ACTION_VIEW, Uri.parse("maglev://settings/about")).setPackage(context.packageName)
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, 4201, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun post(context: Context, id: Int, title: String, text: String?, tap: PendingIntent?, actionLabel: String? = null, action: PendingIntent? = tap) {
        ensureChannel(context)
        val nm = NotificationManagerCompat.from(context)
        if (!nm.areNotificationsEnabled()) return
        val b = NotificationCompat.Builder(context, CH_UPDATES)
            .setSmallIcon(R.drawable.ic_tile_maglev)
            .setContentTitle(title)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
        if (text != null) b.setContentText(text)
        if (tap != null) {
            b.setContentIntent(tap)
            if (actionLabel != null && action != null) b.addAction(0, actionLabel, action)
        }
        try {
            nm.notify(id, b.build())
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS was revoked between the check and the call.
        }
    }

    /**
     * The Install action of a "ready" notice: a broadcast to [UpdateInstallReceiver] that starts the install
     * (section 30). The tap on the body still opens About.
     */
    private fun installAction(context: Context, version: String, path: String, sha256: String): PendingIntent {
        val i = Intent(context, UpdateInstallReceiver::class.java).setAction(UpdateInstallReceiver.ACTION_INSTALL)
            .putExtra(UpdateInstallReceiver.EXTRA_PATH, path)
            .putExtra(UpdateInstallReceiver.EXTRA_SHA, sha256)
            .putExtra(UpdateInstallReceiver.EXTRA_VERSION, version)
        return PendingIntent.getBroadcast(context, 4204, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /**
     * kind: "available" (ask mode), "ready" (downloaded), "updated" (after MY_PACKAGE_REPLACED).
     * For "ready", [path] and [sha256] make the Install action start the install itself; without them it opens About.
     */
    fun show(context: Context, kind: String, version: String, path: String? = null, sha256: String? = null): Boolean {
        when (kind) {
            "available" -> post(context, ID_AVAILABLE, "Maglev $version is available", null, aboutIntent(context))
            "ready" -> {
                val about = aboutIntent(context)
                val action = if (path != null && sha256 != null) installAction(context, version, path, sha256) else about
                post(context, ID_READY, "Maglev $version is ready", null, about, "Install", action)
            }
            "updated" -> post(context, ID_UPDATED, "Maglev was updated to $version", null, aboutIntent(context))
            else -> return false
        }
        return true
    }

    /** "Ready, Install" whose tap opens the system confirm screen. Used when the confirm intent arrives in the background. */
    fun showConfirm(context: Context, version: String?, confirm: Intent) {
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val tap = PendingIntent.getActivity(context, 4202, confirm, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        post(context, ID_READY, if (version != null) "Maglev $version is ready" else "Maglev update is ready", null, tap, "Install")
    }

    fun clear(context: Context, kind: String) {
        val id = when (kind) {
            "available" -> ID_AVAILABLE
            "ready" -> ID_READY
            else -> return
        }
        NotificationManagerCompat.from(context).cancel(id)
    }
}
