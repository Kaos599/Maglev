package com.maglev.engine.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserHardeningTest {
    // ---- downloads ----
    @Test fun downloadNeedsATapOrAUserLoad() {
        assertFalse(DownloadRules.tapped(null, 0, false))
        assertTrue(DownloadRules.tapped(null, 0, true))
        assertTrue(DownloadRules.tapped(500L, 0, false))
        assertTrue(DownloadRules.tapped(PopupRules.TAP_MS, 0, false))
    }

    @Test fun oldTapOrUsedTapDoesNotCount() {
        assertFalse(DownloadRules.tapped(PopupRules.TAP_MS + 1, 0, false))
        assertFalse(DownloadRules.tapped(100L, 1, false))
        assertTrue(DownloadRules.tapped(100L, 1, true))
    }

    // ---- back ----
    @Test fun backLandsOnTheNearestUserEntry() {
        assertEquals(2, BackRules.steps(listOf(true, true, false, false), 3))
        assertEquals(1, BackRules.steps(listOf(true, true, true), 2))
        assertEquals(2, BackRules.steps(listOf(true, true, false, true), 3))
    }

    @Test fun backGoesToTheFirstWhenEveryOtherEntryIsNoTap() {
        assertEquals(3, BackRules.steps(listOf(false, false, false, false), 3))
        assertEquals(2, BackRules.steps(listOf(true, false, false), 2))
    }

    @Test fun nothingBehindMeansZero() {
        assertEquals(0, BackRules.steps(listOf(true), 0))
        assertEquals(0, BackRules.steps(emptyList(), 0))
    }

    @Test fun unknownFlagsCountAsMade() {
        assertEquals(1, BackRules.steps(emptyList(), 4))
        assertEquals(1, BackRules.steps(listOf(true), 3))
        assertEquals(1, BackRules.steps(emptyList(), 1))
    }

    @Test fun historyRecordsNewEntriesAndKeepsFlagsOnTraversal() {
        val h = HistoryFlags()
        h.visited("https://a.test/", 0, true)
        h.visited("https://a.test/b", 1, true)
        h.visited("https://a.test/b#x", 2, false) // pushState spam
        h.visited("https://a.test/b#y", 3, false)
        assertEquals(listOf(true, true, false, false), h.flags())
        // Back to entry 1 and forward again: nothing changes.
        h.visited("https://a.test/b", 1, false)
        assertEquals(listOf(true, true, false, false), h.flags())
        h.visited("https://a.test/b#x", 2, true)
        assertEquals(listOf(true, true, false, false), h.flags())
    }

    @Test fun newEntryAfterBackDropsTheForwardEntries() {
        val h = HistoryFlags()
        h.visited("https://a.test/", 0, true)
        h.visited("https://a.test/1", 1, true)
        h.visited("https://a.test/2", 2, false)
        h.visited("https://a.test/1", 1, false)
        h.visited("https://a.test/3", 2, true)
        assertEquals(listOf(true, true, true), h.flags())
    }

    @Test fun replaceKeepsTheFlagAndTrueWins() {
        val h = HistoryFlags()
        h.visited("https://a.test/", 0, true)
        h.visited("https://a.test/1", 1, false)
        h.visited("https://a.test/1b", 1, false)
        assertEquals(listOf(true, false), h.flags())
        h.visited("https://a.test/1c", 1, true)
        assertEquals(listOf(true, true), h.flags())
    }

    @Test fun skipIfUrlOnlyMarksTheMatchingCurrentEntry() {
        val h = HistoryFlags()
        h.visited("http://a.test/", 0, true)
        h.visited("https://b.test/", 1, true)
        h.skipIfUrl("https://other.test/")
        assertEquals(listOf(true, true), h.flags())
        h.skipIfUrl("https://b.test/")
        assertEquals(listOf(true, false), h.flags())
    }

    // ---- https first ----
    private val none = emptySet<String>()

    @Test fun upgradesPlainHttp() {
        assertEquals("https://example.com/a?b=1#c", HttpsFirst.upgrade("http://example.com/a?b=1#c", none))
        assertEquals("https://example.com", HttpsFirst.upgrade("HTTP://example.com", none))
    }

    @Test fun port80IsDroppedOtherPortsStayHttp() {
        assertEquals("https://example.com/x", HttpsFirst.upgrade("http://example.com:80/x", none))
        assertNull(HttpsFirst.upgrade("http://example.com:8080/x", none))
    }

    @Test fun exemptions() {
        assertNull(HttpsFirst.upgrade("https://example.com/", none))
        assertNull(HttpsFirst.upgrade("http://localhost/", none))
        assertNull(HttpsFirst.upgrade("http://192.168.1.5/", none))
        assertNull(HttpsFirst.upgrade("http://8.8.8.8/", none))
        assertNull(HttpsFirst.upgrade("http://[2001:db8::1]/", none))
        assertNull(HttpsFirst.upgrade("http://nas/", none))
        assertNull(HttpsFirst.upgrade("http://router.local/", none))
        assertNull(HttpsFirst.upgrade("http://user@example.com/", none))
        assertNull(HttpsFirst.upgrade("http://example.com/", setOf("example.com")))
    }

    @Test fun failureAndLoop() {
        assertTrue(HttpsFirst.isUpgradeFailure("example.com", "https://example.com/a"))
        assertTrue(HttpsFirst.isUpgradeFailure("example.com", "https://www.example.com/"))
        assertFalse(HttpsFirst.isUpgradeFailure("example.com", "https://other.test/"))
        assertFalse(HttpsFirst.isUpgradeFailure(null, "https://example.com/"))
        assertTrue(HttpsFirst.isLoop("example.com", "http://example.com/"))
        assertTrue(HttpsFirst.isLoop("example.com", "http://www.example.com/x"))
        assertFalse(HttpsFirst.isLoop("example.com", "https://example.com/"))
        assertFalse(HttpsFirst.isLoop("example.com", "http://other.test/"))
    }

    @Test fun hostOfStripsPortAndUser() {
        assertEquals("example.com", HttpsFirst.hostOf("http://u:p@Example.com:8080/x"))
        assertEquals("2001:db8::1", HttpsFirst.hostOf("http://[2001:db8::1]:80/"))
        assertNull(HttpsFirst.hostOf("not a url"))
    }
}
