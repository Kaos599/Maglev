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

    @Test fun notificationCopy() {
        assertEquals("Paused: phone storage is almost full", StorageGuard.PAUSED_TITLE)
        assertEquals("Free up space", StorageGuard.PAUSED_TEXT)
    }
}
