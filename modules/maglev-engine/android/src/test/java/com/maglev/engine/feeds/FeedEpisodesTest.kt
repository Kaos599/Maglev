package com.maglev.engine.feeds

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedEpisodesTest {
    private fun add(rule: String, title: String) = PendingAdd("f", rule, "Rule", title, "magnet:?xt=urn:btih:x", false)

    @Test fun inFlightOnlyCountsTheRule() {
        val pending = listOf(add("a", "Show S01E02 1080p"), add("b", "Other S03E04"), add("a", "No episode here"))
        assertEquals(setOf("s1e2"), FeedEpisodes.inFlight(pending, "a"))
        assertEquals(setOf("s3e4"), FeedEpisodes.inFlight(pending, "b"))
        assertTrue(FeedEpisodes.inFlight(pending, "c").isEmpty())
    }

    @Test fun byRuleGroupsCompletedAdds() {
        val done = listOf(add("a", "Show S01E02"), add("a", "Show S01E03"), add("b", "Anime - 12"), add("c", "Movie 2024"))
        assertEquals(mapOf("a" to setOf("s1e2", "s1e3"), "b" to setOf("s1e12")), FeedEpisodes.byRule(done))
    }

    @Test fun emptyWhenNothingDone() = assertTrue(FeedEpisodes.byRule(emptyList()).isEmpty())
}
