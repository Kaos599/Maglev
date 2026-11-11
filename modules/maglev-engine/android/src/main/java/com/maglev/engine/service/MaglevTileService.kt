package com.maglev.engine.service

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.util.Log
import androidx.core.content.ContextCompat
import com.maglev.engine.EngineHost

/**
 * Quick Settings tile: shows transfer state, taps to Pause all / Resume all (contract 13.3).
 * An active tile (ACTIVE_TILE meta-data): the system binds it on a click, and [EngineHost] asks for an
 * update with [TileService.requestListeningState] when the summary changes.
 */
class MaglevTileService : TileService() {

    override fun onStartListening() {
        refresh()
    }

    override fun onClick() {
        try {
            when (TileModel.from(EngineHost.tileSummary()).tapAction) {
                TileTap.PAUSE_ALL -> sendToEngine(MaglevTorrentService.ACTION_PAUSE_ALL)
                TileTap.RESUME_ALL -> sendToEngine(MaglevTorrentService.ACTION_RESUME_ALL)
                TileTap.OPEN_APP -> openApp()
            }
        } catch (e: Exception) {
            Log.w(TAG, "tile click failed: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /** Service running: same path as the notification action. Otherwise start it with the action. */
    private fun sendToEngine(action: String) {
        if (MaglevTorrentService.instance != null) {
            if (action == MaglevTorrentService.ACTION_PAUSE_ALL) EngineHost.pauseAllFromNotification()
            else EngineHost.resumeAllFromNotification()
            return
        }
        try {
            ContextCompat.startForegroundService(this, Intent(this, MaglevTorrentService::class.java).setAction(action))
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException (API 31+) or anything else: let the user finish in the app.
            Log.w(TAG, "service start refused: ${e.javaClass.simpleName}: ${e.message}")
            openApp()
        }
    }

    private fun openApp() {
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) ?: return
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(launch)
        }
    }

    private fun refresh() {
        val tile = qsTile ?: return
        val m = TileModel.from(EngineHost.tileSummary())
        tile.label = "Maglev"
        tile.state = if (m.state == TileUiState.ACTIVE) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        if (Build.VERSION.SDK_INT >= 29) tile.subtitle = m.subtitle
        tile.updateTile()
    }

    private companion object {
        const val TAG = "MaglevTile"
    }
}
