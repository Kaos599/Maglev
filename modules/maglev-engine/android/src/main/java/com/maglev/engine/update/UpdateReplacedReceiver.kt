package com.maglev.engine.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * MY_PACKAGE_REPLACED after a self-update: posts "Maglev was updated to {version}"
 * only when Maglev itself started the install, and clears the downloaded file. BootReceiver handles the transfer restart.
 */
class UpdateReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val app = context.applicationContext
        // What the background check found was for the version before this one.
        UpdateSchedule.clearFound(app)
        val version = AppUpdater.installingVersion(app) ?: return
        // Always cleared. When a different version got installed (by hand, say), no "updated to" notice.
        AppUpdater.clearInstalling(app)
        AppUpdater.cleanup(app, null)
        UpdateNotices.clear(app, "available")
        UpdateNotices.clear(app, "ready")
        val installed = try { app.packageManager.getPackageInfo(app.packageName, 0).versionName } catch (e: Exception) { null }
        if (installed == null || installed == version) UpdateNotices.show(app, "updated", version)
    }
}
