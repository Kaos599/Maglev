package com.maglev.engine

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import com.maglev.engine.network.NetworkGovernanceManager
import com.maglev.engine.power.PowerGovernanceManager
import com.maglev.engine.service.MaglevTorrentService
import com.maglev.engine.service.Notifications
import com.maglev.engine.service.TransferSummary
import com.maglev.engine.storage.FileActions
import com.maglev.engine.storage.SafStorageManager
import com.maglev.engine.storage.StorageManager
import com.maglev.engine.util.Json
import com.maglev.engine.util.TorrentFetcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** User-visible governance rules (contract section 6). */
data class Governance(
    val wifiOnly: Boolean = false,
    val ssidWhitelist: List<String> = emptyList(),
    val chargingOnly: Boolean = false,
    val batteryCutoffPct: Int = 0,
    val autoExitOnComplete: Boolean = false,
)

/**
 * Process-wide owner of the engine. The Expo module and the foreground service both talk to this object,
 * so downloads keep running when the JS context is gone.
 */
object EngineHost {
    private const val TAG = "MaglevEngine"
    const val PREFS = "maglev_engine"
    private const val KEY_FGS_TIMEOUT = "fgs_timeout"
    private const val KEY_WANTED = "service_wanted"
    private const val KEY_ALIVE_AT = "last_alive_at"
    const val KEY_KILLS = "background_kills"
    const val GOV_PREFS = "maglev_governance"
    const val ENGINE_PREFS = PREFS
    private const val REASON_FGS_TIMEOUT = "fgs_timeout"
    private const val SERVICE_RETRY_MS = 10_000L
    private const val COPY_RETRY_MS = 60_000L
    private const val INIT_GIVE_UP_MS = 10 * 60_000L

    @Volatile private var ctx: Context? = null

    /** Set by the Expo module while JS is alive. Delivers events to JS. */
    @Volatile var emitter: ((String, Map<String, Any?>) -> Unit)? = null

    /** Serializes JNI calls issued on behalf of JS. */
    private val controlExecutor = Executors.newSingleThreadExecutor { Thread(it, "maglev-control") }
    private val control: ExecutorCoroutineDispatcher = controlExecutor.asCoroutineDispatcher()
    private val pollExecutor = Executors.newSingleThreadExecutor { Thread(it, "maglev-poll") }
    private val pollDispatcher: ExecutorCoroutineDispatcher = pollExecutor.asCoroutineDispatcher()

    val scope = CoroutineScope(SupervisorJob() + control)
    private val pollScope = CoroutineScope(SupervisorJob() + pollDispatcher)
    val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile private var initialized = false
    private var pollJob: Job? = null
    private val prevFinished = HashMap<String, Boolean>()
    private val pollLock = Any()
    private var initOnlySince = 0L
    private val cancelledCopies = ConcurrentHashMap.newKeySet<String>()
    private var sawDownloading = false
    private var autoExitFired = false

    @Volatile private var governance = Governance()
    private val lastAllowed = HashMap<String, Boolean>()
    private var net: NetworkGovernanceManager? = null
    private var power: PowerGovernanceManager? = null

    @Volatile private var holdForPaused = false
    @Volatile private var serviceBlocked = false
    private var lastServiceAttempt = 0L
    private var lastHeartbeat = 0L

    private val copying = ConcurrentHashMap.newKeySet<String>()
    private val copyFailedAt = ConcurrentHashMap<String, Long>()
    @Volatile private var lastCopyError: String? = null

    private val bitfieldBuffer: ByteBuffer by lazy { ByteBuffer.allocateDirect(256) }

    fun attach(context: Context) {
        if (ctx == null) {
            ctx = context.applicationContext
            governance = loadGovernance(context.applicationContext)
        }
    }

    private fun loadGovernance(c: Context): Governance {
        val p = c.getSharedPreferences(GOV_PREFS, Context.MODE_PRIVATE)
        return Governance(
            wifiOnly = p.getBoolean("wifiOnly", false),
            ssidWhitelist = (p.getString("ssids", "") ?: "").split('\n').filter { it.isNotBlank() },
            chargingOnly = p.getBoolean("chargingOnly", false),
            batteryCutoffPct = p.getInt("batteryCutoffPct", 0),
            autoExitOnComplete = p.getBoolean("autoExitOnComplete", false),
        )
    }

    private fun saveGovernance(c: Context, g: Governance) {
        c.getSharedPreferences(GOV_PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("wifiOnly", g.wifiOnly)
            .putString("ssids", g.ssidWhitelist.joinToString("\n"))
            .putBoolean("chargingOnly", g.chargingOnly)
            .putInt("batteryCutoffPct", g.batteryCutoffPct)
            .putBoolean("autoExitOnComplete", g.autoExitOnComplete)
            .apply()
    }

    private fun requireCtx(): Context? = ctx

    // region raw native calls

    /** Runs a native call and decodes the envelope. Never throws. */
    fun call(block: () -> String): Map<String, Any?> {
        if (!NativeCore.loaded) {
            return Json.failure("ENGINE_UNAVAILABLE", NativeCore.loadError ?: "Engine library is not loaded")
        }
        return try {
            Json.parseObject(block())
        } catch (t: Throwable) {
            Log.w(TAG, "native call failed", t)
            Json.failure("INTERNAL", t.message ?: "Engine call failed")
        }
    }

    private fun isOk(m: Map<String, Any?>) = m["ok"] == true

    // endregion

    // region lifecycle

    /**
     * JS entry point. Idempotent: if the engine was already started headlessly after a process restart,
     * the JS config is applied to the running engine instead of starting a second one.
     */
    fun init(config: Map<String, Any?>): Map<String, Any?> {
        val configJson = Json.toJson(Json.snakeify(config))
        if (initialized) {
            val applied = call { NativeCore.nativeApplyConfig(configJson) }
            startPolling()
            emitStorageStatus()
            val out = LinkedHashMap<String, Any?>(applied)
            out["ok"] = true
            out["alreadyRunning"] = true
            out["storage"] = storageStatus()
            return out
        }
        return startEngine(configJson)
    }

    /** Starts the native session. [configJson] of "" makes Rust load its last persisted config. */
    private fun startEngine(configJson: String): Map<String, Any?> {
        val c = requireCtx() ?: return Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
        if (!NativeCore.loaded) {
            return Json.failure("ENGINE_UNAVAILABLE", NativeCore.loadError ?: "Engine library is not loaded")
        }
        val target = StorageManager.activeTarget(c)
        val session = StorageManager.sessionDir(c).absolutePath
        val res = call { NativeCore.nativeInit(configJson, session, target.path) }
        if (!isOk(res)) return res

        initialized = true
        liftFgsTimeoutBlock(c)
        synchronized(prevFinished) { prevFinished.clear() }
        initOnlySince = 0L
        sawDownloading = false
        autoExitFired = false
        lastAllowed.clear()
        startGovernanceWatchers(c)
        evaluateGovernance(force = true)
        startPolling()
        emitStorageStatus()
        return LinkedHashMap(res).apply { put("storage", storageStatus()) }
    }

    /**
     * The "fgs_timeout" governance block persists inside Rust. Lift it whenever the app has not timed out
     * (flag false). The flag itself is cleared by [onForeground] only after the unblock call succeeded.
     */
    private fun liftFgsTimeoutBlock(c: Context) {
        if (!prefs(c).getBoolean(KEY_FGS_TIMEOUT, false)) {
            call { NativeCore.nativeSetTransfersAllowed(true, REASON_FGS_TIMEOUT) }
        }
    }

    /**
     * Sequence for a sticky restart with a null intent and no JS: the service has already called startForeground.
     * 1. Count a background kill if the previous run never stopped cleanly.
     * 2. If the user stopped transfers ("service wanted" is false), stop the service.
     * 3. Start the engine from Rust's persisted config, with governance rules restored from SharedPreferences.
     * 4. Poll once. If nothing is active or rule-paused, stop the service. Otherwise the poller keeps running.
     */
    fun headlessStart() {
        scope.launch {
            val c = ctx ?: return@launch
            val p = prefs(c)
            if (p.getLong(KEY_ALIVE_AT, 0L) > 0L) {
                p.edit().putInt(KEY_KILLS, p.getInt(KEY_KILLS, 0) + 1).apply()
            }
            if (!p.getBoolean(KEY_WANTED, false)) {
                stopService()
                return@launch
            }
            if (!initialized) {
                val res = startEngine("")
                if (!isOk(res)) {
                    Log.w(TAG, "headless init failed: ${res["code"]}")
                    stopService()
                    return@launch
                }
            }
            val list = call { NativeCore.nativeListTorrents() }
            val summary = summarize(Json.list(list["torrents"]))
            if (summary.busy == 0 && summary.pausedByRules == 0) {
                setWanted(c, false)
                stopService()
            } else {
                pollNow()
            }
        }
    }

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun setWanted(c: Context, wanted: Boolean) {
        val p = prefs(c)
        if (p.getBoolean(KEY_WANTED, false) != wanted) p.edit().putBoolean(KEY_WANTED, wanted).apply()
    }

    /** Called by the service when it is destroyed normally. A missing heartbeat on restart means the process was killed. */
    fun markCleanStop() {
        ctx?.let { prefs(it).edit().putLong(KEY_ALIVE_AT, 0L).apply() }
    }

    private fun heartbeat(c: Context) {
        val now = System.currentTimeMillis()
        if (now - lastHeartbeat >= 30_000L) {
            lastHeartbeat = now
            prefs(c).edit().putLong(KEY_ALIVE_AT, now).apply()
        }
    }

    /** Stops the engine, the poller, the governance watchers and the service. */
    fun shutdownEngine(): Map<String, Any?> {
        initialized = false
        pollJob?.cancel()
        pollJob = null
        net?.stop(); net = null
        power?.stop(); power = null
        holdForPaused = false
        // Taking the poll lock waits for an in-flight poll. Later polls see initialized == false and return.
        val res = synchronized(pollLock) { call { NativeCore.nativeShutdown() } }
        stopService()
        ctx?.let {
            Notifications.cancel(it, Notifications.ID_ONGOING)
            setWanted(it, false) // last, once the poller is quiet
        }
        return res
    }

    /** Shutdown requested from the notification or by auto-exit: stop everything, tell JS, close the app task. */
    private fun shutdownAndExit() {
        scope.launch {
            shutdownEngine()
            emit("onNotificationAction", mapOf("action" to "shutdown"))
            finishAppTasks()
        }
    }

    private fun finishAppTasks() {
        val c = ctx ?: return
        try {
            val am = c.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            am.appTasks.forEach { it.finishAndRemoveTask() }
        } catch (e: Exception) {
            Log.w(TAG, "could not finish app tasks: ${e.message}")
        }
    }

    fun onForeground() {
        holdForPaused = false
        val c = ctx ?: return
        val p = prefs(c)
        if (p.getBoolean(KEY_FGS_TIMEOUT, false)) {
            scope.launch {
                if (!initialized) {
                    // startEngine lifts the block when the flag is clear.
                    p.edit().putBoolean(KEY_FGS_TIMEOUT, false).apply()
                } else if (isOk(call { NativeCore.nativeSetTransfersAllowed(true, REASON_FGS_TIMEOUT) })) {
                    p.edit().putBoolean(KEY_FGS_TIMEOUT, false).apply()
                }
                pollNow()
            }
        }
        if (initialized) {
            ioScope.launch { checkSafPermission()?.let { emitStorageStatus() } }
        }
    }

    // endregion

    // region polling

    private fun hasObserver() = emitter != null || MaglevTorrentService.instance != null

    private fun startPolling() {
        if (pollJob?.isActive == true) return
        pollJob = pollScope.launch {
            while (isActive && initialized) {
                val started = SystemClock.elapsedRealtime()
                if (hasObserver()) {
                    try {
                        pollOnce()
                    } catch (t: Throwable) {
                        Log.w(TAG, "poll failed", t)
                    }
                }
                delay((1000 - (SystemClock.elapsedRealtime() - started)).coerceAtLeast(100))
            }
        }
    }

    /** Polls immediately, used after state-changing calls so the service and locks react fast. */
    fun pollNow() {
        if (!initialized) return
        pollScope.launch {
            try {
                pollOnce()
            } catch (t: Throwable) {
                Log.w(TAG, "poll failed", t)
            }
        }
    }

    private fun pollOnce() {
        synchronized(pollLock) { pollLocked() }
    }

    private fun pollLocked() {
        if (!initialized) return
        val res = call { NativeCore.nativeListTorrents() }
        if (!isOk(res)) {
            if (res["code"] == "NOT_INITIALIZED") initialized = false
            return
        }
        ctx?.let { heartbeat(it) }
        val torrents = Json.list(res["torrents"])
        detectCompletions(torrents)
        val summary = summarize(torrents)
        @Suppress("UNCHECKED_CAST")
        val body = LinkedHashMap(Json.camelize(res) as Map<String, Any?>)
        body["serviceBlocked"] = serviceBlocked
        emit("onTelemetry", body)
        driveService(summary)
        copyStagedTorrents(torrents)
        checkAutoExit(torrents)
    }

    private fun isFinished(t: Map<String, Any?>): Boolean {
        (t["finished"] as? Boolean)?.let { return it }
        val total = Json.long(t["total_bytes"])
        return total > 0 && Json.long(t["progress_bytes"]) >= total
    }

    private fun summarize(torrents: List<Map<String, Any?>>): TransferSummary {
        var dl = 0; var seed = 0; var queued = 0; var paused = 0; var byRules = 0
        var checking = 0; var init = 0
        var done = 0L; var total = 0L; var down = 0L; var up = 0L
        for (t in torrents) {
            when (t["state"]) {
                "DOWNLOADING" -> { dl++; done += Json.long(t["progress_bytes"]); total += Json.long(t["total_bytes"]) }
                "SEEDING" -> seed++
                "QUEUED" -> { queued++; done += Json.long(t["progress_bytes"]); total += Json.long(t["total_bytes"]) }
                "CHECKING" -> { checking++; done += Json.long(t["progress_bytes"]); total += Json.long(t["total_bytes"]) }
                "INITIALIZING" -> init++
                "PAUSED" -> when (t["paused_by"]) {
                    null, "user" -> paused++
                    "wifi_only", "battery", "charging_only" -> byRules++
                }
            }
            down += Json.long(t["down_bps"])
            up += Json.long(t["up_bps"])
        }
        // A torrent stuck in INITIALIZING (no metadata, no peers) must not hold the service forever.
        val initOnly = init > 0 && dl + seed + queued + checking == 0
        val now = SystemClock.elapsedRealtime()
        if (initOnly) {
            if (initOnlySince == 0L) initOnlySince = now
        } else {
            initOnlySince = 0L
        }
        val effectiveInit = if (initOnly && now - initOnlySince > INIT_GIVE_UP_MS) 0 else init
        val pct = if (dl + queued + checking > 0 && total > 0) ((done * 100) / total).toInt().coerceIn(0, 100) else -1
        return TransferSummary(dl, seed, queued, paused, pct, down, up, byRules, checking, effectiveInit)
    }

    /** Fires onTorrentCompleted and the notification on the `finished` false to true edge. */
    private fun detectCompletions(torrents: List<Map<String, Any?>>) {
        val c = ctx
        synchronized(prevFinished) {
            for (t in torrents) {
                val id = t["id"] as? String ?: continue
                val finished = isFinished(t)
                val prev = prevFinished[id]
                if (t["state"] == "DOWNLOADING") sawDownloading = true
                if (prev == false && finished) {
                    val name = t["name"] as? String ?: id
                    emit("onTorrentCompleted", mapOf("id" to id, "name" to name))
                    if (c != null) Notifications.notifyCompleted(c, id, name)
                }
                prevFinished[id] = finished
            }
            val alive = torrents.mapNotNull { it["id"] as? String }.toSet()
            prevFinished.keys.retainAll(alive)
        }
    }

    // endregion

    // region service

    private fun driveService(s: TransferSummary) {
        val c = ctx ?: return
        if (!initialized) return
        val timedOut = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_FGS_TIMEOUT, false)
        if (s.active == 0 && s.pausedByUser == 0) holdForPaused = false
        // Wanted = real work exists. A rules-paused torrent counts: it must resume by itself when Wi-Fi or power returns.
        if (initialized) setWanted(c, s.busy > 0 || s.pausedByRules > 0)
        val shouldRun = !timedOut && (s.busy > 0 || s.pausedByRules > 0 || (holdForPaused && s.pausedByUser > 0))
        val svc = MaglevTorrentService.instance
        if (shouldRun) {
            if (svc != null) {
                svc.onSummary(s)
            } else if (initialized) {
                ensureServiceStarted(c)
            }
        } else if (svc != null && svc.isForeground) {
            stopService()
        }
    }

    private fun ensureServiceStarted(c: Context) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastServiceAttempt < SERVICE_RETRY_MS) return
        lastServiceAttempt = now
        try {
            ContextCompat.startForegroundService(
                c, Intent(c, MaglevTorrentService::class.java).setAction(MaglevTorrentService.ACTION_START),
            )
            serviceBlocked = false
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException on API 31+ when the app is in the background.
            onServiceStartBlocked(e.message ?: e.javaClass.simpleName)
        }
    }

    fun onServiceStartBlocked(reason: String) {
        Log.w(TAG, "foreground service could not start: $reason")
        serviceBlocked = true
    }

    private fun stopService() {
        val c = ctx ?: return
        try {
            c.stopService(Intent(c, MaglevTorrentService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "stopService failed: ${e.message}")
        }
    }

    /** Called from the service on the Android 15 dataSync timeout. */
    fun onFgsTimeout() {
        val c = ctx ?: return
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_FGS_TIMEOUT, true).apply()
        scope.launch { call { NativeCore.nativeSetTransfersAllowed(false, REASON_FGS_TIMEOUT) } }
    }

    fun pauseAllFromNotification() {
        scope.launch {
            pauseAll()
            holdForPaused = true
            emit("onNotificationAction", mapOf("action" to "pause_all"))
            pollNow()
        }
    }

    fun resumeAllFromNotification() {
        scope.launch {
            resumeAll()
            holdForPaused = false
            emit("onNotificationAction", mapOf("action" to "resume_all"))
            pollNow()
        }
    }

    fun shutdownFromNotification() = shutdownAndExit()

    // endregion

    // region bulk actions

    fun pauseAll(): Map<String, Any?> {
        ctx?.let { setWanted(it, false) }
        val list = call { NativeCore.nativeListTorrents() }
        if (!isOk(list)) return list
        var n = 0
        for (t in Json.list(list["torrents"])) {
            if ((t["state"] as? String) in setOf("DOWNLOADING", "SEEDING", "QUEUED", "INITIALIZING")) {
                val id = t["id"] as? String ?: continue
                if (isOk(call { NativeCore.nativePause(id) })) n++
            }
        }
        pollNow()
        return linkedMapOf("ok" to true, "count" to n)
    }

    /** Resumes user-paused torrents. Governance-paused ones stay paused until their gate opens. */
    fun resumeAll(): Map<String, Any?> {
        val list = call { NativeCore.nativeListTorrents() }
        if (!isOk(list)) return list
        var n = 0
        for (t in Json.list(list["torrents"])) {
            val by = t["paused_by"]
            if (t["state"] == "PAUSED" && (by == null || by == "user")) {
                val id = t["id"] as? String ?: continue
                if (isOk(call { NativeCore.nativeResume(id) })) n++
            }
        }
        pollNow()
        return linkedMapOf("ok" to true, "count" to n)
    }

    /** Turns an https .torrent URL into a local file path. Returns (source, failure). */
    private fun localizeSource(source: String): Pair<String, Map<String, Any?>?> {
        val c = ctx
        if (c == null || !TorrentFetcher.isHttps(source)) return source to null
        val (path, failure) = TorrentFetcher.fetch(c, source)
        return if (path != null) path to null else source to failure
    }

    fun resolveMetadata(source: String, timeoutMs: Long): Map<String, Any?> {
        val (src, failure) = localizeSource(source)
        if (failure != null) return failure
        val res = call { NativeCore.nativeResolveMetadata(src, timeoutMs) }
        if (src != source) File(src).delete()
        return res
    }

    fun addTorrent(source: String, options: Map<String, Any?>): Map<String, Any?> {
        val c = requireCtx()
        val (src, failure) = localizeSource(source)
        if (failure != null) return failure
        val opts = LinkedHashMap(Json.snakeify(options) as Map<String, Any?>)
        if (opts["output_folder"] == null && c != null) opts["output_folder"] = StorageManager.activeTarget(c).path
        val res = call { NativeCore.nativeAddTorrent(src, Json.toJson(opts)) }
        pollNow()
        return res
    }

    fun deleteTorrent(id: String, deleteFiles: Boolean): Map<String, Any?> {
        val res = call { NativeCore.nativeDelete(id, deleteFiles) }
        if (isOk(res)) {
            ctx?.let { StorageManager.clearCopied(it, id) }
            if (copying.contains(id)) cancelledCopies.add(id)
            copyFailedAt.remove(id)
        }
        pollNow()
        return res
    }

    fun pieceBitfield(id: String): List<Int> {
        if (!NativeCore.loaded) return emptyList()
        return try {
            val buf = bitfieldBuffer
            buf.clear()
            val n = NativeCore.nativeGetPieceBitfield(id, buf)
            (0 until n.coerceIn(0, 256)).map { buf.get(it).toInt() and 0xFF }
        } catch (t: Throwable) {
            emptyList()
        }
    }

    // endregion

    // region governance

    fun setGovernance(g: Governance): Map<String, Any?> {
        governance = g
        val c = ctx
        if (c != null) saveGovernance(c, g)
        if (initialized && c != null) startGovernanceWatchers(c)
        evaluateGovernance(force = false)
        val enforceable = g.ssidWhitelist.isEmpty() || net?.currentSsid() != null
        return linkedMapOf("ok" to true, "ssidEnforceable" to enforceable)
    }

    private fun startGovernanceWatchers(c: Context) {
        if (net == null) net = NetworkGovernanceManager(c) { scope.launch { evaluateGovernance(false) } }.also { it.start() }
        if (power == null) power = PowerGovernanceManager(c) { scope.launch { evaluateGovernance(false) } }.also { it.start() }
    }

    @Synchronized
    private fun evaluateGovernance(force: Boolean) {
        if (!initialized) return
        val g = governance
        val n = net
        val p = power

        var wifiBlocked = false
        if (g.wifiOnly && n != null && n.monitoring) {
            wifiBlocked = !n.unmeteredLink
            if (!wifiBlocked && g.ssidWhitelist.isNotEmpty()) {
                val ssid = n.currentSsid()
                // Unreadable SSID means the whitelist cannot be enforced. Do not block.
                if (ssid != null && g.ssidWhitelist.none { it.trim() == ssid }) wifiBlocked = true
            }
        }
        val charging = p?.charging ?: true
        val level = p?.levelPct ?: 100
        val batteryBlocked = g.batteryCutoffPct > 0 && !charging && level < g.batteryCutoffPct
        val chargingBlocked = g.chargingOnly && !charging

        send("wifi_only", !wifiBlocked, force)
        send("battery", !batteryBlocked, force)
        send("charging_only", !chargingBlocked, force)
    }

    private fun send(reason: String, allowed: Boolean, force: Boolean) {
        if (!force && lastAllowed[reason] == allowed) return
        lastAllowed[reason] = allowed
        call { NativeCore.nativeSetTransfersAllowed(allowed, reason) }
        pollNow()
    }

    private fun checkAutoExit(torrents: List<Map<String, Any?>>) {
        if (!governance.autoExitOnComplete || autoExitFired || !sawDownloading || torrents.isEmpty()) return
        val allDone = torrents.all { isFinished(it) }
        if (allDone) {
            autoExitFired = true
            shutdownAndExit()
        }
    }

    // endregion

    // region storage

    private fun checkSafPermission(): Boolean? {
        val c = ctx ?: return null
        val uri = StorageManager.customUri(c) ?: return null
        return !SafStorageManager.hasPersistedPermission(c, android.net.Uri.parse(uri))
    }

    fun storageStatus(): Map<String, Any?> {
        val c = ctx ?: return linkedMapOf("ok" to false, "code" to "ENGINE_UNAVAILABLE")
        val t = StorageManager.activeTarget(c)
        val m = linkedMapOf<String, Any?>(
            "ok" to true,
            "path" to t.path,
            "fallback" to t.fallback,
            "safLost" to (checkSafPermission() == true),
            "mode" to t.mode,
            "uri" to t.treeUri,
            "displayName" to StorageManager.customName(c),
        )
        lastCopyError?.let { m["copyError"] = it }
        return m
    }

    fun emitStorageStatus() = emit("onStorageStatus", storageStatus())

    /** Copies finished staging torrents into the user's tree. Idempotent, retried after failures. */
    private fun copyStagedTorrents(torrents: List<Map<String, Any?>>) {
        val c = ctx ?: return
        val treeStr = StorageManager.customUri(c) ?: return
        val tree = android.net.Uri.parse(treeStr)
        for (t in torrents) {
            val id = t["id"] as? String ?: continue
            val folder = t["output_folder"] as? String ?: continue
            if (!isFinished(t)) continue
            if (!StorageManager.isStagingPath(c, folder) || StorageManager.isCopied(c, id, folder, treeStr)) continue
            val failedAt = copyFailedAt[id]
            if (failedAt != null && SystemClock.elapsedRealtime() - failedAt < COPY_RETRY_MS) continue
            if (!copying.add(id)) continue
            ioScope.launch {
                try {
                    copyOne(c, tree, id, folder)
                } finally {
                    copying.remove(id)
                }
            }
        }
    }

    private fun copyOne(c: Context, tree: android.net.Uri, id: String, folder: String) {
        val detail = call { NativeCore.nativeGetDetail(id) }
        if (!isOk(detail)) return
        var error: String? = null
        for (f in Json.list(detail["files"])) {
            val rel = f["path"] as? String ?: continue
            if (f["included"] == false) continue
            if (Json.long(f["progress_bytes"]) < Json.long(f["length"])) { error = "Not all files are complete yet"; break }
            // null means the target exists with the source's size. A missing source is an error.
            val e = SafStorageManager.copyFileIntoTree(c, tree, rel, File(folder, rel))
            if (e != null) { error = e; break }
        }
        if (cancelledCopies.remove(id)) return // deleted while copying
        if (error == null) {
            StorageManager.markCopied(c, id, folder, tree.toString())
            copyFailedAt.remove(id)
            lastCopyError = null
        } else {
            copyFailedAt[id] = SystemClock.elapsedRealtime()
            lastCopyError = error
        }
        emitStorageStatus()
    }

    /** Resolves (outputFolder, relPath) for a torrent file, or null. Blocking. */
    private fun fileLocation(id: String, fileIndex: Int): Pair<String, String>? {
        val d = call { NativeCore.nativeGetDetail(id) }
        if (!isOk(d)) return null
        @Suppress("UNCHECKED_CAST")
        val folder = (d["snapshot"] as? Map<String, Any?>)?.get("output_folder") as? String ?: return null
        val rel = Json.list(d["files"]).firstOrNull { (it["index"] as? Number)?.toInt() == fileIndex }?.get("path") as? String
            ?: return null
        return folder to rel
    }

    private fun fileAction(id: String, fileIndex: Int, act: (Context, String, String) -> String?): Map<String, Any?> {
        val c = requireCtx() ?: return Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
        val loc = fileLocation(id, fileIndex) ?: return Json.failure("NOT_FOUND", "File not found")
        val err = act(c, loc.first, loc.second)
        return if (err == null) linkedMapOf("ok" to true) else Json.failure("NOT_FOUND", err)
    }

    fun openFile(id: String, fileIndex: Int) = fileAction(id, fileIndex, FileActions::openFile)
    fun shareFile(id: String, fileIndex: Int) = fileAction(id, fileIndex, FileActions::shareFile)

    fun openFolder(id: String): Map<String, Any?> {
        val c = requireCtx() ?: return Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
        val d = call { NativeCore.nativeGetDetail(id) }
        if (!isOk(d)) return d
        @Suppress("UNCHECKED_CAST")
        val folder = (d["snapshot"] as? Map<String, Any?>)?.get("output_folder") as? String
            ?: return Json.failure("NOT_FOUND", "Folder not found")
        val err = FileActions.openFolder(c, folder)
        return if (err == null) linkedMapOf("ok" to true) else Json.failure("NOT_FOUND", err)
    }

    // endregion

    fun emit(name: String, body: Map<String, Any?>) {
        try {
            emitter?.invoke(name, body)
        } catch (t: Throwable) {
            Log.w(TAG, "event $name not delivered: ${t.message}")
        }
    }
}
