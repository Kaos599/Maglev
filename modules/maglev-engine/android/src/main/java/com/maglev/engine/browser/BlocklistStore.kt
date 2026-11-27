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

/** What the list holds and where it came from (`getBlocklistInfo`). */
data class BlocklistInfo(
    val domains: Int,
    val updatedAt: Long?,
    val source: String,
    val urls: List<String>,
    val bytes: Long = 0L,
    /** False when a conditional update found every address unchanged. */
    val changed: Boolean = true,
)

/** What a server said about one address: the body (null on 304) and the validators to send next time. */
internal class Fetched(val body: String?, val etag: String?, val lastModified: String?)

/** `If-None-Match` and `If-Modified-Since` values stored for one address. */
internal class Validators(val etag: String?, val lastModified: String?)

/**
 * Holds the active block list. The matcher is an immutable [DomainSet] swapped atomically, so WebView's request
 * threads read it without locks. Loaded lazily and off the main thread: `filesDir/browser/blocklist.txt` when
 * valid, otherwise the bundled asset `blocklist.txt`. Updates write a temp file, fsync, then rename.
 *
 * The update time is written inside the list file (`# updated-at: <epoch ms>`), in the same atomic write as the
 * domains. A file's modification time isn't the update time: a backup restore or a device transfer writes the file
 * again, and Android may report 0 for it ("updated 57 years ago"). A second file for the time could be left behind by
 * a kill between the two writes. See the self-updating-parts model.
 *
 * An update never replaces the list in use with one that failed a check: too few domains, too big, not a list, or
 * (with the same addresses) less than half the domains of the list in use. A GitHub raw address that can't be reached
 * is tried once more through jsDelivr's copy of the same file.
 */
object BlocklistStore {
    private const val ASSET = "blocklist.txt"
    /** Crypto-mining domains. Merged into every active list, so a custom list never drops them. */
    private const val MINERS_ASSET = "miners.txt"
    private const val DIR = "browser"
    private const val FILE = "blocklist.txt"
    private const val META = "blocklist.json"
    private const val TIMEOUT_MS = 30_000
    private const val MAX_REDIRECTS = 5
    private const val TIME_LINE = "# updated-at: "
    /** 2024-01-01. A file time before this on a list Maglev downloaded can't be when it was downloaded. */
    private const val PLAUSIBLE_SINCE_MS = 1_704_067_200_000L

    private val set = AtomicReference(DomainSet.EMPTY)
    private val info = AtomicReference(BlocklistInfo(0, null, "bundled", emptyList()))
    private val started = AtomicBoolean(false)
    private val ready = CountDownLatch(1)
    private val writeLock = Any()
    /** The daily background job, the app's own check and "Update now" can overlap. One runs at a time. */
    private val updateLock = Any()
    @Volatile private var miners: Set<String> = emptySet()
    @Volatile private var minerSet = DomainSet.EMPTY

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

    /** The mining domains alone. Checked on every subresource request, with ad blocking on or off. Request threads only. */
    fun minerMatcher(): DomainSet {
        if (ready.count > 0) ready.await(3, TimeUnit.SECONDS)
        return minerSet
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

    private fun loadMiners(context: Context) {
        miners = try {
            context.assets.open(MINERS_ASSET).use { BlocklistParser.parse(BlocklistParser.readCapped(it)) }
        } catch (_: Exception) {
            emptySet()
        }
        minerSet = DomainSet(miners)
    }

    /** The matcher for [domains] plus the mining domains. `info.domains` still counts only [domains]. */
    private fun withMiners(domains: Set<String>): DomainSet = DomainSet(if (miners.isEmpty()) domains else domains + miners)

    private fun load(context: Context) {
        loadMiners(context)
        val f = File(dir(context), FILE)
        if (f.isFile) {
            try {
                val text = f.inputStream().use { BlocklistParser.readCapped(it) }
                val domains = BlocklistParser.parse(text)
                BlocklistParser.requireEnough(domains)
                set.set(withMiners(domains))
                info.set(BlocklistInfo(domains.size, updatedAtOf(text, f.lastModified()), "downloaded", readUrls(context), f.length()))
                return
            } catch (_: Exception) {
                // A damaged copy falls back to the bundled list.
            }
        }
        loadBundled(context)
    }

    private fun loadBundled(context: Context) {
        val domains = context.assets.open(ASSET).use { BlocklistParser.parse(BlocklistParser.readCapped(it)) }
        set.set(withMiners(domains))
        info.set(BlocklistInfo(domains.size, null, "bundled", emptyList()))
    }

    /**
     * The update time written in the list's first lines. A list saved by an older Maglev has none: its file time is
     * used only when it is plausible (after 2024 and not in the future), else the time is unknown (null).
     */
    internal fun updatedAtOf(text: String, fileTime: Long, now: Long = System.currentTimeMillis()): Long? {
        for (line in text.lineSequence().take(5)) {
            if (line.startsWith(TIME_LINE)) return line.removePrefix(TIME_LINE).trim().toLongOrNull()?.takeIf { it > 0L }
        }
        return fileTime.takeIf { it >= PLAUSIBLE_SINCE_MS && it <= now + 24 * 60 * 60 * 1000L }
    }

    /**
     * jsDelivr's copy of a file on raw.githubusercontent.com (`/gh/user/repo@ref/path`), or null for other addresses.
     * jsDelivr serves GitHub files up to 20 MB and refreshes a branch within 12 hours, so it is a fallback only.
     * https://github.com/jsdelivr/jsdelivr#github
     */
    internal fun mirrorOf(url: String): String? {
        val m = Regex("^https://raw\\.githubusercontent\\.com/([^/]+)/([^/]+)/(.+)$", RegexOption.IGNORE_CASE).find(url.trim()) ?: return null
        val (user, repo, rest) = m.destructured
        val parts = rest.split('/')
        // Both raw forms: `<ref>/<path>` and `refs/heads/<ref>/<path>` (or refs/tags).
        val (ref, path) = if (parts.size >= 4 && parts[0] == "refs" && (parts[1] == "heads" || parts[1] == "tags")) {
            parts[2] to parts.drop(3).joinToString("/")
        } else if (parts.size >= 2) {
            parts[0] to parts.drop(1).joinToString("/")
        } else {
            return null
        }
        if (ref.isEmpty() || path.isEmpty() || path.contains('?') || path.contains('#')) return null
        return "https://cdn.jsdelivr.net/gh/$user/$repo@$ref/$path"
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
    fun update(context: Context, urls: List<String>, conditional: Boolean = false): BlocklistInfo =
        synchronized(updateLock) { updateLocked(context, urls, conditional) }

    private fun updateLocked(context: Context, urls: List<String>, conditional: Boolean): BlocklistInfo {
        val clean = urls.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        if (clean.isEmpty()) throw BlocklistException("INVALID_ARGUMENT", "Add at least one list address.")
        if (clean.any { !BlocklistParser.isHttpsUrl(it) }) {
            throw BlocklistException("INVALID_ARGUMENT", "List addresses must start with https://.")
        }
        BrowserGovernance.blockedReason(context)?.let { throw BlocklistException("BLOCKED", it) }
        warm(context)
        ready.await(10, TimeUnit.SECONDS)
        // A conditional request is skipped when the downloaded list is missing.
        val stored = if (conditional && File(dir(context), FILE).isFile) readValidators(context) else emptyMap()
        val answers = LinkedHashMap<String, Fetched>()
        for (u in clean) answers[u] = fetchOrMirror(u, stored[u])
        if (answers.values.all { it.body == null }) {
            // Every address answered 304: nothing is rewritten.
            return info(context).copy(changed = false)
        }
        // A 304 has no body to merge, so an address that didn't change is fetched again in full.
        for (u in clean) if (answers[u]?.body == null) answers[u] = fetchOrMirror(u, null)
        val all = HashSet<String>()
        for (u in clean) all.addAll(BlocklistParser.parse(answers[u]?.body ?: ""))
        BlocklistParser.requireEnough(all)
        // A list cut short by its server still has thousands of names, so the minimum alone doesn't catch it. With the
        // same addresses, a list under half the size of the one in use is refused and the one in use stays.
        val inUse = info.get()
        if (inUse.source == "downloaded" && inUse.urls.toSet() == clean.toSet() && all.size * 2 < inUse.domains) {
            throw BlocklistException("LIST_INVALID", "The new list is less than half the size of the one in use, so Maglev kept the one in use.")
        }
        synchronized(writeLock) {
            val d = dir(context)
            if (!d.isDirectory && !d.mkdirs()) throw BlocklistException("INTERNAL", "Couldn't save the list.")
            val updatedAt = System.currentTimeMillis()
            val body = buildString {
                append("# Maglev block list, updated from your list addresses\n")
                append(TIME_LINE).append(updatedAt).append('\n')
                for (x in all.sorted()) append(x).append('\n')
            }
            writeAtomic(File(d, FILE), body.toByteArray(Charsets.UTF_8))
            val validators = JSONObject()
            for (u in clean) {
                val a = answers[u] ?: continue
                if (a.etag == null && a.lastModified == null) continue
                validators.put(u, JSONObject().put("etag", a.etag ?: JSONObject.NULL).put("lastModified", a.lastModified ?: JSONObject.NULL))
            }
            val meta = JSONObject().put("urls", JSONArray(clean)).put("validators", validators).toString()
            writeAtomic(File(d, META), meta.toByteArray(Charsets.UTF_8))
            set.set(withMiners(all))
            val written = File(d, FILE)
            val i = BlocklistInfo(all.size, updatedAt, "downloaded", clean, written.length(), true)
            info.set(i)
            return i
        }
    }

    /** ETag and Last-Modified stored per address by the last update. Empty when there are none. */
    private fun readValidators(context: Context): Map<String, Validators> = try {
        val o = JSONObject(File(dir(context), META).readText()).optJSONObject("validators")
        val out = HashMap<String, Validators>()
        if (o != null) {
            for (key in o.keys()) {
                val v = o.optJSONObject(key) ?: continue
                val etag = if (v.isNull("etag")) null else v.optString("etag").ifEmpty { null }
                val lm = if (v.isNull("lastModified")) null else v.optString("lastModified").ifEmpty { null }
                if (etag != null || lm != null) out[key] = Validators(etag, lm)
            }
        }
        out
    } catch (_: Exception) {
        emptyMap()
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

    /** [fetch], then jsDelivr's copy when a GitHub raw address can't be reached or answers with an error. */
    private fun fetchOrMirror(url: String, validators: Validators?): Fetched = try {
        fetch(url, validators)
    } catch (e: BlocklistException) {
        val mirror = if (e.code == "NETWORK" || e.code == "HTTP_STATUS") mirrorOf(url) else null
        if (mirror == null) throw e
        // The validators belong to the first host, so the copy is fetched in full.
        try {
            fetch(mirror, null)
        } catch (_: BlocklistException) {
            throw e
        }
    }

    private fun fetch(startUrl: String, validators: Validators?): Fetched {
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
                validators?.etag?.let { conn.setRequestProperty("If-None-Match", it) }
                validators?.lastModified?.let { conn.setRequestProperty("If-Modified-Since", it) }
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
                if (code == 304 && validators != null) return Fetched(null, validators.etag, validators.lastModified)
                if (code != 200) throw BlocklistException("HTTP_STATUS", "The list server answered $code.")
                if (conn.contentLengthLong > BlocklistParser.MAX_BYTES) {
                    throw BlocklistException("LIST_TOO_LARGE", "That list is too big (over ${BlocklistParser.MAX_BYTES / (1024 * 1024)} MB).")
                }
                val text = conn.inputStream.use { BlocklistParser.readCapped(it) }
                return Fetched(text, conn.getHeaderField("ETag"), conn.getHeaderField("Last-Modified"))
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
