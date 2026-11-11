package com.maglev.engine.util

import android.content.Context
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Downloads `https://` .torrent files in Kotlin, because the Rust side has no TLS for them yet. */
object TorrentFetcher {
    private const val TIMEOUT_MS = 30_000
    private const val MAX_BYTES = 10 * 1024 * 1024
    private const val KEEP_MS = 7L * 24 * 3600 * 1000

    fun isHttps(source: String): Boolean =
        source.startsWith("https://", ignoreCase = true) && !source.startsWith("magnet:", ignoreCase = true)

    /** Returns the absolute path of the saved file, or a failure envelope. */
    fun fetch(context: Context, url: String): Pair<String?, Map<String, Any?>?> {
        var conn: HttpURLConnection? = null
        try {
            val deadline = System.currentTimeMillis() + TIMEOUT_MS
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "Maglev")
            }
            val code = conn.responseCode
            if (code !in 200..299) return null to Json.failure("NETWORK", "The server answered with error $code.")
            val out = ByteArrayOutputStream()
            val buf = ByteArray(16 * 1024)
            conn.inputStream.use { input ->
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    if (out.size() > MAX_BYTES) return null to Json.failure("INVALID_SOURCE", "That file is too large to be a torrent.")
                    if (System.currentTimeMillis() > deadline) return null to Json.failure("NETWORK", "The download took too long.")
                }
            }
            val bytes = out.toByteArray()
            if (bytes.isEmpty() || bytes[0] != 'd'.code.toByte()) {
                return null to Json.failure("INVALID_SOURCE", "That link is not a torrent file.")
            }
            val dir = File(context.cacheDir, "torrents").also { it.mkdirs() }
            prune(dir)
            val f = File(dir, "${url.hashCode().toUInt()}-${System.currentTimeMillis()}.torrent")
            f.writeBytes(bytes)
            return f.absolutePath to null
        } catch (e: java.net.SocketTimeoutException) {
            return null to Json.failure("NETWORK", "The server took too long to answer.")
        } catch (e: java.net.MalformedURLException) {
            return null to Json.failure("INVALID_SOURCE", "That link is not valid.")
        } catch (e: Exception) {
            return null to Json.failure("NETWORK", "Could not download the torrent file.")
        } finally {
            conn?.disconnect()
        }
    }

    private fun prune(dir: File) {
        val cutoff = System.currentTimeMillis() - KEEP_MS
        dir.listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
    }
}
