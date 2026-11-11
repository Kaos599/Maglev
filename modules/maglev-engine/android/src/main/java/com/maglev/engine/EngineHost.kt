package com.maglev.engine

import android.app.ActivityManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.media.MediaScannerConnection
import android.content.Intent
import android.os.StatFs
import android.net.Uri
import android.os.SystemClock
import android.service.quicksettings.TileService
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.maglev.engine.service.TileModel
import com.maglev.engine.network.NetworkGovernanceManager
import com.maglev.engine.storage.Admission
import com.maglev.engine.feeds.FeedScheduler
import com.maglev.engine.feeds.FeedStore
import com.maglev.engine.power.PowerGovernanceManager
import com.maglev.engine.schedule.ScheduleEvaluator
import com.maglev.engine.schedule.ScheduleManager
import com.maglev.engine.schedule.ScheduleState
import com.maglev.engine.service.CompletionPolicy
import com.maglev.engine.service.StorageHealthDriver
import com.maglev.engine.service.MaglevTileService
import com.maglev.engine.service.MaglevTorrentService
import com.maglev.engine.service.Notifications
import com.maglev.engine.service.TransferSummary
import com.maglev.engine.storage.FileActions
import com.maglev.engine.storage.SafStorageManager
import com.maglev.engine.storage.MediaScanPaths
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
    /** Contract section 21: pause while the active network is not a VPN. */
    val vpnOnly: Boolean = false,
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
    private const val KEY_USER_SHUTDOWN = "user_shutdown"
    private const val KEY_USER_PAUSED_ALL = "user_paused_all"
    private const val KEY_LIMIT_DOWN = "limitDownBps"
    private const val KEY_LIMIT_UP = "limitUpBps"
    private const val SCHEDULE_STOP_DELAY_MS = 10_000L
    private const val SCHEDULE_TICK_MS = 60_000L
    private const val NO_SPACE_MARGIN = 200L * 1024 * 1024
    const val KEY_KILLS = "background_kills"
    const val GOV_PREFS = "maglev_governance"
    const val ENGINE_PREFS = PREFS
    private const val REASON_FGS_TIMEOUT = "fgs_timeout"
    private const val SERVICE_RETRY_MS = 10_000L
    private const val TILE_REFRESH_MS = 2_000L
    private const val COPY_RETRY_MS = 60_000L
    private const val FEED_RESOLVE_MS = 20_000L
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
    private val prevState = HashMap<String, String?>()
    /** Info-hashes already handed to the media scanner for their current completion (contract 12.2). */
    private val mediaScanned = ConcurrentHashMap.newKeySet<String>()
    private val pollLock = Any()
    private var initOnlySince = 0L
    private val cancelledCopies = ConcurrentHashMap.newKeySet<String>()
    /** Torrents whose staged copy was freed at the seed limit in this process. */
    private val seedLimitFreed = ConcurrentHashMap.newKeySet<String>()
    private var sawDownloading = false
    /** Per torrent: seen DOWNLOADING since it was last unfinished (contract 13.2). Guarded by [prevFinished]. */
    private val sawDownloadingById = HashMap<String, Boolean>()
    /** Per torrent: when the user removed files from it while it was finished (elapsedRealtime). Guarded by [prevFinished]. */
    private val quietCompletion = HashMap<String, Long>()
    private const val QUIET_COMPLETION_MS = 30_000L
    /** Latest summary for the Quick Settings tile (contract 13.3). Null until the first poll after init. */
    @Volatile private var lastSummary: TransferSummary? = null
    private var lastTileModel: TileModel? = null
    private var lastTileAt = 0L
    private var autoExitFired = false

    @Volatile private var governance = Governance()
    private val lastAllowed = HashMap<String, Boolean>()
    private var net: NetworkGovernanceManager? = null
    private var power: PowerGovernanceManager? = null

    @Volatile private var holdForPaused = false

    // Scheduler (contract 11.5). Global limits are the user's values, never the schedule-adjusted ones.
    @Volatile private var globalDown = 0L
    @Volatile private var globalUp = 0L
    private var scheduleLimitApplied = false
    private var lastPushedLimits: Pair<Long, Long>? = null
    private var scheduleIdleSince = 0L
    private var lastScheduleTick = 0L
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
            val gp = context.applicationContext.getSharedPreferences(GOV_PREFS, Context.MODE_PRIVATE)
            globalDown = gp.getLong(KEY_LIMIT_DOWN, 0L)
            globalUp = gp.getLong(KEY_LIMIT_UP, 0L)
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
            vpnOnly = p.getBoolean("vpnOnly", false),
        )
    }

    private fun saveGovernance(c: Context, g: Governance) {
        c.getSharedPreferences(GOV_PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("wifiOnly", g.wifiOnly)
            .putString("ssids", g.ssidWhitelist.joinToString("\n"))
            .putBoolean("chargingOnly", g.chargingOnly)
            .putInt("batteryCutoffPct", g.batteryCutoffPct)
            .putBoolean("autoExitOnComplete", g.autoExitOnComplete)
            .putBoolean("vpnOnly", g.vpnOnly)
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
        val snake = Json.snakeify(config) as Map<*, *>
        val configJson = Json.toJson(snake)
        captureGlobalLimits(snake)
        // JS opened the app: a schedule hold from an earlier pause no longer applies once the schedule allows transfers.
        ctx?.let { if (!ScheduleManager.state(it).paused) ScheduleManager.setHeld(it, false) }
        if (initialized) {
            val applied = call { NativeCore.nativeApplyConfig(configJson) }
            lastPushedLimits = null
            evaluateGovernance(force = false)
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
        synchronized(prevFinished) { prevFinished.clear(); sawDownloadingById.clear() }
        lastSummary = null
        initOnlySince = 0L
        sawDownloading = false
        autoExitFired = false
        lastAllowed.clear()
        lastPushedLimits = null
        scheduleLimitApplied = false
        scheduleIdleSince = 0L
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
    fun headlessStart(countKill: Boolean = true) {
        scope.launch {
            val c = ctx ?: return@launch
            val p = prefs(c)
            if (countKill && p.getLong(KEY_ALIVE_AT, 0L) > 0L) {
                p.edit().putInt(KEY_KILLS, p.getInt(KEY_KILLS, 0) + 1).apply()
            }
            // "Not wanted" used to stop the restart outright. It still does: a count of 0 vetoes the restart.
            val wanted = p.getBoolean(KEY_WANTED, false)
            val intent = RestartInput(
                userShutdown = p.getBoolean(KEY_USER_SHUTDOWN, false),
                userPausedAll = p.getBoolean(KEY_USER_PAUSED_ALL, false),
                scheduleHeld = ScheduleManager.isHeld(c),
                activeTorrents = if (wanted) RestartPolicy.UNKNOWN_COUNT else 0,
            )
            if (RestartPolicy.decide(intent) == RestartDecision.StayStopped) {
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
            } else {
                evaluateGovernance(force = false)
            }
            val list = call { NativeCore.nativeListTorrents() }
            val summary = summarize(Json.list(list["torrents"]), list["streaming"] == true)
            val counted = summary.busy + summary.pausedByRules + summary.pausedBySchedule
            if (RestartPolicy.decide(intent.copy(activeTorrents = counted)) == RestartDecision.StayStopped) {
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
        // Real work exists again, so an earlier user stop no longer applies.
        if (wanted && (p.getBoolean(KEY_USER_SHUTDOWN, false) || p.getBoolean(KEY_USER_PAUSED_ALL, false))) {
            p.edit().putBoolean(KEY_USER_SHUTDOWN, false).putBoolean(KEY_USER_PAUSED_ALL, false).apply()
        }
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
            prefs(it).edit().putBoolean(KEY_USER_SHUTDOWN, true).apply()
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
        onForegroundHealth()
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
                scheduleTick()
                delay((1000 - (SystemClock.elapsedRealtime() - started)).coerceAtLeast(100))
            }
        }
    }

    /** Re-evaluates the schedule once a minute while the engine runs, because alarms can be late. */
    private fun scheduleTick() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastScheduleTick < SCHEDULE_TICK_MS) return
        lastScheduleTick = now
        val c = ctx ?: return
        if (!ScheduleManager.config(c).enabled) return
        ScheduleManager.rearm(c)
        scope.launch { evaluateGovernance(false) }
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
        val summary = summarize(torrents, res["streaming"] == true)
        lastSummary = summary
        refreshTile(summary)
        @Suppress("UNCHECKED_CAST")
        val body = LinkedHashMap(Json.camelize(res) as Map<String, Any?>)
        body["serviceBlocked"] = serviceBlocked
        emit("onTelemetry", body)
        driveService(summary)
        healthTick(torrents, summary)
        copyStagedTorrents(torrents)
        freeStagedAtSeedLimit(torrents)
        checkAutoExit(torrents)
    }

    private fun isFinished(t: Map<String, Any?>): Boolean {
        (t["finished"] as? Boolean)?.let { return it }
        val total = Json.long(t["total_bytes"])
        return total > 0 && Json.long(t["progress_bytes"]) >= total
    }

    private fun summarize(torrents: List<Map<String, Any?>>, streaming: Boolean = false): TransferSummary {
        var dl = 0; var seed = 0; var queued = 0; var paused = 0; var byRules = 0
        var checking = 0; var init = 0; var bySchedule = 0
        var done = 0L; var total = 0L; var down = 0L; var up = 0L
        var dlDone = 0L; var dlTotal = 0L
        var seedId: String? = null
        var wifiPaused = false; var batteryPaused = false; var chargingPaused = false
        var unvalidatedPaused = false; var vpnPaused = false
        // §18.5: storage-paused torrents keep the service alive so the free-space poll and media receiver keep running.
        var spacePaused = false; var volumePaused = false
        var primary: Map<String, Any?>? = null
        var latest: Map<String, Any?>? = null
        for (t in torrents) {
            if (latest == null || Json.long(t["added_at"]) > Json.long(latest["added_at"])) latest = t
            when (t["state"]) {
                "DOWNLOADING" -> {
                    dl++; done += Json.long(t["progress_bytes"]); total += Json.long(t["total_bytes"])
                    dlDone += Json.long(t["progress_bytes"]); dlTotal += Json.long(t["total_bytes"])
                    val p = primary
                    // Highest down_bps wins. Ties go to the most recently added torrent.
                    if (p == null || Json.long(t["down_bps"]) > Json.long(p["down_bps"]) ||
                        (Json.long(t["down_bps"]) == Json.long(p["down_bps"]) &&
                            Json.long(t["added_at"]) > Json.long(p["added_at"]))
                    ) primary = t
                }
                "SEEDING" -> { seed++; seedId = t["id"] as? String }
                "QUEUED" -> { queued++; done += Json.long(t["progress_bytes"]); total += Json.long(t["total_bytes"]) }
                "CHECKING" -> { checking++; done += Json.long(t["progress_bytes"]); total += Json.long(t["total_bytes"]) }
                "INITIALIZING" -> init++
                "PAUSED" -> when (t["paused_by"]) {
                    null, "user" -> paused++
                    "wifi_only" -> { byRules++; wifiPaused = true }
                    "battery" -> { byRules++; batteryPaused = true }
                    "charging_only" -> { byRules++; chargingPaused = true }
                    "network_unvalidated" -> { byRules++; unvalidatedPaused = true }
                    "vpn_required" -> { byRules++; vpnPaused = true }
                    "storage_full" -> { byRules++; spacePaused = true }
                    "storage_unavailable" -> { byRules++; volumePaused = true }
                    "schedule" -> bySchedule++
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
        val dlPct = if (dl > 0 && dlTotal > 0) ((dlDone * 100) / dlTotal).toInt().coerceIn(0, 100) else -1
        val shown = primary ?: latest
        val singleId = when {
            dl == 1 -> primary?.get("id") as? String
            dl == 0 && seed == 1 -> seedId
            else -> null
        }
        val reason = when {
            wifiPaused -> "wifi_only"
            unvalidatedPaused -> "network_unvalidated"
            vpnPaused -> "vpn_required"
            batteryPaused -> "battery"
            chargingPaused -> "charging_only"
            spacePaused -> "storage_full"
            volumePaused -> "storage_unavailable"
            else -> null
        }
        return TransferSummary(
            dl, seed, queued, paused, pct, down, up, byRules, checking, effectiveInit,
            primaryName = shown?.get("name") as? String,
            primaryEtaSecs = if (primary != null) (primary["eta_secs"] as? Number)?.toLong() ?: -1L else -1L,
            downloadingPct = dlPct,
            singleTorrentId = singleId,
            ruleReason = reason,
            pausedBySchedule = bySchedule,
            scheduleResumeAt = if (bySchedule > 0) ctx?.let { ScheduleManager.nextBoundaryLabel(it) } else null,
            streaming = streaming,
        )
    }

    /** Fires onTorrentCompleted and the notification on the `finished` false to true edge. */
    private fun detectCompletions(torrents: List<Map<String, Any?>>) {
        val c = ctx
        synchronized(prevFinished) {
            for (t in torrents) {
                val id = t["id"] as? String ?: continue
                val finished = isFinished(t)
                val prev = prevFinished[id]
                val state = t["state"] as? String
                val prevSt = prevState[id]
                if (state == "DOWNLOADING") {
                    sawDownloading = true
                    sawDownloadingById[id] = true
                }
                // The user removed files from a finished torrent. Either it stays finished (the mark is dropped
                // after a short while) or it un-finishes and finishes again, which is not a new download.
                val quietSince = quietCompletion[id]
                if (quietSince != null && prev == true && finished &&
                    SystemClock.elapsedRealtime() - quietSince > QUIET_COMPLETION_MS
                ) quietCompletion.remove(id)
                if (prev == false && finished) {
                    val name = t["name"] as? String ?: id
                    emit("onTorrentCompleted", mapOf("id" to id, "name" to name))
                    val quiet = quietCompletion.remove(id) != null
                    if (c != null && CompletionPolicy.shouldNotify(prev, finished, sawDownloadingById[id] == true, quiet)) {
                        announceCompletion(c, id, name)
                    }
                    scanMedia(id, force = false)
                }
                // A move changed the files' location: scan the new paths even if this completion was scanned before.
                if (prevSt == "MOVING" && state != "MOVING" && t["error"] == null && finished) {
                    scanMedia(id, force = true)
                }
                // CHECKING and MOVING can flip `finished` briefly. Only a real un-finish starts a new completion.
                if (!finished && state != "CHECKING" && state != "MOVING") mediaScanned.remove(id)
                // A finished torrent starts over: the next notification needs a fresh DOWNLOADING.
                if (finished) sawDownloadingById.remove(id)
                prevFinished[id] = finished
                prevState[id] = state
            }
            val alive = torrents.mapNotNull { it["id"] as? String }.toSet()
            prevFinished.keys.retainAll(alive)
            prevState.keys.retainAll(alive)
            sawDownloadingById.keys.retainAll(alive)
            quietCompletion.keys.retainAll(alive)
            mediaScanned.retainAll(alive)
        }
    }

    /**
     * Posts the "Download finished" notification (contract 13.2). Reads the detail for the size of the included
     * files and, with exactly one included file, a content URI for the Open action. Runs on IO.
     */
    private fun announceCompletion(c: Context, id: String, name: String) {
        ioScope.launch {
            var size = 0L
            var open: PendingIntent? = null
            try {
                val d = call { NativeCore.nativeGetDetail(id) }
                if (isOk(d)) {
                    val files = Json.list(d["files"]).filter { it["included"] != false }
                    size = files.sumOf { Json.long(it["length"]) }
                    @Suppress("UNCHECKED_CAST")
                    val folder = (d["snapshot"] as? Map<String, Any?>)?.get("output_folder") as? String
                    val rel = files.singleOrNull()?.get("path") as? String
                    if (folder != null && rel != null) {
                        val uri = viewUri(c, folder, rel)
                        if (uri != null) open = Notifications.openFileAction(c, id, uri, SafStorageManager.mimeFor(rel))
                    }
                }
            } catch (t: Throwable) {
                Log.w(TAG, "completion detail failed", t)
            }
            Notifications.notifyCompleted(c, id, name, size, open)
        }
    }

    /** Same resolution as FileActions.openFile: FileProvider for a POSIX path, else the SAF tree. */
    private fun viewUri(c: Context, folder: String, rel: String): Uri? {
        val f = File(folder, rel)
        if (f.exists()) {
            return try {
                FileProvider.getUriForFile(c, FileActions.authority(c), f)
            } catch (_: IllegalArgumentException) {
                null
            }
        }
        val tree = StorageManager.customUri(c) ?: return null
        return SafStorageManager.findInTree(c, Uri.parse(tree), rel)?.uri
    }

    /** Summary for the Quick Settings tile, or null when the engine is not running. */
    fun tileSummary(): TransferSummary? = if (initialized) lastSummary else null

    /** Asks the system to rebind the tile when its content changed, at most every 2 s (contract 13.3). */
    private fun refreshTile(s: TransferSummary) {
        val c = ctx ?: return
        val model = TileModel.from(s)
        if (model == lastTileModel) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastTileAt < TILE_REFRESH_MS) return
        lastTileModel = model
        lastTileAt = now
        try {
            // Needs ACTIVE_TILE meta-data; a no-op when the tile is not added. May throw on API 33+ for a bad request.
            TileService.requestListeningState(c, ComponentName(c, MaglevTileService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "tile refresh failed: ${e.message}")
        }
    }

    /**
     * Makes finished files visible to Photos and music apps (contract 12.2). Public shared storage only.
     * At most once per completion unless [force] (after a move). Runs on IO because it reads the detail.
     */
    private fun scanMedia(id: String, force: Boolean) {
        val c = ctx ?: return
        if (!mediaScanned.add(id) && !force) return
        ioScope.launch {
            try {
                val d = call { NativeCore.nativeGetDetail(id) }
                if (!isOk(d)) return@launch
                @Suppress("UNCHECKED_CAST")
                val folder = (d["snapshot"] as? Map<String, Any?>)?.get("output_folder") as? String ?: return@launch
                val rels = Json.list(d["files"]).filter { it["included"] != false }.mapNotNull { it["path"] as? String }
                scanPaths(c, folder, rels)
            } catch (t: Throwable) {
                Log.w(TAG, "media scan failed", t)
            }
        }
    }

    /** Filters to public storage and asks the system scanner. API 1+, see MediaScannerConnection.scanFile. */
    private fun scanPaths(c: Context, baseDir: String, rels: List<String>) {
        val privateRoots = listOfNotNull(
            StorageManager.stagingDir(c).path,
            c.getExternalFilesDir(null)?.path,
            c.filesDir.path,
            c.cacheDir.path,
        )
        val paths = MediaScanPaths.select(
            baseDir, rels, android.os.Environment.getExternalStorageDirectory().path, privateRoots,
        )
        if (paths.isEmpty()) return
        MediaScannerConnection.scanFile(c, paths.toTypedArray(), null, null)
    }

    // endregion

    // region service

    private fun driveService(s: TransferSummary) {
        val c = ctx ?: return
        if (!initialized) return
        val timedOut = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_FGS_TIMEOUT, false)
        if (s.active == 0 && s.pausedByUser == 0) holdForPaused = false
        val svc = MaglevTorrentService.instance
        val others = s.busy > 0 || s.pausedByRules > 0 || (holdForPaused && s.pausedByUser > 0)
        // Schedule pause: keep the service ~10 s, then stop it and persist scheduleHeld (contract 11.5).
        var scheduleGrace = false
        if (!others && s.pausedBySchedule > 0) {
            val now = SystemClock.elapsedRealtime()
            if (scheduleIdleSince == 0L) scheduleIdleSince = now
            if (now - scheduleIdleSince >= SCHEDULE_STOP_DELAY_MS) {
                if (ScheduleManager.state(c).paused) ScheduleManager.setHeld(c, true)
            } else {
                scheduleGrace = true
            }
        } else {
            scheduleIdleSince = 0L
            if (s.busy > 0 && svc != null) ScheduleManager.setHeld(c, false)
        }
        // Wanted = real work exists. A rules- or schedule-paused torrent counts: it must resume by itself later.
        if (initialized) setWanted(c, others || s.pausedBySchedule > 0)
        val shouldRun = !timedOut && (others || scheduleGrace)
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
        ctx?.let {
            setWanted(it, false)
            prefs(it).edit().putBoolean(KEY_USER_PAUSED_ALL, true).apply()
        }
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

    /** Polled by the Add screen while a magnet resolves (contract 12.1). Does not wait for the resolve. */
    fun resolveActivity(infoHash: String): Map<String, Any?> = call { NativeCore.nativeResolveActivity(infoHash) }

    fun cancelResolve(infoHash: String): Map<String, Any?> = call { NativeCore.nativeCancelResolve(infoHash) }

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
        // Contract section 21: keeping the files of a staged torrent means the copy in the user's folder is the
        // one that stays, so the staged copy goes. The paths must be read before the torrent is gone.
        val staged = if (!deleteFiles) stagedFilesOf(id) else null
        val res = call { NativeCore.nativeDelete(id, deleteFiles) }
        if (isOk(res)) {
            if (staged != null) freeStagedAsync(staged.first, staged.second)
            ctx?.let { StorageManager.clearCopied(it, id) }
            if (copying.contains(id)) cancelledCopies.add(id)
            copyFailedAt.remove(id)
        }
        pollNow()
        return res
    }

    /** (outputFolder, relPaths) when [id] writes into the staging folder and a custom folder is set, else null. */
    private fun stagedFilesOf(id: String): Pair<String, List<String>>? {
        val c = ctx ?: return null
        if (StorageManager.customUri(c) == null) return null
        val detail = call { NativeCore.nativeGetDetail(id) }
        if (!isOk(detail)) return null
        val folder = (detail["snapshot"] as? Map<*, *>)?.get("output_folder") as? String ?: return null
        if (!StorageManager.isStagingPath(c, folder)) return null
        val rels = Json.list(detail["files"]).mapNotNull { it["path"] as? String }
        return if (rels.isEmpty()) null else folder to rels
    }

    /** Frees the staged files whose copy in the user's folder matches by size. Runs off the control thread. */
    private fun freeStagedAsync(folder: String, rels: List<String>) {
        val c = ctx ?: return
        ioScope.launch {
            try {
                val freed = StorageManager.freeStagedFiles(c, folder, rels)
                if (freed > 0) Log.i(TAG, "freed $freed bytes of staged files")
            } catch (t: Throwable) {
                Log.w(TAG, "could not free staged files", t)
            }
        }
    }

    /** Staged torrents that hit their seed limit have their staged copy freed once (contract section 21). */
    private fun freeStagedAtSeedLimit(torrents: List<Map<String, Any?>>) {
        val c = ctx ?: return
        val treeStr = StorageManager.customUri(c) ?: return
        for (t in torrents) {
            if (t["paused_by"] != "seed_limit") continue
            val id = t["id"] as? String ?: continue
            val folder = t["output_folder"] as? String ?: continue
            if (!StorageManager.isStagingPath(c, folder) || !StorageManager.isCopied(c, id, folder, treeStr)) continue
            if (!seedLimitFreed.add(id)) continue
            ioScope.launch {
                try {
                    val detail = call { NativeCore.nativeGetDetail(id) }
                    if (!isOk(detail)) { seedLimitFreed.remove(id); return@launch }
                    val rels = Json.list(detail["files"]).mapNotNull { it["path"] as? String }
                    StorageManager.freeStagedFiles(c, folder, rels)
                } catch (e: Throwable) {
                    Log.w(TAG, "could not free staged files at the seed limit", e)
                }
            }
        }
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

    // region wave 3 (contract section 10)

    /** [priorities] is a list of {index, priority}. Rust validates indices and the empty include set. */
    fun setFilePriorities(id: String, priorities: List<Map<String, Any?>>): Map<String, Any?> {
        val json = Json.toJson(priorities.map { linkedMapOf("index" to it["index"], "priority" to it["priority"]) })
        val res = call { NativeCore.nativeSetFilePriorities(id, json) }
        pollNow()
        return res
    }

    /**
     * Removes the data of the files at [indices] (contract section 14). Rust stops downloading them, deletes
     * them from the output folder and drops the have bits. The result carries `freed_bytes` (`freedBytes` in JS).
     * For a staging torrent that was already copied into the user's SAF folder, the copy is deleted here,
     * through the same layer that wrote it.
     */
    fun removeFiles(id: String, indices: List<Int>): Map<String, Any?> {
        // Resolve the paths first; the detail still lists skipped files afterwards, but this keeps the order obvious.
        val located = call { NativeCore.nativeGetDetail(id) }
        val folder = ((located["snapshot"] as? Map<*, *>)?.get("output_folder")) as? String
        val rels = if (isOk(located)) {
            Json.list(located["files"])
                .filter { f -> indices.contains((f["index"] as? Number)?.toInt()) }
                .mapNotNull { it["path"] as? String }
        } else emptyList()
        // A finished torrent that downloads boundary pieces again after this is not completing a new download.
        synchronized(prevFinished) {
            if (prevFinished[id] == true) quietCompletion[id] = SystemClock.elapsedRealtime()
        }
        val res = call { NativeCore.nativeRemoveFiles(id, Json.toJson(indices)) }
        if (!isOk(res)) synchronized(prevFinished) { quietCompletion.remove(id) }
        val c = ctx
        if (isOk(res) && c != null && folder != null && StorageManager.isStagingPath(c, folder)) {
            val treeStr = StorageManager.customUri(c)
            if (treeStr != null) {
                val tree = android.net.Uri.parse(treeStr)
                for (rel in rels) {
                    if (!SafStorageManager.deleteFromTree(c, tree, rel)) {
                        Log.w(TAG, "could not delete the copy of $rel from the chosen folder")
                        lastCopyError = "Couldn't delete a file from your chosen folder"
                    }
                }
                emitStorageStatus()
            }
        }
        pollNow()
        return res
    }

    /** The result carries `retry_after_secs` (camelized to retryAfterSecs by the module) when rate limited. */
    fun reannounce(id: String): Map<String, Any?> = call { NativeCore.nativeReannounce(id) }

    /**
     * Free space of the directory Rust writes into (default, direct SAF path or staging).
     * In staging mode, `targetFreeBytes` is the SAF target volume when the tree resolves to a readable path, else null.
     */
    fun freeSpace(): Map<String, Any?> {
        val c = requireCtx() ?: return Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
        val t = StorageManager.activeTarget(c)
        val own = statOf(File(t.path)) ?: return Json.failure("INTERNAL", "Could not read free space")
        val m = linkedMapOf<String, Any?>(
            "ok" to true,
            "path" to t.path,
            "freeBytes" to own.first,
            "totalBytes" to own.second,
            "mode" to t.mode,
        )
        if (t.mode == "staging") {
            val tree = t.treeUri?.let { SafStorageManager.treeToPosixPath(android.net.Uri.parse(it)) }
            m["targetFreeBytes"] = tree?.let { statOf(File(it))?.first }
        }
        return m
    }

    /** (available, total) bytes for the nearest existing directory at or above [dir], or null. */
    private fun statOf(dir: File): Pair<Long, Long>? {
        var d: File? = dir
        while (d != null && !d.exists()) d = d.parentFile
        if (d == null) return null
        return try {
            val st = StatFs(d.absolutePath)
            st.availableBytes to st.totalBytes
        } catch (e: Exception) {
            Log.w(TAG, "StatFs failed for ${d.path}: ${e.message}")
            null
        }
    }

    // endregion

    // region governance

    fun setGovernance(g: Governance): Map<String, Any?> {
        governance = g
        val c = ctx
        if (c != null) {
            saveGovernance(c, g)
            FeedScheduler.apply(c) // the Wi-Fi-only setting changes the work constraint
        }
        if (initialized && c != null) startGovernanceWatchers(c)
        evaluateGovernance(force = false)
        val enforceable = g.ssidWhitelist.isEmpty() || net?.currentSsid() != null
        return linkedMapOf("ok" to true, "ssidEnforceable" to enforceable)
    }

    /**
     * Contract section 21: a validated network was gained, so peers and trackers are asked again. Rust refuses a
     * torrent that announced less than 60 s ago (section 10) and one that is not running, so errors are ignored.
     */
    private fun reannounceLiveTorrents() {
        if (!initialized) return
        val list = call { NativeCore.nativeListTorrents() }
        if (!isOk(list)) return
        for (t in Json.list(list["torrents"])) {
            val state = t["state"] as? String
            if (state != "DOWNLOADING" && state != "SEEDING") continue
            val id = t["id"] as? String ?: continue
            call { NativeCore.nativeReannounce(id) }
        }
    }

    private fun startGovernanceWatchers(c: Context) {
        if (net == null) {
            net = NetworkGovernanceManager(
                c,
                onChanged = { scope.launch { evaluateGovernance(false) } },
                onGained = { scope.launch { reannounceLiveTorrents() } },
            ).also { it.start() }
        }
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
        // Contract section 21. Only judged while the callback is registered and a network exists: no network at
        // all is "offline", which these rules do not turn into a pause.
        val linkKnown = n != null && n.monitoring && n.connected
        // A sign-in page, not merely an unvalidated network (§21).
        val unvalidatedBlocked = linkKnown && n?.captivePortal == true
        val vpnBlocked = g.vpnOnly && linkKnown && n?.vpn == false
        val charging = p?.charging ?: true
        val level = p?.levelPct ?: 100
        val batteryBlocked = g.batteryCutoffPct > 0 && !charging && level < g.batteryCutoffPct
        val chargingBlocked = g.chargingOnly && !charging

        send("wifi_only", !wifiBlocked, force)
        send("battery", !batteryBlocked, force)
        send("charging_only", !chargingBlocked, force)
        send("network_unvalidated", !unvalidatedBlocked, force)
        send("vpn_required", !vpnBlocked, force)

        val c = ctx ?: return
        val st = ScheduleManager.state(c)
        val held = ScheduleManager.isHeld(c)
        // Schedule allows transfers again but the service is down: start it. The service clears the hold.
        if (held && !st.paused) ScheduleManager.requestResumeIfAllowed(c)
        send("schedule", !st.paused && !held, force)
        applyLimits(st, force)
    }

    private fun pushLimits(down: Long, up: Long) {
        val pair = down to up
        if (lastPushedLimits == pair) return
        lastPushedLimits = pair
        call { NativeCore.nativeSetGlobalLimits(down, up) }
    }

    /**
     * Effective limit = min(global, schedule) per direction, 0 = none. Rust keeps its own persisted global limits
     * until a schedule limit has been applied in this process, so a headless restart never resets them.
     */
    private fun applyLimits(st: ScheduleState, force: Boolean) {
        val active = st.downBps != null || st.upBps != null
        if (active) {
            scheduleLimitApplied = true
            if (force) lastPushedLimits = null
            pushLimits(
                ScheduleEvaluator.effectiveLimit(globalDown, st.downBps),
                ScheduleEvaluator.effectiveLimit(globalUp, st.upBps),
            )
        } else if (scheduleLimitApplied) {
            scheduleLimitApplied = false
            pushLimits(globalDown, globalUp)
        }
    }

    private fun captureGlobalLimits(snakeConfig: Map<*, *>) {
        val d = (snakeConfig["download_limit_bps"] as? Number)?.toLong()
        val u = (snakeConfig["upload_limit_bps"] as? Number)?.toLong()
        if (d != null || u != null) storeGlobalLimits(d ?: globalDown, u ?: globalUp)
    }

    private fun storeGlobalLimits(down: Long, up: Long) {
        globalDown = down.coerceAtLeast(0L)
        globalUp = up.coerceAtLeast(0L)
        ctx?.getSharedPreferences(GOV_PREFS, Context.MODE_PRIVATE)?.edit()
            ?.putLong(KEY_LIMIT_DOWN, globalDown)?.putLong(KEY_LIMIT_UP, globalUp)?.apply()
    }

    /** JS setGlobalLimits: remember the user's values and apply min(global, schedule). */
    fun setGlobalLimits(down: Long, up: Long): Map<String, Any?> {
        storeGlobalLimits(down, up)
        val c = ctx
        val st = if (c != null) ScheduleManager.state(c) else null
        val d = ScheduleEvaluator.effectiveLimit(globalDown, st?.downBps)
        val u = ScheduleEvaluator.effectiveLimit(globalUp, st?.upBps)
        scheduleLimitApplied = st != null && (st.downBps != null || st.upBps != null)
        lastPushedLimits = d to u
        return call { NativeCore.nativeSetGlobalLimits(d, u) }
    }

    // region wave 4 (contract section 11)

    /** JS setTorrentLimits. Values below 0 are treated as 0 (no limit). Rust clamps above u32::MAX. */
    fun setTorrentLimits(id: String, limits: Map<String, Any?>): Map<String, Any?> {
        val down = ((limits["downBps"] as? Number)?.toLong() ?: 0L).coerceAtLeast(0L)
        val up = ((limits["upBps"] as? Number)?.toLong() ?: 0L).coerceAtLeast(0L)
        val res = call { NativeCore.nativeSetTorrentLimits(id, Json.toJson(linkedMapOf("down_bps" to down, "up_bps" to up))) }
        pollNow()
        return res
    }

    private const val TREE_STAGING_ONLY =
        "Maglev can't keep active torrents in this folder. Pick a folder inside Download, or use the default."

    /**
     * Resolves [target] (`{kind:"default"}` or `{kind:"tree", uri}`) to a directory Maglev can write directly,
     * checks free space for a cross-volume move, then asks Rust to move. Never changes the default download folder.
     */
    fun moveStorage(id: String, target: Map<String, Any?>): Map<String, Any?> {
        val c = requireCtx() ?: return Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
        val dest: String = when (target["kind"]) {
            "default" -> StorageManager.resolveDefaultDownloadDir(c).first.absolutePath
            "tree" -> {
                val raw = target["uri"] as? String ?: return Json.failure("UNSUPPORTED", "Pick a folder to move to.")
                val uri = android.net.Uri.parse(raw)
                // Keeps access to the folder across restarts. Does not touch the stored default folder.
                SafStorageManager.takePersistablePermission(c, uri)
                val path = SafStorageManager.treeToPosixPath(uri)
                if (path == null || !StorageManager.probeWritable(File(path))) {
                    return Json.failure("UNSUPPORTED", TREE_STAGING_ONLY)
                }
                path
            }
            else -> return Json.failure("UNSUPPORTED", "Pick a folder to move to.")
        }
        val detail = call { NativeCore.nativeGetDetail(id) }
        if (!isOk(detail)) return detail
        @Suppress("UNCHECKED_CAST")
        val snap = detail["snapshot"] as? Map<String, Any?>
        val source = snap?.get("output_folder") as? String
        if (source != null && crossVolume(source, dest)) {
            val needed = Json.long(snap?.get("progress_bytes")) + NO_SPACE_MARGIN
            val free = statOf(File(dest))?.first
            if (free != null && free < needed) {
                return Json.failure("DISK_FULL", "Not enough free space in that folder to move this torrent.")
            }
        }
        val res = call { NativeCore.nativeMoveStorage(id, dest) }
        pollNow()
        return res
    }

    /** Different st_dev means a copy instead of a rename. Unknown counts as cross-volume, which is the safe side. */
    private fun crossVolume(a: String, b: String): Boolean = try {
        fun existing(p: String): File {
            var f: File? = File(p)
            while (f != null && !f.exists()) f = f.parentFile
            return f ?: File("/")
        }
        android.system.Os.stat(existing(a).absolutePath).st_dev != android.system.Os.stat(existing(b).absolutePath).st_dev
    } catch (e: Exception) {
        true
    }

    /** "Play with" chooser for a stream URL (contract 11.4). */
    fun openStream(url: String, mime: String, title: String): Map<String, Any?> {
        val c = requireCtx() ?: return Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(android.net.Uri.parse(url), mime)
            .putExtra(Intent.EXTRA_TITLE, title)
        val noPlayer = Json.failure("UNSUPPORTED", "No video player found. Install VLC or another player.")
        return try {
            // Needs the <queries> entry in the module manifest to see other apps on API 30+.
            if (c.packageManager.queryIntentActivities(view, 0).isEmpty()) return noPlayer
            c.startActivity(Intent.createChooser(view, "Play with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            linkedMapOf("ok" to true)
        } catch (e: android.content.ActivityNotFoundException) {
            noPlayer
        } catch (e: Exception) {
            Json.failure("INTERNAL", e.message ?: "Could not open the player")
        }
    }

    // region trackers and .torrent export (contract section 15)

    /** [urls] are announce URLs, one per entry. Rust validates them all and changes nothing unless every one is valid. */
    fun addTrackers(id: String, urls: List<String>): Map<String, Any?> =
        call { NativeCore.nativeAddTrackers(id, Json.toJson(urls)) }

    fun removeTracker(id: String, url: String): Map<String, Any?> =
        call { NativeCore.nativeRemoveTracker(id, url) }

    private val fileNameJunk = Regex("[\\\\/:*?\"<>|\\p{Cntrl}]")

    /** A file name for a torrent: no path characters, at most 120 characters, always ending in `.torrent`. */
    private fun torrentFileName(name: String): String {
        val cleaned = name.replace(fileNameJunk, "_").trim().trim('.').take(120).trim()
        return (if (cleaned.isEmpty()) "torrent" else cleaned) + ".torrent"
    }

    /** `Download/Maglev` instead of `/storage/emulated/0/Download/Maglev`. */
    private fun friendlyFolder(path: String): String = path.removePrefix("/storage/emulated/0/")

    /**
     * JS exportTorrent: writes `<name>.torrent` to the download folder (`Download/Maglev` by default, a direct
     * custom folder, or the SAF folder) and returns `{path, name, folder, bytes}`. `path` is a real file that exists
     * and can be shared; `folder` is the place to tell the user about. Overwrites an earlier export of the same name.
     * In SAF staging mode Rust writes into an app folder first, and the file is then copied into the tree.
     */
    fun exportTorrent(id: String): Map<String, Any?> {
        val c = requireCtx() ?: return Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
        val detail = call { NativeCore.nativeGetDetail(id) }
        if (!isOk(detail)) return detail
        @Suppress("UNCHECKED_CAST")
        val name = (detail["snapshot"] as? Map<String, Any?>)?.get("name") as? String ?: ""
        val fileName = torrentFileName(name)
        val target = StorageManager.activeTarget(c)
        val tree = if (target.mode == "staging") target.treeUri else null
        val dir = if (tree != null) {
            File(c.getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS) ?: c.filesDir, "Exports")
                .also { it.mkdirs() }
        } else {
            File(target.path)
        }
        val dest = File(dir, fileName)
        val res = call { NativeCore.nativeExportTorrent(id, dest.absolutePath) }
        if (!isOk(res)) return res
        val folder: String
        if (tree != null) {
            val uri = Uri.parse(tree)
            // copyFileIntoTree keeps an existing file of the same size, so remove the old export first.
            try {
                SafStorageManager.findInTree(c, uri, fileName)?.delete()
            } catch (e: Exception) {
                Log.w(TAG, "could not replace the old export: ${e.message}")
            }
            val err = SafStorageManager.copyFileIntoTree(c, uri, fileName, dest)
            if (err != null) {
                Log.w(TAG, "export copy into the chosen folder failed: $err")
                return Json.failure("PERMISSION", "Maglev can't write to your download folder. Pick the folder again in Settings.")
            }
            folder = StorageManager.customName(c) ?: "your download folder"
        } else {
            folder = friendlyFolder(dir.absolutePath)
            try {
                MediaScannerConnection.scanFile(c, arrayOf(dest.absolutePath), arrayOf("application/x-bittorrent"), null)
            } catch (e: Exception) {
                Log.w(TAG, "media scan skipped: ${e.message}")
            }
        }
        return linkedMapOf(
            "ok" to true,
            "path" to dest.absolutePath,
            "name" to fileName,
            "folder" to folder,
            "bytes" to Json.long(res["bytes"]),
        )
    }

    /** JS shareExportedTorrent: the share sheet for a file [exportTorrent] returned. */
    fun shareExportedTorrent(path: String): Map<String, Any?> {
        val c = requireCtx() ?: return Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
        val file = File(path)
        if (!path.endsWith(".torrent", ignoreCase = true) || !file.isFile) {
            return Json.failure("NOT_FOUND", "The saved file isn't there any more. Save it again.")
        }
        val err = FileActions.shareLocalFile(c, file, "application/x-bittorrent")
        return if (err == null) linkedMapOf("ok" to true) else Json.failure("UNSUPPORTED", err)
    }

    // endregion

    // region Health (§18)

    /** [tag] is `files_missing`, `files_changed`, `storage_full`, `storage_unavailable`, `no_peers`, or "" to clear it. */
    fun setHealth(id: String, tag: String): Map<String, Any?> {
        val res = call { NativeCore.nativeSetHealth(id, tag) }
        pollNow()
        return res
    }

    /** One scan of every torrent's files now. The result carries `changed`, the number of torrents whose tag changed. */
    fun scanFileHealth(): Map<String, Any?> {
        val res = call { NativeCore.nativeScanFileHealth() }
        pollNow()
        return res
    }

    /** `{files: [{index, state: "ok"|"missing"|"changed"}]}` for the included files. */
    fun fileHealth(id: String): Map<String, Any?> = call { NativeCore.nativeFileHealth(id) }

    /** [action] is `stop`, `again`, `folder` or `recheck`; [dir] is only read by `folder`. */
    fun resolveFiles(id: String, action: String, indices: List<Int>, dir: String): Map<String, Any?> {
        // "Pick folder" hands over a SAF tree URI; Rust needs the POSIX path behind it, as Move does.
        var target = dir
        if (dir.startsWith("content://")) {
            val c = ctx ?: return Json.failure("NOT_READY", "Maglev isn't ready yet.")
            val uri = android.net.Uri.parse(dir)
            SafStorageManager.takePersistablePermission(c, uri)
            target = SafStorageManager.treeToPosixPath(uri)
                ?: return Json.failure("FILES_MISSING", "Maglev can't read that folder directly. Pick a folder on this phone.")
        }
        val res = call { NativeCore.nativeResolveFiles(id, action, Json.toJson(indices), target) }
        pollNow()
        return res
    }

    // endregion

    /** JS setSchedule: persist, re-arm the alarm and apply the new state now. */
    fun setSchedule(cfg: Map<String, Any?>): Map<String, Any?> {
        val c = requireCtx() ?: return Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
        ScheduleManager.setConfig(c, cfg)
        ScheduleManager.resetResumeThrottle()
        scheduleIdleSince = 0L
        if (initialized) {
            evaluateGovernance(force = false)
            pollNow()
        }
        return ScheduleManager.status(c)
    }

    /** Alarm or clock change reached the process. */
    fun onScheduleChanged() {
        if (!initialized) return
        scope.launch {
            evaluateGovernance(false)
            pollNow()
        }
    }

    /** Service action ACTION_SCHEDULE_RESUME: the schedule allows transfers again. */
    fun scheduleResume() {
        val c = ctx ?: return
        ScheduleManager.resetResumeThrottle()
        scheduleIdleSince = 0L
        if (!ScheduleManager.state(c).paused) ScheduleManager.setHeld(c, false)
        headlessStart(countKill = false)
    }

    fun setFeedAutomation(cfg: Map<String, Any?>): Map<String, Any?> {
        val c = requireCtx() ?: return Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
        FeedStore.setConfig(c, cfg)
        FeedScheduler.apply(c)
        return FeedStore.status(c)
    }

    fun feedStatus(): Map<String, Any?> {
        val c = requireCtx() ?: return Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
        return FeedStore.status(c)
    }

    fun runFeedCheckNow(): Map<String, Any?> {
        val c = requireCtx() ?: return Json.failure("ENGINE_UNAVAILABLE", "Module is not attached")
        return if (FeedScheduler.runNow(c)) linkedMapOf("ok" to true) else Json.failure("INTERNAL", "Could not start the feed check")
    }

    /**
     * Admission check (SM-35, `Admission.kt`) for a feed match. Reads the size from the torrent's metadata; a source
     * whose size cannot be read in time (a magnet with no peers yet) is let through, as it was before.
     */
    private fun feedFits(source: String): Boolean {
        val meta = resolveMetadata(source, FEED_RESOLVE_MS)
        if (!isOk(meta)) return true
        val selection = Json.long(meta["total_bytes"])
        val space = freeSpace()
        if (!isOk(space)) return true
        val staged = space["mode"] == "staging"
        val ownFree = Json.long(space["freeBytes"])
        val free = if (staged) (space["targetFreeBytes"] as? Number)?.toLong()?.coerceAtMost(ownFree) ?: ownFree else ownFree
        val list = call { NativeCore.nativeListTorrents() }
        var pending = 0L
        if (isOk(list)) {
            for (t in Json.list(list["torrents"])) {
                if (isFinished(t)) continue
                pending += (Json.long(t["total_bytes"]) - Json.long(t["progress_bytes"])).coerceAtLeast(0L)
            }
        }
        val out = Admission.admit(free, pending, if (staged) 2 else 1, selection)
        if (out.result == Admission.Result.DoesntFit) Log.i(TAG, "feed match does not fit: need ${out.need}, budget ${out.budget}")
        return out.result != Admission.Result.DoesntFit
    }

    /**
     * Service action ACTION_DRAIN_FEED_ADDS: starts the engine if needed, then adds every queued match through
     * the normal add path. A duplicate counts as done. Network and disk failures stay queued for the next drain.
     */
    fun drainFeedAdds() {
        scope.launch {
            val c = ctx ?: return@launch
            if (!initialized) {
                val res = startEngine("")
                if (!isOk(res)) {
                    Log.w(TAG, "feed drain: engine did not start: ${res["code"]}")
                    stopService()
                    return@launch
                }
            }
            ioScope.launch {
                val pending = FeedStore.pending(c)
                val done = ArrayList<com.maglev.engine.feeds.PendingAdd>()
                var added = 0
                for (p in pending) {
                    val fits = feedFits(p.source)
                    val res = addTorrent(p.source, mapOf("paused" to (p.startPaused || !fits)))
                    // Contract section 21: a match that does not fit is kept, paused, and marked as out of space.
                    if (!fits && isOk(res)) (res["id"] as? String)?.let { setHealth(it, "storage_full") }
                    val code = res["code"]
                    when {
                        isOk(res) -> { added++; done.add(p) }
                        code == "DUPLICATE" || code == "INVALID_SOURCE" || code == "UNSUPPORTED" -> done.add(p)
                        else -> Log.w(TAG, "feed add kept for retry: $code")
                    }
                }
                FeedStore.remove(c, done)
                FeedStore.addedDone(c, added)
                pollNow()
            }
        }
    }

    // endregion

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
        val copiedRels = ArrayList<String>()
        for (f in Json.list(detail["files"])) {
            val rel = f["path"] as? String ?: continue
            if (f["included"] == false) continue
            copiedRels.add(rel)
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
            // Only when the tree resolves to a real path. Otherwise the document provider indexes it itself.
            val treePath = SafStorageManager.treeToPosixPath(tree)
            if (treePath != null && mediaScanned.add(id)) {
                try { scanPaths(c, treePath, copiedRels) } catch (t: Throwable) { Log.w(TAG, "media scan failed", t) }
            }
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

    // region Restart and storage (§18.5, §19)

    /** Per-poll hook: storage health, background error notice, restart bookkeeping, resolve retry work. */
    private fun healthTick(torrents: List<Map<String, Any?>>, summary: TransferSummary) {
        val c = ctx ?: return
        StorageHealthDriver.onTelemetry(c, torrents)
        RestartPrefs.recordTick(c, summary.busy + summary.pausedByRules + summary.pausedBySchedule)
        ResolveRetry.sync(c, torrents.any { it["health"] == "no_peers" })
    }

    /** App-in-front hook: the one-time "stopped by Android" notice, and a file health scan. */
    private fun onForegroundHealth() {
        val c = ctx ?: return
        if (RestartEntry.onAppOpen(c)) emit("onNotificationAction", mapOf("action" to "stopped_by_android", "message" to RestartEntry.STOPPED_NOTICE))
        if (initialized) scope.launch { scanFileHealth() }
    }

    /** Clears every no_peers tag so the 10 minute resolve window starts again (contract 20). Starts the engine if needed. */
    fun resolveRetry() {
        scope.launch {
            val c = ctx ?: return@launch
            if (RestartPolicy.decide(RestartPrefs.input(c).copy(activeTorrents = RestartPolicy.UNKNOWN_COUNT)) == RestartDecision.StayStopped) return@launch
            if (!initialized && !isOk(startEngine(""))) return@launch
            val list = call { NativeCore.nativeListTorrents() }
            for (t in Json.list(list["torrents"])) {
                if (t["health"] == "no_peers") (t["id"] as? String)?.let { setHealth(it, "") }
            }
            pollNow()
        }
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
