package com.maglev.engine.update

import android.content.Context
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The one place that asks GitHub for the release list, for the app's own check and for the background job alike, so
 * both share the same validator and the same back-off.
 *
 * - It sends `If-None-Match` with the ETag of the last answer it kept. A 304 hands back that kept list, so nothing
 *   is downloaded twice.
 * - After a 403 or 429 it asks again only once GitHub's wait is over: `retry-after` seconds, else `x-ratelimit-reset`
 *   when `x-ratelimit-remaining` is 0, else one hour. The wait is capped at a day.
 * - No token, no cookies, and nothing but the app version in its User-Agent.
 *
 * GitHub's rules: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api and
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api. (An unauthenticated 304 still counts
 * toward the hourly limit, so the ETag saves the download, not the request.)
 */
object ReleaseFeed {
    private const val PREFS = "maglev_update_feed"
    private const val KEY_ETAG = "etag"
    private const val KEY_RETRY_AT = "retry_at"
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 15_000
    /** The 20-release list is about 100 KB. Anything far larger is not the list. */
    private const val MAX_BODY = 4 * 1024 * 1024
    private const val DEFAULT_WAIT_MS = 60L * 60 * 1000
    private const val MAX_WAIT_MS = 24L * 60 * 60 * 1000

    sealed class Result {
        class Ok(val body: String) : Result()
        class Failed(val code: String, val retryAt: Long? = null) : Result()
    }

    private val lock = Any()

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun cacheFile(c: Context) = File(c.cacheDir, "update-feed.json")

    /** Blocking. Call off the main thread. */
    fun fetch(context: Context, appVersion: String): Result = synchronized(lock) { fetchLocked(context.applicationContext, appVersion) }

    private fun fetchLocked(c: Context, appVersion: String): Result {
        val p = prefs(c)
        val now = System.currentTimeMillis()
        val retryAt = p.getLong(KEY_RETRY_AT, 0L)
        // A wait longer than the cap means the clock moved back; drop it rather than wait for it.
        if (retryAt > now && retryAt - now <= MAX_WAIT_MS) return Result.Failed("RATE_LIMITED", retryAt)
        val cached = cacheFile(c)
        val etag = if (cached.isFile) p.getString(KEY_ETAG, null) else null
        var conn: HttpURLConnection? = null
        try {
            conn = URL(ReleasePicker.RELEASES_URL).openConnection() as HttpURLConnection
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.useCaches = false
            conn.setRequestProperty("Accept", "application/vnd.github+json")
            conn.setRequestProperty("User-Agent", "Maglev/$appVersion")
            if (etag != null) conn.setRequestProperty("If-None-Match", etag)
            val code = conn.responseCode
            when {
                code == 304 && etag != null -> {
                    val body = try { cached.readText() } catch (e: IOException) { null }
                    if (body != null) return Result.Ok(body)
                    p.edit().remove(KEY_ETAG).apply()
                    return Result.Failed("NETWORK")
                }
                code == 200 -> {
                    val bytes = conn.inputStream.use { input ->
                        val out = java.io.ByteArrayOutputStream()
                        val buf = ByteArray(16 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            if (out.size() > MAX_BODY) throw IOException("release list too large")
                        }
                        out.toByteArray()
                    }
                    val body = String(bytes, Charsets.UTF_8)
                    val newTag = conn.getHeaderField("ETag")
                    try {
                        cached.writeText(body)
                        p.edit().apply { if (newTag != null) putString(KEY_ETAG, newTag) else remove(KEY_ETAG) }.remove(KEY_RETRY_AT).apply()
                    } catch (e: IOException) {
                        p.edit().remove(KEY_ETAG).apply()
                    }
                    return Result.Ok(body)
                }
                code == 403 || code == 429 -> {
                    val until = now + waitMs(conn, now)
                    p.edit().putLong(KEY_RETRY_AT, until).apply()
                    return Result.Failed("RATE_LIMITED", until)
                }
                else -> return Result.Failed("HTTP_STATUS")
            }
        } catch (e: IOException) {
            return Result.Failed("NETWORK")
        } catch (e: Exception) {
            return Result.Failed("NETWORK")
        } finally {
            conn?.disconnect()
        }
    }

    private fun waitMs(conn: HttpURLConnection, now: Long): Long {
        val retryAfter = conn.getHeaderField("Retry-After")?.trim()?.toLongOrNull()
        val remaining = conn.getHeaderField("X-RateLimit-Remaining")?.trim()
        val reset = conn.getHeaderField("X-RateLimit-Reset")?.trim()?.toLongOrNull()
        val ms = when {
            retryAfter != null && retryAfter > 0 -> retryAfter * 1000
            remaining == "0" && reset != null -> reset * 1000 - now
            else -> DEFAULT_WAIT_MS
        }
        return ms.coerceIn(60_000L, MAX_WAIT_MS)
    }

    /** Forgets the kept list and the wait, after Maglev was updated (another version reads the list differently). */
    fun forget(context: Context) {
        val c = context.applicationContext
        cacheFile(c).delete()
        prefs(c).edit().clear().apply()
    }
}
