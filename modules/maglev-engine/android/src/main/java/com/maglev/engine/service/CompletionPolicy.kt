package com.maglev.engine.service

import java.util.Locale

/** Pure rules and text for the "Download finished" notification (contract 13.2). */
object CompletionPolicy {
    /**
     * Notify on the `finished` false to true edge, and only when this torrent was seen DOWNLOADING since it was
     * last unfinished. A recheck, a move, an app restart (prev is null) or an already-complete add never notifies.
     */
    fun shouldNotify(prevFinished: Boolean?, finished: Boolean, sawDownloading: Boolean): Boolean =
        prevFinished == false && finished && sawDownloading

    /** "Downloaded · 1.4 GB". Without a known size, just "Downloaded". */
    fun body(sizeBytes: Long): String =
        if (sizeBytes > 0) "Downloaded · ${size(sizeBytes)}" else "Downloaded"

    fun summaryTitle(count: Int): String = if (count == 1) "1 download finished" else "$count downloads finished"

    /** Binary units, same style as [Notifications.speed]. */
    fun size(bytes: Long): String {
        val v = bytes.toDouble()
        return when {
            v >= 1024.0 * 1024 * 1024 * 1024 -> String.format(Locale.US, "%.1f TB", v / (1024.0 * 1024 * 1024 * 1024))
            v >= 1024.0 * 1024 * 1024 -> String.format(Locale.US, "%.1f GB", v / (1024.0 * 1024 * 1024))
            v >= 1024.0 * 1024 -> String.format(Locale.US, "%.1f MB", v / (1024.0 * 1024))
            v >= 1024.0 -> String.format(Locale.US, "%.0f KB", v / 1024.0)
            else -> "$bytes B"
        }
    }
}
