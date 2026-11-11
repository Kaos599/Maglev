package com.maglev.engine.service

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Starts the foreground service from a place that has no visible UI (alarm receiver, worker).
 * Contract section 11, "Background-start rule". On API 31+ the platform may throw
 * ForegroundServiceStartNotAllowedException, which extends IllegalStateException
 * (https://developer.android.com/reference/android/app/ForegroundServiceStartNotAllowedException).
 * Catching Exception also covers a SecurityException for a missing foreground-service permission, and keeps
 * API 24..30 free of a class that does not exist there.
 */
object BackgroundStart {
    private const val TAG = "MaglevBgStart"

    /** True when the start was accepted. False means the caller must post a notification instead. */
    fun start(context: Context, action: String): Boolean = try {
        ContextCompat.startForegroundService(
            context, Intent(context, MaglevTorrentService::class.java).setAction(action),
        )
        true
    } catch (e: Exception) {
        Log.w(TAG, "background start of $action refused: ${e.javaClass.simpleName}: ${e.message}")
        false
    }
}
