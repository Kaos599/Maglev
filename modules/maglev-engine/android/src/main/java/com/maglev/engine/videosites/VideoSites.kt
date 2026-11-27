package com.maglev.engine.videosites

import android.content.Context
import android.util.Log
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.BufferedInputStream
import java.io.File
import java.io.InputStream
import java.util.zip.ZipInputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * Video sites (prototype). yt-dlp, through youtubedl-android, only finds the
 * file addresses of a video page. Maglev's own downloader fetches them. The library is initialised on the first
 * resolve, never on the main thread (the caller runs [resolve] on an IO thread).
 *
 * Library API: https://github.com/yausername/youtubedl-android (`YoutubeDL.init(context)`, `execute(request)`).
 */
object VideoSites {
    class VideoSitesException(val code: String, message: String) : Exception(message)

    const val NOT_SUPPORTED = "SITE_NOT_SUPPORTED"
    const val NEEDS_LOGIN = "SITE_NEEDS_LOGIN"
    const val NO_VIDEO = "SITE_NO_VIDEO"
    const val FAILED = "SITE_FAILED"
    const val UNAVAILABLE = "VIDEO_SITES_UNAVAILABLE"

    private val TOP_KEYS = listOf("id", "title", "thumbnail", "duration", "extractor_key", "webpage_url")
    private val FORMAT_KEYS = listOf(
        "format_id", "url", "ext", "vcodec", "acodec", "height", "width", "filesize", "filesize_approx",
        "tbr", "abr", "audio_channels", "protocol", "http_headers", "language",
    )

    @Volatile
    private var ready = false

    /** The yt-dlp version the library last downloaded itself, or null while the bundled one is in use. */
    fun version(context: Context): String? = try {
        YoutubeDL.version(context)
    } catch (t: Throwable) {
        null
    }

    /**
     * What the Settings row shows: the version read from the yt-dlp file that actually runs. Before the library has put
     * a file in place, the tag it saved, else null (the built-in yt-dlp). A file that can't be read shows "unknown",
     * never the saved tag, which is what can be wrong.
     */
    fun versionLabel(context: Context): String? = try {
        if (installedFile(context).isFile) {
            installedVersion(context) ?: "unknown"
        } else {
            YoutubeDL.versionName(context) ?: YoutubeDL.version(context)
        }
    } catch (t: Throwable) {
        null
    }

    // The library's own settings file and keys (youtubedl_common SharedPrefsHelper, YoutubeDLUpdater `dlpVersion`,
    // `dlpVersionName`). They are private there, so they are named here. The backup rules exclude this file.
    private const val TAG = "MaglevVideoSites"
    private const val LIB_PREFS = "youtubedl-android"
    private const val LIB_KEY_TAG = "dlpVersion"
    private const val LIB_KEY_NAME = "dlpVersionName"

    @Volatile
    private var installedCache: Triple<Long, Long, String?>? = null

    /** The yt-dlp file the library runs (`noBackupFilesDir/youtubedl-android/yt-dlp/yt-dlp`). */
    private fun installedFile(context: Context): File =
        File(File(File(context.noBackupFilesDir, YoutubeDL.baseName), YoutubeDL.ytdlpDirName), YoutubeDL.ytdlpBin)

    /** The version inside the yt-dlp file that runs, or null when there is no file yet or it can't be read. */
    fun installedVersion(context: Context): String? = try {
        val f = installedFile(context)
        if (!f.isFile) {
            null
        } else {
            val key = f.length() to f.lastModified()
            val hit = installedCache
            if (hit != null && hit.first == key.first && hit.second == key.second) {
                hit.third
            } else {
                val v = try {
                    f.inputStream().use { zipVersion(it) }
                } catch (t: Throwable) {
                    null
                }
                if (v == null) Log.w(TAG, "couldn't read the version inside the yt-dlp file (${f.length()} bytes)")
                installedCache = Triple(key.first, key.second, v)
                v
            }
        }
    } catch (t: Throwable) {
        null
    }

    /**
     * A yt-dlp file is a zip behind a `#!/usr/bin/env python3` line. Reads `__version__` from `yt_dlp/version.py`
     * (an early entry) by streaming from the first local file header, so the zip's offsets don't matter.
     */
    internal fun zipVersion(raw: InputStream): String? {
        val input = BufferedInputStream(raw, 8192)
        input.mark(4096)
        val head = ByteArray(4096)
        val n = input.read(head).coerceAtLeast(0)
        input.reset()
        var start = -1
        for (i in 0 until n - 3) {
            if (head[i] == 'P'.code.toByte() && head[i + 1] == 'K'.code.toByte() && head[i + 2] == 3.toByte() && head[i + 3] == 4.toByte()) {
                start = i
                break
            }
        }
        if (start < 0) return null
        var skipped = 0L
        while (skipped < start) {
            val s = input.skip(start - skipped)
            if (s <= 0) return null
            skipped += s
        }
        val zip = ZipInputStream(input)
        while (true) {
            val entry = zip.nextEntry ?: return null
            if (entry.name == "yt_dlp/version.py") {
                val text = zip.readBytes().toString(Charsets.UTF_8)
                return Regex("""__version__\s*=\s*['"]([^'"]+)['"]""").find(text)?.groupValues?.get(1)
            }
        }
    }

    /**
     * The library skips the download when its saved tag equals GitHub's newest, and never looks at the file that runs.
     * The tag can outlive the file: a backup restore brings the library's settings back but never `no_backup`, where
     * the file lives, and a kill between its delete and copy leaves the built-in copy behind. Then the old copy runs
     * while every check says "up to date". A tag that the file's own version contradicts is forgotten, so the check
     * downloads. A file that can't be read proves nothing, so it leaves the tag alone (no download loop).
     */
    private fun forgetStaleTag(context: Context) {
        val tag = YoutubeDL.version(context) ?: return
        val running = installedVersion(context) ?: return
        if (running == tag) return
        Log.i(TAG, "yt-dlp file is $running but the saved tag says $tag: downloading again")
        context.getSharedPreferences(LIB_PREFS, Context.MODE_PRIVATE).edit()
            .remove(LIB_KEY_TAG).remove(LIB_KEY_NAME).commit()
    }

    /**
     * True when the yt-dlp that runs is not a verified download: nothing downloaded yet (the built-in copy, far behind
     * the sites), or a saved tag the file contradicts. [VideoSitesUpdater] then asks for one update soon instead of
     * waiting for the daily one.
     */
    fun needsUpdateSoon(context: Context): Boolean = try {
        val tag = YoutubeDL.version(context)
        if (tag == null) {
            true
        } else {
            val running = installedVersion(context)
            running != null && running != tag
        }
    } catch (t: Throwable) {
        false
    }

    data class UpdateResult(val status: String, val version: String?)

    const val UPDATED = "updated"
    const val CURRENT = "current"
    const val UPDATE_FAILED = "failed"
    private const val PREFS = "maglev_video_sites"
    private const val KEY_LAST_CHECK = "last_check_ms"

    private val updateLock = Any()

    /**
     * Downloads the newest yt-dlp (youtubedl-android `updateYoutubeDL`, a blocking network call). Never throws: any
     * failure is `failed`. Two calls never run at once; the second waits and then finds it up to date.
     * Library API: https://github.com/yausername/youtubedl-android (YoutubeDL.kt `updateYoutubeDL`, `UpdateStatus`).
     */
    fun update(context: Context, @Suppress("UNUSED_PARAMETER") force: Boolean): UpdateResult = synchronized(updateLock) {
        try {
            ensureInit(context)
            forgetStaleTag(context)
            val status = YoutubeDL.updateYoutubeDL(context, YoutubeDL.UpdateChannel.STABLE)
            recordCheck(context)
            UpdateResult(if (status == YoutubeDL.UpdateStatus.DONE) UPDATED else CURRENT, versionLabel(context))
        } catch (t: Throwable) {
            UpdateResult(UPDATE_FAILED, versionLabel(context))
        }
    }

    private fun recordCheck(context: Context) {
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply()
        } catch (t: Throwable) {
            // Only the Settings line ("checked …") depends on it.
        }
    }

    /** Epoch ms of the last successful update check, or 0 when there was none. */
    fun lastCheck(context: Context): Long = try {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(KEY_LAST_CHECK, 0L)
    } catch (t: Throwable) {
        0L
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
        val clean = url.trim()
        val hasBadChar = clean.any { it.code < 0x20 || it.code == 0x7F || it.isWhitespace() }
        val host = if (!hasBadChar && Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(clean)) {
            android.net.Uri.parse(clean).host
        } else {
            null
        }
        if (host.isNullOrBlank()) {
            throw VideoSitesException(FAILED, "Couldn't read this video. Try again.")
        }
        ensureInit(context) // never updates here: a resolve must not wait on a download (VideoSitesUpdater does it in the background)
        val request = YoutubeDLRequest(clean)
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

    /** Maps yt-dlp's error text to an app error code. */
    fun classify(message: String?): VideoSitesException {
        val m = (message ?: "").lowercase()
        return when {
            m.contains("unsupported url") ->
                VideoSitesException(NOT_SUPPORTED, "Maglev can't read this site. Open it in the browser to find the video.")
            NO_VIDEO_HINTS.any { m.contains(it) } ->
                VideoSitesException(NO_VIDEO, "No video found in this post.")
            LOGIN_HINTS.any { m.contains(it) } ->
                VideoSitesException(
                    NEEDS_LOGIN,
                    "This site only shows the video to signed-in people. Open it in the browser, sign in and play it.",
                )
            else -> VideoSitesException(FAILED, "Couldn't read this video. Try again.")
        }
    }

    /**
     * What yt-dlp says when the page is real but holds no video, for example a text or picture post on X
     * ("No video could be found in this tweet", "There's no video in this tweet") or "No video formats found".
     */
    private val NO_VIDEO_HINTS = listOf(
        "no video could be found", "no video in this", "no video formats found", "no media found", "there is no video",
    )

    private val LOGIN_HINTS = listOf(
        "login", "log in", "sign in", "cookies", "private video", "members-only", "confirm your age", "age-restricted",
    )

    /**
     * Keeps only what the app needs: title, thumbnail, duration, site and the formats' addresses, codecs, sizes and
     * headers. A page with several videos (a playlist result) gives its first one.
     */
    fun trim(raw: JSONObject): JSONObject {
        val entries = raw.optJSONArray("entries")
        val picked = if (!raw.has("formats") && entries != null) {
            var found: JSONObject? = null
            for (i in 0 until entries.length()) {
                val entry = entries.optJSONObject(i) ?: continue
                val fmts = entry.optJSONArray("formats")
                if (fmts != null && fmts.length() > 0) {
                    found = entry
                    break
                }
            }
            found ?: entries.optJSONObject(0)
        } else {
            null
        }
        val src = picked ?: raw
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
