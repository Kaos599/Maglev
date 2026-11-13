package com.maglev.engine.share

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.maglev.engine.EngineHost
import com.maglev.engine.NativeCore
import com.maglev.engine.service.BackgroundStart
import com.maglev.engine.service.MaglevTorrentService
import com.maglev.engine.storage.Admission
import com.maglev.engine.util.Json
import java.io.File

/**
 * Everything the quick share card asks of the engine (docs/contracts-0.19/quick-share.md section 5). Blocking: call from a
 * worker thread. It reuses the add paths the feed drain uses (`EngineHost.addTorrent`, `EngineHost.addDownload`); nothing
 * here invents a value. An unknown size stays null.
 */
object QuickShareAdd {
    private const val METADATA_MS = 10_000L
    private const val PROBE_MS = 8_000L
    private const val MAX_TORRENT_BYTES = 10 * 1024 * 1024

    data class Info(val name: String?, val sizeBytes: Long?, val fileCount: Int?, val infoHash: String?)
    data class Existing(val percent: Int)
    data class LowSpace(val needBytes: Long, val freeBytes: Long)
    data class Outcome(val ok: Boolean, val code: String?, val duplicate: Boolean, val serviceBlocked: Boolean)

    /** Starts the engine from Rust's saved config when this process has no engine yet. True when it is running. */
    fun startEngine(c: Context): Boolean {
        EngineHost.attach(c)
        return EngineHost.ensureStarted()["ok"] == true
    }

    /**
     * A `.torrent` the core can read: it only takes absolute paths. A `file://` URI becomes its path; a `content://`
     * URI is copied into the cache while the activity still holds the read grant. Null when it cannot be read.
     */
    fun localize(c: Context, source: String): String? {
        if (source.startsWith("file://", ignoreCase = true)) return Uri.parse(source).path
        if (!source.startsWith("content://", ignoreCase = true)) return null
        return try {
            val dir = File(c.cacheDir, "torrents").also { it.mkdirs() }
            val out = File(dir, "quick-${System.currentTimeMillis()}.torrent")
            c.contentResolver.openInputStream(Uri.parse(source))?.use { input ->
                out.outputStream().use { o ->
                    val buf = ByteArray(16 * 1024)
                    var total = 0
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_TORRENT_BYTES) { out.delete(); return null }
                        o.write(buf, 0, n)
                    }
                }
            } ?: return null
            // A torrent file is a bencoded dictionary: it starts with 'd'.
            if (out.length() == 0L || out.inputStream().use { it.read() } != 'd'.code) { out.delete(); null } else out.absolutePath
        } catch (e: Exception) {
            null
        }
    }

    /** The file name a content URI reports, without `.torrent`. Null when it does not say. */
    fun displayName(c: Context, source: String): String? = try {
        c.contentResolver.query(Uri.parse(source), arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0)?.replace(Regex("\\.torrent$", RegexOption.IGNORE_CASE), "")?.ifEmpty { null } else null
        }
    } catch (e: Exception) {
        null
    }

    /** Name, size and file count from the core. A failure leaves the fields null (shown as unknown). */
    fun inspect(cls: ShareClass, localTorrent: String?): Info = when (cls.kind) {
        ShareKind.MAGNET, ShareKind.TORRENT_FILE -> {
            val src = localTorrent ?: cls.source ?: return Info(null, null, null, null)
            val meta = EngineHost.resolveMetadata(src, METADATA_MS)
            if (meta["ok"] != true) Info(null, null, null, cls.infoHash)
            else Info(
                (meta["name"] as? String)?.ifEmpty { null },
                Json.long(meta["total_bytes"]).takeIf { it > 0 },
                Json.list(meta["files"]).size.takeIf { it > 0 },
                (meta["info_hash"] as? String)?.lowercase() ?: cls.infoHash,
            )
        }
        ShareKind.FILE_LINK -> {
            val probe = EngineHost.probeUrl(cls.source ?: "", emptyMap(), PROBE_MS)
            if (probe["ok"] != true) Info(null, null, null, null)
            else Info((probe["name"] as? String)?.ifEmpty { null }, (probe["size"] as? Number)?.toLong()?.takeIf { it > 0 }, null, null)
        }
        else -> Info(null, null, null, null)
    }

    /** `scheme://host/path`: how the downloads list shows a link (no user, query or fragment). */
    fun displayUrl(url: String): String {
        val m = Regex("^(https?)://([^\\s/?#]+)([^\\s?#]*)", RegexOption.IGNORE_CASE).find(url.trim()) ?: return ""
        val host = m.groupValues[2].substringAfterLast('@')
        return "${m.groupValues[1].lowercase()}://$host${m.groupValues[3].ifEmpty { "/" }}"
    }

    /** The torrent or download already in Maglev for this source, with how far it is. Null when it is new. */
    fun findExisting(cls: ShareClass, info: Info): Existing? {
        val list = EngineHost.call { NativeCore.nativeListTorrents() }
        if (list["ok"] != true) return null
        if (cls.kind == ShareKind.FILE_LINK) {
            val shown = displayUrl(cls.source ?: return null)
            val d = Json.list(list["downloads"]).firstOrNull { (it["url_display"] as? String) == shown } ?: return null
            val size = Json.long(d["size"])
            val pct = if (d["state"] == "finished") 100 else if (size > 0) (Json.long(d["downloaded"]) * 100 / size).toInt() else 0
            return Existing(pct.coerceIn(0, 100))
        }
        val hash = (cls.infoHash ?: info.infoHash) ?: return null
        val t = Json.list(list["torrents"]).firstOrNull { (it["id"] as? String).equals(hash, ignoreCase = true) } ?: return null
        val total = Json.long(t["total_bytes"])
        val pct = if (t["finished"] == true) 100 else if (total > 0) (Json.long(t["progress_bytes"]) * 100 / total).toInt() else 0
        return Existing(pct.coerceIn(0, 100))
    }

    /** "Needs X, Y free": the same admission check the feed drain uses (`Admission`, SM-35). Null when it fits or cannot be judged. */
    fun lowSpace(needBytes: Long): LowSpace? {
        val space = EngineHost.freeSpace()
        if (space["ok"] != true) return null
        val staged = space["mode"] == "staging"
        val ownFree = Json.long(space["freeBytes"])
        val free = if (staged) (space["targetFreeBytes"] as? Number)?.toLong()?.coerceAtMost(ownFree) ?: ownFree else ownFree
        var pending = 0L
        val list = EngineHost.call { NativeCore.nativeListTorrents() }
        if (list["ok"] == true) {
            for (t in Json.list(list["torrents"])) {
                if (t["finished"] == true) continue
                pending += (Json.long(t["total_bytes"]) - Json.long(t["progress_bytes"])).coerceAtLeast(0L)
            }
        }
        val out = Admission.admit(free, pending, if (staged) 2 else 1, needBytes)
        return if (out.result == Admission.Result.DoesntFit) LowSpace(out.need, free) else null
    }

    /**
     * Adds the source. Starts the engine and the foreground service first (the card is on screen, so Android allows it).
     * A refused service start is reported, not hidden: the add still happens.
     */
    fun add(c: Context, cls: ShareClass, localTorrent: String?): Outcome {
        if (!startEngine(c)) return Outcome(false, "ENGINE_UNAVAILABLE", false, false)
        val serviceStarted = BackgroundStart.start(c, MaglevTorrentService.ACTION_START)
        val res = if (cls.kind == ShareKind.FILE_LINK) {
            EngineHost.addDownload(cls.source ?: "", emptyMap())
        } else {
            EngineHost.addTorrent(localTorrent ?: cls.source ?: "", emptyMap())
        }
        val ok = res["ok"] == true
        val code = res["code"] as? String
        return Outcome(ok, code, code == "DUPLICATE", !serviceStarted)
    }
}
