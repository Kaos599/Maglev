package com.maglev.engine.browser

/**
 * Pure rules for downloads without a tap, Back-button hijacking and HTTPS-first (docs/NATIVE_CONTRACT.md section 24.11).
 * Mirrored in `utils/browser/hardening.ts`. No Android types.
 */
object DownloadRules {
    /**
     * A download the user asked for: it came from a navigation they typed or tapped ([userLoad]), or a tap ended within
     * [PopupRules.TAP_MS] and no other download used that tap yet ([usesSoFar] is 0). [tapAgeMs] is null with no tap.
     */
    fun tapped(tapAgeMs: Long?, usesSoFar: Int, userLoad: Boolean): Boolean =
        userLoad || (tapAgeMs != null && tapAgeMs in 0..PopupRules.TAP_MS && usesSoFar == 0)
}

object BackRules {
    /**
     * How many entries Back steps over. [userMade] has one flag per history entry (index 0 is the oldest), true when the
     * user made the entry (typed, tapped, reloaded). [current] is the index of the page on screen. Back lands on the
     * nearest earlier entry the user made, or on the first entry. 0 means nothing is behind. An unknown flag counts as made.
     */
    fun steps(userMade: List<Boolean>, current: Int): Int {
        if (current <= 0) return 0
        var i = current - 1
        while (i > 0 && !(userMade.getOrNull(i) ?: true)) i--
        return current - i
    }
}

/** What made each history entry, kept next to WebView's own list. Main thread only. */
class HistoryFlags {
    private val urls = ArrayList<String>()
    private val made = ArrayList<Boolean>()
    private var index = -1

    /** One flag per entry, oldest first. */
    fun flags(): List<Boolean> = made

    fun clear() {
        urls.clear()
        made.clear()
        index = -1
    }

    /**
     * WebView reported [url] at position [current] of its list (doUpdateVisitedHistory). One step forward to an entry we
     * have not seen is a new entry and takes [userMade]; the same position is a replace or a reload and keeps the flag
     * (true wins); anything else is Back or Forward and keeps what was stored.
     */
    fun visited(url: String, current: Int, userMade: Boolean) {
        if (current < 0) return
        val prev = index
        index = current
        if (current == prev + 1 && (current >= made.size || urls[current] != url)) {
            while (made.size > current) {
                made.removeAt(made.size - 1)
                urls.removeAt(urls.size - 1)
            }
            urls.add(url)
            made.add(userMade)
            return
        }
        while (made.size <= current) {
            urls.add(url)
            made.add(true)
        }
        if (current == prev) {
            urls[current] = url
            if (userMade) made[current] = true
        }
    }

    /** Back should step over the current entry when it is [url] (a failed HTTPS try). */
    fun skipIfUrl(url: String) {
        if (index in 0 until made.size && urls[index] == url) made[index] = false
    }
}

object HttpsFirst {
    private val http = Regex("^http://([^/?#]*)(.*)$", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))

    /** Host of [url], lower case, no port, no trailing dot. Null when there is none. */
    fun hostOf(url: String?): String? {
        val m = Regex("^[a-z][a-z0-9+.-]*://([^/?#]*)", RegexOption.IGNORE_CASE).find(url?.trim() ?: return null) ?: return null
        var a = m.groupValues[1]
        a = a.substring(a.lastIndexOf('@') + 1)
        if (a.startsWith("[")) return a.trimStart('[').substringBefore(']').lowercase()
        return a.substringBefore(':').lowercase().trimEnd('.').ifEmpty { null }
    }

    /**
     * The https:// twin of a main-frame http:// [url], or null when it must stay http: not http, an IP address, a LAN or
     * local name, a port other than 80, a user name in the address, or a host in [fallbackHosts].
     */
    fun upgrade(url: String, fallbackHosts: Set<String>): String? {
        val m = http.matchEntire(url.trim()) ?: return null
        val authority = m.groupValues[1]
        val rest = m.groupValues[2]
        if (authority.isEmpty() || authority.contains('@') || authority.startsWith("[")) return null
        val colon = authority.indexOf(':')
        val hostPart = if (colon >= 0) authority.substring(0, colon) else authority
        if (colon >= 0) {
            val port = authority.substring(colon + 1)
            if (port != "80" && port.isNotEmpty()) return null
        }
        val h = hostPart.lowercase().trimEnd('.')
        if (h.isEmpty() || LocalHost.parseV4(h) != null || LocalHost.isLanHost(h) || h in fallbackHosts) return null
        return "https://$hostPart$rest"
    }

    private fun bare(host: String?): String? = host?.removePrefix("www.")

    /** [url] is on [host] (or its www. twin). */
    fun sameHost(host: String?, url: String?): Boolean = host != null && bare(host) == bare(hostOf(url))

    /** An error or SSL failure for [failedUrl] while the upgrade of [pendingHost] had not loaded yet. */
    fun isUpgradeFailure(pendingHost: String?, failedUrl: String?): Boolean = sameHost(pendingHost, failedUrl)

    /** The server answered the https try with a redirect to http on the same host: a loop. */
    fun isLoop(pendingHost: String?, redirectUrl: String): Boolean =
        pendingHost != null && redirectUrl.trim().startsWith("http://", ignoreCase = true) && isUpgradeFailure(pendingHost, redirectUrl)
}
