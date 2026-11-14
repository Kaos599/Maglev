package com.maglev.engine.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import com.maglev.engine.EngineHost

/**
 * Receives the PackageInstaller session status (docs/NATIVE_CONTRACT.md section 27.5).
 * The PendingIntent that points here is FLAG_MUTABLE because the system adds EXTRA_STATUS to it (API 31+).
 */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent == null) return
        val app = context.applicationContext
        if (intent.action == ACTION_INSTALL) return startInstall(app, intent)
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = confirmIntent(intent) ?: return emit(failure("INSTALL_FAILED", "Android didn't install the update."))
                if (AppUpdater.inForeground) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    try {
                        app.startActivity(confirm)
                        emit(mapOf("ok" to true, "status" to "needs_user"))
                    } catch (e: Exception) {
                        UpdateNotices.showConfirm(app, AppUpdater.installingVersion(app), confirm)
                    }
                } else {
                    UpdateNotices.showConfirm(app, AppUpdater.installingVersion(app), confirm)
                    emit(mapOf("ok" to true, "status" to "needs_user"))
                }
            }
            // The system restarts Maglev's process as part of the install. MY_PACKAGE_REPLACED posts the notice.
            PackageInstaller.STATUS_SUCCESS -> emit(mapOf("ok" to true, "status" to "installed"))
            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                AppUpdater.clearInstalling(app)
                emit(failure("INSTALL_CANCELLED", "The update wasn't installed."))
            }
            PackageInstaller.STATUS_FAILURE_STORAGE -> {
                AppUpdater.clearInstalling(app)
                emit(failure("STORAGE_FULL", "There isn't enough space to install the update."))
            }
            else -> {
                AppUpdater.clearInstalling(app)
                emit(failure("INSTALL_FAILED", "Android didn't install the update."))
            }
        }
    }

    /** The notification's Install action (section 30). Falls back to the plain "ready" notice, which opens About. */
    private fun startInstall(app: Context, intent: Intent) {
        val path = intent.getStringExtra(EXTRA_PATH)
        val sha = intent.getStringExtra(EXTRA_SHA)
        val version = intent.getStringExtra(EXTRA_VERSION) ?: ""
        if (path == null || sha == null) {
            UpdateNotices.show(app, "ready", version)
            return
        }
        val pending = goAsync()
        Thread {
            try {
                val res = AppUpdater.install(app, path, false, sha)
                if (res["ok"] != true) {
                    emit(res)
                    UpdateNotices.show(app, "ready", version)
                } else if (res["status"] == "needs_permission") {
                    UpdateNotices.show(app, "ready", version)
                }
            } finally {
                pending.finish()
            }
        }.start()
    }

    private fun confirmIntent(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }

    private fun failure(code: String, message: String): Map<String, Any?> =
        linkedMapOf("ok" to false, "code" to code, "message" to message)

    private fun emit(body: Map<String, Any?>) {
        EngineHost.emitter?.invoke("onUpdateResult", body)
    }

    companion object {
        const val ACTION_STATUS = "com.maglev.engine.update.INSTALL_STATUS"
        const val ACTION_INSTALL = "com.maglev.engine.update.INSTALL_NOW"
        const val EXTRA_PATH = "path"
        const val EXTRA_SHA = "sha256"
        const val EXTRA_VERSION = "version"
    }
}
