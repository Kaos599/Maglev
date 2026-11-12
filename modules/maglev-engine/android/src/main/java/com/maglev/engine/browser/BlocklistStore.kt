package com.maglev.engine.browser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** What the list holds and where it came from (docs/NATIVE_CONTRACT.md section 24.4 `getBlocklistInfo`). */
data class BlocklistInfo(val domains: Int, val updatedAt: Long?, val source: String, val urls: List<String>, val bytes: Long = 0L)

/**
 * Holds the active block list. The matcher is an immutable [DomainSet] swapped atomically, so WebView's request
 * threads read it without locks. Loaded lazily and off the main thread: `filesDir/browser/blocklist.txt` when
 * valid, otherwise the bundled asset `blocklist.txt`. Updates write a temp file, fsync, then rename.
 */
object BlocklistStore {
    private const val ASSET = "blocklist.txt"
    private const val DIR = "browser"
    private const val FILE = "blocklist.txt"
    private const val META = "blocklist.json"
    private const val TIMEOUT_MS = 30_000
    private const val MAX_REDIRECTS = 5

    private val set = AtomicReference(DomainSet.EMPTY)
    private val info = AtomicReference(BlocklistInfo(0, null, "bundled", emptyList()))
    private val started = AtomicBoolean(false)
    private val ready = CountDownLatch(1)
    private val writeLock = Any()

    /** Starts loading in the background, once. Safe to call from any thread. */
    fun warm(context: Context) {
        if (!started.compareAndSet(false, true)) return
        val app = context.applicationContext
        Thread({
            try {
                load(app)
            } catch (_: Throwable) {
                // Keep the empty set: browsing works without blocking.
            } finally {
                ready.countDown()
            }
        }, "maglev-blocklist").start()
    }

    /** The current matcher. Waits briefly for the first load: request threads may block, the main thread must not call this. */
    fun matcher(): DomainSet {
        if (ready.count > 0) ready.await(3, TimeUnit.SECONDS)
        return set.get()
    }

    /** The current matcher without waiting: empty until the first load is done. For the main thread. */
    fun peek(): DomainSet = set.get()

    /** Info for `getBlocklistInfo`. Blocks until the first load is done. */
    fun info(context: Context): BlocklistInfo {
        warm(context)
        ready.await(10, TimeUnit.SECONDS)
        return info.get()
    }

    private fun dir(context: Context) = File(context.filesDir, DIR)

    private fun load(context: Context) {
        val f = File(dir(context), FILE)
        if (f.isFile) {
            try {
                val domains = f.inputStream().use { BlocklistParser.parse(BlocklistParser.readCapped(it)) }
                BlocklistParser.requireEnough(domains)
                set.set(DomainSet(domains))
                info.set(BlocklistInfo(domains.size, f.lastModified(), "downloaded", readUrls(context)))
                return
            } catch (_: Exception) {
                // A damaged copy falls back to the bundled list.
            }
        }
        loadBundled(context)
    }

    private fun loadBundled(context: Context) {
        val domains = context.assets.open(ASSET).use { BlocklistParser.parse(BlocklistParser.readCapped(it)) }
        set.set(DomainSet(domains))
        info.set(BlocklistInfo(domains.size, null, "bundled", emptyList()))
    }

    private fun readUrls(context: Context): List<String> = try {
        val o = JSONObject(File(dir(context), META).readText())
        val a = o.optJSONArray("urls") ?: JSONArray()
        (0 until a.length()).map { a.getString(it) }
    } catch (_: Exception) {
        emptyList()
    }

    /** Back to the bundled list. Deletes the downloaded copy. */
    fun reset(context: Context) {
        warm(context)
        ready.await(10, TimeUnit.SECONDS)
        synchronized(writeLock) {
            File(dir(context), FILE).delete()
            File(dir(context), META).delete()
            loadBundled(context)
        }
    }

    /**
     * Fetches every URL (https only), merges the domains and replaces the list atomically. Blocking: call off the
     * main thread. Throws [BlocklistException] with code NETWORK, HTTP_STATUS, LIST_TOO_LARGE, LIST_INVALID, BLOCKED
     * or INVALID_ARGUMENT. The current list stays when anything fails.
     */
    fun update(context: Context, urls: List<String>): BlocklistInfo {
        val clean = urls.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        if (clean.isEmpty()) throw BlocklistException("INVALID_ARGUMENT", "Add at least one list address.")
        if (clean.any { !BlocklistParser.isHttpsUrl(it) }) {
            throw BlocklistException("INVALID_ARGUMENT", "List addresses must start with https://.")
        }
        BrowserGovernance.blockedReason(context)?.let { throw BlocklistException("BLOCKED", it) }
        warm(context)
        val all = HashSet<String>()
        for (u in clean) all.addAll(BlocklistParser.parse(fetch(u)))
        BlocklistParser.requireEnough(all)
        synchronized(writeLock) {
            val d = dir(context)
            if (!d.isDirectory && !d.mkdirs()) throw BlocklistException("INTERNAL", "Couldn't save the list.")
            val body = buildString {
                append("# Maglev block list, updated from your list addresses\n")
                for (x in all.sorted()) append(x).append('\n')
            }
            writeAtomic(File(d, FILE), body.toByteArray(Charsets.UTF_8))
            val meta = JSONObject().put("urls", JSONArray(clean)).toString()
            writeAtomic(File(d, META), meta.toByteArray(Charsets.UTF_8))
            set.set(DomainSet(all))
            val written = File(d, FILE)
            val i = BlocklistInfo(all.size, written.lastModified(), "downloaded", clean, written.length())
            info.set(i)
            return i
        }
    }

    /** Temp file in the same folder, fsync, then rename over the target. */
    private fun writeAtomic(target: File, bytes: ByteArray) {
        val tmp = File(target.parentFile, target.name + ".tmp")
        try {
            FileOutputStream(tmp).use { out ->
                out.write(bytes)
                out.flush()
                out.fd.sync()
            }
            if (!tmp.renameTo(target)) throw IOException("rename failed")
        } catch (e: IOException) {
            tmp.delete()
            throw BlocklistException("INTERNAL", "Couldn't save the list.")
        }
    }

    private fun fetch(startUrl: String): String {
        var url = startUrl
        var hops = 0
        while (true) {
            val conn = try {
                URL(url).openConnection() as HttpURLConnection
            } catch (_: Exception) {
                throw BlocklistException("INVALID_ARGUMENT", "That list address isn't valid.")
            }
            try {
                conn.connectTimeout = TIMEOUT_MS
                conn.readTimeout = TIMEOUT_MS
                conn.instanceFollowRedirects = false
                conn.setRequestProperty("Accept", "text/plain, */*")
                val code = conn.responseCode
                if (code in 300..399) {
                    val next = conn.getHeaderField("Location")
                    if (next == null || ++hops > MAX_REDIRECTS) throw BlocklistException("NETWORK", "The list address redirected too many times.")
                    val resolved = URL(URL(url), next).toString()
                    // A redirect may not leave https.
                    if (!BlocklistParser.isHttpsUrl(resolved)) throw BlocklistException("NETWORK", "The list address redirected to an unsafe address.")
                    url = resolved
                    continue
                }
                if (code != 200) throw BlocklistException("HTTP_STATUS", "The list server answered $code.")
                if (conn.contentLengthLong > BlocklistParser.MAX_BYTES) {
                    throw BlocklistException("LIST_TOO_LARGE", "That list is too big (over ${BlocklistParser.MAX_BYTES / (1024 * 1024)} MB).")
                }
                return conn.inputStream.use { BlocklistParser.readCapped(it) }
            } catch (e: BlocklistException) {
                throw e
            } catch (e: IOException) {
                throw BlocklistException("NETWORK", "Couldn't reach the list. Check your connection and try again.")
            } finally {
                conn.disconnect()
            }
        }
    }
}
