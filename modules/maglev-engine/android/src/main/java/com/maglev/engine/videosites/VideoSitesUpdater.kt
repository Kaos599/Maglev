package com.maglev.engine.videosites

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Keeps yt-dlp current in the background, with the app open or closed. A read of a video page never waits on
 * this. One unique periodic work, daily, on an unmetered network unless "Update on mobile data" is on. It exists
 * only while "Keep video sites working" is on. While the yt-dlp that runs is not one this app checked and saw run (a
 * fresh install runs the library's built-in copy, which the sites already refuse), one extra update is asked for
 * right away, under the same network rule, instead of waiting up to a day. On mobile data with "Update on mobile
 * data" off, that one waits for Wi-Fi; the add screen says so and offers Update now.
 *
 * WorkManager API: https://developer.android.com/reference/androidx/work/PeriodicWorkRequest.Builder,
 * https://developer.android.com/reference/androidx/work/ExistingPeriodicWorkPolicy,
 * https://developer.android.com/reference/androidx/work/CoroutineWorker
 */
object VideoSitesUpdater {
    const val UNIQUE_PERIODIC = "maglev-video-sites-update"
    const val UNIQUE_SOON = "maglev-video-sites-update-soon"
    private const val PREFS = "maglev_video_sites"
    private const val KEY_MOBILE = "scheduled_mobile"

    /** Schedules the daily work, or cancels it when [enabled] is false. Safe to call often. Never throws. */
    fun apply(c: Context, enabled: Boolean, mobileData: Boolean) {
        try {
            val wm = WorkManager.getInstance(c)
            if (!enabled) {
                wm.cancelUniqueWork(UNIQUE_PERIODIC)
                wm.cancelUniqueWork(UNIQUE_SOON)
                return
            }
            val prefs = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            // KEEP leaves the existing schedule alone. A changed network rule needs UPDATE, which swaps the constraint
            // and keeps the period.
            val changed = !prefs.contains(KEY_MOBILE) || prefs.getBoolean(KEY_MOBILE, false) != mobileData
            val network = Constraints.Builder()
                .setRequiredNetworkType(if (mobileData) NetworkType.CONNECTED else NetworkType.UNMETERED)
                .build()
            val req = PeriodicWorkRequest.Builder(VideoSitesUpdateWorker::class.java, 1, TimeUnit.DAYS)
                .setConstraints(network)
                .build()
            wm.enqueueUniquePeriodicWork(
                UNIQUE_PERIODIC,
                if (changed) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
                req,
            )
            prefs.edit().putBoolean(KEY_MOBILE, mobileData).apply()
            // KEEP: a pending one (waiting for Wi-Fi) stays as it is; a finished one is replaced, so each app start
            // tries again until a download is verified.
            if (VideoSites.needsUpdateSoon(c)) {
                val soon = OneTimeWorkRequest.Builder(VideoSitesUpdateWorker::class.java).setConstraints(network).build()
                wm.enqueueUniqueWork(UNIQUE_SOON, if (changed) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, soon)
            }
        } catch (t: Throwable) {
            Log.w("MaglevVideoSites", "could not schedule the yt-dlp update: ${t.message}")
        }
    }
}

/**
 * Runs [VideoSites.update] off the main thread. A try that failed on the way (no network, GitHub down) is retried
 * twice, then left to tomorrow. A release that failed its test run, or a network rule that forbids the download, is
 * not retried: trying again an hour later would give the same answer.
 */
class VideoSitesUpdateWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val r = VideoSites.update(applicationContext, false)
        val result = YtDlpInstall.readStatus(applicationContext).optString("result", "")
        if (r.status == VideoSites.UPDATE_FAILED && result == VideoSites.RESULT_FAILED && runAttemptCount < 2) Result.retry() else Result.success()
    }
}
