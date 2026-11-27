package com.maglev.engine.share

import android.content.Context
import android.net.Uri
import java.io.File
import java.security.MessageDigest

/**
 * Carries one link that opens an Add screen (a share, a magnet or .torrent from another app, a Watch notification's
 * Download action) to the app's JS without making it the start intent of the task. A start intent is replayed whenever
 * Android rebuilds the task (the process died, or the app was updated), which reopened the Add screen of a link the user
 * had already dealt with. A link kept here is read once and then gone.
 *
 * It lives in SharedPreferences, not in memory, so it survives the process dying between the card and JS reading it.
 * The card and the module run in the same process, so one lock makes [take] read and clear in a single step.
 */
object ShareHandoff {
    /** A share that was never opened must not pop up later. */
    const val MAX_AGE_MS = 10 * 60 * 1000L

    /** Extra on the card's intent: open this maglev://add-torrent link in the app through the store (Watch notification). */
    const val EXTRA_OPEN_ADD = "com.maglev.engine.share.OPEN_ADD"

    /** Most files one hand-off keeps. */
    const val MAX_FILES = 50

    private const val FILE = "maglev_share_handoff"
    private const val KEY_LINK = "link"
    private const val KEY_AT = "at"

    private const val COPY_DIR = "share-handoff"
    private const val MAX_COPY_BYTES = 10 * 1024 * 1024
    private const val COPY_MAX_AGE_MS = 24 * 60 * 60 * 1000L

    private val lock = Any()

    /** Stores [link], replacing any link still waiting: the newest share is the one to show. */
    fun put(context: Context, link: String) {
        synchronized(lock) {
            context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
                .putString(KEY_LINK, link)
                .putLong(KEY_AT, System.currentTimeMillis())
                .commit() // blocking on purpose: it must be on disk before the app is started
        }
    }

    /** The waiting link, once. It is cleared whether or not it was still fresh. Null when there is none. */
    fun take(context: Context): String? {
        sweepCopies(context)
        synchronized(lock) {
            val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            val link = prefs.getString(KEY_LINK, null) ?: return null
            val at = prefs.getLong(KEY_AT, 0L)
            prefs.edit().clear().commit()
            val age = System.currentTimeMillis() - at
            return if (link.isNotBlank() && age in 0..MAX_AGE_MS) link else null
        }
    }

    /**
     * Copies a local .torrent (content:// or file://) into Maglev's own cache while the caller still holds the read
     * grant, and returns a file:// URI for the copy. Only a .torrent of at most 10 MB is kept (a bencoded dictionary starts
     * with 'd'), named by a hash of its content so the same file is kept once. Null when it cannot be read or is not one.
     * Blocking: call from a worker thread.
     */
    fun keepLocalTorrent(context: Context, source: String): String? {
        val dir = File(context.cacheDir, COPY_DIR)
        val tmp = File(dir, "tmp-${System.nanoTime()}")
        return try {
            dir.mkdirs()
            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            var first = -1
            val input = context.contentResolver.openInputStream(Uri.parse(source)) ?: return null
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

    /** Deletes kept copies older than a day, so the cache does not fill with files that were never opened. */
    private fun sweepCopies(context: Context) {
        try {
            val cutoff = System.currentTimeMillis() - COPY_MAX_AGE_MS
            File(context.cacheDir, COPY_DIR).listFiles()?.forEach { if (it.lastModified() < cutoff) it.delete() }
        } catch (e: Exception) {
            // The next start tries again.
        }
    }
}
