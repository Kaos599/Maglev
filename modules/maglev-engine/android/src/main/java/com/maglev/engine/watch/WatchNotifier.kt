package com.maglev.engine.watch

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

/**
 * Posts "<title> is up" for a watch (docs/contracts-0.19/watch.md section 7). Open and Download are deep links
 * (maglev://search?..., maglev://add-torrent?source=...), so nothing is added without the Add screen's checks.
 */
object WatchNotifier {
    const val CHANNEL = "maglev_watches"

    /** Same as utils/watch/logic.ts notificationId: 7000 + (String.hashCode() and 0xFFFF). */
    fun notificationId(watchId: String): Int = 7000 + (watchId.hashCode() and 0xFFFF)

    private fun ensureChannel(c: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val ch = NotificationChannel(CHANNEL, "Watches", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "A title you are watching for has a new result"
        }
        nm.createNotificationChannel(ch)
    }

    private fun link(c: Context, url: String, requestCode: Int): PendingIntent {
        val i = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            .setPackage(c.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(c, requestCode, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** True when the notification was handed to the system. False when notifications are off or the input is bad. */
    fun notify(c: Context, n: Map<String, Any?>): Boolean {
        val id = n["id"]?.toString() ?: return false
        val title = n["title"]?.toString() ?: return false
        val text = n["text"]?.toString() ?: ""
        val openUrl = n["openUrl"]?.toString() ?: return false
        val downloadUrl = n["downloadUrl"]?.toString()
        return try {
            ensureChannel(c)
            val nid = notificationId(id)
            val b = NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_tile_maglev)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
                .setContentIntent(link(c, openUrl, nid))
                .addAction(0, "Open", link(c, openUrl, nid))
            if (!downloadUrl.isNullOrEmpty()) b.addAction(0, "Download", link(c, downloadUrl, nid + 0x10000))
            val nm = NotificationManagerCompat.from(c)
            if (!nm.areNotificationsEnabled()) return false
            nm.notify(nid, b.build())
            true
        } catch (_: SecurityException) {
            false
        } catch (_: Exception) {
            false
        }
    }

    fun cancel(c: Context, watchId: String) {
        try {
            NotificationManagerCompat.from(c).cancel(notificationId(watchId))
        } catch (_: Exception) {
        }
    }
}
