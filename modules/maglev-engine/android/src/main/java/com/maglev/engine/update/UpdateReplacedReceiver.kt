package com.maglev.engine.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * MY_PACKAGE_REPLACED after a self-update (docs/NATIVE_CONTRACT.md section 27.5): posts "Maglev was updated to {version}"
 * only when Maglev itself started the install, and clears the downloaded file. BootReceiver handles the transfer restart.
 */
class UpdateReplacedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val app = context.applicationContext
        val version = AppUpdater.installingVersion(app) ?: return
        AppUpdater.clearInstalling(app)
        AppUpdater.cleanup(app, null)
        UpdateNotices.clear(app, "available")
        UpdateNotices.clear(app, "ready")
        UpdateNotices.show(app, "updated", version)
    }
}
