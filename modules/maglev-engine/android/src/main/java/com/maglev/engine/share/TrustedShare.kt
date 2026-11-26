package com.maglev.engine.share

/**
 * Remembers the one link the quick share card is about to hand to the app, so the add screen can tell a real share
 * from a maglev://add-download link that a web page or another app opened. Only this process can set it, and a link
 * can be taken once, within [WINDOW_MS] of being recorded.
 */
object TrustedShare {
    private const val WINDOW_MS = 60_000L

    private val lock = Any()
    private var link: String? = null
    private var recordedAt = 0L

    /** Called by the quick share card just before it opens the app for [url]. */
    fun record(url: String) {
        synchronized(lock) {
            link = url.trim()
            recordedAt = System.currentTimeMillis()
        }
    }

    /** True once for the recorded link, if [url] matches it and it is fresh, then forgets it. */
    fun consume(url: String): Boolean {
        synchronized(lock) {
            val stored = link
            val fresh = System.currentTimeMillis() - recordedAt in 0..WINDOW_MS
            val ok = stored != null && fresh && stored == url.trim()
            if (ok) link = null
            return ok
        }
    }
}
