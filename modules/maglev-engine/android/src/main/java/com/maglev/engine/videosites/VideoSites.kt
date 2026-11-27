package com.maglev.engine.videosites

import android.content.Context
import android.util.Log
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.BufferedInputStream
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
    /** A read failed while the library's built-in copy still runs: the sites refuse that copy. The screen offers Update now. */
    const val OUTDATED = "VIDEO_SITES_OUTDATED"
    private const val OUTDATED_MESSAGE =
        "Video support still runs the version that came with the app, and sites refuse it. Maglev gets the new one by itself on Wi-Fi, or tap Update now."

    private val TOP_KEYS = listOf("id", "title", "thumbnail", "duration", "extractor_key", "webpage_url")
    private val FORMAT_KEYS = listOf(
        "format_id", "url", "ext", "vcodec", "acodec", "height", "width", "filesize", "filesize_approx",
        "tbr", "abr", "protocol", "http_headers", "language",
    )

    @Volatile
    private var ready = false

    private const val TAG = "MaglevVideoSites"

    @Volatile
    private var installedCache: Triple<Long, Long, String?>? = null

    /**
     * What the Settings row shows: the version read from the yt-dlp file that actually runs, null before the first read
     * or update put one in place (the built-in copy), or "unknown" when the file can't be read. No saved tag is
     * consulted, so nothing can say a version the file doesn't have.
     */
    fun versionLabel(context: Context): String? = try {
        if (YtDlpInstall.file(context).isFile) installedVersion(context) ?: "unknown" else null
    } catch (t: Throwable) {
        null
    }

    /** The version inside the yt-dlp file that runs, or null when there is no file yet or it can't be read. */
    fun installedVersion(context: Context): String? = try {
        val f = YtDlpInstall.file(context)
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
     * True while the yt-dlp that runs is not one this app checked and saw run: a fresh install still on the library's
     * built-in copy (a year behind the sites), or a copy left by an older Maglev. [VideoSitesUpdater] then asks for one
     * update soon instead of waiting for the daily one.
     */
    fun needsUpdateSoon(context: Context): Boolean = try {
        !YtDlpInstall.runsCheckedDownload(context)
    } catch (t: Throwable) {
        false
    }

    data class UpdateResult(val status: String, val version: String?)

    const val UPDATED = "updated"
    const val CURRENT = "current"
    const val UPDATE_FAILED = "failed"

    /** What the Settings line and the debug log say about the last check (`result` in the status file). */
    const val RESULT_UPDATED = "updated"
    const val RESULT_CURRENT = "current"
    const val RESULT_FAILED = "failed"
    const val RESULT_BLOCKED = "blocked"
    /** The newest release failed its test run on this phone's Python, so the previous copy stayed. */
    const val RESULT_ROLLED_BACK = "rolledBack"

    private val updateLock = Any()

    /**
     * Replaces yt-dlp with its newest stable release, or finds it already in place. Never throws: any failure is
     * `failed`, and the copy in use stays. Two calls never run at once; the second waits and then finds it current.
     *
     * Steps (see the self-updating-parts model): check the newest release's SHA-256 against the file in use, download
     * next to it, check the download's SHA-256, read its version, then swap and test-run under the write lock
     * ([YtDlpInstall.install]), which rolls back when the run fails.
     *
     * [manual] is "Check now" or an Update button. It may use mobile data even with "Update on mobile data" off,
     * because the person asked for it now. Both kinds honour Wi-Fi only and VPN only, as every other download does.
     */
    fun update(context: Context, manual: Boolean): UpdateResult = synchronized(updateLock) { updateLocked(context, manual) }

    @Suppress("UNUSED_PARAMETER")
    private fun updateLocked(context: Context, manual: Boolean): UpdateResult {
        return try {
            ensureInit(context)
            if (com.maglev.engine.browser.BrowserGovernance.blockedReason(context) != null) {
                note(context, RESULT_BLOCKED, null, checked = false)
                return UpdateResult(UPDATE_FAILED, versionLabel(context))
            }
            val latest = YtDlpRelease.latest()
            val running = YtDlpInstall.runningSha256(context)
            if (running == latest.sha256) {
                // In place already, and its bytes are the published ones: from now on it counts as checked.
                YtDlpInstall.writeStatus(context) { it.put("installedSha", running) }
                note(context, RESULT_CURRENT, null, checked = true)
                return UpdateResult(CURRENT, versionLabel(context))
            }
            if (latest.sha256 == YtDlpInstall.readStatus(context).optString("badSha", "")) {
                // This release already failed its test run here. Keep the copy that works until a newer one is out.
                note(context, RESULT_ROLLED_BACK, null, checked = true)
                return UpdateResult(UPDATE_FAILED, versionLabel(context))
            }
            val tmp = YtDlpInstall.downloadFile(context)
            val got = YtDlpRelease.download(latest.tag, tmp)
            if (got != latest.sha256) {
                tmp.delete()
                Log.w(TAG, "yt-dlp ${latest.tag}: the download's SHA-256 doesn't match SHA2-256SUMS; deleted")
                note(context, RESULT_FAILED, "The download didn't match its published checksum.", checked = true)
                return UpdateResult(UPDATE_FAILED, versionLabel(context))
            }
            val version = try {
                tmp.inputStream().use { zipVersion(it) }
            } catch (t: Throwable) {
                null
            }
            when (YtDlpInstall.install(context, version)) {
                YtDlpInstall.Outcome.INSTALLED -> {
                    YtDlpInstall.writeStatus(context) { it.put("installedSha", latest.sha256).remove("badSha") }
                    Log.i(TAG, "yt-dlp ${version ?: latest.tag} installed and ran")
                    note(context, RESULT_UPDATED, null, checked = true)
                    UpdateResult(UPDATED, versionLabel(context))
                }
                YtDlpInstall.Outcome.ROLLED_BACK -> {
                    YtDlpInstall.writeStatus(context) { it.put("badSha", latest.sha256) }
                    note(context, RESULT_ROLLED_BACK, "yt-dlp ${version ?: latest.tag} didn't run on this phone.", checked = true)
                    UpdateResult(UPDATE_FAILED, versionLabel(context))
                }
                YtDlpInstall.Outcome.BUSY -> {
                    tmp.delete()
                    note(context, RESULT_FAILED, "A video was being read the whole time. It tries again later.", checked = true)
                    UpdateResult(UPDATE_FAILED, versionLabel(context))
                }
                YtDlpInstall.Outcome.FAILED -> {
                    tmp.delete()
                    note(context, RESULT_FAILED, "Couldn't save the new copy.", checked = true)
                    UpdateResult(UPDATE_FAILED, versionLabel(context))
                }
            }
        } catch (e: YtDlpRelease.ReleaseException) {
            Log.w(TAG, "yt-dlp check failed: ${e.code} ${e.message}")
            note(context, RESULT_FAILED, e.message, checked = false)
            UpdateResult(UPDATE_FAILED, versionLabel(context))
        } catch (t: Throwable) {
            Log.w(TAG, "yt-dlp update failed: ${t.message}")
            note(context, RESULT_FAILED, t.message?.take(200), checked = false)
            UpdateResult(UPDATE_FAILED, versionLabel(context))
        }
    }

    /** Records the outcome; [checked] moves "checked …" only when GitHub was reached. Never throws. */
    private fun note(context: Context, result: String, error: String?, checked: Boolean) {
        YtDlpInstall.writeStatus(context) {
            it.put("result", result)
            if (error == null) it.remove("error") else it.put("error", error)
            if (checked) it.put("checkedAt", System.currentTimeMillis())
        }
        Log.i(TAG, "yt-dlp status: ${statusLine(context)}")
    }

    /** Epoch ms of the last check that reached GitHub, or 0 when there was none on this phone. */
    fun lastCheck(context: Context): Long = YtDlpInstall.readStatus(context).optLong("checkedAt", 0L)

    /** One line for the debug log: version in use, last check, result and error. */
    fun statusLine(context: Context): String {
        val s = YtDlpInstall.readStatus(context)
        return "running=${versionLabel(context) ?: "built-in"} checked=${YtDlpInstall.runsCheckedDownload(context)} " +
            "lastCheckAt=${s.optLong("checkedAt", 0L)} result=${s.optString("result", "none")} error=${s.optString("error", "")}"
    }

    /** `{ version, lastCheckAt, result, error, builtIn }` for Settings. */
    fun report(context: Context): Map<String, Any?> {
        val s = YtDlpInstall.readStatus(context)
        val last = s.optLong("checkedAt", 0L)
        return linkedMapOf(
            "version" to versionLabel(context),
            "lastCheckAt" to (if (last > 0L) last.toDouble() else null),
            "result" to (if (s.has("result")) s.optString("result") else null),
            "error" to (if (s.has("error")) s.optString("error") else null),
            "builtIn" to !YtDlpInstall.runsCheckedDownload(context),
        )
    }

    /**
     * Starts the library once per process, never on the main thread. Before that, puts back a previous yt-dlp whose
     * replacement never finished its test run ([YtDlpInstall.recover]); the library's init then copies its built-in
     * copy in only if the path is still empty.
     */
    private fun ensureInit(context: Context) {
        if (ready) return
        synchronized(this) {
            if (ready) return
            try {
                YtDlpInstall.recover(context)
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
        ensureInit(context) // never downloads here: a read must not wait on yt-dlp's download (VideoSitesUpdater does that)
        val request = YoutubeDLRequest(clean)
        request.addOption("--dump-single-json")
        request.addOption("--no-playlist")
        request.addOption("--no-warnings")
        request.addOption("--socket-timeout", 20)
        // The read lock keeps a swap of the yt-dlp file away while this runs.
        val out = try {
            YtDlpInstall.reading { YoutubeDL.execute(request, null, null).out }
        } catch (t: Throwable) {
            val e = classify(t.message)
            // A plain failure on the built-in copy is almost always that copy's age, so say so instead of "Try again".
            if (e.code == FAILED && !YtDlpInstall.runsCheckedDownload(context)) throw VideoSitesException(OUTDATED, OUTDATED_MESSAGE)
            throw e
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
