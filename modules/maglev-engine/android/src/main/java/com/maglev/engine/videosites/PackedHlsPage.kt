package com.maglev.engine.videosites

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI

/** Reads the player configuration as text. It never evaluates the page's JavaScript. */
internal object PackedHlsPage {
    private const val MAX_PAGE_BYTES = 1024 * 1024
    private const val BODY_BUDGET_NANOS = 10_000_000_000L
    private const val READ_TIMEOUT_MS = 1000
    const val USER_AGENT = "Mozilla/5.0"
    private val pagePath = Regex("""/[de]/[A-Za-z0-9_-]{1,80}/?""")
    private val packedStart = Regex("""eval\(function\(p,a,c,k,e,[rd]\)""")
    private val packed = Regex(
        """eval\(function\(p,a,c,k,e,[rd]\)[\s\S]*?\}\(\s*'((?:[^'\\]++|\\.)*+)'\s*,\s*(\d+)\s*,\s*\d+\s*,\s*'((?:[^'\\]++|\\.)*+)'\.split\('\|'\)""",
    )
    private val word = Regex("""\b[0-9A-Za-z]+\b""")
    private val hlsUrl = Regex("""["'](https://[^"'<>\\\s?#]+\.m3u8(?:\?[^"'<>\\\s#]*)?)["']""", RegexOption.IGNORE_CASE)
    private const val DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

    private fun uri(value: String): URI? = runCatching { URI(value) }.getOrNull()

    fun pageUri(url: String): URI? = uri(url)?.takeIf {
        it.scheme.equals("https", ignoreCase = true) &&
            (it.rawAuthority.equals("lplaygo.com", ignoreCase = true) || it.rawAuthority.equals("lplaygo.com:443", ignoreCase = true)) &&
            pagePath.matches(it.rawPath.orEmpty())
    }

    fun read(page: URI): String? {
        val connection = page.toURL().openConnection() as HttpURLConnection
        return try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 10_000
            connection.readTimeout = READ_TIMEOUT_MS
            connection.setRequestProperty("User-Agent", USER_AGENT)
            if (connection.responseCode != HttpURLConnection.HTTP_OK) return null
            connection.inputStream.use { input ->
                val started = System.nanoTime()
                val body = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (body.size() <= MAX_PAGE_BYTES) {
                    if (System.nanoTime() - started >= BODY_BUDGET_NANOS) return null
                    val count = input.read(buffer)
                    if (System.nanoTime() - started >= BODY_BUDGET_NANOS) return null
                    if (count < 0) return findPlaylist(body.toString(Charsets.UTF_8.name()))
                    if (count > MAX_PAGE_BYTES - body.size()) return null
                    body.write(buffer, 0, count)
                }
                null
            }
        } catch (_: IOException) {
            null
        } finally {
            connection.disconnect()
        }
    }

    fun findPlaylist(html: String): String? {
        if (html.length > MAX_PAGE_BYTES) return null
        val candidates = mutableSetOf<String>()
        var decodedTotal = 0
        // A missing suffix must not rescan the page for every malformed prefix.
        val starts = packedStart.findAll(html).map { it.range.first }.toList()
        for ((position, start) in starts.withIndex()) {
            val end = starts.getOrNull(position + 1) ?: html.length
            val match = packed.find(html.substring(start, end)) ?: continue
            val (payload, radix, dictionary) = match.destructured
            val base = radix.toIntOrNull()?.takeIf { it in 2..DIGITS.length } ?: continue
            val words = dictionary.split('|')
            val decoded = StringBuilder(payload.length)
            var cursor = 0
            for (token in word.findAll(payload)) {
                val index = tokenIndex(token.value, base, words.size)
                val replacement = words.getOrNull(index)?.takeIf(String::isNotEmpty) ?: token.value
                if (decodedTotal + decoded.length + token.range.first - cursor + replacement.length > MAX_PAGE_BYTES) return null
                decoded.append(payload, cursor, token.range.first).append(replacement)
                cursor = token.range.last + 1
            }
            if (decodedTotal + decoded.length + payload.length - cursor > MAX_PAGE_BYTES) return null
            decoded.append(payload, cursor, payload.length)
            decodedTotal += decoded.length
            for (candidate in hlsUrl.findAll(decoded)) {
                val url = candidate.groupValues[1]
                val target = uri(url) ?: continue
                if (target.host != null && target.rawUserInfo == null && target.rawPath.endsWith(".m3u8", ignoreCase = true)) {
                    candidates.add(url)
                }
            }
        }
        return candidates.singleOrNull()
    }

    private fun tokenIndex(token: String, base: Int, size: Int): Int {
        var index = 0L
        for (char in token) {
            val digit = DIGITS.indexOf(char)
            if (digit !in 0 until base) return -1
            index = index * base + digit
            if (index >= size) return -1
        }
        return index.toInt()
    }
}
