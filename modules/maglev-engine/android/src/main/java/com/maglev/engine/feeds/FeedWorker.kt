package com.maglev.engine.feeds

import android.content.Context
import android.util.Log
import android.util.Xml
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.maglev.engine.service.BackgroundStart
import com.maglev.engine.service.MaglevTorrentService
import com.maglev.engine.service.Notifications
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Fetches feeds, matches rules and queues adds (contract section 11.6). Runs with the app closed.
 * Never throws: a bad feed sets lastError and the other feeds still run.
 */
class FeedWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG = "MaglevFeeds"
        private const val TIMEOUT_MS = 15_000
        private const val MAX_BYTES = 2 * 1024 * 1024

        /** Downloads at most [MAX_BYTES]. Returns null on any failure or when the cap is exceeded. */
        fun fetch(url: String): ByteArray? {
            var conn: HttpURLConnection? = null
            return try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = TIMEOUT_MS
                    readTimeout = TIMEOUT_MS
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", "Maglev")
                }
                if (conn.responseCode !in 200..299) return null
                val out = java.io.ByteArrayOutputStream()
                val buf = ByteArray(16 * 1024)
                conn.inputStream.use { input ->
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        if (out.size() > MAX_BYTES) return null
                    }
                }
                out.toByteArray()
            } catch (e: Exception) {
                null
            } finally {
                conn?.disconnect()
            }
        }

        fun parse(bytes: ByteArray): List<FeedItem>? = try {
            val p = Xml.newPullParser()
            p.setInput(ByteArrayInputStream(bytes), null)
            FeedParser.parse(p)
        } catch (e: Exception) {
            null
        }
    }

    override suspend fun doWork(): Result {
        val c = applicationContext
        val cfg = FeedStore.config(c)
        if (!cfg.enabled) return Result.success()
        var error: String? = null
        val queued = ArrayList<PendingAdd>()
        for (feed in cfg.feeds) {
            try {
                val bytes = fetch(feed.url)
                val items = bytes?.let { parse(it) }
                if (items == null) {
                    error = "Could not read ${feed.name}."
                    continue
                }
                queued.addAll(process(c, cfg, feed, items))
            } catch (t: Throwable) {
                Log.w(TAG, "feed ${feed.id} failed", t)
                error = "Could not read ${feed.name}."
            }
        }
        FeedStore.recordRun(c, error, 0)
        FeedStore.enqueue(c, queued)
        if (FeedStore.pending(c).isNotEmpty()) startDrain(c, queued)
        return Result.success()
    }

    /** Applies the seen-set and the rules to one feed. Returns the new matches. */
    private fun process(c: Context, cfg: FeedConfig, feed: FeedSource, items: List<FeedItem>): List<PendingAdd> {
        val seen = FeedStore.seen(c, feed.id)
        val keys = items.map { FeedStore.seenKey(feed.id, it) }
        if (seen == null) {
            // First fetch of a feed: remember everything, add nothing.
            FeedStore.saveSeen(c, feed.id, keys)
            return emptyList()
        }
        val seenSet = HashSet(seen)
        val rules = cfg.rules.filter { it.enabled && (it.feedIds.isEmpty() || it.feedIds.contains(feed.id)) }
        val episodes = HashMap<String, MutableSet<String>>()
        val out = ArrayList<PendingAdd>()
        // Feeds list newest first. Walk oldest first so "new_only" keeps the earliest release of an episode.
        for (i in items.indices.reversed()) {
            val item = items[i]
            val key = keys[i]
            if (seenSet.contains(key)) continue
            seen.add(key)
            val source = item.source ?: continue
            for (rule in rules) {
                val eps = episodes.getOrPut(rule.id) { FeedStore.seenEpisodes(c, rule.id) }
                if (!FeedRuleMatcher.matches(rule, item.title, eps)) continue
                FeedRuleMatcher.episodeKey(item.title)?.let { eps.add(it) }
                out.add(PendingAdd(feed.id, rule.id, rule.name, item.title, source, rule.startPaused))
                break
            }
        }
        FeedStore.saveSeen(c, feed.id, seen)
        for ((ruleId, eps) in episodes) FeedStore.saveSeenEpisodes(c, ruleId, eps)
        return out
    }

    /** Background-start rule: a refused start becomes a "Tap to download." notification per rule. */
    private fun startDrain(c: Context, justQueued: List<PendingAdd>) {
        if (BackgroundStart.start(c, MaglevTorrentService.ACTION_DRAIN_FEED_ADDS)) return
        val all = FeedStore.pending(c)
        for ((ruleId, group) in all.groupBy { it.ruleId }) {
            Notifications.notifyFeedMatches(c, ruleId, group.first().ruleName, group.size)
        }
    }
}
