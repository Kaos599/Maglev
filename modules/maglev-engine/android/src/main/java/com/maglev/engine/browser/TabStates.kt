package com.maglev.engine.browser

import android.os.Bundle

/**
 * 0.35 W-C: the page state of tabs that went to sleep, kept in process memory only (never on disk) and keyed by tab id.
 * A view saves its WebView's back/forward list (WebView.saveState) when it is destroyed and takes it back once, before
 * its first load, when the same tab wakes (WebView.restoreState). Process death loses it, and the tab loads its URL.
 * https://developer.android.com/reference/android/webkit/WebView#saveState(android.os.Bundle)
 * https://developer.android.com/reference/android/webkit/WebView#restoreState(android.os.Bundle)
 *
 * Views call it on the main thread; the module's retain and clear calls come from its own queue, so every method is
 * synchronized.
 */
object TabStates {
    /** What a woken view needs: WebView's own state plus the view's per-tab rules that WebView does not keep. */
    class Saved(
        val bundle: Bundle,
        val typedUrl: String?,
        val typedHost: String?,
        val history: HistoryFlags.Snapshot,
    )

    /** One entry per tab and no more than the tab cap (utils/browser/tabs.ts MAX_TABS); the least recently used goes first. */
    private const val MAX_ENTRIES = 50

    private val states = object : LinkedHashMap<String, Saved>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Saved>?): Boolean = size > MAX_ENTRIES
    }

    /** Replaces any earlier state of [id]. */
    @Synchronized
    fun put(id: String, saved: Saved) {
        states[id] = saved
    }

    /** The saved state of [id], removed from the map: it is used once. Null when there is none. */
    @Synchronized
    fun take(id: String): Saved? = states.remove(id)

    @Synchronized
    fun drop(id: String) {
        states.remove(id)
    }

    /** Keeps only the states of [ids] (the tabs that still exist). A closed tab's state goes here. */
    @Synchronized
    fun retain(ids: Collection<String>) {
        val keep = ids.toHashSet()
        states.keys.retainAll(keep)
    }

    @Synchronized
    fun clear() {
        states.clear()
    }
}
