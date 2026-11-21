package com.maglev.engine.videosites

import android.content.Context
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import org.json.JSONArray
import org.json.JSONObject

/**
 * Video sites (docs/NATIVE_CONTRACT.md section 48, prototype). yt-dlp, through youtubedl-android, only finds the
 * file addresses of a video page. Maglev's own downloader fetches them. The library is initialised on the first
 * resolve, never on the main thread (the caller runs [resolve] on an IO thread).
 *
 * Library API: https://github.com/yausername/youtubedl-android (`YoutubeDL.init(context)`, `execute(request)`).
 */
object VideoSites {
    class VideoSitesException(val code: String, message: String) : Exception(message)

    const val NOT_SUPPORTED = "SITE_NOT_SUPPORTED"
    const val NEEDS_LOGIN = "SITE_NEEDS_LOGIN"
    const val FAILED = "SITE_FAILED"
    const val UNAVAILABLE = "VIDEO_SITES_UNAVAILABLE"

    private val TOP_KEYS = listOf("title", "thumbnail", "duration", "extractor_key", "webpage_url")
    private val FORMAT_KEYS = listOf(
        "format_id", "url", "ext", "vcodec", "acodec", "height", "width", "filesize", "filesize_approx",
        "tbr", "abr", "protocol", "http_headers", "language",
    )

    @Volatile
    private var ready = false

    /** The yt-dlp version the library last downloaded itself, or null while the bundled one is in use. */
    fun version(context: Context): String? = try {
        YoutubeDL.version(context)
    } catch (t: Throwable) {
        null
    }

    private fun ensureInit(context: Context) {
        if (ready) return
        synchronized(this) {
            if (ready) return
            try {
                YoutubeDL.init(context)
            } catch (t: Throwable) {
                throw VideoSitesException(UNAVAILABLE, "Video sites aren't available in this build.")
            }
            ready = true
        }
    }

    /** Runs yt-dlp for [url] and returns the trimmed JSON text (see [trim]). Throws [VideoSitesException]. */
    fun resolve(context: Context, url: String): String {
        ensureInit(context)
        val request = YoutubeDLRequest(url)
        request.addOption("--dump-single-json")
        request.addOption("--no-playlist")
        request.addOption("--no-warnings")
        request.addOption("--socket-timeout", 20)
        val out = try {
            YoutubeDL.execute(request, null, null).out
        } catch (t: Throwable) {
            throw classify(t.message)
        }
        val raw = try {
            JSONObject(out.trim())
        } catch (e: Exception) {
            throw VideoSitesException(FAILED, "Couldn't read this video. Try again.")
        }
        return trim(raw).toString()
    }

    /** Maps yt-dlp's error text to a contract error (section 48.1). */
    fun classify(message: String?): VideoSitesException {
        val m = (message ?: "").lowercase()
        return when {
            m.contains("unsupported url") ->
                VideoSitesException(NOT_SUPPORTED, "Maglev can't read this site. Open it in the browser to find the video.")
            LOGIN_HINTS.any { m.contains(it) } ->
                VideoSitesException(
                    NEEDS_LOGIN,
                    "This site only shows the video to signed-in people. Open it in the browser, sign in and play it.",
                )
            else -> VideoSitesException(FAILED, "Couldn't read this video. Try again.")
        }
    }

    private val LOGIN_HINTS = listOf(
        "login", "log in", "sign in", "cookies", "private video", "members-only", "confirm your age", "age-restricted",
    )

    /**
     * Keeps only what the app needs: title, thumbnail, duration, site and the formats' addresses, codecs, sizes and
     * headers. A page with several videos (a playlist result) gives its first one.
     */
    fun trim(raw: JSONObject): JSONObject {
        val entries = raw.optJSONArray("entries")
        val first = entries?.optJSONObject(0)
        val src = if (!raw.has("formats") && first != null) first else raw
        val out = JSONObject()
        for (k in TOP_KEYS) {
            if (src.has(k) && !src.isNull(k)) out.put(k, src.get(k))
        }
        val formats = JSONArray()
        val list = src.optJSONArray("formats")
        if (list != null) {
            for (i in 0 until list.length()) {
                val f = list.optJSONObject(i) ?: continue
                val keep = JSONObject()
                for (k in FORMAT_KEYS) {
                    if (f.has(k) && !f.isNull(k)) keep.put(k, f.get(k))
                }
                formats.put(keep)
            }
        }
        out.put("formats", formats)
        return out
    }
}
