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
            val out = Admission.admit(
                v.getLong("freeBytes"), v.getLong("pendingNeed"), v.getInt("stagingFactor"), v.getLong("selectionBytes"),
            )
            assertEquals("vector $i (${v.getString("name")})", v.getString("expect"), out.result.name)
        }
    }

    @Test fun budgetAndLeftAfter() {
        val gb = 1024L * 1024 * 1024
        val o = Admission.admit(10 * gb, 0, 1, gb)
        assertEquals(10 * gb - 200L * 1024 * 1024, o.budget)
        assertEquals(o.budget - o.need, o.leftAfter)
    }
}
