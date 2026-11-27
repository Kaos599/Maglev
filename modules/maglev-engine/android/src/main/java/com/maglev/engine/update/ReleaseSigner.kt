package com.maglev.engine.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest

/**
 * Whether this copy of Maglev is signed with the key the GitHub releases are signed with.
 *
 * Android installs an update only when it is signed with the same key as the installed app. A copy signed with any
 * other key (a CI or pull request build, a fork, an F-Droid build installed by hand, an old debug build) can never
 * install a release, so the updater checks this before downloading anything instead of finding out after 40 to
 * 115 MB.
 *
 * The digest is SHA-256 over the DER-encoded signing certificate, lowercase hex without colons: the
 * "Signer #1 certificate SHA-256 digest" line of `apksigner verify --print-certs Maglev-vX.Y-arm64-v8a.apk`, and the
 * same value [AppUpdater.verify] compares (SHA-256 of `Signature.toByteArray()`). If the release key is ever rotated,
 * add the new certificate here as well; a rotated app still lists the old one in its signing history, so either one
 * matches.
 *
 * APIs: https://developer.android.com/reference/android/content/pm/SigningInfo#getSigningCertificateHistory(),
 * https://developer.android.com/reference/android/content/pm/SigningInfo#getApkContentsSigners(),
 * https://developer.android.com/reference/android/content/pm/PackageManager#GET_SIGNING_CERTIFICATES,
 * https://developer.android.com/reference/android/content/pm/Signature#toByteArray()
 */
object ReleaseSigner {
    val RELEASE_CERTS: Set<String> = setOf(
        "c8e15bd47fb39fb2248d8b501a677e61be564d52ba535e31a1608564e35df3c4",
    )

    const val RELEASE = "release"
    const val FOREIGN = "foreign"
    const val UNKNOWN = "unknown"

    @Volatile
    private var cached: String? = null

    /**
     * "release", "foreign", or "unknown" when the package can't be read. The signer of an installed app never changes
     * while it runs (a different key can't update it in place), so the answer is cached for the process.
     */
    fun check(context: Context): String {
        cached?.let { return it }
        val certs = try { installedCerts(context) } catch (e: Exception) { null }
        val answer = when {
            certs == null || certs.digests.isEmpty() -> UNKNOWN
            // Several signers make one identity: every one of them must be the release key.
            certs.allRequired && certs.digests.all { it in RELEASE_CERTS } -> RELEASE
            !certs.allRequired && certs.digests.any { it in RELEASE_CERTS } -> RELEASE
            else -> FOREIGN
        }
        if (answer != UNKNOWN) cached = answer
        return answer
    }

    fun isForeign(context: Context): Boolean = check(context) == FOREIGN

    /**
     * Every certificate the installed app may sign as. On API 28+ that is the rotation history (original first,
     * current last), or the content signers when the app has several signers and so no history. Below 28, the
     * signatures from GET_SIGNATURES.
     */
    private class Certs(val digests: Set<String>, val allRequired: Boolean)

    private fun installedCerts(context: Context): Certs {
        val pm = context.packageManager
        val info: PackageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES)
        }
        var allRequired = false
        val sigs: Array<android.content.pm.Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val si = info.signingInfo
            when {
                si == null -> null
                si.hasMultipleSigners() -> { allRequired = true; si.apkContentsSigners }
                else -> si.signingCertificateHistory ?: si.apkContentsSigners
            }
        } else {
            @Suppress("DEPRECATION")
            info.signatures.also { allRequired = (it?.size ?: 0) > 1 }
        }
        return Certs((sigs ?: emptyArray()).map { sha256(it.toByteArray()) }.toSet(), allRequired)
    }

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
