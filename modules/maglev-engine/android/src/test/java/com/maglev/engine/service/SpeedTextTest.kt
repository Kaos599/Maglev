package com.maglev.engine.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Same cases as scripts/test-format.js, so the notification and the app agree. */
class SpeedTextTest {
    private val k = 1024L
    private val m = 1024L * 1024L

    @Test fun matchesTheAppFormat() {
        val cases = listOf(
            0L to "0 B/s", 512L to "512 B/s", 999L to "999 B/s", 1000L to "0.98 KB/s",
            (4.1 * k).toLong() to "4.10 KB/s", (62.5 * k).toLong() to "62.5 KB/s", 250 * k to "250 KB/s",
            1000 * k to "0.98 MB/s", 2 * m to "2.00 MB/s", (62.5 * m).toLong() to "62.5 MB/s",
            125 * m to "125 MB/s", 625 * m to "625 MB/s", (1.25 * 1024 * m).toLong() to "1.25 GB/s",
        )
        for ((bps, want) in cases) assertEquals("$bps", want, SpeedText.format(bps))
    }

    @Test fun neverWiderThanNine() {
        var e = 0.0
        while (e <= 40.0) {
            val s = SpeedText.format(Math.pow(2.0, e).toLong())
            assertTrue(s, s.length <= 9)
            e += 0.01
        }
        assertEquals("0 B/s", SpeedText.format(-5))
    }
}
