package com.maglev.engine.videosites

import android.content.Context
import android.net.ConnectivityManager
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
 * Keeps yt-dlp current in the background. A resolve waits on an update only while the library's built-in copy still
 * runs ([VideoSites.resolve]). One unique periodic work, daily, on an unmetered network unless "Update on mobile data" is on. It exists
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
    private const val KEY_AUTO_ON = "auto_on"
    private const val KEY_MOBILE_ON = "mobile_on"

    /**
     * May an update run now, on the user's choices? "Keep video sites working" on (the default), and an unmetered
     * network unless "Update on mobile data" is on. Before the app has passed the choices, the defaults apply.
     */
    fun allowedNow(c: Context): Boolean = try {
        val prefs = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val auto = prefs.getBoolean(KEY_AUTO_ON, true)
        val mobile = prefs.getBoolean(KEY_MOBILE_ON, false)
        val cm = c.getSystemService(ConnectivityManager::class.java)
        auto && cm?.activeNetwork != null && (mobile || !cm.isActiveNetworkMetered)
    } catch (t: Throwable) {
        false
    }

    /** Schedules the daily work, or cancels it when [enabled] is false. Safe to call often. Never throws. */
    fun apply(c: Context, enabled: Boolean, mobileData: Boolean) {
        try {
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_AUTO_ON, enabled).putBoolean(KEY_MOBILE_ON, mobileData).apply()
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
