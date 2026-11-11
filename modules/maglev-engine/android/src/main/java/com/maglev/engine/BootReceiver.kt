package com.maglev.engine

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * BOOT_COMPLETED and MY_PACKAGE_REPLACED run [RestartEntry] (contract 19).
 * LOCKED_BOOT_COMPLETED is delivered because the receiver is directBootAware, and ignored: nothing here may
 * touch credential-protected storage before the user unlocks the phone.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_BOOT_COMPLETED -> RestartEntry.run(context, RestartEntryKind.BootCompleted)
            Intent.ACTION_MY_PACKAGE_REPLACED -> RestartEntry.run(context, RestartEntryKind.PackageReplaced)
            else -> Unit
        }
    }
}
