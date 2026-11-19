package com.maglev.engine.service

import java.util.Locale

/**
 * The app's speed format, the twin of `formatSpeed` in constants/format.ts: 3 significant digits ("2.00 MB/s",
 * "62.5 MB/s", "125 MB/s") and the unit moves up at 1000, not 1024 ("0.98 MB/s", never "1000 KB/s"). Bytes per second
 * stay whole. The notification and the app always show the same text.
 */
object SpeedText {
    private val UNITS = arrayOf("B", "KB", "MB", "GB", "TB")

    fun format(bps: Long): String {
        var v = if (bps > 0) bps.toDouble() else 0.0
        var i = 0
        while (i < UNITS.size - 1 && Math.round(v) >= 1000) {
            i++
            v /= 1024.0
        }
        if (i == 0) return "${Math.round(v)} B/s"
        val two = String.format(Locale.US, "%.2f", v)
        val one = String.format(Locale.US, "%.1f", v)
        val shown = when {
            two.toDouble() < 10 -> two
            one.toDouble() < 100 -> one
            else -> String.format(Locale.US, "%.0f", v)
        }
        return "$shown ${UNITS[i]}/s"
    }
}
