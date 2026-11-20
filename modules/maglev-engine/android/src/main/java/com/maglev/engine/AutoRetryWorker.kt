package com.maglev.engine

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.maglev.engine.service.BackgroundStart
import com.maglev.engine.service.MaglevTorrentService
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Retry failed downloads automatically (docs/NATIVE_CONTRACT.md, autoRetry). Link downloads only.
 * One work request per download id, delayed by the user's wait. It runs with the app closed.
 */
class AutoRetryWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val id = inputData.getString(AutoRetry.KEY_ID) ?: return Result.success()
        return if (AutoRetry.fire(applicationContext, id)) Result.success() else Result.retry()
    }
}

object AutoRetry {
    private const val TAG = "MaglevAutoRetry"
    const val KEY_ID = "download_id"
    private const val PREFS = "maglev_autoretry"
    private const val KEY_MODE = "mode"
    private const val KEY_DELAY = "delay_min"
    private const val KEY_ALWAYS = "always"
    private const val ROUNDS_PREFIX = "rounds:"
    private const val WORK_PREFIX = "maglev-auto-retry-"
    /** Without "Keep trying", a download is given up on after this many automatic tries. */
    const val MAX_ROUNDS = 3
    private const val SETTLE_MS = 5_000L
    private val DELAYS = setOf(1, 5, 15, 60)

    /**
     * Error codes worth another try: the network failed, the server stopped sending data, or it answered with a
     * temporary status (408, 429, 500, 502, 503, 504). Everything else needs the user: AUTH_REQUIRED, LINK_REFUSED, LINK_EXPIRED,
     * needs_link, DISK_FULL, STORAGE_UNAVAILABLE, FILE_TOO_LARGE, PERMISSION, FILE_CHANGED, NOT_A_FILE,
     * CHECKSUM_MISMATCH, LAN_ADDRESS, LOCAL_REDIRECT, BLOCKED, UNSUPPORTED, INTERNAL and any other status.
     */
    private val RETRY_STATUSES = setOf(408, 429, 500, 502, 503, 504)

    private val scheduled = ConcurrentHashMap.newKeySet<String>()
    private val rounds = ConcurrentHashMap<String, Int>()
    private val firedAt = ConcurrentHashMap<String, Long>()

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Called from the module's setGovernance. A missing key leaves the saved value alone. */
    fun save(c: Context, rules: Map<String, Any?>) {
        val e = prefs(c).edit()
        (rules["autoRetry"] as? String)?.let { if (it == "off" || it == "after") e.putString(KEY_MODE, it) }
        (rules["autoRetryDelayMin"] as? Number)?.toInt()?.let { if (it in DELAYS) e.putInt(KEY_DELAY, it) }
        if (rules.containsKey("autoRetryAlways")) e.putBoolean(KEY_ALWAYS, rules["autoRetryAlways"] == true)
        e.apply()
    }

    /** On by default, like the setting. */
    fun enabled(c: Context): Boolean = prefs(c).getString(KEY_MODE, "after") != "off"
    fun delayMin(c: Context): Int = prefs(c).getInt(KEY_DELAY, 5)
    fun always(c: Context): Boolean = prefs(c).getBoolean(KEY_ALWAYS, false)

    /** True when [d] (a native download record) is in `error` with a code that is worth retrying. */
    fun retryable(d: Map<String, Any?>): Boolean {
        if (d["state"] != "error") return false
        val err = d["error"] as? Map<*, *> ?: return false
        return when (err["code"]) {
            "NETWORK", "STALLED" -> true
            "HTTP_STATUS" -> ((err["http_status"] as? Number)?.toInt() ?: -1) in RETRY_STATUSES
            else -> false
        }
    }

    private fun roundsOf(c: Context, id: String): Int =
        rounds.getOrPut(id) { prefs(c).getInt(ROUNDS_PREFIX + id, 0) }

    private fun setRounds(c: Context, id: String, n: Int) {
        rounds[id] = n
        if (n == 0) prefs(c).edit().remove(ROUNDS_PREFIX + id).apply() else prefs(c).edit().putInt(ROUNDS_PREFIX + id, n).apply()
    }

    /** The user retried by hand, so the count starts again. */
    fun reset(c: Context, id: String) {
        setRounds(c, id, 0)
        cancel(c, id)
    }

    private fun cancel(c: Context, id: String) {
        scheduled.remove(id)
        try {
            WorkManager.getInstance(c).cancelUniqueWork(WORK_PREFIX + id)
        } catch (e: Exception) {
            Log.w(TAG, "could not cancel retry: ${e.message}")
        }
    }

    /** Called on every telemetry tick with the link downloads. Acts only on changes. */
    fun onDownloads(c: Context, downloads: List<Map<String, Any?>>) {
        if (!enabled(c)) {
            if (scheduled.isNotEmpty()) scheduled.toList().forEach { cancel(c, it) }
            return
        }
        val live = HashSet<String>()
        val now = android.os.SystemClock.elapsedRealtime()
        for (d in downloads) {
            val id = d["id"] as? String ?: continue
            live.add(id)
            when {
                d["state"] == "finished" -> {
                    if (rounds.containsKey(id) || scheduled.contains(id)) { setRounds(c, id, 0); cancel(c, id) }
                }
                retryable(d) -> {
                    if (scheduled.contains(id)) continue
                    if (now - (firedAt[id] ?: 0L) < SETTLE_MS) continue
                    if (!always(c) && roundsOf(c, id) >= MAX_ROUNDS) continue
                    schedule(c, id)
                }
                else -> if (scheduled.contains(id)) cancel(c, id)
            }
        }
        // A removed download leaves no work behind.
        for (id in scheduled.toList()) if (id !in live) cancel(c, id)
    }

    private fun schedule(c: Context, id: String) {
        try {
            val req = OneTimeWorkRequest.Builder(AutoRetryWorker::class.java)
                .setInitialDelay(delayMin(c).toLong(), TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInputData(Data.Builder().putString(KEY_ID, id).build())
                .build()
            WorkManager.getInstance(c).enqueueUniqueWork(WORK_PREFIX + id, ExistingWorkPolicy.KEEP, req)
            scheduled.add(id)
        } catch (e: Exception) {
            Log.w(TAG, "could not schedule retry: ${e.message}")
        }
    }

    /** Counts the try that is about to start. */
    fun countRound(c: Context, id: String) {
        firedAt[id] = android.os.SystemClock.elapsedRealtime()
        scheduled.remove(id)
        setRounds(c, id, roundsOf(c, id) + 1)
    }

    /** Forgets a download that is gone. */
    fun forget(c: Context, id: String) {
        setRounds(c, id, 0)
        cancel(c, id)
    }

    /**
     * The worker's entry. True when the work is done (retried, or nothing to do); false to try again later, which
     * is what a Wi-Fi only or VPN rule asks for. With the service down the engine is started in this process, and the
     * service is started so the download keeps going after the worker ends.
     */
    suspend fun fire(c: Context, id: String): Boolean {
        EngineHost.attach(c)
        scheduled.remove(id)
        val retried = EngineHost.autoRetryDownload(id) ?: return false
        if (retried && MaglevTorrentService.instance == null) {
            BackgroundStart.start(c, MaglevTorrentService.ACTION_RESOLVE_RETRY)
        }
        return true
    }
}
