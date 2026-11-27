package com.maglev.engine.lists

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.maglev.engine.browser.BlocklistException
import com.maglev.engine.browser.BlocklistStore
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray

/**
 * Keeps the ad block list current with Maglev closed: once a day, on an unmetered network (the same rule as the
 * app's own daily check, which never spends mobile data on the list). It exists only while "Update lists
 * automatically" is on. The app sends the list addresses here whenever they change, because the job runs without
 * the JavaScript side and reads them from SharedPreferences.
 *
 * The update itself is [BlocklistStore.update] with conditional requests, so an unchanged list costs one small
 * request per address, and a failed or cut-short download leaves the list in use as it is. Wi-Fi only and VPN only
 * are checked there too.
 *
 * WorkManager: https://developer.android.com/reference/androidx/work/PeriodicWorkRequest.Builder,
 * https://developer.android.com/reference/androidx/work/NetworkType#UNMETERED,
 * https://developer.android.com/reference/androidx/work/ExistingPeriodicWorkPolicy#KEEP
 */
object ListsUpdater {
    const val UNIQUE = "maglev-lists-update"
    private const val PREFS = "maglev_lists_work"
    private const val KEY_URLS = "urls"

    /** Schedules the daily job with these addresses, or cancels it. Safe to call often. Never throws. */
    fun apply(context: Context, enabled: Boolean, urls: List<String>) {
        try {
            val wm = WorkManager.getInstance(context)
            val clean = urls.map { it.trim() }.filter { it.startsWith("https://", ignoreCase = true) }.distinct()
            if (!enabled || clean.isEmpty()) {
                wm.cancelUniqueWork(UNIQUE)
                return
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_URLS, JSONArray(clean).toString()).apply()
            val req = PeriodicWorkRequest.Builder(ListsUpdateWorker::class.java, 1, TimeUnit.DAYS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build())
                .build()
            // KEEP leaves the running schedule alone; the addresses are read when the job runs.
            wm.enqueueUniquePeriodicWork(UNIQUE, ExistingPeriodicWorkPolicy.KEEP, req)
        } catch (t: Throwable) {
            Log.w("MaglevLists", "could not schedule the list update: ${t.message}")
        }
    }

    fun urls(context: Context): List<String> = try {
        val a = JSONArray(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_URLS, "[]") ?: "[]")
        (0 until a.length()).map { a.getString(it) }
    } catch (t: Throwable) {
        emptyList()
    }
}

/** One daily try. No network or a server error is retried twice; a list that fails its checks waits for tomorrow. */
class ListsUpdateWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val urls = ListsUpdater.urls(applicationContext)
        if (urls.isEmpty()) return@withContext Result.success()
        try {
            val info = BlocklistStore.update(applicationContext, urls, conditional = true)
            Log.i("MaglevLists", "background list check: ${if (info.changed) "updated, ${info.domains} domains" else "unchanged"}")
            Result.success()
        } catch (e: BlocklistException) {
            Log.w("MaglevLists", "background list check failed: ${e.code} ${e.message}")
            if ((e.code == "NETWORK" || e.code == "HTTP_STATUS") && runAttemptCount < 2) Result.retry() else Result.success()
        } catch (t: Throwable) {
            Log.w("MaglevLists", "background list check failed: ${t.message}")
            Result.success()
        }
    }
}
