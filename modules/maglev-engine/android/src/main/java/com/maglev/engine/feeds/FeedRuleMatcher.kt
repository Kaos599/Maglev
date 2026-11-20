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

    /** Start index of the earliest episode marker in [title], or -1. */
    private fun markerStart(title: String): Int {
        val starts = listOfNotNull(
            seasonEpisode.find(title)?.range?.first,
            nxnn.find(title)?.range?.first,
            anime.find(title)?.range?.first,
        )
        return starts.minOrNull() ?: -1
    }

    /** `S01E02`, `1x02`, `S01E01-E03` (first episode) and anime ` - 12` / ` - 12v2`, as "s1e2". Null when absent. */
    fun episodeKey(title: String): String? {
        seasonEpisode.find(title)?.let { return "s${it.groupValues[1].toInt()}e${it.groupValues[2].toInt()}" }
        nxnn.find(title)?.let { return "s${it.groupValues[1].toInt()}e${it.groupValues[2].toInt()}" }
        anime.find(title)?.let { return "s1e${it.groupValues[1].toInt()}" }
        return null
    }

    private val bracketTags = Regex("\\[[^\\]]*]|\\([^)]*\\)")
    private val separators = Regex("[._\\-]+")
    private val spacedTags = Regex("\\b(?:web ?dl|web ?rip|blu ?ray|h ?26[45]|x ?26[45])\\b")
    private val year = Regex("^(?:19|20)\\d\\d$")
    private val qualityTags = setOf(
        "480p", "576p", "720p", "1080p", "1440p", "2160p", "4k", "uhd", "hd", "web", "webdl", "webrip", "bluray",
        "bdrip", "brrip", "hdrip", "hdtv", "dvdrip", "remux", "x264", "x265", "h264", "h265", "hevc", "avc", "xvid",
        "aac", "ac3", "10bit", "hdr", "proper", "repack",
    )

    /**
     * Show name of [title]: the text before the episode marker, lower case, `. _ -` as spaces, bracket groups
     * (release groups), years (only when other words remain) and quality/source tags dropped, spaces collapsed.
     * Empty when there is no marker or no text before it.
     */
    fun showName(title: String): String {
        val at = markerStart(title)
        if (at < 0) return ""
        val text = title.substring(0, at).replace(bracketTags, " ").lowercase().replace(separators, " ")
            .replace(spacedTags) { it.value.replace(" ", "") }
        val words = text.split(Regex("\\s+")).filter { it.isNotEmpty() }
        val named = words.filter { it !in qualityTags }
        // A year is dropped only when other words remain ("1923 S01E01" is the show "1923").
        val noYear = named.filter { !year.matches(it) }
        val kept = if (noYear.isNotEmpty()) noYear else named
        // Never reduce a titled release to nothing: fall back to the normalised words.
        return (if (kept.isNotEmpty()) kept else words).joinToString(" ")
    }

    /** `<show>|s1e2` (show may be empty), or null when [title] has no episode marker. */
    fun episodeIdentity(title: String): String? = episodeKey(title)?.let { "${showName(title)}|$it" }

    /**
     * True when [title] passes include and exclude, and (for new_only) its episode is not in [seenEpisodes].
     * Seen keys are `<show>|s1e2`. An old key without a show ("s1e2") belongs to an unknown show, so it keeps
     * suppressing that episode for every show and is never removed (a duplicate download is worse than a skip).
     */
    fun matches(rule: FeedRule, title: String, seenEpisodes: Collection<String>): Boolean {
        if (!includeOk(rule.include, title)) return false
        if (excludeHit(rule.exclude, title)) return false
        if (rule.episodes == "new_only") {
            val key = episodeKey(title)
            if (key != null) {
                if (seenEpisodes.contains("${showName(title)}|$key")) return false
                if (seenEpisodes.contains(key)) return false
            }
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
