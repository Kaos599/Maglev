package com.maglev.engine.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.maglev.engine.EngineHost
import com.maglev.engine.util.Json
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask

/**
 * In-app updater (docs/NATIVE_CONTRACT.md section 27.4 and 27.5).
 * Downloads one APK from GitHub's release servers, verifies it, and hands it to PackageInstaller.
 * It uses its own HttpURLConnection, so nothing appears in Transfers.
 * Every entry point refuses with MANAGED when another app owns updates (27.1).
 */
object AppUpdater {
    /** The only hosts a download may start on or be redirected to. */
    val ALLOWED_HOSTS: Set<String> = setOf(
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    )
    private const val PACKAGE = "com.maglev"
    private const val MAX_BYTES = 150L * 1024 * 1024
    private const val MAX_REDIRECTS = 5
    private const val READ_TIMEOUT_MS = 60_000
    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val PROGRESS_EVERY_MS = 250L
    private const val PREFS = "maglev_update"
    private const val KEY_INSTALLING = "installing_version"

    /** Set by MaglevEngineModule on activity foreground and background. */
    @Volatile
    var inForeground: Boolean = false

    @Volatile
    private var cancelled = false
    private val lock = Any()
    private var inflight: FutureTask<Map<String, Any?>>? = null

    private class UpdateException(val code: String, message: String) : Exception(message)

    /** https on an allowed host, nothing else. */
    fun isAllowedUrl(url: String): Boolean {
        val u = try { URL(url) } catch (e: Exception) { return false }
        return u.protocol == "https" && u.host.lowercase() in ALLOWED_HOSTS
    }

    private fun updatesDir(context: Context): File = File(context.cacheDir, "updates").also { it.mkdirs() }

    private fun failure(code: String, message: String): Map<String, Any?> = Json.failure(code, message)

    private fun managed(context: Context): Map<String, Any?>? =
        if (InstallSource.managedBy(context) != null) failure("MANAGED", "Another app updates Maglev.") else null

    // region download

    fun cancelDownload() {
        cancelled = true
    }

    /** Blocking. Call off the main thread. A second call while one runs joins the first. */
    fun download(context: Context, url: String, sha256: String, size: Long): Map<String, Any?> {
        managed(context)?.let { return it }
        if (!isAllowedUrl(url)) return failure("UPDATE_INVALID", "This update didn't pass Maglev's checks, so it wasn't installed.")
        if (!Regex("^[0-9a-fA-F]{64}$").matches(sha256)) return failure("UPDATE_INVALID", "This update didn't pass Maglev's checks, so it wasn't installed.")
        val task: FutureTask<Map<String, Any?>>
        val mine: Boolean
        synchronized(lock) {
            val cur = inflight
            if (cur != null && !cur.isDone) {
                task = cur
                mine = false
            } else {
                cancelled = false
                task = FutureTask { runDownload(context.applicationContext, url, sha256.lowercase(), size) }
                inflight = task
                mine = true
            }
        }
        if (mine) task.run()
        return try {
            task.get()
        } catch (e: ExecutionException) {
            failure("NETWORK", "Couldn't download the update.")
        }
    }

    private fun runDownload(context: Context, url: String, sha256: String, size: Long): Map<String, Any?> {
        val dir = updatesDir(context)
        val part = File(dir, "$sha256.apk.part")
        val done = File(dir, "$sha256.apk")
        try {
            if (done.exists()) {
                if (verify(context, done, sha256) == null) return mapOf("ok" to true, "path" to done.absolutePath)
                done.delete()
            }
            if (size > MAX_BYTES) throw UpdateException("UPDATE_INVALID", "This update didn't pass Maglev's checks, so it wasn't installed.")
            val need = if (size > 0) size else 0L
            if (need > 0 && dir.usableSpace < need - part.length() + 8L * 1024 * 1024) {
                throw UpdateException("STORAGE_FULL", "There isn't enough space to download the update.")
            }
            fetch(url, part, size)
            if (done.exists()) done.delete()
            if (!part.renameTo(done)) throw UpdateException("STORAGE_FULL", "Couldn't save the update.")
            val bad = verify(context, done, sha256)
            if (bad != null) {
                done.delete()
                throw UpdateException("UPDATE_INVALID", "This update didn't pass Maglev's checks, so it wasn't installed.")
            }
            return mapOf("ok" to true, "path" to done.absolutePath)
        } catch (e: UpdateException) {
            if (e.code == "UPDATE_INVALID") {
                part.delete()
                done.delete()
            }
            return failure(e.code, e.message ?: "Couldn't download the update.")
        } catch (e: IOException) {
            return ioFailure(e)
        } catch (e: Exception) {
            return failure("NETWORK", "Couldn't download the update.")
        }
    }

    private fun ioFailure(e: IOException): Map<String, Any?> =
        if ((e.message ?: "").contains("ENOSPC") || (e.message ?: "").contains("No space left")) {
            failure("STORAGE_FULL", "There isn't enough space to download the update.")
        } else {
            failure("NETWORK", "Couldn't download the update.")
        }

    /** Opens the connection, following at most [MAX_REDIRECTS] hops. Each hop must stay on an allowed host. */
    private fun connect(start: String, from: Long): HttpURLConnection {
        var current = URL(start)
        var hops = 0
        while (true) {
            if (!isAllowedUrl(current.toString())) throw UpdateException("UPDATE_INVALID", "This update didn't pass Maglev's checks, so it wasn't installed.")
            val c = current.openConnection() as HttpURLConnection
            c.instanceFollowRedirects = false
            c.connectTimeout = CONNECT_TIMEOUT_MS
            c.readTimeout = READ_TIMEOUT_MS
            c.setRequestProperty("User-Agent", "Maglev")
            c.setRequestProperty("Accept", "application/octet-stream")
            if (from > 0) c.setRequestProperty("Range", "bytes=$from-")
            val code = c.responseCode
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                val loc = c.getHeaderField("Location")
                c.disconnect()
                if (loc == null || ++hops > MAX_REDIRECTS) throw UpdateException("NETWORK", "Couldn't download the update.")
                current = URL(current, loc)
                continue
            }
            return c
        }
    }

    private fun fetch(url: String, part: File, expectedSize: Long) {
        var restarted = false
        while (true) {
            var from = if (part.exists()) part.length() else 0L
            val c = connect(url, from)
            try {
                val code = c.responseCode
                if (code == 416 && from > 0 && !restarted) {
                    part.delete()
                    restarted = true
                    continue
                }
                val append: Boolean
                var total = -1L
                when (code) {
                    206 -> {
                        append = true
                        total = c.getHeaderField("Content-Range")?.substringAfter('/', "")?.toLongOrNull() ?: -1L
                    }
                    200 -> {
                        // The server ignored Range (or there was nothing to resume): start from zero.
                        append = false
                        from = 0L
                        total = c.contentLengthLong
                    }
                    else -> throw UpdateException("HTTP_STATUS", "The download server answered $code.")
                }
                if (total <= 0) total = expectedSize
                if (total > MAX_BYTES) throw UpdateException("UPDATE_INVALID", "This update didn't pass Maglev's checks, so it wasn't installed.")
                var bytes = from
                var lastEmit = 0L
                c.inputStream.use { input ->
                    java.io.FileOutputStream(part, append).use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            if (cancelled) throw UpdateException("CANCELLED", "The download was cancelled.")
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            bytes += n
                            if (bytes > MAX_BYTES) throw UpdateException("UPDATE_INVALID", "This update didn't pass Maglev's checks, so it wasn't installed.")
                            val now = System.currentTimeMillis()
                            if (now - lastEmit >= PROGRESS_EVERY_MS) {
                                lastEmit = now
                                progress(bytes, total)
                            }
                        }
                    }
                }
                progress(bytes, total)
                return
            } finally {
                c.disconnect()
            }
        }
    }

    private fun progress(bytes: Long, total: Long) {
        EngineHost.emitter?.invoke("onUpdateProgress", mapOf("bytes" to bytes.toDouble(), "total" to total.toDouble()))
    }

    // endregion

    // region verify

    private fun sha256Hex(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    @Suppress("DEPRECATION")
    private fun flags(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES
        else PackageManager.GET_SIGNATURES

    private fun archiveInfo(pm: PackageManager, path: String): PackageInfo? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(flags().toLong()))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageArchiveInfo(path, flags())
        }

    private fun installedInfo(pm: PackageManager, pkg: String): PackageInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(flags().toLong()))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(pkg, flags())
        }

    @Suppress("DEPRECATION")
    private fun versionOf(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
        else info.versionCode.toLong()

    private fun signers(info: PackageInfo): Set<String> {
        val raw: Array<android.content.pm.Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners
        } else {
            @Suppress("DEPRECATION")
            info.signatures
        }
        val sigs = raw ?: return emptySet()
        return sigs.map { s -> MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) } }.toSet()
    }

    /** The active network as the update rules see it: online, on a metered link (not NET_CAPABILITY_NOT_METERED), on a VPN. */
    fun network(context: Context): Map<String, Any?> {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
        val caps = try { cm.activeNetwork?.let { cm.getNetworkCapabilities(it) } } catch (e: Exception) { null }
        return linkedMapOf(
            "ok" to true,
            "connected" to (caps?.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) == true),
            "metered" to (caps == null || !caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED)),
            "vpn" to (caps?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN) == true),
        )
    }

    /** The installed versionCode (base * 10 + ABI digit, plugins/withAbiSplits.js), or null when unreadable. */
    fun installedVersionCode(context: Context): Long? = try {
        val pm = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0L))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(context.packageName, 0)
        }
        versionOf(info)
    } catch (e: Exception) {
        null
    }

    /**
     * The four checks of 27.4: the file's SHA-256, the package name, a higher versionCode, and the same signing
     * certificates as the installed app. Returns null when all pass, otherwise a short reason for the log.
     */
    fun verify(context: Context, file: File, sha256: String): String? {
        if (!file.isFile) return "missing file"
        if (sha256Hex(file) != sha256.lowercase()) return "sha256 mismatch"
        val pm = context.packageManager
        val archive = archiveInfo(pm, file.absolutePath) ?: return "unreadable package"
        if (archive.packageName != PACKAGE) return "wrong package"
        val installed = try { installedInfo(pm, context.packageName) } catch (e: Exception) { return "installed app unreadable" }
        if (versionOf(archive) <= versionOf(installed)) return "not newer"
        val a = signers(archive)
        if (a.isEmpty() || a != signers(installed)) return "different signer"
        return null
    }

    // endregion

    // region install

    private fun inUpdatesDir(context: Context, path: String): File? {
        val f = File(path)
        val dir = updatesDir(context).canonicalFile
        return if (f.canonicalFile.parentFile == dir) f else null
    }

    /** Verifies again, then commits a PackageInstaller session. [silent] asks Android for no confirmation where it allows it. */
    fun install(context: Context, path: String, silent: Boolean): Map<String, Any?> {
        managed(context)?.let { return it }
        val file = inUpdatesDir(context, path) ?: return failure("UPDATE_INVALID", "This update didn't pass Maglev's checks, so it wasn't installed.")
        val sha = file.name.removeSuffix(".apk")
        if (verify(context, file, sha) != null) {
            file.delete()
            return failure("UPDATE_INVALID", "This update didn't pass Maglev's checks, so it wasn't installed.")
        }
        val pm = context.packageManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !pm.canRequestPackageInstalls()) {
            return mapOf("ok" to true, "status" to "needs_permission")
        }
        val version = archiveInfo(pm, file.absolutePath)?.versionName
        return try {
            val installer = pm.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(PACKAGE)
            params.setSize(file.length())
            if (silent && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Needs the normal permission ENFORCE_UPDATE_OWNERSHIP (plugins/withSelfUpdate.js). Best effort: a phone that refuses still installs.
                try { params.setRequestUpdateOwnership(true) } catch (e: SecurityException) { /* not granted */ }
            }
            val id = installer.createSession(params)
            installer.openSession(id).use { session ->
                file.inputStream().use { input ->
                    session.openWrite("maglev.apk", 0, file.length()).use { out ->
                        input.copyTo(out)
                        session.fsync(out)
                    }
                }
                val intent = Intent(context, UpdateInstallReceiver::class.java).setAction(UpdateInstallReceiver.ACTION_STATUS)
                // FLAG_MUTABLE: the system adds the status extras to this intent (required on API 31+).
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                val pi = PendingIntent.getBroadcast(context, id, intent, flags)
                setInstalling(context, version)
                session.commit(pi.intentSender)
            }
            mapOf("ok" to true, "status" to "started")
        } catch (e: IOException) {
            clearInstalling(context)
            if ((e.message ?: "").contains("ENOSPC") || (e.message ?: "").contains("No space left")) {
                failure("STORAGE_FULL", "There isn't enough space to install the update.")
            } else {
                failure("INSTALL_FAILED", "Android didn't install the update.")
            }
        } catch (e: Exception) {
            clearInstalling(context)
            failure("INSTALL_FAILED", "Android didn't install the update.")
        }
    }

    /** Opens "Install unknown apps" for Maglev (ACTION_MANAGE_UNKNOWN_APP_SOURCES). Returns an error message or null. */
    fun openInstallPermissionSettings(context: Context): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null
        return try {
            val i = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            null
        } catch (e: Exception) {
            e.message ?: "Settings aren't available"
        }
    }

    // endregion

    // region state

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun setInstalling(context: Context, version: String?) {
        prefs(context).edit().apply { if (version == null) remove(KEY_INSTALLING) else putString(KEY_INSTALLING, version) }.apply()
    }

    fun installingVersion(context: Context): String? = prefs(context).getString(KEY_INSTALLING, null)

    fun clearInstalling(context: Context) = setInstalling(context, null)

    /** Deletes everything in cacheDir/updates except [keepPath] (the pending update), at startup. */
    fun cleanup(context: Context, keepPath: String?) {
        val keep = keepPath?.let { runCatching { File(it).canonicalFile }.getOrNull() }
        updatesDir(context).listFiles()?.forEach { f ->
            if (keep == null || f.canonicalFile != keep) f.delete()
        }
    }

    // endregion
}
