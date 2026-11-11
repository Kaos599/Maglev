package com.maglev.engine

import android.content.Context
import android.os.Build
import android.util.Log
import com.maglev.engine.feeds.FeedScheduler
import com.maglev.engine.schedule.ScheduleManager
import com.maglev.engine.service.BackgroundStart
import com.maglev.engine.service.MaglevTorrentService
import com.maglev.engine.service.Notifications

enum class RestartEntryKind { BootCompleted, PackageReplaced, StickyRestart, AppOpen }

/** What an entry point must do besides re-arming the alarm and the feed worker, which always happens. */
data class RestartPlan(
    /** Try a headless foreground start. */
    val start: Boolean,
    /** Post the "Tap to continue" reminder when no start happened (not tried, or refused). */
    val remind: Boolean,
)

/** Pure decision for SM-34 (contract 19). No android.* imports. */
object RestartEntryPolicy {
    /** Android 15 stops BOOT_COMPLETED receivers from starting dataSync services (NATIVE_CONTRACT 8). Older releases allow it. */
    fun canStartFromBoot(useSpecialUse: Boolean, sdk: Int): Boolean = useSpecialUse || sdk < 35

    fun plan(
        kind: RestartEntryKind,
        input: RestartInput,
        resumeAfterRestart: Boolean,
        useSpecialUse: Boolean,
        sdk: Int,
    ): RestartPlan {
        // A sticky restart already runs inside the service, and AppOpen has its own check.
        if (kind == RestartEntryKind.StickyRestart || kind == RestartEntryKind.AppOpen) return RestartPlan(false, false)
        if (RestartPolicy.decide(input) == RestartDecision.StayStopped || !resumeAfterRestart) return RestartPlan(false, false)
        return RestartPlan(start = canStartFromBoot(useSpecialUse, sdk), remind = true)
    }

    fun reminderTitle(count: Int): String = when {
        count == 1 -> "Tap to continue 1 download"
        count > 1 -> "Tap to continue $count downloads"
        else -> "Tap to continue your downloads"
    }

    /** Heartbeat gap above which Android is assumed to have killed the process. */
    const val GAP_MS = 2 * 60_000L

    /** SM-34 AppOpen row: gap > 2 min, the last state was running, and the service is not running now. */
    fun shouldShowStoppedNotice(nowMs: Long, heartbeatAtMs: Long, wasRunning: Boolean, serviceRunning: Boolean): Boolean =
        heartbeatAtMs > 0L && nowMs - heartbeatAtMs > GAP_MS && wasRunning && !serviceRunning
}

/** SharedPreferences keys read headless. The literals match the private constants in EngineHost. */
object RestartPrefs {
    const val ENGINE = "maglev_engine"
    const val GOV = "maglev_governance"
    const val KEY_USER_SHUTDOWN = "user_shutdown"
    const val KEY_USER_PAUSED_ALL = "user_paused_all"
    const val KEY_WANTED = "service_wanted"
    const val KEY_LAST_ACTIVE = "lastActiveCount"
    const val KEY_HEARTBEAT = "heartbeat_at"
    const val KEY_RESUME_AFTER_RESTART = "resumeAfterRestart"
    private const val HEARTBEAT_EVERY_MS = 10_000L

    @Volatile private var lastBeat = 0L

    fun resumeAfterRestart(c: Context): Boolean =
        c.getSharedPreferences(GOV, Context.MODE_PRIVATE).getBoolean(KEY_RESUME_AFTER_RESTART, true)

    /** For the module's setGovernance, once JS pushes the setting. */
    fun setResumeAfterRestart(c: Context, value: Boolean) {
        c.getSharedPreferences(GOV, Context.MODE_PRIVATE).edit().putBoolean(KEY_RESUME_AFTER_RESTART, value).apply()
    }

    /** Called on every telemetry tick: the heartbeat (throttled to 10 s) and [KEY_LAST_ACTIVE] when it changes. */
    fun recordTick(c: Context, activeCount: Int) {
        val p = c.getSharedPreferences(ENGINE, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val e = p.edit()
        var dirty = false
        if (now - lastBeat >= HEARTBEAT_EVERY_MS) { lastBeat = now; e.putLong(KEY_HEARTBEAT, now); dirty = true }
        if (p.getInt(KEY_LAST_ACTIVE, Int.MIN_VALUE) != activeCount) { e.putInt(KEY_LAST_ACTIVE, activeCount); dirty = true }
        if (dirty) e.apply()
    }

    /** Persisted intent plus the last known active count. A missing count (older install) is UNKNOWN. */
    fun input(c: Context): RestartInput {
        val p = c.getSharedPreferences(ENGINE, Context.MODE_PRIVATE)
        return RestartInput(
            userShutdown = p.getBoolean(KEY_USER_SHUTDOWN, false),
            userPausedAll = p.getBoolean(KEY_USER_PAUSED_ALL, false),
            scheduleHeld = ScheduleManager.isHeld(c),
            activeTorrents = if (p.contains(KEY_LAST_ACTIVE)) p.getInt(KEY_LAST_ACTIVE, 0) else RestartPolicy.UNKNOWN_COUNT,
        )
    }
}

/** Android side of SM-34. Every entry point (boot, package update, sticky restart) runs [run]. */
object RestartEntry {
    private const val TAG = "MaglevRestart"
    const val STOPPED_NOTICE = "Maglev was stopped by Android. Downloads resumed."

    fun run(context: Context, kind: RestartEntryKind) {
        val c = context.applicationContext
        try {
            EngineHost.attach(c)
            ScheduleManager.rearm(c)
            FeedScheduler.apply(c)
            val input = RestartPrefs.input(c)
            val plan = RestartEntryPolicy.plan(
                kind, input, RestartPrefs.resumeAfterRestart(c),
                MaglevTorrentService.USE_SPECIAL_USE_FGS, Build.VERSION.SDK_INT,
            )
            val started = plan.start && BackgroundStart.start(c, MaglevTorrentService.ACTION_RESTART)
            if (plan.remind && !started) Notifications.notifyContinue(c, input.activeTorrents)
        } catch (t: Throwable) {
            Log.w(TAG, "restart entry $kind failed", t)
        }
    }

    /**
     * AppOpen row. Returns true when the one-time notice is due: the service is started again and the caller
     * tells JS. The heartbeat is reset so the notice cannot repeat.
     */
    fun onAppOpen(c: Context): Boolean {
        val p = c.getSharedPreferences(RestartPrefs.ENGINE, Context.MODE_PRIVATE)
        val running = p.getBoolean(RestartPrefs.KEY_WANTED, false) &&
            p.getInt(RestartPrefs.KEY_LAST_ACTIVE, 0) > 0 &&
            !p.getBoolean(RestartPrefs.KEY_USER_SHUTDOWN, false) &&
            !p.getBoolean(RestartPrefs.KEY_USER_PAUSED_ALL, false)
        val now = System.currentTimeMillis()
        val due = RestartEntryPolicy.shouldShowStoppedNotice(
            now, p.getLong(RestartPrefs.KEY_HEARTBEAT, 0L), running, MaglevTorrentService.instance != null,
        )
        if (due) {
            p.edit().putLong(RestartPrefs.KEY_HEARTBEAT, now).apply()
            BackgroundStart.start(c, MaglevTorrentService.ACTION_RESTART)
        }
        return due
    }
}
