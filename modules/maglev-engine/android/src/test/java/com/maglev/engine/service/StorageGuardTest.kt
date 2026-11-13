package com.maglev.engine.service

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Runs every vector in scripts/fixtures/storage-reserve-vectors.json, the same file the Rust tests read. */
class StorageGuardTest {
    private fun fixture(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val f = File(dir, "scripts/fixtures/storage-reserve-vectors.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        throw AssertionError("storage-reserve-vectors.json not found above ${System.getProperty("user.dir")}")
    }

    @Test fun allVectors() {
        val arr = JSONArray(fixture().readText())
        assertTrue(arr.length() >= 10)
        for (i in 0 until arr.length()) {
            val v = arr.getJSONObject(i)
            val total = v.getLong("total")
            assertEquals("reserve of vector $i", v.getLong("reserve"), StorageGuard.reserve(total))
            assertEquals(
                "vector $i (${v.getString("name")})",
                v.getBoolean("expectBlocked"),
                StorageGuard.next(v.getBoolean("blocked"), v.getLong("free"), total),
            )
        }
    }

    /** The share card judges space against what the storage rule keeps free, not only Admission's 200 MiB. */
    @Test fun shareCardFreeLeavesTheReserve() {
        val gib = 1024L * 1024 * 1024
        val mib = 1024L * 1024
        val total = 231 * gib // reserve is capped at 1 GiB
        // Admission already keeps 200 MiB, so the card takes off the other 824 MiB.
        assertEquals(3 * gib - (gib - 200 * mib), StorageGuard.shareCardFree(3 * gib, total))
        // Under the reserve nothing is usable, never a negative number.
        assertEquals(0L, StorageGuard.shareCardFree(500 * mib, total))
        // A small volume: reserve is the 500 MiB floor, so 300 MiB more than Admission keeps.
        assertEquals(2 * gib - 300 * mib, StorageGuard.shareCardFree(2 * gib, 16 * gib))
    }

    @Test fun notificationCopy() {
        assertEquals("Paused: phone storage is almost full", StorageGuard.PAUSED_TITLE)
        assertEquals("Free up space", StorageGuard.PAUSED_TEXT)
    }
}
