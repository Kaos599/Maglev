package com.maglev.engine.share

import android.content.Context
import android.content.Intent
import android.net.Uri
import java.io.File
import java.security.MessageDigest

/**
 * Carries every link or route that opens a page in the app (a share, a magnet or .torrent from another app, a
 * notification tap, the Quick Settings tile) to the app's JS without making it the start intent of the task. A start
 * intent is replayed whenever Android rebuilds the task (the process died, or the app was updated), which reopened pages
 * the user had already dealt with, and a restored task reports its original intent even after a newer start. A link kept
 * here is read once and then gone, and the app is always started with the plain launcher intent.
 *
 * It lives in SharedPreferences, not in memory, so it survives the process dying between the card and JS reading it.
 * The card and the module run in the same process, so one lock makes [take] read and clear in a single step.
 */
object ShareHandoff {
    /** A share that was never opened must not pop up later. */
    const val MAX_AGE_MS = 10 * 60 * 1000L

    /** While the app runs a share is taken at once, so anything older than this is not what the user just did. */
    const val WARM_MAX_AGE_MS = 60 * 1000L

    /** Extra on the card's intent: open this maglev:// route in the app through the store (see [routeIntent]). */
    const val EXTRA_OPEN_ROUTE = "com.maglev.engine.share.OPEN_ROUTE"

    /** Most files one hand-off keeps. */
    const val MAX_FILES = 50

    private const val FILE = "maglev_share_handoff"
    private const val KEY_LINK = "link"
    private const val KEY_AT = "at"
    private const val KEY_TRUSTED = "trusted"

    private const val COPY_DIR = "share-handoff"
    private const val MAX_COPY_BYTES = 10 * 1024 * 1024
    private const val COPY_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000L
    private val TORRENT_TYPES = setOf("application/x-bittorrent", "application/x-torrent")

    /** The routes Maglev's own taps may open through the card. The card is exported, so nothing else is accepted. */
    private val ROUTES = Regex("^maglev://(from/(tile|notification)|free-space|settings/updates|torrent/[^/?#\\s]+|(add-torrent|search)\\?\\S*)$")

    private val lock = Any()

    /** True once something may be waiting, false once the store is known empty, null when this process has not looked yet. */
    @Volatile private var waiting: Boolean? = null

    /** True for a route [routeIntent] may carry. */
    fun allowedRoute(route: String): Boolean = ROUTES.matches(route)

    /**
     * An intent for the card that opens [route] in the app. The route is also the intent's data, because PendingIntents
     * that differ only in their extras would be treated as the same one.
     */
    fun routeIntent(context: Context, route: String): Intent =
        Intent(context, QuickShareActivity::class.java)
            .setData(Uri.parse(route))
            .putExtra(EXTRA_OPEN_ROUTE, route)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /**
     * Stores [link], replacing whatever is still waiting: the newest thing is the one to show. [trustedUrl] is a link the
     * card vouches for (a video site the user shared); it is marked as trusted when the entry is taken.
     */
    fun put(context: Context, link: String, trustedUrl: String? = null) {
        synchronized(lock) {
            context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
                .putString(KEY_LINK, link)
                .putLong(KEY_AT, System.currentTimeMillis())
                .putString(KEY_TRUSTED, trustedUrl)
                .commit() // blocking on purpose: it must be on disk before the app is started
            waiting = true
        }
        // A running app is told so it need not wait for an app-state change (split-screen keeps it resumed).
        MaglevQuickShareModule.notifyWaiting()
    }

    /**
     * The waiting link, once. It is cleared whether or not it was still fresh. Null when there is none. A start-up take
     * always reads the disk, accepts an entry up to [MAX_AGE_MS] old and is the only place old copies are swept. A warm
     * take (while the app runs) accepts only [WARM_MAX_AGE_MS] and does no disk work when the store is known empty.
     */
    fun take(context: Context, startUp: Boolean): String? {
        if (startUp) sweepCopies(context)
        synchronized(lock) {
            if (!startUp && waiting == false) return null
            val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            val link = prefs.getString(KEY_LINK, null)
            val trusted = prefs.getString(KEY_TRUSTED, null)
            val at = prefs.getLong(KEY_AT, 0L)
            if (link != null) prefs.edit().clear().commit()
            waiting = false
            if (link == null) return null
            val age = System.currentTimeMillis() - at
            if (link.isBlank() || age !in 0..(if (startUp) MAX_AGE_MS else WARM_MAX_AGE_MS)) return null
            if (trusted != null) TrustedShare.record(trusted)
            return link
        }
    }

    /**
     * Clears the waiting entry without reading it, and without marking anything as trusted. For a link that reached the
     * app another way and is newer. Does no disk work when the store is known empty.
     */
    fun drop(context: Context) {
        synchronized(lock) {
            if (waiting == false) return
            context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().clear().commit()
            waiting = false
        }
    }

    /**
     * Copies a local .torrent (content:// or file://) into Maglev's own cache while the caller still holds the read
     * grant, and returns a file:// URI for the copy. Only a .torrent of at most 10 MB is kept: its name ends in .torrent
     * or its type is a torrent type ([hintType] is the type the sender declared), and it starts with a bencoded
     * dictionary ('d'). It is named by a hash of its content, so the same file is kept once, and an existing copy is
     * touched so the sweep does not remove it. Null when it cannot be read or is not one. Blocking: call from a worker.
     */
    fun keepLocalTorrent(context: Context, source: String, hintType: String?): String? {
        val uri = Uri.parse(source)
        val type = (try { context.contentResolver.getType(uri) } catch (e: Exception) { null }) ?: hintType
        val named = (QuickShareAdd.fileName(context, source) ?: uri.lastPathSegment ?: "").endsWith(".torrent", ignoreCase = true)
        val torrentType = type != null && type.lowercase() in TORRENT_TYPES
        if (!named && !torrentType) return null
        val dir = File(context.cacheDir, COPY_DIR)
        val tmp = File(dir, "tmp-${System.nanoTime()}")
        return try {
            dir.mkdirs()
            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            var first = -1
            val input = context.contentResolver.openInputStream(uri) ?: return null
            input.use { ins ->
                tmp.outputStream().use { out ->
                    val buf = ByteArray(16 * 1024)
                    while (true) {
                        val n = ins.read(buf)
                        if (n < 0) break
                        if (n == 0) continue
                        if (first < 0) first = buf[0].toInt()
                        total += n
                        if (total > MAX_COPY_BYTES) return null
                        digest.update(buf, 0, n)
                        out.write(buf, 0, n)
                    }
                }
            }
            if (total == 0L || first != 'd'.code) return null
            val name = digest.digest().joinToString("") { "%02x".format(it) } + ".torrent"
            val kept = File(dir, name)
            if (kept.exists()) kept.setLastModified(System.currentTimeMillis())
            else if (!tmp.renameTo(kept)) return null
            "file://" + kept.absolutePath
        } catch (e: Exception) {
            null
        } finally {
            tmp.delete() // already moved on success
        }
    }

    /** Deletes kept copies older than two days, so the cache does not fill with files that were never opened. */
    private fun sweepCopies(context: Context) {
        try {
            val cutoff = System.currentTimeMillis() - COPY_MAX_AGE_MS
            File(context.cacheDir, COPY_DIR).listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
        } catch (e: Exception) {
            // The next start tries again.
        }
    }
}
