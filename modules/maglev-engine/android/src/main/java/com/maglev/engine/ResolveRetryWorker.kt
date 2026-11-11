package com.maglev.engine

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.SystemClock
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.maglev.engine.service.BackgroundStart
import com.maglev.engine.service.MaglevTorrentService
import java.util.concurrent.TimeUnit

/**
 * SM-37 (contract 20): every hour, with a network, clear `no_peers` so the 10 minute resolve window starts again.
 * Enqueued while any torrent has `health = no_peers`, cancelled when none has.
 */
class ResolveRetryWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        ResolveRetry.retryNow(applicationContext)
        return Result.success()
    }
}

object ResolveRetry {
    private const val TAG = "MaglevResolveRetry"
    const val UNIQUE = "maglev-resolve-retry"
    private const val NETWORK_DEBOUNCE_MS = 30_000L

    @Volatile private var enqueued: Boolean? = null
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var lastNetworkRetryAt = 0L

    /** Called on every telemetry tick. Acts only when the "any no_peers" state changes. */
    fun sync(c: Context, anyNoPeers: Boolean) {
        if (enqueued == anyNoPeers) return
        enqueued = anyNoPeers
        try {
            val wm = WorkManager.getInstance(c)
            if (anyNoPeers) {
                // Periodic work has a 15 minute minimum interval, 1 hour is above it.
                val req = PeriodicWorkRequest.Builder(ResolveRetryWorker::class.java, 1, TimeUnit.HOURS)
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .build()
                wm.enqueueUniquePeriodicWork(UNIQUE, ExistingPeriodicWorkPolicy.KEEP, req)
            } else {
                wm.cancelUniqueWork(UNIQUE)
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not update resolve retry work: ${e.message}")
            enqueued = null
        }
        watchNetwork(c, anyNoPeers)
    }

    /**
     * One retry when a validated network is gained while any torrent is no_peers. Lives as long as this process
     * does: with the app closed and the process gone, the hourly worker is the fallback.
     */
    private fun watchNetwork(c: Context, on: Boolean) {
        val cm = c.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        synchronized(this) {
            if (!on) {
                callback?.let { try { cm.unregisterNetworkCallback(it) } catch (_: Exception) {} }
                callback = null
                return
            }
            if (callback != null) return
            val cb = object : ConnectivityManager.NetworkCallback() {
                private var wasValidated = false
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    val ok = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                    val gained = ok && !wasValidated
                    wasValidated = ok
                    val now = SystemClock.elapsedRealtime()
                    if (gained && now - lastNetworkRetryAt > NETWORK_DEBOUNCE_MS) {
                        lastNetworkRetryAt = now
                        retryNow(c)
                    }
                }

                override fun onLost(network: Network) {
                    wasValidated = false
                }
            }
            try {
                cm.registerDefaultNetworkCallback(cb)
                callback = cb
            } catch (e: Exception) {
                Log.w(TAG, "network callback not registered: ${e.message}")
            }
        }
    }

    /**
     * Clears every no_peers tag. With the service up the engine is running, so it is a direct call. Otherwise the
     * service is started headless; if that is refused (background-start rule) the engine is started in this process.
     */
    fun retryNow(c: Context) {
        EngineHost.attach(c)
        if (MaglevTorrentService.instance != null) {
            EngineHost.resolveRetry()
        } else if (!BackgroundStart.start(c, MaglevTorrentService.ACTION_RESOLVE_RETRY)) {
            EngineHost.resolveRetry()
        }
    }
}
