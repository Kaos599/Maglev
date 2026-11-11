package com.maglev.engine.feeds

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import com.maglev.engine.EngineHost
import java.util.concurrent.TimeUnit

/** Schedules the unique periodic `maglev-feeds` work (contract 11.6). */
object FeedScheduler {
    const val UNIQUE_PERIODIC = "maglev-feeds"
    const val UNIQUE_NOW = "maglev-feeds-now"

    private fun constraints(c: Context): Constraints {
        val wifiOnly = c.getSharedPreferences(EngineHost.GOV_PREFS, Context.MODE_PRIVATE).getBoolean("wifiOnly", false)
        return Constraints.Builder()
            .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
            .build()
    }

    /** Enqueues or updates the periodic work, or cancels it when automation is off. Safe to call often. */
    fun apply(c: Context) {
        try {
            val wm = WorkManager.getInstance(c)
            val cfg = FeedStore.config(c)
            if (!cfg.enabled) {
                wm.cancelUniqueWork(UNIQUE_PERIODIC)
                return
            }
            val req = PeriodicWorkRequest.Builder(FeedWorker::class.java, cfg.intervalMins.toLong(), TimeUnit.MINUTES)
                .setConstraints(constraints(c))
                .build()
            wm.enqueueUniquePeriodicWork(UNIQUE_PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, req)
        } catch (e: Exception) {
            android.util.Log.w("MaglevFeeds", "could not schedule feeds: ${e.message}")
        }
    }

    fun runNow(c: Context): Boolean = try {
        val req = OneTimeWorkRequest.Builder(FeedWorker::class.java).setConstraints(constraints(c)).build()
        WorkManager.getInstance(c).enqueueUniqueWork(UNIQUE_NOW, ExistingWorkPolicy.REPLACE, req)
        true
    } catch (e: Exception) {
        false
    }
}
