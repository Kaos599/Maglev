package com.maglev.engine.videosites

import android.content.Context
import android.system.Os
import android.util.Log
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantReadWriteLock
import org.json.JSONObject

/**
 * The yt-dlp file on disk: where it lives, the lock that keeps a swap away from a running read, the swap itself with
 * its test run and rollback, and the start-up repair after Android closed Maglev mid-swap.
 *
 * The library always runs `noBackupFilesDir/youtubedl-android/yt-dlp/yt-dlp` (YoutubeDL.init sets that path and copies
 * its built-in copy there only when the file is missing), so a new copy has to land at exactly that path. Python opens
 * the yt-dlp zip again by name for every module it loads (CPython zipimport `_get_data`), so replacing the file while
 * a read runs can break that read even with an atomic rename. Reads take [lock]'s read side; a swap and its test run
 * take the write side.
 *
 * Files next to the copy in use, all in the same folder so every rename stays on one file system:
 * - `yt-dlp.new`: a download in progress. Never run. Deleted at start-up.
 * - `yt-dlp.prev`: the copy that was in use, kept until the new one has run once. While it exists, the copy at the path
 *   hasn't proved itself, so start-up puts `yt-dlp.prev` back.
 *
 * Library source (0.18.1): https://github.com/yausername/youtubedl-android/blob/master/library/src/main/java/com/yausername/youtubedl_android/YoutubeDL.kt
 * zipimport: https://github.com/python/cpython/blob/3.12/Lib/zipimport.py
 * Os.rename (rename(2), replaces the target in one step): https://developer.android.com/reference/android/system/Os#rename(java.lang.String,%20java.lang.String)
 * ReentrantReadWriteLock: https://developer.android.com/reference/java/util/concurrent/locks/ReentrantReadWriteLock
 */
object YtDlpInstall {
    private const val TAG = "MaglevVideoSites"
    private const val NEW = ".new"
    private const val PREV = ".prev"
    private const val STATUS = "maglev-video-sites.json"

    /** A swap waits this long for running reads to finish, then gives up until the next check. */
    private const val SWAP_WAIT_MS = 120_000L

    /** `yt-dlp --version` takes a few seconds on a slow phone; one that hangs counts as broken. */
    private const val TEST_RUN_MS = 60_000L

    private val lock = ReentrantReadWriteLock()
    private val killer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "maglev-ytdlp-test").apply { isDaemon = true } }

    fun dir(context: Context): File = File(File(context.noBackupFilesDir, YoutubeDL.baseName), YoutubeDL.ytdlpDirName)
    fun file(context: Context): File = File(dir(context), YoutubeDL.ytdlpBin)
    fun downloadFile(context: Context): File = File(dir(context), YoutubeDL.ytdlpBin + NEW)
    private fun prevFile(context: Context): File = File(dir(context), YoutubeDL.ytdlpBin + PREV)

    /** Runs [block] while no swap can happen. Many reads can run together. */
    fun <T> reading(block: () -> T): T {
        val r = lock.readLock()
        r.lock()
        try {
            return block()
        } finally {
            r.unlock()
        }
    }

    /**
     * Start-up repair, before the library's init. A `yt-dlp.prev` means Android closed Maglev after a swap and before
     * the new copy's test run finished: the untested copy goes and the previous one comes back. A half download goes.
     */
    fun recover(context: Context) {
        val w = lock.writeLock()
        w.lock()
        try {
            val prev = prevFile(context)
            if (prev.isFile) {
                try {
                    Os.rename(prev.path, file(context).path)
                    Log.i(TAG, "start-up: put the previous yt-dlp back (the new one never finished its test run)")
                } catch (t: Throwable) {
                    Log.w(TAG, "start-up: couldn't put the previous yt-dlp back: ${t.message}")
                }
            }
            downloadFile(context).delete()
            File(dir(context), YoutubeDL.ytdlpBin + PREV + ".tmp").delete()
        } finally {
            w.unlock()
        }
    }

    enum class Outcome { INSTALLED, ROLLED_BACK, BUSY, FAILED }

    /**
     * Puts the checked download ([downloadFile]) in place of the copy in use and runs it once. While this runs no read
     * can start, and it starts only when no read runs. The run passes: `yt-dlp.prev` is deleted. It fails: `yt-dlp.prev`
     * is renamed back, so the copy that worked is the one at the path again. [expectedVersion] is the version read from
     * inside the download; the run must print it.
     */
    fun install(context: Context, expectedVersion: String?): Outcome {
        val w = lock.writeLock()
        if (!w.tryLock(SWAP_WAIT_MS, TimeUnit.MILLISECONDS)) return Outcome.BUSY
        try {
            val current = file(context)
            val next = downloadFile(context)
            val prev = prevFile(context)
            val prevTmp = File(dir(context), YoutubeDL.ytdlpBin + PREV + ".tmp")
            if (!next.isFile) return Outcome.FAILED
            // Keep the copy in use. Written under a temp name and renamed, so a yt-dlp.prev that exists is whole.
            try {
                if (current.isFile) {
                    copySynced(current, prevTmp)
                    Os.rename(prevTmp.path, prev.path)
                }
                Os.rename(next.path, current.path)
            } catch (t: Throwable) {
                Log.w(TAG, "couldn't swap in the new yt-dlp: ${t.message}")
                prevTmp.delete()
                next.delete()
                if (prev.isFile && !current.isFile) runCatching { Os.rename(prev.path, current.path) }
                prev.delete()
                return Outcome.FAILED
            }
            if (testRun(expectedVersion)) {
                prev.delete()
                return Outcome.INSTALLED
            }
            return try {
                if (prev.isFile) Os.rename(prev.path, current.path) else current.delete()
                Log.w(TAG, "the new yt-dlp failed its test run; the previous one is back")
                Outcome.ROLLED_BACK
            } catch (t: Throwable) {
                Log.w(TAG, "couldn't put the previous yt-dlp back: ${t.message}")
                Outcome.FAILED
            }
        } finally {
            w.unlock()
        }
    }

    /**
     * `yt-dlp --version` through the library, the same way a read runs it (same Python, same options). A run that takes
     * longer than [TEST_RUN_MS] is stopped with the library's `destroyProcessById`, which makes `execute` throw.
     */
    private fun testRun(expectedVersion: String?): Boolean {
        val id = "maglev-ytdlp-test-${System.nanoTime()}"
        val stop = killer.schedule(Runnable { YoutubeDL.destroyProcessById(id) }, TEST_RUN_MS, TimeUnit.MILLISECONDS)
        return try {
            val out = YoutubeDL.execute(YoutubeDLRequest(emptyList<String>()).addOption("--version"), id, null)
            val first = out.out.trim().lineSequence().firstOrNull()?.trim().orEmpty()
            out.exitCode == 0 && first.isNotEmpty() && (expectedVersion == null || first.startsWith(expectedVersion))
        } catch (t: Throwable) {
            Log.w(TAG, "yt-dlp test run failed: ${t.message?.take(300)}")
            false
        } finally {
            stop.cancel(false)
        }
    }

    private fun copySynced(from: File, to: File) {
        FileInputStream(from).use { input ->
            FileOutputStream(to).use { out ->
                input.copyTo(out, 64 * 1024)
                out.flush()
                out.fd.sync()
            }
        }
    }

    @Volatile
    private var hashCache: Triple<Long, Long, String>? = null

    /** SHA-256 of the copy in use, as lowercase hex, or null when there is none. Cached on the file's size and time. */
    fun runningSha256(context: Context): String? = try {
        val f = file(context)
        if (!f.isFile) {
            null
        } else {
            val hit = hashCache
            if (hit != null && hit.first == f.length() && hit.second == f.lastModified()) {
                hit.third
            } else {
                val h = FileInputStream(f).use { sha256(it) }
                hashCache = Triple(f.length(), f.lastModified(), h)
                h
            }
        }
    } catch (t: Throwable) {
        null
    }

    fun sha256(input: java.io.InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            md.update(buf, 0, n)
        }
        return hex(md.digest())
    }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    /**
     * What the updater last did, kept in `no_backup` next to the file it describes, so a backup restore can't pair a
     * record from one phone with a file from another. Fields: `installedSha` (the copy this updater put in place and
     * saw run), `checkedAt` (epoch ms the last check reached GitHub), `result`, `error`, `badSha` (a release that failed
     * its test run; skipped until a newer one is out).
     */
    @Synchronized
    fun readStatus(context: Context): JSONObject = try {
        JSONObject(File(context.noBackupFilesDir, STATUS).readText())
    } catch (t: Throwable) {
        JSONObject()
    }

    @Synchronized
    fun writeStatus(context: Context, change: (JSONObject) -> Unit) {
        try {
            val o = readStatus(context)
            change(o)
            val target = File(context.noBackupFilesDir, STATUS)
            val tmp = File(context.noBackupFilesDir, "$STATUS.tmp")
            FileOutputStream(tmp).use { out ->
                out.write(o.toString().toByteArray(Charsets.UTF_8))
                out.flush()
                out.fd.sync()
            }
            Os.rename(tmp.path, target.path)
        } catch (t: Throwable) {
            Log.w(TAG, "couldn't save the yt-dlp update status: ${t.message}")
        }
    }

    /** True when the copy in use is one this updater checked and saw run, not the library's built-in one. */
    fun runsCheckedDownload(context: Context): Boolean {
        val installed = readStatus(context).optString("installedSha", "")
        return installed.isNotEmpty() && installed == runningSha256(context)
    }
}
