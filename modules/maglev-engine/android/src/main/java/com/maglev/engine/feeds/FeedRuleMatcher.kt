package com.maglev.engine.feeds

/**
 * Feed rule matching, contract section 11.6. Pure Kotlin, no android.* imports.
 * The semantics are fixed by scripts/fixtures/feeds/rule-vectors.json, which the TS side must also pass.
 */
data class FeedRule(
    val id: String,
    val name: String,
    /** Empty means every feed. */
    val feedIds: Set<String>,
    val include: String,
    val exclude: String,
    /** "all" or "new_only". */
    val episodes: String,
    val startPaused: Boolean,
    val enabled: Boolean,
)

object FeedRuleMatcher {
    private val seasonEpisode = Regex("s(\\d{1,2})e(\\d{1,3})", RegexOption.IGNORE_CASE)
    private val nxnn = Regex("\\b(\\d{1,2})x(\\d{2,3})\\b", RegexOption.IGNORE_CASE)
    private val anime = Regex("\\s-\\s(\\d{1,4})(?:v\\d+)?(?=[\\s\\[(.]|$)")

    /** `S01E02`, `1x02`, `S01E01-E03` (first episode) and anime ` - 12` / ` - 12v2`, as "s1e2". Null when absent. */
    fun episodeKey(title: String): String? {
        seasonEpisode.find(title)?.let { return "s${it.groupValues[1].toInt()}e${it.groupValues[2].toInt()}" }
        nxnn.find(title)?.let { return "s${it.groupValues[1].toInt()}e${it.groupValues[2].toInt()}" }
        anime.find(title)?.let { return "s1e${it.groupValues[1].toInt()}" }
        return null
    }

    /** True when [title] passes include and exclude, and (for new_only) its episode is not in [seenEpisodes]. */
    fun matches(rule: FeedRule, title: String, seenEpisodes: Collection<String>): Boolean {
        if (!includeOk(rule.include, title)) return false
        if (excludeHit(rule.exclude, title)) return false
        if (rule.episodes == "new_only") {
            val key = episodeKey(title)
            if (key != null && seenEpisodes.contains(key)) return false
        }
        return true
    }

    /** A `/.../` string is a case-insensitive regex. Null for plain words or an invalid regex (never matches). */
    private sealed class Pattern {
        class Re(val regex: Regex) : Pattern()
        object Invalid : Pattern()
        class Words(val words: List<String>) : Pattern()
    }

    private fun parse(s: String): Pattern {
        val t = s.trim()
        if (t.length > 2 && t.startsWith("/") && t.endsWith("/")) {
            return try {
                Pattern.Re(Regex(t.substring(1, t.length - 1), RegexOption.IGNORE_CASE))
            } catch (e: Exception) {
                Pattern.Invalid
            }
        }
        return Pattern.Words(t.split(Regex("\\s+")).filter { it.isNotEmpty() }.map { it.lowercase() })
    }

    private fun includeOk(include: String, title: String): Boolean = when (val p = parse(include)) {
        is Pattern.Invalid -> false
        is Pattern.Re -> p.regex.containsMatchIn(title)
        is Pattern.Words -> {
            val lower = title.lowercase()
            p.words.all { lower.contains(it) }
        }
    }

    private fun excludeHit(exclude: String, title: String): Boolean = when (val p = parse(exclude)) {
        is Pattern.Invalid -> false
        is Pattern.Re -> p.regex.containsMatchIn(title)
        is Pattern.Words -> {
            val lower = title.lowercase()
            p.words.any { lower.contains(it) }
        }
    }
}
