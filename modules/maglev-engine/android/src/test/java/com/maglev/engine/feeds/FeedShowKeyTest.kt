package com.maglev.engine.feeds

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** "Skip episodes I already have" is keyed by show and episode (contract section 41, Feeds B2). */
class FeedShowKeyTest {
    private val rule = FeedRule("r", "Rule", emptySet(), "", "", "new_only", startPaused = false, enabled = true)

    @Test fun normalisesShowNames() {
        assertEquals("the show", FeedRuleMatcher.showName("The.Show.2019.S01E02.1080p.WEB-DL.x264"))
        assertEquals("the show", FeedRuleMatcher.showName("The Show S01E02 720p"))
        assertEquals("the show", FeedRuleMatcher.showName("the_show - 1x02 HDTV"))
        assertEquals("show", FeedRuleMatcher.showName("1080p.WEB-DL.Show.S01E02"))
        assertEquals("frieren", FeedRuleMatcher.showName("[SubsPlease] Frieren - 12v2 (1080p) [ABCD1234].mkv"))
        assertEquals("frieren", FeedRuleMatcher.showName("[Other] Frieren - 12 (720p).mkv"))
        assertEquals("", FeedRuleMatcher.showName("ubuntu-26.04-desktop-amd64.iso"))
    }

    @Test fun identityIsShowPipeEpisode() {
        assertEquals("the show|s1e2", FeedRuleMatcher.episodeIdentity("The.Show.2019.S01E02.1080p.WEB-DL"))
        assertEquals("|s1e2", FeedRuleMatcher.episodeIdentity("S01E02"))
        assertNull(FeedRuleMatcher.episodeIdentity("Some Movie 2024 1080p"))
    }

    @Test fun otherShowSameEpisodeStillDownloads() {
        val seen = listOf("show a|s1e2")
        assertFalse(FeedRuleMatcher.matches(rule, "Show.A.S01E02.720p", seen))
        assertTrue(FeedRuleMatcher.matches(rule, "Show.B.S01E02.720p", seen))
    }

    @Test fun sameShowOtherQualityAndGroupDedupes() {
        val seen = listOf("the show|s1e2")
        assertFalse(FeedRuleMatcher.matches(rule, "The Show S01E02 720p", seen))
        assertFalse(FeedRuleMatcher.matches(rule, "The.Show.2019.S01E02.1080p.WEB-DL-GRP", seen))
        assertFalse(FeedRuleMatcher.matches(rule, "[Grp2] The Show 1x02 (480p)", seen))
    }

    @Test fun oldKeyKeepsSuppressingEveryShow() {
        assertFalse(FeedRuleMatcher.matches(rule, "Show A S01E02", listOf("s1e2")))
        assertFalse(FeedRuleMatcher.matches(rule, "Show B S01E02", listOf("s1e2")))
        assertTrue(FeedRuleMatcher.matches(rule, "Show B S01E03", listOf("s1e2")))
        // A new-style key for another show must not release the old key: show A's repost stays suppressed.
        val mixed = listOf("s1e2", "show b|s1e2")
        assertFalse(FeedRuleMatcher.matches(rule, "Show A S01E02", mixed))
        assertFalse(FeedRuleMatcher.matches(rule, "Show B S01E02", mixed))
        assertFalse(FeedRuleMatcher.matches(rule, "Show C S01E02", mixed))
    }

    @Test fun twoShowsOnOneRuleWithNewKeys() {
        assertTrue(FeedRuleMatcher.matches(rule, "Show B S01E02", listOf("show a|s1e2")))
        val both = listOf("show a|s1e2", "show b|s1e2")
        assertFalse(FeedRuleMatcher.matches(rule, "Show A S01E02", both))
        assertFalse(FeedRuleMatcher.matches(rule, "Show B S01E02", both))
        assertTrue(FeedRuleMatcher.matches(rule, "Show C S01E02", both))
    }

    @Test fun yearOnlyShowKeepsItsName() {
        assertEquals("1923", FeedRuleMatcher.showName("1923 S01E01"))
        assertEquals("1923|s1e1", FeedRuleMatcher.episodeIdentity("1923.S01E01.1080p"))
        assertEquals("2024", FeedRuleMatcher.showName("2024 S01E01"))
        assertEquals("1080p", FeedRuleMatcher.showName("1080p.S01E02"))
    }

    @Test fun yearDroppedOnlyWhenOtherWordsRemain() {
        assertEquals("show", FeedRuleMatcher.showName("Show 2024 S01E01"))
        assertEquals(FeedRuleMatcher.episodeIdentity("Show S01E01"), FeedRuleMatcher.episodeIdentity("Show 2024 S01E01"))
        assertTrue(FeedRuleMatcher.matches(rule, "1923 S01E01", listOf("other|s1e1")))
        assertFalse(FeedRuleMatcher.matches(rule, "1923 S01E01", listOf("1923|s1e1")))
    }
}
