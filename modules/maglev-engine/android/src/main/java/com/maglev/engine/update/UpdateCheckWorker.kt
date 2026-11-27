package com.maglev.engine.update

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * The app update check that runs while Maglev is closed. Once a day, with a network, it asks GitHub for a newer
 * version (the same list and rules as the app's own check), and then does what "When an update is found" says:
 *  - Tell me: posts "Maglev X is available".
 *  - Download on Wi-Fi / Install automatically: on an unmetered network it downloads and checks the APK, then posts
 *    "Maglev X is ready" with an Install button. On mobile data it saves what it found and asks for one more run
 *    when an unmetered network is back. It never installs on its own: an install restarts Maglev, and only the app
 *    knows whether a transfer is running.
 *
 * It never runs for a store install or for a copy signed with another key, and it downloads through
 * [AppUpdater.download], whose lock the app's own download shares, so the two never write the file at once.
 *
 * WorkManager API: https://developer.android.com/reference/androidx/work/PeriodicWorkRequest.Builder,
 * https://developer.android.com/reference/androidx/work/ExistingPeriodicWorkPolicy,
 * https://developer.android.com/reference/androidx/work/NetworkType,
 * https://developer.android.com/reference/androidx/work/CoroutineWorker
 */
class UpdateCheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        when (UpdateSchedule.runOnce(applicationContext)) {
            UpdateSchedule.Outcome.TRY_AGAIN -> if (runAttemptCount < 2) Result.retry() else Result.success()
            else -> Result.success()
        }
    }
}

object UpdateSchedule {
    private const val TAG = "MaglevAppUpdate"
    const val UNIQUE_DAILY = "maglev-app-update-check"
    const val UNIQUE_WIFI = "maglev-app-update-wifi"
    private const val PREFS = "maglev_update_schedule"
    private const val KEY_CONFIG = "config"
    private const val KEY_SCHEDULED_WIFI_ONLY = "scheduled_wifi_only"
    private const val KEY_FOUND = "found"
    private const val KEY_FOUND_PATH = "found_path"
    private const val KEY_NOTICE = "notice"

    enum class Outcome { DONE, TRY_AGAIN }

    /** What the app's settings say, pushed by the app whenever they change. */
    class Config(
        val autoCheck: Boolean,
        val mode: String,
        val skippedVersion: String?,
        val wifiOnly: Boolean,
        val vpnOnly: Boolean,
    ) {
        fun toJson(): JSONObject = JSONObject().put("autoCheck", autoCheck).put("mode", mode)
            .put("skippedVersion", skippedVersion ?: JSONObject.NULL).put("wifiOnly", wifiOnly).put("vpnOnly", vpnOnly)

        companion object {
            fun from(raw: Map<String, Any?>): Config = Config(
                autoCheck = raw["autoCheck"] != false,
                mode = (raw["mode"] as? String)?.takeIf { it in setOf("ask", "download", "auto") } ?: "download",
                skippedVersion = (raw["skippedVersion"] as? String)?.takeIf { it.isNotEmpty() },
                wifiOnly = raw["wifiOnly"] == true,
                vpnOnly = raw["vpnOnly"] == true,
            )

            fun fromJson(o: JSONObject): Config = Config(
                autoCheck = o.optBoolean("autoCheck", true),
                mode = o.optString("mode", "download").takeIf { it in setOf("ask", "download", "auto") } ?: "download",
                skippedVersion = if (o.isNull("skippedVersion")) null else o.optString("skippedVersion").ifEmpty { null },
                wifiOnly = o.optBoolean("wifiOnly", false),
                vpnOnly = o.optBoolean("vpnOnly", false),
            )
        }
    }

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun config(c: Context): Config? = prefs(c).getString(KEY_CONFIG, null)?.let {
        try { Config.fromJson(JSONObject(it)) } catch (e: Exception) { null }
    }

    /** True when this copy may update itself: not owned by a store, and signed with the release key. */
    private fun selfUpdating(c: Context): Boolean =
        InstallSource.managedBy(c) == null && !ReleaseSigner.isForeign(c)

    /**
     * Saves [cfg] and schedules the daily run (or cancels it when checking automatically is off, a store owns updates,
     * or this copy is signed with another key). [waitForWifi]: the app is waiting for Wi-Fi to download, so one run is
     * also asked for on the next unmetered network, in case Maglev is closed by then. Safe to call often. Never throws.
     */
    fun apply(c: Context, cfg: Config, waitForWifi: Boolean) {
        try {
            val p = prefs(c)
            p.edit().putString(KEY_CONFIG, cfg.toJson().toString()).apply()
            val wm = WorkManager.getInstance(c)
            if (!cfg.autoCheck || !selfUpdating(c)) {
                wm.cancelUniqueWork(UNIQUE_DAILY)
                wm.cancelUniqueWork(UNIQUE_WIFI)
                return
            }
            // "Wi-Fi only" (Settings > Network) also covers the check itself.
            val changed = !p.contains(KEY_SCHEDULED_WIFI_ONLY) || p.getBoolean(KEY_SCHEDULED_WIFI_ONLY, false) != cfg.wifiOnly
            val daily = PeriodicWorkRequest.Builder(UpdateCheckWorker::class.java, 1, TimeUnit.DAYS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(if (cfg.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED).build())
                .build()
            // KEEP leaves the running schedule alone; UPDATE swaps a changed network rule and keeps the period.
            wm.enqueueUniquePeriodicWork(UNIQUE_DAILY, if (changed) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP, daily)
            p.edit().putBoolean(KEY_SCHEDULED_WIFI_ONLY, cfg.wifiOnly).apply()
            if (waitForWifi && cfg.mode != "ask") enqueueWifiRun(c) else wm.cancelUniqueWork(UNIQUE_WIFI)
        } catch (t: Throwable) {
            Log.w(TAG, "could not schedule the update check: ${t.message}")
        }
    }

    /** One run on the next unmetered network. KEEP: a run already waiting for it stays as it is. */
    private fun enqueueWifiRun(c: Context) {
        val req = OneTimeWorkRequest.Builder(UpdateCheckWorker::class.java)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.UNMETERED).build())
            .build()
        WorkManager.getInstance(c).enqueueUniqueWork(UNIQUE_WIFI, ExistingWorkPolicy.KEEP, req)
    }

    /** The same rule as networkAllows in utils/update/rules.ts. */
    private fun networkAllows(net: Map<String, Any?>, cfg: Config): Boolean {
        if (net["connected"] != true) return false
        if (cfg.wifiOnly && net["metered"] == true) return false
        if (cfg.vpnOnly && net["vpn"] != true) return false
        return true
    }

    /** The same rule as autoDownloadAllowed in utils/update/rules.ts: allowed, and not metered. */
    private fun autoDownloadAllowed(net: Map<String, Any?>, cfg: Config): Boolean = networkAllows(net, cfg) && net["metered"] != true

    private fun installedVersionName(c: Context): String? = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            c.packageManager.getPackageInfo(c.packageName, android.content.pm.PackageManager.PackageInfoFlags.of(0L)).versionName
        } else {
            @Suppress("DEPRECATION")
            c.packageManager.getPackageInfo(c.packageName, 0).versionName
        }
    } catch (e: Exception) {
        null
    }

    /** One background check. Blocking: WorkManager runs it off the main thread. */
    fun runOnce(c: Context): Outcome {
        val cfg = config(c) ?: return Outcome.DONE
        if (!cfg.autoCheck || !selfUpdating(c)) return Outcome.DONE
        val net = AppUpdater.network(c)
        if (!networkAllows(net, cfg)) return Outcome.DONE
        val version = installedVersionName(c) ?: return Outcome.DONE
        val feed = ReleaseFeed.fetch(c, version)
        if (feed is ReleaseFeed.Result.Failed) {
            // A rate limit waits for GitHub's time; only a dropped connection is worth another try soon.
            return if (feed.code == "NETWORK") Outcome.TRY_AGAIN else Outcome.DONE
        }
        val list = try { JSONArray((feed as ReleaseFeed.Result.Ok).body) } catch (e: Exception) { return Outcome.DONE }
        val release = ReleasePicker.pick(list, version, AppUpdater.installedVersionCode(c))
        if (release == null) {
            clearFound(c)
            return Outcome.DONE
        }
        if (release.version == cfg.skippedVersion) return Outcome.DONE
        saveFound(c, release, null)
        if (cfg.mode == "ask") {
            noticeOnce(c, "available", release, null)
            return Outcome.DONE
        }
        if (!autoDownloadAllowed(net, cfg)) {
            // Mobile data: wait for an unmetered network, like the app's "Waiting for Wi-Fi".
            try { enqueueWifiRun(c) } catch (t: Throwable) { Log.w(TAG, "could not wait for Wi-Fi: ${t.message}") }
            return Outcome.DONE
        }
        val res = AppUpdater.download(c, release.apkUrl, release.sha256, release.size, cfg.vpnOnly)
        if (res["ok"] != true) return if (res["code"] == "NETWORK") Outcome.TRY_AGAIN else Outcome.DONE
        val path = res["path"] as? String ?: return Outcome.DONE
        saveFound(c, release, path)
        noticeOnce(c, "ready", release, path)
        return Outcome.DONE
    }

    /** Posts each kind of notice once per version, so the daily run doesn't repeat it. */
    private fun noticeOnce(c: Context, kind: String, r: ReleasePicker.Release, path: String?) {
        if (claimNotice(c, kind, r.version)) UpdateNotices.show(c, kind, r.version, path, if (path != null) r.sha256 else null)
    }

    /**
     * True the first time a notice of [kind] for [version] is asked for, false after. The app's notices go through
     * here too, so a notice the background job already posted isn't posted again when Maglev opens.
     */
    fun claimNotice(c: Context, kind: String, version: String): Boolean {
        val key = "$kind:$version"
        synchronized(this) {
            val p = prefs(c)
            if (p.getString(KEY_NOTICE, null) == key) return false
            p.edit().putString(KEY_NOTICE, key).apply()
        }
        return true
    }

    private fun saveFound(c: Context, r: ReleasePicker.Release, path: String?) {
        prefs(c).edit().putString(KEY_FOUND, r.toJson().toString()).apply {
            if (path != null) putString(KEY_FOUND_PATH, path) else remove(KEY_FOUND_PATH)
        }.apply()
    }

    fun clearFound(c: Context) {
        prefs(c).edit().remove(KEY_FOUND).remove(KEY_FOUND_PATH).apply()
    }

    /**
     * What the background check found since the app last asked, then forgotten: `{ info, path }`, where `path` is the
     * downloaded and checked APK or null. Both null when there is nothing. The app decides what to do with it.
     */
    fun takeFound(c: Context): Map<String, Any?> {
        val p = prefs(c)
        val info = p.getString(KEY_FOUND, null)?.let { try { ReleasePicker.Release.fromJson(JSONObject(it)) } catch (e: Exception) { null } }
        val path = p.getString(KEY_FOUND_PATH, null)
        clearFound(c)
        return linkedMapOf("ok" to true, "info" to info?.toMap(), "path" to (if (info != null) path else null))
    }
}
