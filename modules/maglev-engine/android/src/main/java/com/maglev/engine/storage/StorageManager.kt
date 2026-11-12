package com.maglev.engine.storage

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import androidx.core.content.ContextCompat
import java.io.File

/** Where the engine writes new torrents. Policy: docs/NATIVE_CONTRACT.md section 5. */
data class DownloadTarget(
    /** Absolute POSIX directory handed to Rust as the output folder. */
    val path: String,
    /** True when the public Download/Maglev folder was not usable. */
    val fallback: Boolean,
    /** Tree URI of the user's custom folder, or null. */
    val treeUri: String?,
    /** "default", "direct" or "staging". */
    val mode: String,
)

object StorageManager {
    private const val PREFS = "maglev_storage"
    private const val KEY_URI = "tree_uri"
    private const val KEY_PATH = "tree_path"
    private const val KEY_MODE = "tree_mode"
    private const val KEY_NAME = "tree_name"
    private const val KEY_COPIED = "copied_ids"
    private const val PROBE = ".maglev_probe"

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** App-private staging root. Seeding continues from here for staging-mode torrents. */
    fun stagingDir(context: Context): File {
        val base = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir
        return File(base, "Staging").also { it.mkdirs() }
    }

    fun sessionDir(context: Context): File = File(context.filesDir, "session").also { it.mkdirs() }

    /** Public `Download/Maglev`, only when it exists or can be created, and a write probe passes. */
    fun resolveDefaultDownloadDir(context: Context): Pair<File, Boolean> {
        val canTryPublic = Build.VERSION.SDK_INT > Build.VERSION_CODES.P ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
            PackageManager.PERMISSION_GRANTED
        if (canTryPublic) {
            try {
                @Suppress("DEPRECATION")
                val pub = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Maglev")
                pub.mkdirs()
                if (probeWritable(pub)) return pub to false
            } catch (_: Exception) {
                // fall through to the app-specific folder
            }
        }
        val fallbackDir = File(
            context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir,
            "Maglev",
        )
        fallbackDir.mkdirs()
        return fallbackDir to true
    }

    /** Creates and deletes a file in [dir]. */
    private val probeCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Boolean, Long>>()
    private const val PROBE_TTL_MS = 60_000L

    /**
     * True when a file can be written in [dir]. Cached per folder for a minute: each probe write in
     * shared storage makes MediaProvider log an error, and storage status is read often.
     */
    fun probeWritable(dir: File): Boolean {
        val key = dir.absolutePath
        val now = android.os.SystemClock.elapsedRealtime()
        probeCache[key]?.let { (ok, at) -> if (now - at < PROBE_TTL_MS) return ok }
        return probeUncached(dir).also { probeCache[key] = it to now }
    }

    private fun probeUncached(dir: File): Boolean {
        return try {
            if (!dir.exists() && !dir.mkdirs()) return false
            val probe = File(dir, PROBE)
            probe.writeText("ok")
            val ok = probe.exists()
            probe.delete()
            ok
        } catch (_: Exception) {
            false
        }
    }

    /** Resolves the directory new torrents go to, honoring a persisted custom folder. */
    fun activeTarget(context: Context): DownloadTarget {
        val p = prefs(context)
        val uri = p.getString(KEY_URI, null)
        val mode = p.getString(KEY_MODE, null)
        if (uri != null && mode != null) {
            if (mode == "direct") {
                val path = p.getString(KEY_PATH, null)
                if (path != null && probeWritable(File(path))) {
                    return DownloadTarget(path, false, uri, "direct")
                }
            }
            if (mode == "staging" || mode == "direct") {
                // A direct folder that stopped working falls back to staging so downloads keep going.
                return DownloadTarget(stagingDir(context).absolutePath, false, uri, "staging")
            }
        }
        val (dir, fallback) = resolveDefaultDownloadDir(context)
        return DownloadTarget(dir.absolutePath, fallback, null, "default")
    }

    fun saveCustomFolder(context: Context, uri: String, path: String?, mode: String, name: String) {
        prefs(context).edit()
            .putString(KEY_URI, uri).putString(KEY_PATH, path).putString(KEY_MODE, mode).putString(KEY_NAME, name)
            .apply()
    }

    fun clearCustomFolder(context: Context) {
        prefs(context).edit().remove(KEY_URI).remove(KEY_PATH).remove(KEY_MODE).remove(KEY_NAME).apply()
    }

    fun customUri(context: Context): String? = prefs(context).getString(KEY_URI, null)
    fun customName(context: Context): String? = prefs(context).getString(KEY_NAME, null)

    fun isStagingPath(context: Context, outputFolder: String): Boolean {
        val root = stagingDir(context).absolutePath
        return outputFolder == root || outputFolder.startsWith(root + File.separator)
    }

    /**
     * Frees the staged files of a torrent whose copy in the user's tree is verified by size. Seeding reads from
     * staging (NATIVE_CONTRACT section 5), so call this only when the torrent is removed with its files kept in
     * the tree, or has stopped seeding for good. Returns bytes freed. Blocking, call from IO.
     */
    fun freeStagedFiles(context: Context, outputFolder: String, relPaths: List<String>): Long {
        val tree = customUri(context)?.let { android.net.Uri.parse(it) } ?: return 0L
        if (!isStagingPath(context, outputFolder)) return 0L
        return StagingCleanup.free(stagingDir(context), File(outputFolder), relPaths) { rel, f ->
            SafStorageManager.copyMatches(context, tree, rel, f)
        }
    }

    /**
     * Frees a staged link download once its copy in the user's tree is verified by size: the file, then the
     * unfinished `.part` and `.maglev-dl.json` leftovers (docs/NATIVE_CONTRACT.md section 17). Returns bytes freed.
     * Blocking, call from IO.
     */
    fun freeStagedDownload(context: Context, folder: String, name: String): Long {
        val tree = customUri(context)?.let { android.net.Uri.parse(it) } ?: return 0L
        if (!isStagingPath(context, folder)) return 0L
        val leftovers = setOf("$name.part", "$name.maglev-dl.json")
        return StagingCleanup.free(stagingDir(context), File(folder), listOf(name) + leftovers) { rel, f ->
            rel in leftovers || SafStorageManager.copyMatches(context, tree, rel, f)
        }
    }

    private fun copiedKey(id: String, folder: String, tree: String) = "$id|$folder|$tree"

    /** A marker is valid only for the same torrent, output folder and destination tree. */
    fun isCopied(context: Context, id: String, folder: String, tree: String): Boolean =
        prefs(context).getStringSet(KEY_COPIED, emptySet())?.contains(copiedKey(id, folder, tree)) == true

    fun markCopied(context: Context, id: String, folder: String, tree: String) {
        val p = prefs(context)
        val next = HashSet(p.getStringSet(KEY_COPIED, emptySet()) ?: emptySet())
        next.add(copiedKey(id, folder, tree))
        p.edit().putStringSet(KEY_COPIED, next).apply()
    }

    /** Forget every marker of a torrent, used when it is deleted. */
    fun clearCopied(context: Context, id: String) {
        val p = prefs(context)
        val next = HashSet(p.getStringSet(KEY_COPIED, emptySet()) ?: emptySet())
        if (next.removeAll { it.startsWith("$id|") }) p.edit().putStringSet(KEY_COPIED, next).apply()
    }
}
