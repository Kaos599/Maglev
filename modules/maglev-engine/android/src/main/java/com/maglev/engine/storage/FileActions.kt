package com.maglev.engine.storage

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.core.content.FileProvider
import java.io.File

/** Open, share and reveal files through FileProvider (POSIX paths) or document URIs (SAF). */
object FileActions {
    private const val EXTERNAL_DOCS = "com.android.externalstorage.documents"

    fun authority(context: Context) = context.packageName + ".maglev.fileprovider"

    /** Resolves a content URI for a torrent file, or null if it exists nowhere we can reach. */
    private fun resolveUri(context: Context, outputFolder: String, relPath: String): Uri? {
        val f = File(outputFolder, relPath)
        if (f.exists()) {
            return try {
                FileProvider.getUriForFile(context, authority(context), f)
            } catch (_: IllegalArgumentException) {
                null
            }
        }
        val tree = StorageManager.customUri(context) ?: return null
        return SafStorageManager.findInTree(context, Uri.parse(tree), relPath)?.uri
    }

    /** What [open] did. */
    sealed class OpenResult {
        object Opened : OpenResult()
        /** The file is fine but no installed app handles its type. */
        object NoApp : OpenResult()
        /** The file is missing or access was refused; [message] is plain English. */
        data class Failed(val message: String) : OpenResult()
    }

    fun open(context: Context, outputFolder: String, relPath: String): OpenResult {
        val uri = resolveUri(context, outputFolder, relPath) ?: return OpenResult.Failed("File not found")
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, SafStorageManager.mimeFor(relPath))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            context.startActivity(intent)
            OpenResult.Opened
        } catch (_: ActivityNotFoundException) {
            OpenResult.NoApp
        } catch (e: SecurityException) {
            OpenResult.Failed(e.message ?: "Access denied")
        }
    }

    /** Returns null on success or a plain-English error. */
    fun openFile(context: Context, outputFolder: String, relPath: String): String? =
        when (val r = open(context, outputFolder, relPath)) {
            OpenResult.Opened -> null
            OpenResult.NoApp -> "No app can open this file"
            is OpenResult.Failed -> r.message
        }

    fun shareFile(context: Context, outputFolder: String, relPath: String): String? {
        val uri = resolveUri(context, outputFolder, relPath) ?: return "File not found"
        val send = Intent(Intent.ACTION_SEND)
            .setType(SafStorageManager.mimeFor(relPath))
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val chooser = Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return start(context, chooser, "Sharing is not available")
    }

    /** Shares a file at a POSIX path the FileProvider covers. Returns null on success or a plain-English error. */
    fun shareLocalFile(context: Context, file: File, mime: String): String? {
        val uri = try {
            FileProvider.getUriForFile(context, authority(context), file)
        } catch (_: IllegalArgumentException) {
            return "Sharing is not available for this folder"
        }
        val send = Intent(Intent.ACTION_SEND)
            .setType(mime)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val chooser = Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return start(context, chooser, "Sharing is not available")
    }

    /** Opens the folder in a file manager, falling back to the system Downloads view. */
    fun openFolder(context: Context, outputFolder: String): String? {
        val docUri = folderDocumentUri(context, outputFolder)
        if (docUri != null) {
            val view = Intent(Intent.ACTION_VIEW)
                .setDataAndType(docUri, DocumentsContract.Document.MIME_TYPE_DIR)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            if (start(context, view, "") == null) return null
        }
        val fallback = Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return start(context, fallback, "No file manager found")
    }

    private fun folderDocumentUri(context: Context, outputFolder: String): Uri? {
        val tree = StorageManager.customUri(context)
        if (tree != null && StorageManager.isStagingPath(context, outputFolder)) {
            val t = Uri.parse(tree)
            return DocumentsContract.buildDocumentUriUsingTree(t, DocumentsContract.getTreeDocumentId(t))
        }
        val prefix = "/storage/emulated/0/"
        if (outputFolder.startsWith(prefix)) {
            val rel = outputFolder.removePrefix(prefix).trimEnd('/')
            return DocumentsContract.buildDocumentUri(EXTERNAL_DOCS, "primary:$rel")
        }
        return null
    }

    private fun start(context: Context, intent: Intent, notFound: String): String? {
        return try {
            context.startActivity(intent)
            null
        } catch (_: ActivityNotFoundException) {
            notFound
        } catch (e: SecurityException) {
            e.message ?: "Access denied"
        }
    }
}
