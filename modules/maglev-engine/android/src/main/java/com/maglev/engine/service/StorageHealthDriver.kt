package com.maglev.engine.service

import android.app.ActivityManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.StatFs
import android.util.Log
import androidx.core.content.ContextCompat
import com.maglev.engine.EngineHost
import kotlinx.coroutines.launch
import java.io.File

/**
 * Android side of SM-33 and the background half of SM-36 (contract 18.5).
 * [onTelemetry] runs on every poll. The media receiver is registered only while the service runs.
 * Decisions live in [StorageHealth] and [ErrorNotice].
 */
object StorageHealthDriver {
    private const val TAG = "MaglevStorageHealth"

    @Volatile private var latest: List<HealthTorrent> = emptyList()
    @Volatile private var receiver: BroadcastReceiver? = null
    private val lock = Any()
    private var lastFreePollAt = 0L
    private var shownFull = -1
    private var shownGone = -1
    private val seenState = HashMap<String, String?>()

    /** Registers the volume receiver. ACTION_MEDIA_* are broadcast with a `file:` data URI, so the filter needs scheme "file". */
    fun start(context: Context) {
        if (receiver != null) return
        val c = context.applicationContext
        val rcv = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                onMedia(ctx, intent.action, intent.data?.path)
            }
        }
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_MEDIA_UNMOUNTED)
            addAction(Intent.ACTION_MEDIA_EJECT)
            addAction(Intent.ACTION_MEDIA_MOUNTED)
            addDataScheme("file")
        }
        try {
            ContextCompat.registerReceiver(c, rcv, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
            receiver = rcv
        } catch (e: Exception) {
            Log.w(TAG, "media receiver not registered: ${e.message}")
        }
    }

    fun stop(context: Context) {
        val rcv = receiver ?: return
        receiver = null
        try {
            context.applicationContext.unregisterReceiver(rcv)
        } catch (_: Exception) {
        }
    }

    private fun onMedia(c: Context, action: String?, volumeRoot: String?) {
        val torrents = latest
        val ids = when (action) {
            Intent.ACTION_MEDIA_UNMOUNTED, Intent.ACTION_MEDIA_EJECT -> StorageHealth.unmountTargets(torrents, volumeRoot)
            Intent.ACTION_MEDIA_MOUNTED -> StorageHealth.mountTargets(torrents, volumeRoot)
            else -> emptyList()
        }
        if (ids.isEmpty()) return
        val tag = if (action == Intent.ACTION_MEDIA_MOUNTED) "" else StorageHealth.UNAVAILABLE
        EngineHost.scope.launch { ids.forEach { EngineHost.setHealth(it, tag) } }
    }

    /** Called from the poll thread with the raw snapshot maps (snake_case). */
    fun onTelemetry(c: Context, raw: List<Map<String, Any?>>) {
        val torrents = raw.mapNotNull { HealthTorrent.from(it) }
        latest = torrents
        notifyErrors(c, torrents)
        syncNotifications(c, torrents)
        pollFreeSpace(torrents)
        guardReserve()
    }

    @Volatile private var reserveBlocked = false
    private var lastGuardAt = 0L

    /**
     * Proactive low-storage protection (docs/contracts-0.19/play-and-storage.md section 2). Every 15 s reads free and
     * total bytes of the download target and applies [StorageGuard.next]. A change is sent as the governance tag
     * `storage_full`, which pauses unfinished transfers with that reason and resumes only those carrying it.
     * Unknown free space changes nothing.
     */
    private fun guardReserve() {
        val now = android.os.SystemClock.elapsedRealtime()
        synchronized(lock) {
            if (lastGuardAt != 0L && now - lastGuardAt < StorageGuard.POLL_MS) return
            lastGuardAt = now
        }
        EngineHost.ioScope.launch {
            val fs = EngineHost.freeSpace()
            if (fs["ok"] != true) return@launch
            val own = (fs["freeBytes"] as? Number)?.toLong() ?: return@launch
            val total = (fs["totalBytes"] as? Number)?.toLong() ?: 0L
            // Staged copies need room on both volumes: the smaller free space is what writes can use.
            val target = (fs["targetFreeBytes"] as? Number)?.toLong()
            val free = if (target != null) minOf(own, target) else own
            val next = StorageGuard.next(reserveBlocked, free, total)
            if (next != reserveBlocked) {
                reserveBlocked = next
                EngineHost.setStorageReserveBlocked(next)
            }
        }
    }

    /** SM-36: one notification on the edge into ERROR while the app is not in front. */
    private fun notifyErrors(c: Context, torrents: List<HealthTorrent>) {
        val inFront = appInFront(c)
        val fire = ArrayList<HealthTorrent>()
        synchronized(seenState) {
            for (t in torrents) {
                if (ErrorNotice.shouldNotify(seenState[t.id], t.state, seenState.containsKey(t.id), inFront)) fire.add(t)
                seenState[t.id] = t.state
            }
            seenState.keys.retainAll(torrents.map { it.id }.toSet())
        }
        fire.forEach { Notifications.notifyTorrentError(c, it.id, ErrorNotice.title(it.name, it.errorCode)) }
    }

    /** Grouped notifications on maglev_reminders. Posted when the count changes, cancelled at 0. */
    private fun syncNotifications(c: Context, torrents: List<HealthTorrent>) {
        val full = StorageHealth.countPaused(torrents, StorageHealth.FULL)
        val gone = StorageHealth.countPaused(torrents, StorageHealth.UNAVAILABLE)
        if (full != shownFull) {
            shownFull = full
            if (full > 0) Notifications.notifyStorage(c, Notifications.ID_STORAGE_FULL, StorageHealth.fullTitle(full))
            else Notifications.cancel(c, Notifications.ID_STORAGE_FULL)
        }
        if (gone != shownGone) {
            shownGone = gone
            if (gone > 0) Notifications.notifyStorage(c, Notifications.ID_SD_REMOVED, StorageHealth.removedTitle(gone))
            else Notifications.cancel(c, Notifications.ID_SD_REMOVED)
        }
    }

    /** Every 60 s while any torrent is storage_full: clear the tag where the folder has room again. */
    private fun pollFreeSpace(torrents: List<HealthTorrent>) {
        if (torrents.none { it.health == StorageHealth.FULL }) return
        val now = android.os.SystemClock.elapsedRealtime()
        synchronized(lock) {
            if (lastFreePollAt != 0L && now - lastFreePollAt < StorageHealth.POLL_MS) return
            lastFreePollAt = now
        }
        EngineHost.ioScope.launch {
            val ids = StorageHealth.recoveryTargets(torrents, ::freeBytes)
            if (ids.isNotEmpty()) EngineHost.scope.launch { ids.forEach { EngineHost.setHealth(it, "") } }
        }
    }

    /** Free bytes of the nearest existing parent of [folder], or null when it cannot be read. */
    private fun freeBytes(folder: String): Long? = try {
        var f: File? = File(folder)
        while (f != null && !f.exists()) f = f.parentFile
        f?.let { StatFs(it.path).availableBytes }
    } catch (_: Exception) {
        null
    }

    /**
     * True only when this process has a visible activity. A foreground service alone ranks lower than
     * IMPORTANCE_FOREGROUND, so it counts as "not in front".
     * https://developer.android.com/reference/android/app/ActivityManager#getMyMemoryState(android.app.ActivityManager.RunningAppProcessInfo)
     */
    private fun appInFront(c: Context): Boolean = try {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    } catch (_: Exception) {
        false
    }
}
