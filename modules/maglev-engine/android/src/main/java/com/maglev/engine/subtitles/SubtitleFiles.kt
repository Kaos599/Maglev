package com.maglev.engine.subtitles

import android.content.Context
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.RandomAccessFile

/**
 * Disk side of the subtitle calls (NATIVE_CONTRACT 36.6). Blocking: call from IO.
 *
 * Accepted forms of a video location:
 *  - an absolute POSIX path (`/storage/emulated/0/Download/Maglev/X/video.mkv`) or `file://` + that path. This is
 *    what JS builds from the torrent's output folder plus `DetailFile.path` for the default folder and for a custom
 *    folder in "direct" mode;
 *  - a SAF document URI inside a granted tree (`content://.../tree/<tree>/document/<doc>`), for a custom folder in
 *    "staging" mode where the file only exists as a document in the tree.
 * A bare tree URI, or a relative path, is not accepted.
 */
object SubtitleFiles {

    // region hash

    fun hash(context: Context, pathOrUri: String): Pair<String, Long> {
        try {
            if (pathOrUri.startsWith("content://")) {
                val pfd = context.contentResolver.openFileDescriptor(Uri.parse(pathOrUri), "r")
                    ?: throw SubtitleException("NOT_FOUND", "The video was not found")
                return pfd.use { p -> FileInputStream(p.fileDescriptor).use { fis -> SubtitleHash.hashChannel(fis.channel) } }
            }
            val file = posixFile(pathOrUri)
            if (!file.isFile) throw SubtitleException("NOT_FOUND", "The video was not found")
            return RandomAccessFile(file, "r").use { SubtitleHash.hashChannel(it.channel) }
        } catch (e: SubtitleException) {
            throw e
        } catch (e: FileNotFoundException) {
            throw SubtitleException("NOT_FOUND", "The video was not found")
        } catch (e: SecurityException) {
            throw SubtitleException("IO", e.message ?: "Access to the video was refused")
        } catch (e: IOException) {
            throw SubtitleException("IO", e.message ?: "The video could not be read")
        }
    }

    // endregion

    // region save

    /** A bare file name: no slash, no "..", not empty, at most 255 bytes in UTF-8. */
    fun validName(name: String): Boolean =
        name.isNotEmpty() && name != "." && !name.contains('/') && !name.contains('\\') && !name.contains("..") &&
            !name.contains('\u0000') && name.toByteArray(Charsets.UTF_8).size <= 255

    /** Writes [data] as [fileName] next to the video. Returns the path or document URI of the written file. */
    fun save(context: Context, videoPathOrUri: String, fileName: String, data: ByteArray, replace: Boolean): String {
        if (!validName(fileName)) throw SubtitleException("CANT_WRITE", "That file name can't be used")
        return try {
            if (videoPathOrUri.startsWith("content://")) saveSaf(context, Uri.parse(videoPathOrUri), fileName, data, replace)
            else savePosix(videoPathOrUri, fileName, data, replace)
        } catch (e: SubtitleException) {
            throw e
        } catch (e: Exception) {
            throw mapWriteError(e)
        }
    }

    private fun posixFile(pathOrUri: String): File =
        File(if (pathOrUri.startsWith("file://")) Uri.parse(pathOrUri).path ?: pathOrUri.removePrefix("file://") else pathOrUri)

    private fun savePosix(videoPath: String, fileName: String, data: ByteArray, replace: Boolean): String {
        val dir = posixFile(videoPath).parentFile
        if (dir == null || !dir.isDirectory) throw SubtitleException("CANT_WRITE", "The video's folder was not found")
        val target = File(dir, fileName)
        if (target.exists() && !replace) throw SubtitleException("NAME_TAKEN", "A file with this name already exists")
        val tmp = File(dir, ".$fileName.maglev-tmp")
        try {
            writeSynced(tmp, data)
            // rename(2) replaces an existing file atomically.
            if (!tmp.renameTo(target)) throw IOException("Could not move the subtitle into place")
        } catch (e: Exception) {
            try { tmp.delete() } catch (_: Exception) {}
            throw e
        }
        if (target.name != fileName || target.length() != data.size.toLong()) {
            try { target.delete() } catch (_: Exception) {}
            throw SubtitleException("VERIFY_FAILED", "The saved subtitle did not check out")
        }
        return target.absolutePath
    }

    private fun writeSynced(file: File, data: ByteArray) {
        java.io.FileOutputStream(file).use { out ->
            out.write(data)
            out.flush()
            out.fd.sync()
        }
    }

    private fun saveSaf(context: Context, videoUri: Uri, fileName: String, data: ByteArray, replace: Boolean): String {
        val resolver = context.contentResolver
        val parentId = parentDocumentId(context, videoUri)
            ?: throw SubtitleException("CANT_WRITE", "Maglev can't find the video's folder")
        val parentUri = DocumentsContract.buildDocumentUriUsingTree(videoUri, parentId)
        val existing = findChild(context, videoUri, parentId, fileName)
        if (existing != null && !replace) throw SubtitleException("NAME_TAKEN", "A file with this name already exists")

        val created = existing == null
        val target: Uri = existing
            ?: DocumentsContract.createDocument(resolver, parentUri, "application/octet-stream", fileName)
            ?: throw SubtitleException("CANT_WRITE", "Maglev can't create the subtitle file")
        // From here on the document is ours: any failure removes it. A replaced original is overwritten anyway.
        fun fail(code: String, message: String): Nothing {
            try { DocumentsContract.deleteDocument(resolver, target) } catch (_: Exception) {}
            throw SubtitleException(code, message)
        }
        if (created) {
            // The provider may have renamed it (a clash it did not tell us about, or an added extension).
            val (name, _) = queryNameSize(context, target)
            if (name != fileName) fail("VERIFY_FAILED", "The saved subtitle did not check out")
        }
        try {
            val out = resolver.openOutputStream(target, "wt") ?: fail("CANT_WRITE", "Maglev can't write the subtitle file")
            out.use { it.write(data) }
        } catch (e: SubtitleException) {
            throw e
        } catch (e: Exception) {
            val mapped = mapWriteError(e)
            fail(mapped.code, mapped.message ?: "Maglev can't write the subtitle file")
        }
        val (name, size) = queryNameSize(context, target)
        if (name != fileName || size != data.size.toLong()) fail("VERIFY_FAILED", "The saved subtitle did not check out")
        return target.toString()
    }

    /** The document id of the folder holding [docUri], or null when it can't be told. */
    private fun parentDocumentId(context: Context, docUri: Uri): String? {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                try {
                    val ids = DocumentsContract.findDocumentPath(context.contentResolver, docUri)?.path
                    if (ids != null && ids.size >= 2) return ids[ids.size - 2]
                } catch (_: Exception) {
                    // Fall back to the id shape below.
                }
            }
            val id = DocumentsContract.getDocumentId(docUri)
            return when {
                id.contains('/') -> id.substringBeforeLast('/')
                id.contains(':') -> id.substringBefore(':') + ":" // a file at the root of an external-storage volume
                else -> null
            }
        } catch (_: Exception) {
            return null
        }
    }

    /** The child of [parentId] whose display name is exactly [name], or null. [treeBase] is any tree-based URI. */
    private fun findChild(context: Context, treeBase: Uri, parentId: String, name: String): Uri? {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(treeBase, parentId)
        val cols = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        context.contentResolver.query(children, cols, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                if (c.getString(1) == name) return DocumentsContract.buildDocumentUriUsingTree(treeBase, c.getString(0))
            }
        }
        return null
    }

    /** Display name and size of a document; (null, -1) when it can't be read. */
    private fun queryNameSize(context: Context, uri: Uri): Pair<String?, Long> {
        val cols = arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_SIZE)
        context.contentResolver.query(uri, cols, null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val name = if (c.isNull(0)) null else c.getString(0)
                val size = if (c.isNull(1)) -1L else c.getLong(1)
                return name to size
            }
        }
        return null to -1L
    }

    /** ENOSPC becomes NO_SPACE, everything else CANT_WRITE. */
    fun mapWriteError(e: Throwable): SubtitleException {
        var t: Throwable? = e
        while (t != null) {
            val m = t.message ?: ""
            if (m.contains("ENOSPC") || m.contains("No space left", ignoreCase = true)) {
                return SubtitleException("NO_SPACE", "There isn't enough free space to save the subtitle")
            }
            t = t.cause
        }
        return SubtitleException("CANT_WRITE", e.message ?: "Maglev can't write the subtitle file")
    }

    // endregion
}
