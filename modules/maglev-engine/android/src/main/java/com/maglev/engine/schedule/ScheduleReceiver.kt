package com.maglev.engine.schedule

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.maglev.engine.EngineHost

/**
 * Handles the schedule alarm and the clock changes that invalidate it (TIME_SET and TIMEZONE_CHANGED are exempt
 * from the implicit-broadcast limits, https://developer.android.com/develop/background-work/background-tasks/broadcasts/broadcast-exceptions).
 */
class ScheduleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val app = context.applicationContext
        EngineHost.attach(app)
        ScheduleManager.rearm(app)
        ScheduleManager.resetResumeThrottle()
        ScheduleManager.requestResumeIfAllowed(app)
        // Engine already alive in this process: apply the new state now.
        EngineHost.onScheduleChanged()
    }
}
