package com.maglev.engine.update

import android.content.Context
import android.os.Build

/**
 * Who installed Maglev (docs/NATIVE_CONTRACT.md section 27.1).
 * When [managedBy] is not null another app owns updates, and Maglev never downloads or installs one.
 */
object InstallSource {
    private val FDROID = setOf(
        "org.fdroid.fdroid",
        "org.fdroid.basic",
        "com.looker.droidify",
        "com.machiav3lli.fdroid",
        "in.sunilpaulmathew.izzyondroid",
    )
    private const val OBTAINIUM = "dev.imranr.obtainium"
    private const val PLAY = "com.android.vending"
    private const val ACCRESCENT = "app.accrescent.client"
    /** Other app stores that own updates (docs/NATIVE_CONTRACT.md section 30). A sideload is never in this set. */
    private val STORES = setOf(
        "com.aurora.store",
        "com.sec.android.app.samsungapps",
        "com.amazon.venezia",
        "com.xiaomi.market",
        "com.huawei.appmarket",
        "com.heytap.market",
        "com.oppo.market",
    )

    /** Pure mapping: "fdroid", "obtainium", "play", "accrescent", "store" or null (self-update allowed). */
    fun managedBy(installer: String?): String? = when {
        installer == null -> null
        installer in FDROID -> "fdroid"
        installer == OBTAINIUM || installer.startsWith("$OBTAINIUM.") -> "obtainium"
        installer == PLAY -> "play"
        installer == ACCRESCENT -> "accrescent"
        installer in STORES -> "store"
        else -> null
    }

    /** `getInstallSourceInfo(pkg).installingPackageName` on API 30+, `getInstallerPackageName` below. Null when unknown. */
    fun installer(context: Context): String? {
        val pm = context.packageManager
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                pm.getInstallSourceInfo(context.packageName).installingPackageName
            } else {
                @Suppress("DEPRECATION")
                pm.getInstallerPackageName(context.packageName)
            }
        } catch (e: Exception) {
            null
        }
    }

    fun managedBy(context: Context): String? = managedBy(installer(context))
}
