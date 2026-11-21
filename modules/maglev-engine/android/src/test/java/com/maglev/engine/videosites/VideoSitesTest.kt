package com.maglev.engine.videosites

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoSitesTest {
    private val day = 24L * 60 * 60 * 1000

    @Test fun builtInYtDlpUpdatesAtOnceEvenOnMobileData() {
        assertTrue(VideoSites.shouldAutoUpdate(bundled = true, lastCheckMs = 0, nowMs = 1, metered = true))
    }

    @Test fun anUpdatedYtDlpIsCheckedAfterAWeekOnUnmeteredOnly() {
        val now = 100 * day
        assertTrue(VideoSites.shouldAutoUpdate(false, now - 8 * day, now, metered = false))
        assertFalse(VideoSites.shouldAutoUpdate(false, now - 8 * day, now, metered = true))
        assertFalse(VideoSites.shouldAutoUpdate(false, now - 2 * day, now, metered = false))
    }

    @Test fun unsupportedSite() =
        assertEquals(VideoSites.NOT_SUPPORTED, VideoSites.classify("ERROR: Unsupported URL: https://a.test/x").code)

    @Test fun loginNeeded() {
        assertEquals(VideoSites.NEEDS_LOGIN, VideoSites.classify("ERROR: Sign in to confirm you are not a bot").code)
        assertEquals(VideoSites.NEEDS_LOGIN, VideoSites.classify("rate-limit reached or login required").code)
    }

    @Test fun anythingElseFails() {
        assertEquals(VideoSites.FAILED, VideoSites.classify("HTTP Error 500").code)
        assertEquals(VideoSites.FAILED, VideoSites.classify(null).code)
    }

    @Test fun trimKeepsOnlyWhatTheAppNeeds() {
        val raw = JSONObject(
            """{"title":"T","thumbnail":null,"duration":5,"uploader":"x",
               "formats":[{"format_id":"1","url":"https://a.test/1","ext":"mp4","fragments":[1,2],"height":720}]}""",
        )
        val out = VideoSites.trim(raw)
        assertEquals("T", out.getString("title"))
        assertFalse(out.has("thumbnail"))
        assertFalse(out.has("uploader"))
        val f = out.getJSONArray("formats").getJSONObject(0)
        assertEquals(720, f.getInt("height"))
        assertFalse(f.has("fragments"))
    }

    @Test fun aPlaylistResultGivesItsFirstEntry() {
        val raw = JSONObject("""{"_type":"playlist","entries":[{"title":"A","formats":[{"format_id":"x","url":"u"}]}]}""")
        val out = VideoSites.trim(raw)
        assertEquals("A", out.getString("title"))
        assertTrue(out.getJSONArray("formats").length() == 1)
    }
}
