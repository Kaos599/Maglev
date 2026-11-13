package com.maglev.engine.share

import java.io.File
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs the vectors in `modules/maglev-engine/src/shareClassify.fixture.json`, the same file the node test reads. */
class ShareClassifyTest {
    private fun fixture(): JSONArray {
        val candidates = listOf(
            "../src/shareClassify.fixture.json", // Gradle runs unit tests from the android/ folder
            "src/shareClassify.fixture.json",
            "modules/maglev-engine/src/shareClassify.fixture.json",
        )
        val f = candidates.map { File(it) }.firstOrNull { it.exists() }
            ?: error("shareClassify.fixture.json not found from ${File(".").absolutePath}")
        return JSONArray(f.readText())
    }

    private fun str(o: org.json.JSONObject, k: String): String? = if (o.isNull(k)) null else o.getString(k)

    @Test fun everyVector() {
        val v = fixture()
        assertTrue(v.length() > 20)
        for (i in 0 until v.length()) {
            val o = v.getJSONObject(i)
            val got = ShareClassify.classify(str(o, "text"), str(o, "mime"))
            val label = o.getString("name")
            assertEquals(label, o.getString("kind").uppercase(), got.kind.name)
            assertEquals("$label source", str(o, "source"), got.source)
            assertEquals("$label name", str(o, "name"), got.name)
            assertEquals("$label infoHash", str(o, "infoHash"), got.infoHash)
        }
    }

    @Test fun nullTextIsNone() = assertEquals(ShareKind.NONE, ShareClassify.classify(null, null).kind)
}
