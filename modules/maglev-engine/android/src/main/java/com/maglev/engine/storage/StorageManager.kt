package com.maglev.engine.storage

import android.content.Context
import android.os.Environment
import java.io.File

object StorageManager {
    /**
     * Resolves the primary default zero-copy App-Specific External Storage directory:
     * `/storage/emulated/0/Android/data/com.maglev/files/Download`
     *
     * This path retains 100% direct native POSIX filesystem access (open, pwrite64, pread64)
     * without SAF Binder IPC overhead and without FUSE permission prompts on Android 11-15.
     */
    fun getDefaultDownloadDirectory(context: Context): File {
        val baseDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: File(context.filesDir, "Download")
        if (!baseDir.exists()) {
            baseDir.mkdirs()
        }
        return baseDir
    }

    /**
     * Verifies that the path exists and is writable by writing and deleting a temporary probe file.
     */
    fun verifyDirectoryWritable(dir: File): Boolean {
        return try {
            if (!dir.exists()) {
                dir.mkdirs()
            }
            val probe = File(dir, ".probe_maglev_write")
            probe.writeText("ok")
            val readable = probe.exists()
            probe.delete()
            readable
        } catch (e: Exception) {
            false
        }
    }
}
