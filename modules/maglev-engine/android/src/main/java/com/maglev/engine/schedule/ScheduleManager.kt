package com.maglev.engine.schedule

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import com.maglev.engine.service.BackgroundStart
import com.maglev.engine.service.MaglevTorrentService
import com.maglev.engine.service.Notifications
import com.maglev.engine.util.Json
import java.util.Calendar

/** Android side of the scheduler (contract section 11.5): persistence, wall-clock adapter, alarm, resume request. */
object ScheduleManager {
    private const val TAG = "MaglevSchedule"
    const val PREFS = "maglev_schedule"
    private const val KEY_CONFIG = "config"
    private const val KEY_HELD = "scheduleHeld"
    private const val RESUME_RETRY_MS = 10 * 60_000L

    const val ACTION_ALARM = "com.maglev.engine.action.SCHEDULE_ALARM"

    @Volatile private var cached: ScheduleConfig? = null
    private var lastResumeAttempt = 0L

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun config(c: Context): ScheduleConfig {
        cached?.let { return it }
        val loaded = try {
            val text = prefs(c).getString(KEY_CONFIG, null)
            if (text == null) ScheduleConfig.DISABLED else ScheduleConfig.fromMap(Json.parseObject(text))
        } catch (e: Exception) {
            ScheduleConfig.DISABLED
        }
        cached = loaded
        return loaded
    }

    /** Validates, persists and re-arms. Returns the config that was stored (invalid rules dropped). */
    fun setConfig(c: Context, raw: Map<String, Any?>): ScheduleConfig {
        val cfg = ScheduleConfig.fromMap(raw)
        prefs(c).edit().putString(KEY_CONFIG, Json.toJson(ScheduleConfig.toMap(cfg))).apply()
        cached = cfg
        if (!cfg.enabled) setHeld(c, false)
        rearm(c)
        return cfg
    }

    fun isHeld(c: Context): Boolean = prefs(c).getBoolean(KEY_HELD, false)

    fun setHeld(c: Context, held: Boolean) {
        if (isHeld(c) != held) prefs(c).edit().putBoolean(KEY_HELD, held).apply()
    }

    fun wallTime(cal: Calendar): WallTime =
        WallTime((cal.get(Calendar.DAY_OF_WEEK) + 5) % 7, cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE))

    fun state(c: Context, nowMs: Long = System.currentTimeMillis()): ScheduleState {
        val cal = Calendar.getInstance().apply { timeInMillis = nowMs }
        return ScheduleEvaluator.evaluate(config(c), wallTime(cal))
    }

    /** Epoch millis of the next boundary, built with Calendar so a DST change cannot shift the wall-clock time. */
    fun nextBoundaryEpoch(c: Context, nowMs: Long = System.currentTimeMillis()): Long? {
        val cal = Calendar.getInstance().apply { timeInMillis = nowMs }
        val wt = wallTime(cal)
        val st = ScheduleEvaluator.evaluate(config(c), wt)
        val days = st.boundaryDaysAhead(wt) ?: return null
        val minute = st.boundaryMinuteOfDay(wt) ?: return null
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        cal.add(Calendar.DAY_OF_YEAR, days)
        cal.set(Calendar.HOUR_OF_DAY, minute / 60)
        cal.set(Calendar.MINUTE, minute % 60)
        return cal.timeInMillis
    }

    /** "HH:MM" of the next boundary, for the notification. */
    fun nextBoundaryLabel(c: Context): String? {
        val t = nextBoundaryEpoch(c) ?: return null
        val cal = Calendar.getInstance().apply { timeInMillis = t }
        return ScheduleConfig.formatTime(cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE))
    }

    fun status(c: Context): Map<String, Any?> {
        val cfg = config(c)
        val st = state(c)
        return linkedMapOf(
            "ok" to true,
            "enabled" to cfg.enabled,
            "paused" to st.paused,
            "activeRuleIds" to st.activeRuleIds,
            "nextBoundary" to (if (cfg.enabled) nextBoundaryEpoch(c) else null),
        )
    }

    private fun alarmIntent(c: Context): PendingIntent = PendingIntent.getBroadcast(
        c, 0, Intent(c, ScheduleReceiver::class.java).setAction(ACTION_ALARM),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    /**
     * Arms one inexact alarm at the next boundary: AlarmManager.setAndAllowWhileIdle needs no permission
     * (https://developer.android.com/reference/android/app/AlarmManager#setAndAllowWhileIdle(int,%20long,%20android.app.PendingIntent)).
     * Alarms are cleared on reboot. They are re-armed on app start, on every setSchedule and on time changes.
     */
    fun rearm(c: Context) {
        try {
            val am = c.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pi = alarmIntent(c)
            val at = if (config(c).enabled) nextBoundaryEpoch(c) else null
            if (at == null) {
                am.cancel(pi)
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not arm schedule alarm: ${e.message}")
        }
    }

    /**
     * Called by the alarm receiver and by the per-minute tick. When the schedule allows transfers again and they
     * were held, starts the service headless (contract 8 path). A refused start becomes a notification.
     */
    fun requestResumeIfAllowed(c: Context) {
        if (!isHeld(c) || state(c).paused) return
        val now = SystemClock.elapsedRealtime()
        if (lastResumeAttempt != 0L && now - lastResumeAttempt < RESUME_RETRY_MS) return
        lastResumeAttempt = now
        if (!BackgroundStart.start(c, MaglevTorrentService.ACTION_SCHEDULE_RESUME)) {
            Notifications.notifyScheduleReady(c)
        }
    }

    /** The service reached the resume path, so a later pause may start a new attempt right away. */
    fun resetResumeThrottle() {
        lastResumeAttempt = 0L
    }
}
