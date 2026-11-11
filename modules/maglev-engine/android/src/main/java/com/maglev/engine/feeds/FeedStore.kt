package com.maglev.engine.feeds

import android.content.Context
import com.maglev.engine.util.Json
import org.json.JSONArray

/** A match waiting to be added through the engine. */
data class PendingAdd(val feedId: String, val ruleId: String, val ruleName: String, val title: String, val source: String, val startPaused: Boolean)

/** SharedPreferences `maglev_feeds`: config, seen sets, pending-add queue and run status (contract 11.6). */
object FeedStore {
    const val PREFS = "maglev_feeds"
    private const val KEY_CONFIG = "config"
    private const val KEY_PENDING = "pending"
    private const val KEY_LAST_RUN = "lastRunAt"
    private const val KEY_LAST_ERROR = "lastError"
    private const val KEY_ADDED = "addedTotal"
    const val SEEN_CAP = 1000

    private val lock = Any()

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun config(c: Context): FeedConfig = try {
        val t = prefs(c).getString(KEY_CONFIG, null)
        if (t == null) FeedConfig.DISABLED else FeedConfig.fromMap(Json.parseObject(t))
    } catch (e: Exception) {
        FeedConfig.DISABLED
    }

    /** Stores the raw JS config as given, so nothing is lost between versions. */
    fun setConfig(c: Context, raw: Map<String, Any?>): FeedConfig {
        prefs(c).edit().putString(KEY_CONFIG, Json.toJson(raw)).apply()
        return FeedConfig.fromMap(raw)
    }

    // region seen items. Ordered JSON array of keys, newest last, capped.

    /** Null means the feed was never fetched (first fetch marks everything as seen). */
    fun seen(c: Context, feedId: String): MutableList<String>? {
        val t = prefs(c).getString("seen_$feedId", null) ?: return null
        return try {
            val a = JSONArray(t)
            MutableList(a.length()) { a.getString(it) }
        } catch (e: Exception) {
            mutableListOf()
        }
    }

    fun saveSeen(c: Context, feedId: String, keys: List<String>) {
        val capped = if (keys.size > SEEN_CAP) keys.subList(keys.size - SEEN_CAP, keys.size) else keys
        prefs(c).edit().putString("seen_$feedId", JSONArray(capped).toString()).apply()
    }

    fun seenKey(feedId: String, item: FeedItem) = feedId + "|" + item.guid

    fun seenEpisodes(c: Context, ruleId: String): MutableSet<String> =
        HashSet(prefs(c).getStringSet("eps_$ruleId", emptySet()) ?: emptySet())

    fun saveSeenEpisodes(c: Context, ruleId: String, eps: Set<String>) {
        prefs(c).edit().putStringSet("eps_$ruleId", HashSet(eps)).apply()
    }

    // endregion

    // region pending queue

    fun pending(c: Context): List<PendingAdd> = synchronized(lock) { readPending(c) }

    private fun readPending(c: Context): List<PendingAdd> = try {
        val a = JSONArray(prefs(c).getString(KEY_PENDING, "[]"))
        (0 until a.length()).map {
            val o = a.getJSONObject(it)
            PendingAdd(
                o.optString("feedId"), o.optString("ruleId"), o.optString("ruleName"),
                o.optString("title"), o.getString("source"), o.optBoolean("startPaused"),
            )
        }
    } catch (e: Exception) {
        emptyList()
    }

    private fun writePending(c: Context, list: List<PendingAdd>) {
        val a = JSONArray()
        for (p in list) {
            a.put(
                org.json.JSONObject().put("feedId", p.feedId).put("ruleId", p.ruleId).put("ruleName", p.ruleName)
                    .put("title", p.title).put("source", p.source).put("startPaused", p.startPaused),
            )
        }
        prefs(c).edit().putString(KEY_PENDING, a.toString()).apply()
    }

    fun enqueue(c: Context, items: List<PendingAdd>) {
        if (items.isEmpty()) return
        synchronized(lock) { writePending(c, readPending(c) + items) }
    }

    /** Removes [done] entries (by source) from the queue. Entries added meanwhile stay. */
    fun remove(c: Context, done: Collection<PendingAdd>) {
        if (done.isEmpty()) return
        synchronized(lock) {
            val sources = done.map { it.ruleId + "|" + it.source }.toSet()
            writePending(c, readPending(c).filterNot { sources.contains(it.ruleId + "|" + it.source) })
        }
    }

    // endregion

    fun recordRun(c: Context, error: String?, added: Int) {
        val p = prefs(c)
        p.edit().putLong(KEY_LAST_RUN, System.currentTimeMillis()).putString(KEY_LAST_ERROR, error)
            .putInt(KEY_ADDED, p.getInt(KEY_ADDED, 0) + added).apply()
    }

    fun addedDone(c: Context, n: Int) {
        if (n <= 0) return
        val p = prefs(c)
        p.edit().putInt(KEY_ADDED, p.getInt(KEY_ADDED, 0) + n).apply()
    }

    fun status(c: Context): Map<String, Any?> {
        val p = prefs(c)
        return linkedMapOf(
            "ok" to true,
            "lastRunAt" to (if (p.contains(KEY_LAST_RUN)) p.getLong(KEY_LAST_RUN, 0L) else null),
            "lastError" to p.getString(KEY_LAST_ERROR, null),
            "addedTotal" to p.getInt(KEY_ADDED, 0),
            "pending" to pending(c).size,
        )
    }
}
