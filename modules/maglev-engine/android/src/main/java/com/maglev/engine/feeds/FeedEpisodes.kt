package com.maglev.engine.feeds

/**
 * Episode bookkeeping for "new_only" rules. Pure Kotlin, no android.* imports.
 * An episode counts as seen only after its add succeeded (the drain removes the entry from the queue).
 * Until then it is only "in flight": it blocks other releases of the same episode, but a failed add
 * leaves the episode free for the next release.
 */
object FeedEpisodes {
    /** Episode keys of queued adds for [ruleId]. */
    fun inFlight(pending: Collection<PendingAdd>, ruleId: String): Set<String> =
        pending.filter { it.ruleId == ruleId }.mapNotNull { FeedRuleMatcher.episodeKey(it.title) }.toSet()

    /** Episode keys of completed adds, grouped by rule. */
    fun byRule(done: Collection<PendingAdd>): Map<String, Set<String>> =
        done.groupBy { it.ruleId }.mapValues { (_, adds) -> adds.mapNotNull { FeedRuleMatcher.episodeKey(it.title) }.toSet() }
            .filterValues { it.isNotEmpty() }
}
