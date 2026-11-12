package com.maglev.engine.browser

import java.io.ByteArrayOutputStream
import java.io.InputStream

/** A block list failure. [code] is one of the docs/NATIVE_CONTRACT.md section 24.4 codes. */
class BlocklistException(val code: String, message: String) : Exception(message)

/**
 * An immutable set of blocked domains. A host matches when it, or any parent suffix of it with at least two labels,
 * is in the set (`a.b.ads.com` matches `ads.com`). Immutable, so it is safe to read from WebView's request threads.
 */
class DomainSet(private val domains: Set<String>) {
    val size: Int get() = domains.size

    fun matches(host: String?): Boolean {
        if (host.isNullOrEmpty() || domains.isEmpty()) return false
        var h = host.trim().trimEnd('.').lowercase()
        while (true) {
            if (domains.contains(h)) return true
            val dot = h.indexOf('.')
            if (dot < 0) return false
            h = h.substring(dot + 1)
            if (h.indexOf('.') < 0) return false // a bare top-level name is never a block entry
        }
    }

    companion object {
        val EMPTY = DomainSet(emptySet())
    }
}

/**
 * Parser for block lists (docs/NATIVE_CONTRACT.md section 24.4). Pure Kotlin, no Android classes.
 * Accepts hosts lines (`0.0.0.0 x`, `127.0.0.1 x`), adblock domain rules (`||x^` with no path and no options)
 * and plain domain lines. Comments, cosmetic and path rules, `localhost`-type names and invalid hosts are ignored.
 */
object BlocklistParser {
    const val MIN_DOMAINS = 1000
    const val MAX_BYTES = 10 * 1024 * 1024

    private val label = Regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
    private val localNames = setOf(
        "localhost", "localhost.localdomain", "local", "broadcasthost",
        "ip6-localhost", "ip6-loopback", "ip6-localnet", "ip6-mcastprefix",
        "ip6-allnodes", "ip6-allrouters", "ip6-allhosts",
    )
    private val localSuffixes = listOf(".localhost", ".local", ".localdomain", ".lan", ".home.arpa", ".internal", ".invalid")
    private val hostsIps = setOf("0.0.0.0", "127.0.0.1")
    private val cosmeticMarks = listOf("##", "#@#", "#?#", "#$#", "#%#")

    /** True for a plausible public domain name: lowercase letters, digits and hyphens, at least two labels. */
    fun isValidHost(host: String): Boolean {
        if (host.isEmpty() || host.length > 253) return false
        if (host in localNames || localSuffixes.any { host.endsWith(it) }) return false
        val labels = host.split('.')
        if (labels.size < 2) return false
        if (!labels.all { label.matches(it) }) return false
        // An IP address or a dotted number is not a domain.
        if (labels.last().all { it.isDigit() }) return false
        return true
    }

    private fun clean(raw: String): String? {
        val h = raw.trim().trimEnd('.').lowercase()
        return if (isValidHost(h)) h else null
    }

    /** The domains one line contributes (empty for comments, rules we ignore and invalid lines). */
    fun parseLine(raw: String): List<String> {
        val line = raw.trim()
        if (line.isEmpty() || line.startsWith("!") || line.startsWith("[")) return emptyList()
        if (cosmeticMarks.any { line.contains(it) }) return emptyList()
        if (line.startsWith("||")) {
            val rest = line.substring(2)
            if (!rest.endsWith("^")) return emptyList()
            val host = rest.dropLast(1)
            // No path, no port, no wildcard, no options: only a bare domain.
            if (host.any { it == '/' || it == '*' || it == ':' || it == '^' || it == '$' || it == '|' || it == ',' }) return emptyList()
            return listOfNotNull(clean(host))
        }
        // Exception rules, address rules and regex rules are ignored.
        if (line.startsWith("@@") || line.startsWith("|") || line.startsWith("/")) return emptyList()
        // Hosts and plain lines: `#` starts a comment.
        val body = line.substringBefore('#').trim()
        if (body.isEmpty()) return emptyList()
        val tokens = body.split(Regex("\\s+"))
        if (tokens.size == 1) return listOfNotNull(clean(tokens[0]))
        if (tokens[0] !in hostsIps) return emptyList()
        return tokens.drop(1).mapNotNull { clean(it) }
    }

    /** Every valid domain in [text]. */
    fun parse(text: String): Set<String> {
        val out = HashSet<String>()
        for (line in text.lineSequence()) out.addAll(parseLine(line))
        return out
    }

    /** Throws LIST_INVALID when fewer than [MIN_DOMAINS] domains were found. */
    fun requireEnough(domains: Set<String>) {
        if (domains.size < MIN_DOMAINS) {
            throw BlocklistException("LIST_INVALID", "That list doesn't look like a block list.")
        }
    }

    /** Reads at most [maxBytes] from [input] as UTF-8. Throws LIST_TOO_LARGE when there is more. */
    fun readCapped(input: InputStream, maxBytes: Int = MAX_BYTES): String {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > maxBytes) throw BlocklistException("LIST_TOO_LARGE", "That list is too big (over ${maxBytes / (1024 * 1024)} MB).")
            out.write(buf, 0, n)
        }
        return out.toString(Charsets.UTF_8.name())
    }

    /** True for a URL we may fetch a list from: https only. */
    fun isHttpsUrl(url: String): Boolean = url.trim().startsWith("https://", ignoreCase = true) && url.trim().length > 8
}
