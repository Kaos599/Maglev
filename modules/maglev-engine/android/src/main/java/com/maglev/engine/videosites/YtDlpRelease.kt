package com.maglev.engine.videosites

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * yt-dlp's newest stable release, straight from its GitHub release files. No Maglev server is involved.
 *
 * `https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS` answers with a redirect to
 * `.../releases/download/<tag>/SHA2-256SUMS`, which names the newest tag. The sums file holds one line per release
 * file, `<sha256>  yt-dlp` among them. The `yt-dlp` file is then fetched from the same tag, so the file and its sum
 * always belong to the same release. These are plain release downloads, not the GitHub API, so the API's limit of 60
 * calls an hour per address doesn't apply, and there is no saved tag that could drift from the file.
 *
 * Release files: https://github.com/yt-dlp/yt-dlp#release-files
 * Latest-release links: https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases
 * HttpURLConnection timeouts: https://developer.android.com/reference/java/net/URLConnection#setConnectTimeout(int)
 */
object YtDlpRelease {
    private const val LATEST_SUMS = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS"
    private const val TAG_BASE = "https://github.com/yt-dlp/yt-dlp/releases/download/"
    private const val CONNECT_MS = 15_000
    private const val READ_MS = 30_000
    private const val MAX_SUMS_BYTES = 64 * 1024
    /** The file is about 3 MB. Anything far bigger is not it. */
    const val MAX_FILE_BYTES = 64L * 1024 * 1024
    private val TAG_OK = Regex("^[0-9A-Za-z._-]{1,64}$")
    private val SUM_LINE = Regex("""^([0-9a-fA-F]{64})\s+\*?yt-dlp$""")

    class ReleaseException(val code: String, message: String) : Exception(message)

    data class Latest(val tag: String, val sha256: String)

    /** The newest tag and the SHA-256 of its `yt-dlp` file. Throws [ReleaseException] (NETWORK, HTTP, NO_FILE). */
    fun latest(): Latest {
        val first = open(LATEST_SUMS, follow = false)
        val location = try {
            val code = first.responseCode
            if (code !in 300..399) throw ReleaseException("HTTP", "GitHub answered $code.")
            first.getHeaderField("Location") ?: throw ReleaseException("HTTP", "GitHub didn't name the newest release.")
        } catch (e: IOException) {
            throw ReleaseException("NETWORK", "Couldn't reach GitHub.")
        } finally {
            first.disconnect()
        }
        val resolved = URL(URL(LATEST_SUMS), location).toString()
        val tag = Regex("""/releases/download/([^/]+)/SHA2-256SUMS$""").find(resolved)?.groupValues?.get(1)
        if (tag == null || !TAG_OK.matches(tag)) throw ReleaseException("HTTP", "GitHub named a release Maglev can't read.")
        val text = readText("$TAG_BASE$tag/SHA2-256SUMS", MAX_SUMS_BYTES)
        val sum = text.lineSequence().map { it.trim() }.mapNotNull { SUM_LINE.find(it)?.groupValues?.get(1) }.firstOrNull()
            ?: throw ReleaseException("NO_FILE", "The newest release has no yt-dlp file.")
        return Latest(tag, sum.lowercase())
    }

    /**
     * Downloads `yt-dlp` of [tag] into [to] (synced to disk) and returns its SHA-256. The caller compares it with the
     * published sum before anything runs it. Throws [ReleaseException] (NETWORK, HTTP, TOO_BIG, NO_SPACE).
     */
    fun download(tag: String, to: File): String {
        if (!TAG_OK.matches(tag)) throw ReleaseException("HTTP", "GitHub named a release Maglev can't read.")
        val conn = open("$TAG_BASE$tag/yt-dlp", follow = true)
        try {
            val code = conn.responseCode
            if (code != 200) throw ReleaseException("HTTP", "GitHub answered $code.")
            val length = conn.contentLengthLong
            if (length > MAX_FILE_BYTES) throw ReleaseException("TOO_BIG", "The download is far bigger than yt-dlp.")
            val free = to.parentFile?.usableSpace ?: Long.MAX_VALUE
            // The new copy, plus the copy kept to roll back to, need room next to the one in use.
            if (length > 0 && free < length * 3) throw ReleaseException("NO_SPACE", "Storage full.")
            val md = MessageDigest.getInstance("SHA-256")
            var total = 0L
            conn.inputStream.use { input ->
                FileOutputStream(to).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_FILE_BYTES) throw ReleaseException("TOO_BIG", "The download is far bigger than yt-dlp.")
                        md.update(buf, 0, n)
                        out.write(buf, 0, n)
                    }
                    out.flush()
                    out.fd.sync()
                }
            }
            return YtDlpInstall.hex(md.digest())
        } catch (e: ReleaseException) {
            to.delete()
            throw e
        } catch (e: IOException) {
            to.delete()
            val full = (e.message ?: "").contains("ENOSPC")
            throw ReleaseException(if (full) "NO_SPACE" else "NETWORK", if (full) "Storage full." else "Couldn't reach GitHub.")
        } finally {
            conn.disconnect()
        }
    }

    private fun readText(url: String, max: Int): String {
        val conn = open(url, follow = true)
        try {
            val code = conn.responseCode
            if (code != 200) throw ReleaseException("HTTP", "GitHub answered $code.")
            val bytes = conn.inputStream.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buf = ByteArray(8192)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    if (out.size() > max) throw ReleaseException("HTTP", "GitHub sent something that isn't the sums file.")
                }
                out.toByteArray()
            }
            return bytes.toString(Charsets.UTF_8)
        } catch (e: ReleaseException) {
            throw e
        } catch (e: IOException) {
            throw ReleaseException("NETWORK", "Couldn't reach GitHub.")
        } finally {
            conn.disconnect()
        }
    }

    /**
     * An https connection with connect and read timeouts. With [follow], HttpURLConnection follows redirects itself, and
     * only within https (it never follows a redirect that changes the protocol).
     */
    private fun open(url: String, follow: Boolean): HttpURLConnection {
        val conn = try {
            URL(url).openConnection() as HttpURLConnection
        } catch (e: IOException) {
            throw ReleaseException("NETWORK", "Couldn't reach GitHub.")
        }
        conn.connectTimeout = CONNECT_MS
        conn.readTimeout = READ_MS
        conn.instanceFollowRedirects = follow
        conn.useCaches = false
        conn.setRequestProperty("Accept", "*/*")
        return conn
    }
}
