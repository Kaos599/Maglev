package com.maglev.engine

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.maglev.engine.appicon.AppIconManager
import com.maglev.engine.browser.BlocklistException
import com.maglev.engine.browser.BlocklistInfo
import com.maglev.engine.browser.BlocklistStore
import com.maglev.engine.browser.BrowserData
import com.maglev.engine.browser.HistoryWipe
import com.maglev.engine.browser.MaglevBrowserView
import com.maglev.engine.browser.TabStates
import com.maglev.engine.feeds.FeedScheduler
import com.maglev.engine.network.NetworkWatcher
import com.maglev.engine.permissions.PermissionHelper
import com.maglev.engine.schedule.ScheduleManager
import com.maglev.engine.share.TrustedShare
import com.maglev.engine.service.Notifications
import com.maglev.engine.storage.SafStorageManager
import com.maglev.engine.storage.StorageManager
import com.maglev.engine.subtitles.SubtitleException
import com.maglev.engine.subtitles.SubtitleFiles
import com.maglev.engine.subtitles.SubtitleZip
import com.maglev.engine.update.AppUpdater
import com.maglev.engine.update.InstallSource
import com.maglev.engine.update.UpdateNotices
import com.maglev.engine.videosites.VideoSites
import com.maglev.engine.videosites.VideoSitesUpdater
import com.maglev.engine.util.Json
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.modules.ModuleDefinitionBuilder
import kotlinx.coroutines.launch
import java.io.File

/**
 * Expo module `MaglevEngine`. The methods mirror `MaglevEngineApi` in `MaglevEngine.types.ts`.
 * Heavy lifting lives in [EngineHost]; this class only adapts it to JS.
 */
class MaglevEngineModule : Module() {

    companion object {
        private const val REQ_PICK_FOLDER = 7421
    }

    @Volatile
    private var networkWatcher: NetworkWatcher? = null

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

    /** Runs a block list call off the main thread. Failures resolve as the usual `{ ok: false, code, message }`. */
    private fun blocklist(promise: Promise, block: (Context) -> Map<String, Any?>) {
        val c = context
        if (c == null) {
            promise.resolve(Json.failure("ENGINE_UNAVAILABLE", "Module is not attached"))
            return
        }
        EngineHost.ioScope.launch {
            val result = try {
                block(c)
            } catch (e: BlocklistException) {
                Json.failure(e.code, e.message ?: "The block list call failed")
            } catch (t: Throwable) {
                Json.failure("INTERNAL", t.message ?: "The block list call failed")
            }
            promise.resolve(Json.camelize(result))
        }
    }

    /**
     * Runs a subtitle call off the main thread. The result resolves; a [SubtitleException]
     * rejects with its error code, anything else rejects `IO`.
     */
    private fun subtitles(promise: Promise, block: () -> Any?) {
        EngineHost.ioScope.launch {
            val result: Any? = try {
                block()
            } catch (e: SubtitleException) {
                promise.reject(e.code, e.message ?: e.code, null)
                return@launch
            } catch (t: Throwable) {
                promise.reject("IO", t.message ?: "The subtitle call failed", null)
                return@launch
            }
            promise.resolve(result)
        }
    }

    /** Runs a video site lookup off the main thread. Failures resolve as `{ ok: false, code, message }`. */
    private fun videoSitesResolve(promise: Promise, url: String) {
        val c = context
        if (c == null) {
            promise.resolve(Json.failure(VideoSites.UNAVAILABLE, "Video sites aren't available in this build."))
            return
        }
        EngineHost.ioScope.launch {
            val result: Map<String, Any?> = try {
                linkedMapOf("ok" to true, "json" to VideoSites.resolve(c, url))
            } catch (e: VideoSites.VideoSitesException) {
                Json.failure(e.code, e.message ?: e.code)
            } catch (t: Throwable) {
                Json.failure(VideoSites.FAILED, "Couldn't read this video. Try again.")
            }
            promise.resolve(result)
        }
    }

    private fun decodeBase64(b64: String): ByteArray = try {
        android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
        throw SubtitleException("CANT_WRITE", "The subtitle data is not valid")
    }

    private fun requireContext(): Context = context ?: throw SubtitleException("IO", "Module is not attached")

    private fun BlocklistInfo.toResult(): Map<String, Any?> = linkedMapOf(
        "ok" to true,
        "domains" to domains,
        "bytes" to bytes.toDouble(),
        "updatedAt" to updatedAt?.toDouble(),
        "source" to source,
        "urls" to urls,
        "changed" to changed,
    )

    override fun definition() = ModuleDefinition {
        Name("MaglevEngine")

        Events("onTelemetry", "onTorrentCompleted", "onNotificationAction", "onStorageStatus", "onUpdateProgress", "onUpdateResult", "onBlocksChanged", "onNetworkChanged")

        // Network changes are pushed only while JS listens for them.
        OnStartObserving("onNetworkChanged") {
            val watcher = networkWatcher ?: context?.let { c -> NetworkWatcher(c) { n, b -> sendEvent(n, b) } }?.also { networkWatcher = it }
            watcher?.start()
        }
        OnStopObserving("onNetworkChanged") { networkWatcher?.stop() }

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
            networkWatcher?.stop()
            context?.let { AppIconManager.applyPending(it) }
            EngineHost.emitter = null
            pendingPick?.resolve(mapOf("ok" to true, "cancelled" to true))
            pendingPick = null
        }

        // "Clear history when I close Maglev": only when the activity is really finishing, not on a rotation.
        OnActivityDestroys {
            val a = appContext.currentActivity
            if (a != null && a.isFinishing) {
                context?.let { HistoryWipe.wipeIfArmed(it) }
                // Maglev is closing; drop the slept tabs' page states saved so far.
                TabStates.clear()
            }
        }

        OnActivityEntersForeground {
            AppUpdater.inForeground = true
            EngineHost.onForeground()
        }

        // The launcher icon switch waits until the app is out of sight.
        OnActivityEntersBackground {
            AppUpdater.inForeground = false
            EngineHost.onBackground()
            context?.let { AppIconManager.applyPending(it) }
        }

        // region Engine

        AsyncFunction("init") { config: Map<String, Any?>, promise: Promise ->
            engine(promise) { EngineHost.init(config) }
        }
        AsyncFunction("shutdown") { promise: Promise ->
            engine(promise) { EngineHost.shutdownEngine() }
        }
        // Restart the engine session. Blocks for seconds (the session stops, then starts), so it runs off the serialized thread.
        AsyncFunction("restartEngine") { promise: Promise ->
            io(promise) { EngineHost.restartEngine() }
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
        // URL downloads
        AsyncFunction("probeUrl") { url: String, options: Map<String, Any?>?, timeoutMs: Double, promise: Promise ->
            io(promise) { EngineHost.probeUrl(url, options ?: emptyMap(), timeoutMs.toLong()) }
        }
        AsyncFunction("probeStream") { url: String, options: Map<String, Any?>?, timeoutMs: Double, promise: Promise ->
            io(promise) { EngineHost.probeStream(url, options ?: emptyMap(), timeoutMs.toLong()) }
        }
        AsyncFunction("addDownload") { url: String, options: Map<String, Any?>?, promise: Promise ->
            io(promise) { EngineHost.addDownload(url, options ?: emptyMap()) }
        }
        AsyncFunction("pauseDownload") { id: String, promise: Promise ->
            engine(promise) { EngineHost.pauseDownload(id) }
        }
        AsyncFunction("resumeDownload") { id: String, promise: Promise ->
            engine(promise) { EngineHost.resumeDownload(id) }
        }
        AsyncFunction("resumeDownloadAnyway") { id: String, promise: Promise ->
            engine(promise) { EngineHost.resumeDownloadAnyway(id) }
        }
        AsyncFunction("retryDownload") { id: String, promise: Promise ->
            engine(promise) { EngineHost.retryDownload(id) }
        }
        AsyncFunction("removeDownload") { id: String, deleteFiles: Boolean, promise: Promise ->
            io(promise) { EngineHost.removeDownload(id, deleteFiles) }
        }
        AsyncFunction("refreshDownloadUrl") { id: String, url: String, options: Map<String, Any?>?, promise: Promise ->
            io(promise) { EngineHost.refreshDownloadUrl(id, url, options ?: emptyMap()) }
        }
        AsyncFunction("setDownloadLimits") { id: String, limits: Map<String, Any?>, promise: Promise ->
            engine(promise) { EngineHost.setDownloadLimits(id, limits) }
        }
        AsyncFunction("allowLanHost") { id: String, promise: Promise ->
            io(promise) { EngineHost.allowLanHost(id) }
        }
        AsyncFunction("openDownload") { id: String, promise: Promise ->
            engine(promise) { EngineHost.openDownload(id) }
        }
        AsyncFunction("shareDownload") { id: String, promise: Promise ->
            engine(promise) { EngineHost.shareDownload(id) }
        }
        AsyncFunction("getNetworkState") { promise: Promise ->
            engine(promise) { EngineHost.networkState() }
        }
        // Every rule holding transfers now. [] before init. Never rejects.
        AsyncFunction("getActiveBlocks") { promise: Promise ->
            val list = try {
                EngineHost.activeBlocksList()
            } catch (t: Throwable) {
                emptyList<Map<String, Any?>>()
            }
            promise.resolve(list)
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
        AsyncFunction("resumeAnyway") { id: String, promise: Promise ->
            engine(promise) { EngineHost.resumeAnyway(id) }
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
        // A tracker change restarts the torrent's peer sources, so keep it off the serialized thread.
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
        // Debug log. Runs logcat and writes a file, so off the serialized engine thread.
        AsyncFunction("exportDebugLog") { promise: Promise ->
            io(promise) { EngineHost.exportDebugLog() }
        }
        AsyncFunction("shareDebugLog") { uri: String, promise: Promise ->
            io(promise) { EngineHost.shareDebugLog(uri) }
        }
        AsyncFunction("getPlaybackSupport") { promise: Promise ->
            EngineHost.scope.launch { promise.resolve(CodecProbe.get(context)) }
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
        // Fixing missing files can mean a recheck, so these stay off the serialized thread.
        AsyncFunction("setHealth") { id: String, tag: String, promise: Promise ->
            io(promise) { EngineHost.setHealth(id, tag) }
        }
        AsyncFunction("scanFileHealth") { promise: Promise ->
            io(promise) { EngineHost.scanFileHealth() }
        }
        AsyncFunction("fileHealth") { id: String, promise: Promise ->
            io(promise) { EngineHost.fileHealth(id) }
        }
        AsyncFunction("resolveFiles") { id: String, action: String, indices: List<Int>, dir: String, promise: Promise ->
            io(promise) { EngineHost.resolveFiles(id, action, indices, dir) }
        }
        AsyncFunction("openStream") { url: String, mime: String, title: String, promise: Promise ->
            io(promise) { EngineHost.openStream(url, mime, title) }
        }
        AsyncFunction("version") { promise: Promise ->
            native(promise) { NativeCore.nativeVersion() }
        }

        // endregion

        // region Scheduler and feeds

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
        AsyncFunction("openDownloadFolder") { id: String, promise: Promise ->
            engine(promise) { EngineHost.openDownloadFolder(id) }
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
        AsyncFunction("getAppIcon") { promise: Promise ->
            val c = context
            promise.resolve(
                if (c == null) Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
                else mapOf("ok" to true, "id" to AppIconManager.current(c)),
            )
        }
        AsyncFunction("setAppIcon") { id: String, promise: Promise ->
            val err = AppIconManager.request(id)
            promise.resolve(
                if (err == null) mapOf("ok" to true, "id" to id, "appliesWhenLeaving" to true)
                else Json.failure("INVALID_ARGUMENT", err),
            )
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

        // region Video sites (prototype)
        videoSitesFunctions()

        // endregion

        // region Site checks

        // True once if the quick share card just handed the app exactly this link (see TrustedShare), so the add screen
        // can read a shared link without a tap while an outside maglev:// link still waits.
        AsyncFunction("consumeTrustedShare") { url: String, promise: Promise ->
            promise.resolve(TrustedShare.consume(url))
        }

        // Cookies the shared WebView jar holds for a URL ("a=1; b=2"), or "" when none.
        // CookieManager.getCookie includes HttpOnly cookies such as cf_clearance.
        AsyncFunction("getCookies") { url: String, promise: Promise ->
            promise.resolve(runCatching { android.webkit.CookieManager.getInstance().getCookie(url) }.getOrNull() ?: "")
        }

        // Expires every cookie the jar returns for each URL (hosts the user passed a check on, or a private session
        // visited). Returns how many names were expired.
        // CookieManager.setCookie(url, value): "Any existing cookie with the same host, path and name will be replaced";
        // an already-expired value (Max-Age=0) is how the Chromium jar deletes. getCookie(url) only returns cookies that
        // match that URL (host-only cookies of www.site.com are NOT returned for https://site.com/), so callers pass
        // each host they care about. Per name this expires the host-only form and the Domain=.host form, each at "/" and
        // at every directory of the URL's own path, with Secure set so __Secure-/__Host- cookies are accepted.
        // https://developer.android.com/reference/android/webkit/CookieManager#setCookie(java.lang.String,%20java.lang.String)
        AsyncFunction("clearCookies") { urls: List<String>, promise: Promise ->
            var removed = 0
            runCatching {
                val cm = android.webkit.CookieManager.getInstance()
                for (url in urls) {
                    val parsed = Uri.parse(url)
                    val host = parsed.host ?: continue
                    val names = cm.getCookie(url)?.split(";")?.map { it.substringBefore("=").trim() }?.filter { it.isNotEmpty() }?.distinct() ?: continue
                    val paths = linkedSetOf("/")
                    var dir = ""
                    for (seg in (parsed.path ?: "").split("/").filter { it.isNotEmpty() }.dropLast(1)) {
                        dir += "/$seg"
                        paths.add(dir)
                    }
                    for (name in names) {
                        for (path in paths) {
                            cm.setCookie(url, "$name=; Max-Age=0; Path=$path; Secure")
                            cm.setCookie(url, "$name=; Domain=.$host; Max-Age=0; Path=$path; Secure")
                        }
                        removed++
                    }
                }
                cm.flush()
            }
            promise.resolve(removed)
        }

        // endregion

        // region Subtitles

        // OpenSubtitles 64-bit hash of a finished video. Errors: FILE_TOO_SMALL, NOT_FOUND, IO.
        AsyncFunction("subtitleHash") { pathOrUri: String, promise: Promise ->
            subtitles(promise) {
                val (hash, bytes) = SubtitleFiles.hash(requireContext(), pathOrUri)
                linkedMapOf("hash" to hash, "bytes" to bytes.toDouble())
            }
        }

        // Writes a subtitle next to the video. Errors: NAME_TAKEN, VERIFY_FAILED, CANT_WRITE, NO_SPACE.
        AsyncFunction("saveSubtitle") { videoPathOrUri: String, fileName: String, base64: String, replace: Boolean, promise: Promise ->
            subtitles(promise) {
                val data = decodeBase64(base64)
                val path = SubtitleFiles.save(requireContext(), videoPathOrUri, fileName, data, replace)
                linkedMapOf("path" to path)
            }
        }

        // Subtitle members of a zip, in memory. Error: ARCHIVE_UNSAFE.
        AsyncFunction("unzipSubtitles") { base64: String, promise: Promise ->
            subtitles(promise) {
                val zip = try {
                    android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
                } catch (e: IllegalArgumentException) {
                    throw SubtitleException("ARCHIVE_UNSAFE", "This is not a readable zip")
                }
                SubtitleZip.unzip(zip).map {
                    linkedMapOf("name" to it.name, "base64" to android.util.Base64.encodeToString(it.bytes, android.util.Base64.NO_WRAP))
                }
            }
        }

        // endregion

        // region Browser

        // `options.conditional` sends If-None-Match / If-Modified-Since. The result carries `changed`.
        AsyncFunction("updateBlocklist") { urls: List<String>, options: Map<String, Any?>, promise: Promise ->
            val conditional = options["conditional"] == true
            blocklist(promise) { c -> BlocklistStore.update(c, urls, conditional).toResult() }
        }
        // Checks a signed list file against the key embedded in the app. Never throws.
        AsyncFunction("verifyListSignature") { body: String, sigB64: String, promise: Promise ->
            promise.resolve(com.maglev.engine.lists.ListSignature.verify(body, sigB64))
        }
        AsyncFunction("getBlocklistInfo") { promise: Promise ->
            blocklist(promise) { c -> BlocklistStore.info(c).toResult() }
        }
        AsyncFunction("resetBlocklist") { promise: Promise ->
            blocklist(promise) { c ->
                BlocklistStore.reset(c)
                BlocklistStore.info(c).toResult()
            }
        }
        // Cookies and web storage (`cookies`), cache and form data (`cache`). History is cleared by the JS store.
        // Works without the view mounted.
        AsyncFunction("clearBrowserData") { options: Map<String, Any?>, promise: Promise ->
            val c = context
            if (c == null) {
                promise.resolve(Json.failure("ENGINE_UNAVAILABLE", "Module is not attached"))
            } else {
                BrowserData.clear(c, null, options["cookies"] == true, options["cache"] == true) { promise.resolve(mapOf("ok" to true)) }
            }
        }

        // The "Clear history when I close Maglev" flag. JS sends it at start and on every change.
        AsyncFunction("setHistoryWipeOnClose") { enabled: Boolean, promise: Promise ->
            val c = context
            if (c == null) {
                promise.resolve(Json.failure("ENGINE_UNAVAILABLE", "Module is not attached"))
            } else {
                HistoryWipe.setArmed(c, enabled)
                promise.resolve(mapOf("ok" to true))
            }
        }

        // How many times the history was emptied because Maglev closed. JS compares it with the last count it saw.
        AsyncFunction("getHistoryWipeCount") { promise: Promise ->
            val c = context
            promise.resolve(if (c == null) 0 else HistoryWipe.wipeCount(c))
        }

        // Keep only the saved page states of these tabs (every tab that still exists). JS calls it on each tab change.
        AsyncFunction("retainTabStates") { ids: List<String>, promise: Promise ->
            TabStates.retain(ids)
            promise.resolve(null)
        }

        // Forget every saved page state (history cleared).
        AsyncFunction("clearTabStates") { promise: Promise ->
            TabStates.clear()
            promise.resolve(null)
        }

        View(MaglevBrowserView::class) {
            Events("onPage", "onFound", "onBlockedCount", "onDownloadRequest", "onMagnet", "onRefused", "onCrashed", "onPageNote",
                "onNewWindow", "onPopupRequest", "onPopupBlocked", "onLongPress", "onFindResult", "onMediaHit",
                "onReloadState")

            Prop("url") { view: MaglevBrowserView, url: String -> view.setUrl(url) }
            Prop("urlSource") { view: MaglevBrowserView, source: String -> view.setUrlSource(source) }
            Prop("tabId") { view: MaglevBrowserView, id: String -> view.setTabId(id) }
            Prop("adBlock") { view: MaglevBrowserView, enabled: Boolean -> view.setAdBlock(enabled) }
            Prop("allowAdsHosts") { view: MaglevBrowserView, hosts: List<String> -> view.setAllowAdsHosts(hosts) }
            Prop("desktopMode") { view: MaglevBrowserView, enabled: Boolean -> view.setDesktopMode(enabled) }
            Prop("active") { view: MaglevBrowserView, value: Boolean -> view.setActive(value) }
            Prop("popupPolicy") { view: MaglevBrowserView, value: String -> view.setPopupPolicy(value) }
            Prop("popupAllowHosts") { view: MaglevBrowserView, hosts: List<String> -> view.setPopupAllowHosts(hosts) }
            Prop("popupBlockHosts") { view: MaglevBrowserView, hosts: List<String> -> view.setPopupBlockHosts(hosts) }
            Prop("textZoom") { view: MaglevBrowserView, value: Int -> view.setTextZoom(value) }
            Prop("privateMode") { view: MaglevBrowserView, value: Boolean -> view.setPrivateMode(value) }
            Prop("pullToRefresh") { view: MaglevBrowserView, value: Boolean -> view.setPullToRefresh(value) }
            Prop("blockThirdPartyCookies") { view: MaglevBrowserView, value: Boolean -> view.setBlockThirdPartyCookies(value) }
            Prop("httpsFirst") { view: MaglevBrowserView, value: Boolean -> view.setHttpsFirst(value) }
            Prop("refreshColor") { view: MaglevBrowserView, value: String -> view.setRefreshColor(value) }
            Prop("refreshBackground") { view: MaglevBrowserView, value: String -> view.setRefreshBackground(value) }
            Prop("darkPages") { view: MaglevBrowserView, value: Boolean -> view.setDarkPages(value) }
            Prop("mediaHitScript") { view: MaglevBrowserView, value: String -> view.setMediaHitScript(value) }

            AsyncFunction("goBack") { view: MaglevBrowserView -> view.goBack() }
            AsyncFunction("goForward") { view: MaglevBrowserView -> view.goForward() }
            AsyncFunction("reload") { view: MaglevBrowserView -> view.reload() }
            AsyncFunction("stop") { view: MaglevBrowserView -> view.stop() }
            AsyncFunction("loadUrl") { view: MaglevBrowserView, url: String -> view.loadTyped(url) }
            AsyncFunction("scan") { view: MaglevBrowserView -> view.scan() }
            AsyncFunction("resetFound") { view: MaglevBrowserView, promise: Promise -> view.resetFound(promise) }
            AsyncFunction("clearData") { view: MaglevBrowserView, options: Map<String, Any?> ->
                view.clearData(options["cookies"] == true, options["cache"] == true)
            }
            AsyncFunction("followRedirect") { view: MaglevBrowserView, url: String, promise: Promise -> view.followRedirect(url, promise) }
            AsyncFunction("openApp") { view: MaglevBrowserView, url: String, promise: Promise -> view.openApp(url, promise) }
            AsyncFunction("clearHistoryList") { view: MaglevBrowserView -> view.clearHistoryList() }
            AsyncFunction("clearSiteStorage") { view: MaglevBrowserView -> view.clearSiteStorage() }
            AsyncFunction("findInPage") { view: MaglevBrowserView, query: String, promise: Promise -> view.findInPage(query, promise) }
            AsyncFunction("findNext") { view: MaglevBrowserView, forward: Boolean, promise: Promise -> view.findNext(forward, promise) }
            AsyncFunction("clearFind") { view: MaglevBrowserView, promise: Promise -> view.clearFind(promise) }

            OnViewDidUpdateProps { view: MaglevBrowserView -> view.applyProps() }
            OnViewDestroys { view: MaglevBrowserView -> view.destroyBrowser() }
        }

        // endregion

        // region In-app updates
        updateFunctions()

        // endregion

        // region Governance

        AsyncFunction("setGovernance") { rules: Map<String, Any?>, promise: Promise ->
            engine(promise) {
                @Suppress("UNCHECKED_CAST")
                val ssids = (rules["ssidWhitelist"] as? List<Any?>)?.mapNotNull { it?.toString() } ?: emptyList()
                // Read headless by RestartEntry after a reboot or update, so it lives in SharedPreferences.
                context?.let { RestartPrefs.setResumeAfterRestart(it, rules["resumeAfterRestart"] != false) }
                // Quick share reads these headless, in its own activity.
                context?.let { com.maglev.engine.share.QuickSharePrefs.save(it, rules) }
                // Hide from gallery and automatic retry are read in Kotlin only (never sent to Rust).
                context?.let { c ->
                    com.maglev.engine.storage.GalleryHide.save(c, rules)
                    AutoRetry.save(c, rules)
                    EngineHost.ioScope.launch { com.maglev.engine.storage.GalleryHide.apply(c) }
                }
                EngineHost.setGovernance(
                    Governance(
                        wifiOnly = rules["wifiOnly"] == true,
                        ssidWhitelist = ssids,
                        chargingOnly = rules["chargingOnly"] == true,
                        batteryCutoffPct = (rules["batteryCutoffPct"] as? Number)?.toInt() ?: 0,
                        autoExitOnComplete = rules["autoExitOnComplete"] == true,
                        vpnOnly = rules["vpnOnly"] == true,
                        seedOnMobileData = rules["seedOnMobileData"] == true,
                    ),
                )
            }
        }

        // endregion
    }

    // region Definition parts
    // definition() hit the JVM 64 KB method limit (MethodTooLargeException in CI run 45378913724): every
    // AsyncFunction lambda is inlined into it. These member extensions move groups of functions into their own
    // methods. Called from definition(); behaviour is unchanged.

    private fun ModuleDefinitionBuilder.videoSitesFunctions() {

        // The page's video files as trimmed yt-dlp JSON text: `{ ok: true, json }`. Errors: SITE_NOT_SUPPORTED,
        // SITE_NEEDS_LOGIN, SITE_FAILED, VIDEO_SITES_UNAVAILABLE. Starts the library on the first call, off the main thread.
        AsyncFunction("videoSitesResolve") { url: String, promise: Promise ->
            videoSitesResolve(promise, url)
        }
        // Downloads the newest yt-dlp: `{ ok: true, status: 'updated' | 'current' | 'failed', version }`. Off the main thread.
        AsyncFunction("videoSitesUpdate") { promise: Promise ->
            val c = context
            if (c == null) {
                promise.resolve(Json.failure(VideoSites.UNAVAILABLE, "Video sites aren't available in this build."))
            } else {
                EngineHost.ioScope.launch {
                    val r = VideoSites.update(c, true)
                    promise.resolve(linkedMapOf("ok" to true, "status" to r.status, "version" to r.version))
                }
            }
        }
        // The version of the yt-dlp that runs (read from the file), or null before the first read put one in place.
        AsyncFunction("videoSitesVersion") { promise: Promise ->
            val c = context
            promise.resolve(if (c == null) null else VideoSites.versionLabel(c))
        }
        // What the Settings row shows: `{ version, lastCheckAt }` (version of the yt-dlp that runs, null before the
        // first read put one in place; lastCheckAt epoch ms or null when never checked).
        AsyncFunction("videoSitesStatus") { promise: Promise ->
            val c = context
            if (c == null) {
                promise.resolve(linkedMapOf("version" to null, "lastCheckAt" to null))
            } else {
                EngineHost.ioScope.launch {
                    val last = VideoSites.lastCheck(c)
                    promise.resolve(linkedMapOf("version" to VideoSites.versionLabel(c), "lastCheckAt" to (if (last > 0L) last else null)))
                }
            }
        }
        // Schedules (enabled) or cancels the daily background yt-dlp update. `mobileData` allows a metered network.
        AsyncFunction("videoSitesConfigure") { enabled: Boolean, mobileData: Boolean ->
            context?.let { VideoSitesUpdater.apply(it, enabled, mobileData) }
            true
        }

    }

    private fun ModuleDefinitionBuilder.updateFunctions() {

        AsyncFunction("getInstallSource") { promise: Promise ->
            val c = context
            if (c == null) {
                promise.resolve(Json.failure("ENGINE_UNAVAILABLE", "Module is not attached"))
            } else {
                EngineHost.ioScope.launch {
                    val installer = InstallSource.installer(c)
                    promise.resolve(mapOf("ok" to true, "installer" to installer, "managedBy" to InstallSource.managedBy(installer), "versionCode" to AppUpdater.installedVersionCode(c)?.toDouble()))
                }
            }
        }
        // Blocks for the whole download, so it stays off the serialized engine thread. A second call joins the first.
        AsyncFunction("downloadUpdate") { url: String, sha256: String, size: Double, requireVpn: Boolean, promise: Promise ->
            val c = context
            if (c == null) {
                promise.resolve(Json.failure("ENGINE_UNAVAILABLE", "Module is not attached"))
            } else {
                EngineHost.ioScope.launch { promise.resolve(Json.camelize(AppUpdater.download(c, url, sha256, size.toLong(), requireVpn))) }
            }
        }
        AsyncFunction("getUpdateNetwork") { promise: Promise ->
            val c = context
            promise.resolve(if (c == null) Json.failure("ENGINE_UNAVAILABLE", "Module is not attached") else AppUpdater.network(c))
        }
        AsyncFunction("cancelUpdateDownload") { promise: Promise ->
            AppUpdater.cancelDownload()
            promise.resolve(mapOf("ok" to true))
        }
        AsyncFunction("installUpdate") { path: String, silent: Boolean, sha256: String, promise: Promise ->
            val c = context
            if (c == null) {
                promise.resolve(Json.failure("ENGINE_UNAVAILABLE", "Module is not attached"))
            } else {
                EngineHost.ioScope.launch { promise.resolve(Json.camelize(AppUpdater.install(c, path, silent, sha256))) }
            }
        }
        AsyncFunction("openInstallPermissionSettings") { promise: Promise ->
            val c = context
            val err = if (c == null) "Module is not attached" else AppUpdater.openInstallPermissionSettings(c)
            promise.resolve(if (err == null) mapOf("ok" to true) else Json.failure("INTERNAL", err))
        }
        AsyncFunction("cleanupUpdates") { keepPath: String?, keepSha: String?, promise: Promise ->
            val c = context
            if (c == null) {
                promise.resolve(Json.failure("ENGINE_UNAVAILABLE", "Module is not attached"))
            } else {
                EngineHost.ioScope.launch {
                    AppUpdater.cleanup(c, keepPath, keepSha)
                    promise.resolve(mapOf("ok" to true))
                }
            }
        }
        // kind: "available" | "ready". The "updated" notice comes from UpdateReplacedReceiver.
        AsyncFunction("postUpdateNotice") { kind: String, version: String, path: String?, sha256: String?, promise: Promise ->
            val c = context
            val shown = c != null && (kind == "available" || kind == "ready") && UpdateNotices.show(c, kind, version, path, sha256)
            promise.resolve(if (shown) mapOf("ok" to true) else Json.failure("INVALID_ARGUMENT", "Unknown notice"))
        }
        AsyncFunction("clearUpdateNotice") { kind: String, promise: Promise ->
            context?.let { UpdateNotices.clear(it, kind) }
            promise.resolve(mapOf("ok" to true))
        }

    }

    // endregion

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
            if (saves) com.maglev.engine.storage.GalleryHide.apply(c) // the folder changed: re-check the .nomedia
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
