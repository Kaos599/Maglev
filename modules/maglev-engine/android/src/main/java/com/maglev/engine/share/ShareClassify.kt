package com.maglev.engine.share

import java.net.URLDecoder

/** What a share is (docs/contracts-0.19/quick-share.md section 3). */
enum class ShareKind { MAGNET, TORRENT_FILE, FILE_LINK, WEB_PAGE, NONE }

data class ShareClass(val kind: ShareKind, val source: String?, val name: String?, val infoHash: String?)

/**
 * Pure JVM twin of `modules/maglev-engine/src/shareClassify.ts`. Same regexes, same order, same extension list.
 * `ShareClassifyTest` runs both against `shareClassify.fixture.json`. No android.* imports.
 */
object ShareClassify {
    private val I = setOf(RegexOption.IGNORE_CASE)
    private val MAGNET = Regex("magnet:\\?[^\\s\"'<>]+", I)
    private val TORRENT_URL = Regex("https?://[^\\s\"'<>]+\\.torrent(?:\\?[^\\s\"'<>]*)?", I)
    private val WEB_URL = Regex("https?://[^\\s\"'<>]+", I)
    private val LOCAL_URI = Regex("^(?:content|file)://[^\\s\"'<>]+", I)
    private val TRAILING = Regex("[.,;:!?)\\]}]+$")
    private val BTIH = Regex("(?:^|[?&])xt=urn:btih:([a-z0-9]+)", I)
    private val TORRENT_MIME = Regex("^application/x-(?:bittorrent|torrent)$")
    private val PAGE_MIME = Regex("^(?:text/html|application/xhtml\\+xml)$")
    private val TYPED_MIME = Regex("^(?:application|video|audio)/")

    val FILE_EXTENSIONS = setOf(
        "zip", "7z", "rar", "tar", "gz", "tgz", "xz", "bz2", "iso", "img", "dmg", "exe", "msi", "apk", "deb",
        "mp4", "mkv", "webm", "avi", "mov", "m4v", "mp3", "flac", "wav", "ogg", "opus", "m4a", "aac",
        "pdf", "epub", "cbz", "cbr",
    )

    private const val BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    /** Percent-decoding that keeps `+` literal (like decodeURIComponent). Malformed input comes back unchanged. */
    private fun safeDecode(s: String): String = try {
        URLDecoder.decode(s.replace("+", "%2B"), "UTF-8")
    } catch (e: IllegalArgumentException) {
        s
    }

    private fun base32ToHex(s: String): String? {
        val bits = StringBuilder()
        for (ch in s.uppercase()) {
            val v = BASE32.indexOf(ch)
            if (v < 0) return null
            bits.append(v.toString(2).padStart(5, '0'))
        }
        val hex = StringBuilder()
        var i = 0
        while (i + 8 <= bits.length) {
            hex.append(bits.substring(i, i + 8).toInt(2).toString(16).padStart(2, '0'))
            i += 8
        }
        return if (hex.length == 40) hex.toString() else null
    }

    private fun btihToHex(raw: String): String? = when {
        Regex("^[0-9a-f]{40}$", I).matches(raw) -> raw.lowercase()
        raw.length == 32 -> base32ToHex(raw)
        else -> null
    }

    private fun magnetName(magnet: String): String? {
        val q = magnet.substring(magnet.indexOf('?') + 1)
        for (part in q.split('&')) {
            val eq = part.indexOf('=')
            if (eq < 0 || part.substring(0, eq).lowercase() != "dn") continue
            val v = safeDecode(part.substring(eq + 1).replace('+', ' ')).trim()
            return v.ifEmpty { null }
        }
        return null
    }

    private fun lastSegment(uri: String): String {
        val noQuery = uri.split('?', '#')[0]
        val afterScheme = noQuery.replace(Regex("^[a-z][a-z0-9+.-]*://", I), "")
        val slash = afterScheme.lastIndexOf('/')
        return if (slash < 0) "" else safeDecode(afterScheme.substring(slash + 1))
    }

    private fun extensionOf(segment: String): String {
        val dot = segment.lastIndexOf('.')
        return if (dot < 0) "" else segment.substring(dot + 1).lowercase()
    }

    private fun none() = ShareClass(ShareKind.NONE, null, null, null)

    fun classify(text: String?, mime: String?): ShareClass {
        val t = (text ?: "").trim()
        if (t.isEmpty()) return none()
        val type = (mime ?: "").substringBefore(';').trim().lowercase()

        val magnet = MAGNET.find(t)?.value
        if (magnet != null) {
            val raw = BTIH.find(magnet.substring(magnet.indexOf('?')))?.groupValues?.get(1)
            val hash = raw?.let { btihToHex(it) }
            if (hash != null) return ShareClass(ShareKind.MAGNET, magnet, magnetName(magnet), hash)
        }

        val torrentUrl = TORRENT_URL.find(t)?.value
        if (torrentUrl != null) {
            val source = torrentUrl.replace(TRAILING, "")
            val name = lastSegment(source).replace(Regex("\\.torrent$", I), "").ifEmpty { null }
            return ShareClass(ShareKind.TORRENT_FILE, source, name, null)
        }

        val local = LOCAL_URI.find(t)?.value
        if (local != null && t.startsWith(local)) {
            val seg = lastSegment(local)
            val isTorrent = Regex("\\.torrent$", I).containsMatchIn(local.split('?', '#')[0]) || TORRENT_MIME.matches(type)
            if (isTorrent) {
                val name = if (Regex("\\.torrent$", I).containsMatchIn(seg)) seg.replace(Regex("\\.torrent$", I), "") else null
                return ShareClass(ShareKind.TORRENT_FILE, local, name, null)
            }
            return none()
        }

        val url = WEB_URL.find(t)?.value?.replace(TRAILING, "") ?: return none()
        if (TORRENT_MIME.matches(type)) return ShareClass(ShareKind.TORRENT_FILE, url, null, null)
        if (PAGE_MIME.matches(type)) return ShareClass(ShareKind.WEB_PAGE, url, null, null)
        val seg = lastSegment(url)
        val known = FILE_EXTENSIONS.contains(extensionOf(seg))
        if (TYPED_MIME.containsMatchIn(type)) return ShareClass(ShareKind.FILE_LINK, url, if (known) seg else null, null)
        if (known) return ShareClass(ShareKind.FILE_LINK, url, seg, null)
        return ShareClass(ShareKind.WEB_PAGE, url, null, null)
    }
}
