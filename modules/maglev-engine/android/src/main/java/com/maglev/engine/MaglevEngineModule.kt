package com.maglev.engine

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.maglev.engine.feeds.FeedScheduler
import com.maglev.engine.permissions.PermissionHelper
import com.maglev.engine.schedule.ScheduleManager
import com.maglev.engine.service.Notifications
import com.maglev.engine.storage.SafStorageManager
import com.maglev.engine.storage.StorageManager
import com.maglev.engine.util.Json
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.launch
import java.io.File

/**
 * Expo module `MaglevEngine`. API shape: docs/NATIVE_CONTRACT.md section 6.
 * Heavy lifting lives in [EngineHost]; this class only adapts it to JS.
 */
class MaglevEngineModule : Module() {

    companion object {
        private const val REQ_PICK_FOLDER = 7421
    }

    private var pendingPick: Promise? = null
    /** False for pickFolder (Move): return the folder without making it the default download folder. */
    private var pendingPickSaves = true

    private val context: Context?
        get() = appContext.reactContext?.applicationContext

    /** Runs [block] on the serialized engine thread and resolves the camelCased result. */
    private fun engine(promise: Promise, block: () -> Map<String, Any?>) {
        EngineHost.scope.launch {
            val result = try {
                block()
            } catch (t: Throwable) {
                Json.failure("INTERNAL", t.message ?: "Engine call failed")
            }
            promise.resolve(Json.camelize(result))
        }
    }

    /** Like [engine] but off the serialized thread, for calls that can block for a long time. */
    private fun io(promise: Promise, block: () -> Map<String, Any?>) {
        EngineHost.ioScope.launch {
            val result = try {
                block()
            } catch (t: Throwable) {
                Json.failure("INTERNAL", t.message ?: "Engine call failed")
            }
            promise.resolve(Json.camelize(result))
        }
    }

    private fun native(promise: Promise, block: () -> String) = engine(promise) { EngineHost.call(block) }

    override fun definition() = ModuleDefinition {
        Name("MaglevEngine")

        Events("onTelemetry", "onTorrentCompleted", "onNotificationAction", "onStorageStatus")

        OnCreate {
            context?.let {
                EngineHost.attach(it)
                // Alarms do not survive a reboot, and the work constraint can change: re-arm on app start.
                ScheduleManager.rearm(it)
                FeedScheduler.apply(it)
            }
            EngineHost.emitter = { name, body -> sendEvent(name, body) }
        }

        OnDestroy {
            EngineHost.emitter = null
            pendingPick?.resolve(mapOf("ok" to true, "cancelled" to true))
            pendingPick = null
        }

        OnActivityEntersForeground {
            EngineHost.onForeground()
        }

        // region Engine

        AsyncFunction("init") { config: Map<String, Any?>, promise: Promise ->
            engine(promise) { EngineHost.init(config) }
        }
        AsyncFunction("shutdown") { promise: Promise ->
            engine(promise) { EngineHost.shutdownEngine() }
        }
        AsyncFunction("resolveMetadata") { source: String, timeoutMs: Double, promise: Promise ->
            // Can block for the full timeout, so it must not hold up the serialized engine thread.
            EngineHost.ioScope.launch {
                val r = EngineHost.resolveMetadata(source, timeoutMs.toLong())
                promise.resolve(Json.camelize(r))
            }
        }
        // Off the serialized engine thread, so polling and cancelling work while resolveMetadata blocks.
        AsyncFunction("getResolveActivity") { infoHash: String, promise: Promise ->
            io(promise) { EngineHost.resolveActivity(infoHash) }
        }
        AsyncFunction("cancelResolve") { infoHash: String, promise: Promise ->
            io(promise) { EngineHost.cancelResolve(infoHash) }
        }
        AsyncFunction("addTorrent") { source: String, options: Map<String, Any?>?, promise: Promise ->
            io(promise) { EngineHost.addTorrent(source, options ?: emptyMap()) }
        }
        AsyncFunction("listTorrents") { promise: Promise ->
            native(promise) { NativeCore.nativeListTorrents() }
        }
        AsyncFunction("getDetail") { id: String, promise: Promise ->
            native(promise) { NativeCore.nativeGetDetail(id) }
        }
        AsyncFunction("pause") { id: String, promise: Promise ->
            engine(promise) { EngineHost.call { NativeCore.nativePause(id) }.also { EngineHost.pollNow() } }
        }
        AsyncFunction("resume") { id: String, promise: Promise ->
            engine(promise) { EngineHost.call { NativeCore.nativeResume(id) }.also { EngineHost.pollNow() } }
        }
        AsyncFunction("recheck") { id: String, promise: Promise ->
            io(promise) { EngineHost.call { NativeCore.nativeRecheck(id) } }
        }
        AsyncFunction("pauseAll") { promise: Promise ->
            engine(promise) { EngineHost.pauseAll() }
        }
        AsyncFunction("resumeAll") { promise: Promise ->
            engine(promise) { EngineHost.resumeAll() }
        }
        AsyncFunction("delete") { id: String, deleteFiles: Boolean, promise: Promise ->
            io(promise) { EngineHost.deleteTorrent(id, deleteFiles) }
        }
        AsyncFunction("setIncludedFiles") { id: String, indices: List<Int>, promise: Promise ->
            native(promise) { NativeCore.nativeSetIncludedFiles(id, Json.toJson(indices)) }
        }
        AsyncFunction("setFilePriorities") { id: String, priorities: List<Map<String, Any?>>, promise: Promise ->
            io(promise) { EngineHost.setFilePriorities(id, priorities) }
        }
        AsyncFunction("removeFiles") { id: String, indices: List<Int>, promise: Promise ->
            io(promise) { EngineHost.removeFiles(id, indices) }
        }
        AsyncFunction("reannounce") { id: String, promise: Promise ->
            io(promise) { EngineHost.reannounce(id) }
        }
        // Section 15. A tracker change restarts the torrent's peer sources, so keep it off the serialized thread.
        AsyncFunction("addTrackers") { id: String, urls: List<String>, promise: Promise ->
            io(promise) { EngineHost.addTrackers(id, urls) }
        }
        AsyncFunction("removeTracker") { id: String, url: String, promise: Promise ->
            io(promise) { EngineHost.removeTracker(id, url) }
        }
        AsyncFunction("exportTorrent") { id: String, promise: Promise ->
            io(promise) { EngineHost.exportTorrent(id) }
        }
        AsyncFunction("shareExportedTorrent") { path: String, promise: Promise ->
            io(promise) { EngineHost.shareExportedTorrent(path) }
        }
        AsyncFunction("setGlobalLimits") { down: Double, up: Double, promise: Promise ->
            engine(promise) { EngineHost.setGlobalLimits(down.toLong(), up.toLong()) }
        }
        AsyncFunction("applyConfig") { config: Map<String, Any?>, promise: Promise ->
            native(promise) { NativeCore.nativeApplyConfig(Json.toJson(Json.snakeify(config))) }
        }
        AsyncFunction("getEffectiveConfig") { promise: Promise ->
            native(promise) { NativeCore.nativeGetEffectiveConfig() }
        }
        AsyncFunction("getPieceBitfield") { id: String, promise: Promise ->
            EngineHost.scope.launch { promise.resolve(EngineHost.pieceBitfield(id)) }
        }
        AsyncFunction("streamUrl") { id: String, fileIndex: Int, promise: Promise ->
            native(promise) { NativeCore.nativeStreamUrl(id, fileIndex) }
        }
        AsyncFunction("setTorrentLimits") { id: String, limits: Map<String, Any?>, promise: Promise ->
            engine(promise) { EngineHost.setTorrentLimits(id, limits) }
        }
        AsyncFunction("moveStorage") { id: String, target: Map<String, Any?>, promise: Promise ->
            // Probes the disk and may read free space, so keep it off the serialized engine thread.
            io(promise) { EngineHost.moveStorage(id, target) }
        }
        AsyncFunction("openStream") { url: String, mime: String, title: String, promise: Promise ->
            io(promise) { EngineHost.openStream(url, mime, title) }
        }
        AsyncFunction("version") { promise: Promise ->
            native(promise) { NativeCore.nativeVersion() }
        }

        // endregion

        // region Scheduler and feeds (contract section 11)

        AsyncFunction("setSchedule") { cfg: Map<String, Any?>, promise: Promise ->
            engine(promise) { EngineHost.setSchedule(cfg) }
        }
        AsyncFunction("getScheduleStatus") { promise: Promise ->
            io(promise) {
                val c = context
                if (c == null) Json.failure("ENGINE_UNAVAILABLE", "Module is not attached") else ScheduleManager.status(c)
            }
        }
        AsyncFunction("setFeedAutomation") { cfg: Map<String, Any?>, promise: Promise ->
            io(promise) { EngineHost.setFeedAutomation(cfg) }
        }
        AsyncFunction("getFeedAutomationStatus") { promise: Promise ->
            io(promise) { EngineHost.feedStatus() }
        }
        AsyncFunction("runFeedCheckNow") { promise: Promise ->
            io(promise) { EngineHost.runFeedCheckNow() }
        }

        // endregion

        // region Storage

        AsyncFunction("pickDownloadFolder") { promise: Promise ->
            startFolderPicker(promise, saveAsDefault = true)
        }
        AsyncFunction("pickFolder") { promise: Promise ->
            startFolderPicker(promise, saveAsDefault = false)
        }
        AsyncFunction("getStorageStatus") { promise: Promise ->
            engine(promise) { EngineHost.storageStatus() }
        }
        AsyncFunction("getFreeSpace") { promise: Promise ->
            io(promise) { EngineHost.freeSpace() }
        }
        AsyncFunction("openFile") { id: String, fileIndex: Int, promise: Promise ->
            engine(promise) { EngineHost.openFile(id, fileIndex) }
        }
        AsyncFunction("shareFile") { id: String, fileIndex: Int, promise: Promise ->
            engine(promise) { EngineHost.shareFile(id, fileIndex) }
        }
        AsyncFunction("openFolder") { id: String, promise: Promise ->
            engine(promise) { EngineHost.openFolder(id) }
        }

        OnActivityResult { _, payload ->
            if (payload.requestCode == REQ_PICK_FOLDER) handlePickResult(payload.resultCode, payload.data)
        }

        // endregion

        // region Permissions

        AsyncFunction("getPermissionStatus") { promise: Promise ->
            val c = context
            promise.resolve(
                if (c == null) Json.failure("ENGINE_UNAVAILABLE", "Module is not attached") else PermissionHelper.status(c),
            )
        }
        AsyncFunction("requestNotifications") { promise: Promise ->
            requestRuntimePermission(promise, Manifest.permission.POST_NOTIFICATIONS, Build.VERSION_CODES.TIRAMISU, true)
        }
        AsyncFunction("openBatterySettings") { promise: Promise ->
            val c = context
            val err = if (c == null) "Module is not attached" else PermissionHelper.openBatterySettings(c)
            promise.resolve(if (err == null) mapOf("ok" to true) else Json.failure("INTERNAL", err))
        }
        AsyncFunction("openLiveUpdateSettings") { promise: Promise ->
            val c = context
            val err = if (c == null) "Module is not attached" else PermissionHelper.openLiveUpdateSettings(c)
            promise.resolve(if (err == null) mapOf("ok" to true) else Json.failure("INTERNAL", err))
        }
        AsyncFunction("openNotificationSettings") { channel: String?, promise: Promise ->
            val c = context
            val err = if (c == null) "Module is not attached" else Notifications.openChannelSettings(c, channel ?: Notifications.CH_COMPLETED)
            promise.resolve(if (err == null) mapOf("ok" to true) else Json.failure("INTERNAL", err))
        }
        AsyncFunction("requestLegacyStorage") { promise: Promise ->
            // Only API 28 and below use the runtime permission. Newer versions answer "n/a" in the status.
            requestRuntimePermission(promise, Manifest.permission.WRITE_EXTERNAL_STORAGE, 0, false, maxSdk = Build.VERSION_CODES.P)
        }

        // endregion

        // region Site checks (docs/SEARCH_CONTRACT.md section 8)

        // Cookies the shared WebView jar holds for a URL ("a=1; b=2"), or "" when none.
        // CookieManager.getCookie includes HttpOnly cookies such as cf_clearance.
        AsyncFunction("getCookies") { url: String, promise: Promise ->
            promise.resolve(runCatching { android.webkit.CookieManager.getInstance().getCookie(url) }.getOrNull() ?: "")
        }

        // Expires every cookie the jar holds for each URL (the hosts the user passed a check on). Returns how many were removed.
        AsyncFunction("clearCookies") { urls: List<String>, promise: Promise ->
            var removed = 0
            runCatching {
                val cm = android.webkit.CookieManager.getInstance()
                for (url in urls) {
                    val host = Uri.parse(url).host ?: continue
                    val names = cm.getCookie(url)?.split(";")?.map { it.substringBefore("=").trim() }?.filter { it.isNotEmpty() } ?: continue
                    for (name in names) {
                        // The jar matches on name, domain and path: expire both the host and its dotted domain.
                        cm.setCookie(url, "$name=; Max-Age=0; Path=/")
                        cm.setCookie(url, "$name=; Domain=.$host; Max-Age=0; Path=/")
                        removed++
                    }
                }
                cm.flush()
            }
            promise.resolve(removed)
        }

        // endregion

        // region Governance

        AsyncFunction("setGovernance") { rules: Map<String, Any?>, promise: Promise ->
            engine(promise) {
                @Suppress("UNCHECKED_CAST")
                val ssids = (rules["ssidWhitelist"] as? List<Any?>)?.mapNotNull { it?.toString() } ?: emptyList()
                EngineHost.setGovernance(
                    Governance(
                        wifiOnly = rules["wifiOnly"] == true,
                        ssidWhitelist = ssids,
                        chargingOnly = rules["chargingOnly"] == true,
                        batteryCutoffPct = (rules["batteryCutoffPct"] as? Number)?.toInt() ?: 0,
                        autoExitOnComplete = rules["autoExitOnComplete"] == true,
                    ),
                )
            }
        }

        // endregion
    }

    // region helpers

    private fun requestRuntimePermission(
        promise: Promise,
        permission: String,
        minSdk: Int,
        isNotification: Boolean,
        maxSdk: Int = Int.MAX_VALUE,
    ) {
        val c = context
        if (c == null) {
            promise.resolve(Json.failure("ENGINE_UNAVAILABLE", "Module is not attached"))
            return
        }
        val applicable = Build.VERSION.SDK_INT >= minSdk && Build.VERSION.SDK_INT <= maxSdk
        val perms = appContext.permissions
        if (!applicable || perms == null) {
            promise.resolve(PermissionHelper.status(c))
            return
        }
        if (isNotification) PermissionHelper.markNotificationsAsked(c)
        perms.askForPermissions(PermissionsResponseListener { promise.resolve(PermissionHelper.status(c)) }, permission)
    }

    private fun startFolderPicker(promise: Promise, saveAsDefault: Boolean) {
        if (pendingPick != null) {
            promise.resolve(Json.failure("INTERNAL", "A folder picker is already open"))
            return
        }
        val activity: Activity? = appContext.currentActivity
        if (activity == null) {
            promise.resolve(Json.failure("INTERNAL", "No visible screen to show the folder picker"))
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
        pendingPick = promise
        pendingPickSaves = saveAsDefault
        try {
            activity.startActivityForResult(intent, REQ_PICK_FOLDER)
        } catch (e: Exception) {
            pendingPick = null
            promise.resolve(Json.failure("INTERNAL", e.message ?: "No folder picker available"))
        }
    }

    private fun handlePickResult(resultCode: Int, data: Intent?) {
        val promise = pendingPick ?: return
        pendingPick = null
        val saves = pendingPickSaves
        val tree: Uri? = data?.data
        val c = context
        if (resultCode != Activity.RESULT_OK || tree == null || c == null) {
            promise.resolve(mapOf("ok" to true, "cancelled" to true))
            return
        }
        // Probing touches the disk, so leave the main thread.
        EngineHost.scope.launch {
            val persisted = SafStorageManager.takePersistablePermission(c, tree)
            val path = SafStorageManager.treeToPosixPath(tree)
            val direct = path != null && StorageManager.probeWritable(File(path))
            val mode = if (direct) "direct" else "staging"
            val name = SafStorageManager.displayName(c, tree)
            if (saves) StorageManager.saveCustomFolder(c, tree.toString(), if (direct) path else null, mode, name)
            promise.resolve(
                linkedMapOf(
                    "ok" to true,
                    "uri" to tree.toString(),
                    "displayName" to name,
                    "mode" to mode,
                    "path" to (if (direct) path else null),
                    "permissionPersisted" to persisted,
                ),
            )
            if (saves) EngineHost.emitStorageStatus()
        }
    }

    // endregion
}
