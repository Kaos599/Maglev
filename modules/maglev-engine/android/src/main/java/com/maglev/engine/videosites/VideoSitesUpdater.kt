package com.maglev.engine.videosites

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Keeps yt-dlp current in the background (docs/contracts-0.34/browser.md section 7, rule 2). A resolve never waits on
 * an update. One unique periodic work, daily, on an unmetered network unless "Update on mobile data" is on. It exists
 * only while "Keep video sites working" is on.
 *
 * WorkManager API: https://developer.android.com/reference/androidx/work/PeriodicWorkRequest.Builder,
 * https://developer.android.com/reference/androidx/work/ExistingPeriodicWorkPolicy,
 * https://developer.android.com/reference/androidx/work/CoroutineWorker
 */
object VideoSitesUpdater {
    const val UNIQUE_PERIODIC = "maglev-video-sites-update"
    private const val PREFS = "maglev_video_sites"
    private const val KEY_MOBILE = "scheduled_mobile"

    /** Schedules the daily work, or cancels it when [enabled] is false. Safe to call often. Never throws. */
    fun apply(c: Context, enabled: Boolean, mobileData: Boolean) {
        try {
            val wm = WorkManager.getInstance(c)
            if (!enabled) {
                wm.cancelUniqueWork(UNIQUE_PERIODIC)
                return
            }
            val prefs = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            // KEEP leaves the existing schedule alone. A changed network rule needs UPDATE, which swaps the constraint
            // and keeps the period.
            val changed = !prefs.contains(KEY_MOBILE) || prefs.getBoolean(KEY_MOBILE, false) != mobileData
            val req = PeriodicWorkRequest.Builder(VideoSitesUpdateWorker::class.java, 1, TimeUnit.DAYS)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(if (mobileData) NetworkType.CONNECTED else NetworkType.UNMETERED)
                        .build(),
                )
                .build()
            wm.enqueueUniquePeriodicWork(
                UNIQUE_PERIODIC,
                if (changed) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
                req,
            )
            prefs.edit().putBoolean(KEY_MOBILE, mobileData).apply()
        } catch (t: Throwable) {
            Log.w("MaglevVideoSites", "could not schedule the yt-dlp update: ${t.message}")
        }
    }
}

/** Runs [VideoSites.update] off the main thread. A failed try (no network) is retried twice, then left to tomorrow. */
class VideoSitesUpdateWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val r = VideoSites.update(applicationContext, false)
        if (r.status == VideoSites.UPDATE_FAILED && runAttemptCount < 2) Result.retry() else Result.success()
    }
}
