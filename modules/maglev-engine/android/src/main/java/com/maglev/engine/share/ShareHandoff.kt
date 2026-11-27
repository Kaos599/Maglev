package com.maglev.engine.share

import android.content.Context

/**
 * Carries one shared link from the quick share card to the app's JS without making it the start intent of the
 * task. A start intent is replayed whenever Android rebuilds the task (the process died, or the app was updated), which
 * reopened the Add a link screen of a link the user had already dealt with. A link kept here is read once and then gone.
 *
 * It lives in SharedPreferences, not in memory, so it survives the process dying between the card and JS reading it.
 * The card and the module run in the same process, so one lock makes [take] read and clear in a single step.
 */
object ShareHandoff {
    /** A share that was never opened must not pop up later. */
    const val MAX_AGE_MS = 10 * 60 * 1000L

    private const val FILE = "maglev_share_handoff"
    private const val KEY_LINK = "link"
    private const val KEY_AT = "at"

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
        synchronized(lock) {
            val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            val link = prefs.getString(KEY_LINK, null) ?: return null
            val at = prefs.getLong(KEY_AT, 0L)
            prefs.edit().clear().commit()
            val age = System.currentTimeMillis() - at
            return if (link.isNotBlank() && age in 0..MAX_AGE_MS) link else null
        }
    }
}
