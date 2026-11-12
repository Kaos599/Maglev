package com.maglev.engine.browser

import java.security.MessageDigest

/** One file the page loads or links to (docs/NATIVE_CONTRACT.md section 24.2 `FoundItem`). */
data class FoundItem(
    val id: String,
    val url: String,
    val kind: String,
    val mime: String?,
    val ext: String?,
    val name: String,
    val size: Long?,
    val width: Int?,
    val height: Int?,
    val source: String,
    val stream: String?,
    val pageUrl: String,
    val pageTitle: String,
    /** Installer types get a warning in the UI. Not part of the JS shape: the UI derives it from [ext]. */
    val installer: Boolean = false,
) {
    fun toMap(): Map<String, Any?> = linkedMapOf(
        "id" to id, "url" to url, "kind" to kind, "mime" to mime, "ext" to ext, "name" to name,
        "size" to size?.toDouble(), "width" to width, "height" to height, "source" to source, "stream" to stream,
        "pageUrl" to pageUrl, "pageTitle" to pageTitle,
    )
}

/** What an extension means: the kind, an optional stream type and the installer flag. */
data class Classified(val kind: String, val ext: String?, val stream: String?, val installer: Boolean)

/**
 * Turns URLs into kinds (docs/NATIVE_CONTRACT.md section 24.3). Pure Kotlin, no Android classes.
 */
object FoundClassifier {
    private val video = setOf("mp4", "m4v", "webm", "mkv", "mov", "avi", "ts")
    private val audio = setOf("mp3", "m4a", "aac", "flac", "ogg", "opus", "wav")
    private val image = setOf("jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg")
    private val document = setOf(
        "pdf", "epub", "mobi", "djvu", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        "odt", "ods", "odp", "txt", "rtf", "csv", "md",
    )
    private val other = setOf(
        "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "apk", "exe", "dmg", "torrent",
        "srt", "vtt", "ass", "msi", "bat", "cmd", "scr",
    )
    /** Installers and scripts: shown as `other` with a warning. */
    val installers = setOf("apk", "exe", "msi", "dmg", "bat", "cmd", "scr")

    const val MAX_ITEMS = 500

    private val urlRe = Regex("^(https?)://([^/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$", RegexOption.IGNORE_CASE)
    private val dropParams = setOf("range", "bytes")

    /**
     * The normalized form used for dedupe: lowercase scheme and host, no fragment, no `range`/`bytes` query
     * parameters (other query parameters stay, in order). Null for anything that isn't http or https
     * (so `blob:` and `data:` are skipped).
     */
    fun normalize(url: String?): String? {
        val m = urlRe.matchEntire(url?.trim() ?: return null) ?: return null
        val scheme = m.groupValues[1].lowercase()
        val authority = m.groupValues[2]
        if (authority.isEmpty()) return null
        val at = authority.lastIndexOf('@')
        val userinfo = if (at >= 0) authority.substring(0, at + 1) else ""
        val hostPort = authority.substring(at + 1).lowercase()
        if (hostPort.isEmpty()) return null
        val path = m.groupValues[3].ifEmpty { "/" }
        val query = m.groupValues[4].removePrefix("?")
        val kept = if (query.isEmpty()) emptyList() else query.split('&').filter { part ->
            part.isNotEmpty() && part.substringBefore('=').lowercase() !in dropParams
        }
        val q = if (kept.isEmpty()) "" else "?" + kept.joinToString("&")
        return "$scheme://$userinfo$hostPort$path$q"
    }

    /** A stable id for a normalized URL: the first 16 hex digits of its SHA-256. */
    fun idOf(normalized: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest(normalized.toByteArray(Charsets.UTF_8))
        return d.take(8).joinToString("") { "%02x".format(it) }
    }

    /** The lowercase extension of the last path segment ("tar.gz" gives "gz"), or null. */
    fun extensionOf(url: String): String? {
        val path = pathOf(url)
        val seg = path.substringAfterLast('/')
        val dot = seg.lastIndexOf('.')
        if (dot < 0 || dot == seg.length - 1) return null
        val ext = seg.substring(dot + 1).lowercase()
        return if (ext.length in 1..5 && ext.all { it.isLetterOrDigit() }) ext else null
    }

    private fun pathOf(url: String): String {
        val m = urlRe.matchEntire(url.trim())
        return m?.groupValues?.get(3) ?: url.substringBefore('#').substringBefore('?')
    }

    /** The file name: the last path segment, percent-decoded, or the host when the path is empty. */
    fun nameOf(url: String): String {
        val m = urlRe.matchEntire(url.trim())
        val seg = pathOf(url).trimEnd('/').substringAfterLast('/')
        val decoded = percentDecode(seg)
        if (decoded.isNotEmpty()) return decoded
        return m?.groupValues?.get(2)?.substringAfterLast('@')?.substringBefore(':') ?: url
    }

    private fun percentDecode(s: String): String {
        if (!s.contains('%')) return s
        val out = java.io.ByteArrayOutputStream()
        var i = 0
        val bytes = s.toByteArray(Charsets.UTF_8)
        while (i < bytes.size) {
            val b = bytes[i].toInt()
            if (b == '%'.code && i + 2 < bytes.size) {
                val hi = Character.digit(bytes[i + 1].toInt().toChar(), 16)
                val lo = Character.digit(bytes[i + 2].toInt().toChar(), 16)
                if (hi >= 0 && lo >= 0) {
                    out.write(hi * 16 + lo)
                    i += 3
                    continue
                }
            }
            out.write(b)
            i++
        }
        return out.toString(Charsets.UTF_8.name())
    }

    private fun byExtension(ext: String?): Classified? {
        if (ext == null) return null
        return when (ext) {
            "m3u8" -> Classified("video", ext, "hls", false)
            "mpd" -> Classified("video", ext, "dash", false)
            in video -> Classified("video", ext, null, false)
            in audio -> Classified("audio", ext, null, false)
            in image -> Classified("image", ext, null, false)
            in document -> Classified("document", ext, null, false)
            in other -> Classified("other", ext, null, ext in installers)
            else -> null
        }
    }

    /**
     * A request the WebView made (section 24.3 rule 1). Video, audio and streams only: images are not taken from
     * the network. `.ts` counts only when no HLS playlist has been seen on this page ([hlsSeen]), because then it is a
     * segment. When the path has no known extension, an `Accept` that names video/ or audio/ on a ranged request
     * decides ([accept], [hasRange]).
     */
    fun classifyNetwork(url: String, accept: String? = null, hasRange: Boolean = false, hlsSeen: Boolean = false): Classified? {
        if (normalize(url) == null) return null
        val ext = extensionOf(url)
        val c = byExtension(ext)
        if (c != null) {
            if (c.kind != "video" && c.kind != "audio") return null
            if (ext == "ts" && hlsSeen) return null
            return c
        }
        if (hasRange && accept != null) {
            val a = accept.trim().lowercase()
            if (a.startsWith("video/")) return Classified("video", ext, null, false)
            if (a.startsWith("audio/")) return Classified("audio", ext, null, false)
        }
        return null
    }

    /**
     * A URL the page scan found (section 24.3 rule 2). [hint] is the kind the tag implies (`video`, `audio`, `image`);
     * with a hint an unknown extension still gives that kind. Without one (an `<a href>`) only known extensions count.
     */
    fun classifyPage(url: String, hint: String? = null): Classified? {
        if (normalize(url) == null) return null
        val ext = extensionOf(url)
        val c = byExtension(ext)
        if (c != null) return c
        return if (hint == "video" || hint == "audio" || hint == "image") Classified(hint, ext, null, false) else null
    }

    /** Builds an item, or null when the URL is not http(s) or not classifiable for [source]. */
    fun item(
        url: String,
        c: Classified,
        source: String,
        pageUrl: String,
        pageTitle: String,
        mime: String? = null,
        size: Long? = null,
        width: Int? = null,
        height: Int? = null,
    ): FoundItem? {
        val n = normalize(url) ?: return null
        return FoundItem(
            id = idOf(n), url = n, kind = c.kind, mime = mime, ext = c.ext, name = nameOf(n),
            size = size, width = width, height = height, source = source, stream = c.stream,
            pageUrl = pageUrl, pageTitle = pageTitle, installer = c.installer,
        )
    }
}

/**
 * Per page load: dedupes by id, keeps the newest [FoundClassifier.MAX_ITEMS], and hands out only items not yet sent.
 * Thread-safe (network callbacks arrive on WebView's threads, the page scan on the main thread).
 */
class FoundTracker(private val cap: Int = FoundClassifier.MAX_ITEMS) {
    private val items = LinkedHashMap<String, FoundItem>()
    private val pending = ArrayList<FoundItem>()

    /** Adds [item] unless its id is already known. Returns true when it was new. */
    @Synchronized
    fun add(item: FoundItem): Boolean {
        if (items.containsKey(item.id)) return false
        items[item.id] = item
        pending.add(item)
        while (items.size > cap) {
            val oldest = items.keys.iterator().next()
            items.remove(oldest)
            pending.removeAll { it.id == oldest }
        }
        return true
    }

    /** The items added since the last call, oldest first. */
    @Synchronized
    fun drain(): List<FoundItem> {
        if (pending.isEmpty()) return emptyList()
        val out = ArrayList(pending)
        pending.clear()
        return out
    }

    @Synchronized
    fun size(): Int = items.size

    @Synchronized
    fun clear() {
        items.clear()
        pending.clear()
    }
}
