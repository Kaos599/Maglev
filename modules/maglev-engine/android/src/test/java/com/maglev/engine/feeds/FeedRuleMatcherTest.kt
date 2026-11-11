package com.maglev.engine.feeds

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Runs every vector in scripts/fixtures/feeds/rule-vectors.json, the shared source of truth with the TS side. */
class FeedRuleMatcherTest {

    private fun fixture(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val f = File(dir, "scripts/fixtures/feeds/rule-vectors.json")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        throw AssertionError("scripts/fixtures/feeds/rule-vectors.json not found above ${System.getProperty("user.dir")}")
    }

    @Test fun allVectors() {
        val arr = JSONArray(fixture().readText())
        assertTrue("fixture is empty", arr.length() > 0)
        for (i in 0 until arr.length()) {
            val v = arr.getJSONObject(i)
            val r = v.getJSONObject("rule")
            val rule = FeedRule(
                "r", "Rule", emptySet(), r.getString("include"), r.getString("exclude"), r.getString("episodes"),
                startPaused = false, enabled = true,
            )
            val title = v.getString("title")
            val seen = v.getJSONArray("seenEpisodes").let { a -> (0 until a.length()).map { a.getString(it) } }
            val expect: JSONObject = v.getJSONObject("expect")
            val label = "vector $i (${v.optString("note")})"
            val expectedEpisode = if (expect.isNull("episode")) null else expect.getString("episode")
            assertEquals("$label episode", expectedEpisode, FeedRuleMatcher.episodeKey(title))
            assertEquals("$label match", expect.getBoolean("match"), FeedRuleMatcher.matches(rule, title, seen))
        }
    }
}
