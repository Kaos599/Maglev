package com.maglev.engine.storage

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import java.io.File

/**
 * "Hide from gallery" (docs/NATIVE_CONTRACT.md, hideFromGallery). While on, an empty `.nomedia` sits in the folder
 * Maglev saves to, and Maglev does not ask the media scanner about its files. JS pushes the setting inside the
 * `setGovernance` payload and the module saves it here, so it is read with no JS running.
 *
 * Maglev removes only a `.nomedia` it created itself, and only while that file is still empty.
 */
object GalleryHide {
    private const val TAG = "MaglevGalleryHide"
    private const val PREFS = "maglev_gallery"
    private const val KEY_HIDE = "hide_from_gallery"
    private const val KEY_CREATED = "created_nomedia"
    private const val NOMEDIA = ".nomedia"
    private const val FILE_PREFIX = "file:"
    private const val DOC_PREFIX = "doc:"

    private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Called from the module's setGovernance. A missing key leaves the saved value alone. */
    fun save(c: Context, rules: Map<String, Any?>) {
        if (rules.containsKey("hideFromGallery")) {
            prefs(c).edit().putBoolean(KEY_HIDE, rules["hideFromGallery"] == true).apply()
        }
    }

    /** True while the setting is on. Callers skip every media scan then. */
    fun hidden(c: Context): Boolean = prefs(c).getBoolean(KEY_HIDE, false)

    /**
     * Makes the folder match the setting: writes `.nomedia` when on, removes ours when off. Call at engine start,
     * when the setting changes and when the download folder changes. Blocking, call from IO.
     */
    @Synchronized
    fun apply(c: Context) {
        try {
            if (hidden(c)) ensure(c) else cleanup(c)
        } catch (e: Exception) {
            Log.w(TAG, "could not update .nomedia: ${e.message}")
        }
    }

    private fun ensure(c: Context) {
        val target = StorageManager.activeTarget(c)
        if (target.mode == "staging") {
            // Files are downloaded into private staging and copied into the user's tree when they finish.
            target.treeUri?.let { ensureInTree(c, Uri.parse(it)) }
        } else {
            ensureInFolder(c, File(target.path))
        }
    }

    private fun ensureInFolder(c: Context, dir: File) {
        val f = File(dir, NOMEDIA)
        if (f.exists()) return
        try {
            if ((dir.isDirectory || dir.mkdirs()) && f.createNewFile()) remember(c, FILE_PREFIX + f.absolutePath)
        } catch (e: Exception) {
            Log.w(TAG, "could not write .nomedia: ${e.message}")
        }
    }

    private fun ensureInTree(c: Context, tree: Uri) {
        if (!SafStorageManager.hasPersistedPermission(c, tree)) return
        val root = DocumentFile.fromTreeUri(c, tree) ?: return
        if (root.findFile(NOMEDIA) != null) return
        val made = root.createFile("application/octet-stream", NOMEDIA)
        if (made != null) remember(c, DOC_PREFIX + made.uri.toString())
    }

    private fun cleanup(c: Context) {
        val p = prefs(c)
        val created = p.getStringSet(KEY_CREATED, emptySet()) ?: emptySet()
        for (entry in created) {
            try {
                if (entry.startsWith(FILE_PREFIX)) {
                    val f = File(entry.removePrefix(FILE_PREFIX))
                    if (f.exists() && f.length() == 0L) f.delete()
                } else if (entry.startsWith(DOC_PREFIX)) {
                    val d = DocumentFile.fromSingleUri(c, Uri.parse(entry.removePrefix(DOC_PREFIX)))
                    if (d != null && d.exists() && d.length() == 0L) d.delete()
                }
            } catch (e: Exception) {
                Log.w(TAG, "could not remove .nomedia: ${e.message}")
            }
        }
        if (created.isNotEmpty()) p.edit().remove(KEY_CREATED).apply()
    }

    private fun remember(c: Context, entry: String) {
        val p = prefs(c)
        val next = HashSet(p.getStringSet(KEY_CREATED, emptySet()) ?: emptySet())
        if (next.add(entry)) p.edit().putStringSet(KEY_CREATED, next).apply()
    }
}
