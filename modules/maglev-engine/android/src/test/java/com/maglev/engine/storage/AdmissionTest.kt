package com.maglev.engine.storage

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Runs every vector in scripts/fixtures/admission-vectors.json. The file is read from the repository (found by
 * walking up from the working directory), so the TypeScript and Kotlin ports share one copy.
 */
class AdmissionTest {

    private fun fixture(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val f = File(dir, "scripts/fixtures/admission-vectors.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        throw AssertionError("scripts/fixtures/admission-vectors.json not found above ${System.getProperty("user.dir")}")
    }

    @Test fun allVectors() {
        val arr = JSONArray(fixture().readText())
        assertTrue("fixture is empty", arr.length() >= 10)
        for (i in 0 until arr.length()) {
            val v = arr.getJSONObject(i)
            // A vector gives either a ready pendingNeed or the torrents and link downloads it is computed from.
            val pending = if (v.has("pendingNeed")) v.getLong("pendingNeed") else {
                var need = 0L
                val ts = v.getJSONArray("torrents")
                for (j in 0 until ts.length()) {
                    val t = ts.getJSONObject(j)
                    need += Admission.torrentNeed(t.getBoolean("finished"), t.getLong("includedBytes"), t.getLong("downloadedBytes"))
                }
                val ds = v.getJSONArray("downloads")
                for (j in 0 until ds.length()) {
                    val d = ds.getJSONObject(j)
                    need += Admission.downloadNeed(
                        d.getString("state"),
                        if (d.isNull("size")) null else d.getLong("size"),
                        d.getLong("downloaded"),
                        if (d.isNull("errorCode")) null else d.getString("errorCode"),
                        if (d.isNull("httpStatus")) null else d.getInt("httpStatus"),
                    )
                }
                assertEquals("vector $i (${v.getString("name")}) pending need", v.getLong("expectPendingNeed"), need)
                need
            }
            val out = Admission.admit(
                v.getLong("freeBytes"), pending, v.getInt("stagingFactor"), v.getLong("selectionBytes"),
            )
            assertEquals("vector $i (${v.getString("name")})", v.getString("expect"), out.result.name)
        }
    }

    @Test fun pendingNeedFromNativeList() {
        val gb = 1024L * 1024 * 1024
        val list = mapOf<String, Any?>(
            "ok" to true,
            "torrents" to listOf(
                mapOf("finished" to false, "total_bytes" to 4 * gb, "progress_bytes" to 1 * gb),
                mapOf("finished" to true, "total_bytes" to 9 * gb, "progress_bytes" to 9 * gb),
                // No `finished` flag: judged by progress.
                mapOf("total_bytes" to 2 * gb, "progress_bytes" to 2 * gb),
            ),
            "downloads" to listOf(
                mapOf("state" to "downloading", "size" to 5 * gb, "downloaded" to 1 * gb),
                mapOf("state" to "paused", "size" to 3 * gb, "downloaded" to 0L),
                mapOf("state" to "finished", "size" to 7 * gb, "downloaded" to 7 * gb),
                mapOf("state" to "needs_link", "size" to 7 * gb, "downloaded" to 1 * gb),
                mapOf("state" to "downloading", "size" to null, "downloaded" to 1 * gb),
                mapOf("state" to "error", "size" to 6 * gb, "downloaded" to 0L, "error" to mapOf("code" to "HTTP_STATUS", "http_status" to 404)),
                mapOf("state" to "error", "size" to 1 * gb, "downloaded" to 0L, "error" to mapOf("code" to "HTTP_STATUS", "http_status" to 503)),
            ),
        )
        // 3 (torrent) + 4 + 3 (links) + 1 (503 retry)
        assertEquals(11 * gb, Admission.pendingNeedFromList(list))
        assertEquals(0L, Admission.pendingNeedFromList(mapOf("ok" to true)))
    }

    @Test fun budgetAndLeftAfter() {
        val gb = 1024L * 1024 * 1024
        val o = Admission.admit(10 * gb, 0, 1, gb)
        assertEquals(10 * gb - 200L * 1024 * 1024, o.budget)
        assertEquals(o.budget - o.need, o.leftAfter)
    }
}
