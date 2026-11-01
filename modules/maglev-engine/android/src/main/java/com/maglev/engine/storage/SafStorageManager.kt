package com.maglev.engine.storage

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.documentfile.provider.DocumentFile
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

object SafStorageManager {

    /**
     * Persists URI permission across reboots when user selects a custom tree via ACTION_OPEN_DOCUMENT_TREE.
     */
    fun takePersistablePermission(context: Context, treeUri: Uri) {
        try {
            val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            context.contentResolver.takePersistableUriPermission(treeUri, takeFlags)
        } catch (e: Exception) {
            // Permission already taken or not persistable
        }
    }

    /**
     * Resolves and detaches a file descriptor for a child file inside the SAF document tree.
     * Strictly calls pfd.detachFd() so the native Rust engine holds sole ownership of the fd.
     */
    fun getDetachedFdForFile(
        context: Context,
        treeUri: Uri,
        fileName: String,
        mimeType: String = "application/octet-stream"
    ): Int {
        val rootDoc = DocumentFile.fromTreeUri(context, treeUri) ?: return -1
        var targetDoc = rootDoc.findFile(fileName)
        if (targetDoc == null) {
            targetDoc = rootDoc.createFile(mimeType, fileName)
        }
        val targetUri = targetDoc?.uri ?: return -1

        val pfd = context.contentResolver.openFileDescriptor(targetUri, "rwt") ?: return -1
        return pfd.detachFd()
    }

    /**
     * Auto-moves a completed torrent file or directory to the destination directory.
     * Uses atomic rename if on the same mount, otherwise copies with zero blocking.
     */
    fun moveCompletedPayload(sourcePath: String, destinationDir: String): String? {
        val src = File(sourcePath)
        if (!src.exists()) return null

        val dstDir = File(destinationDir)
        if (!dstDir.exists()) {
            dstDir.mkdirs()
        }

        val target = File(dstDir, src.name)

        // Try atomic rename first
        if (src.renameTo(target)) {
            return target.absolutePath
        }

        // Fallback to streaming copy and delete
        try {
            if (src.isDirectory) {
                src.copyRecursively(target, overwrite = true)
                src.deleteRecursively()
            } else {
                FileInputStream(src).use { input ->
                    FileOutputStream(target).use { output ->
                        input.copyTo(output)
                    }
                }
                src.delete()
            }
            return target.absolutePath
        } catch (e: Exception) {
            return null
        }
    }
}
