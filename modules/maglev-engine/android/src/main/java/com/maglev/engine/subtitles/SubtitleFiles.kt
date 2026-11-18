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

    /**
     * A bare file name: not empty, not "." or "..", no slash, backslash or NUL, at most 255 bytes in UTF-8.
     * Names with ".." inside ("...And Justice for All.en.srt") are valid.
     */
    // NATIVE_CONTRACT 39.1 S4
    fun validName(name: String): Boolean =
        name.isNotEmpty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\') &&
            !name.contains('\u0000') && name.toByteArray(Charsets.UTF_8).size <= 255

    /** The temporary file name next to [fileName]; a short one when the long one would pass 255 bytes (S4). */
    // NATIVE_CONTRACT 39.1 S4
    private fun tempName(fileName: String): String {
        val long = ".$fileName.maglev-tmp"
        return if (long.toByteArray(Charsets.UTF_8).size <= 255) long else ".maglev-${System.nanoTime()}.tmp"
    }

    /** An unknown size (-1) counts as checked; a known size must match. */
    // NATIVE_CONTRACT 39.1 S2
    private fun sizeOk(size: Long, expected: Int): Boolean = size < 0 || size == expected.toLong()

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
        val existed = target.exists()
        if (existed && !replace) throw SubtitleException("NAME_TAKEN", "A file with this name already exists")
        val tmp = File(dir, tempName(fileName))
        try {
            writeSynced(tmp, data)
            // rename(2) replaces an existing file atomically, so the old file is never half-written (S2).
            if (!tmp.renameTo(target)) {
                // NATIVE_CONTRACT 39.1 S5: the old file can't be replaced (another app or an earlier install owns it).
                if (existed) throw SubtitleException("REPLACE_DENIED", "That file belongs to another app")
                throw IOException("Could not move the subtitle into place")
            }
        } catch (e: Exception) {
            try { tmp.delete() } catch (_: Exception) {}
            throw e
        }
        if (target.name != fileName || target.length() != data.size.toLong()) {
            // Only a file we created is removed; a replaced original is already gone by the atomic rename.
            if (!existed) try { target.delete() } catch (_: Exception) {}
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
        return if (existing == null) createSaf(context, parentUri, fileName, data) else replaceSaf(context, parentUri, existing, fileName, data)
    }

    private fun writeDocument(context: Context, uri: Uri, data: ByteArray) {
        try {
            val out = context.contentResolver.openOutputStream(uri, "wt") ?: throw SubtitleException("CANT_WRITE", "Maglev can't write the subtitle file")
            out.use { it.write(data) }
        } catch (e: SubtitleException) {
            throw e
        } catch (e: Exception) {
            throw mapWriteError(e)
        }
    }

    private fun deleteQuietly(context: Context, uri: Uri) {
        try { DocumentsContract.deleteDocument(context.contentResolver, uri) } catch (_: Exception) {}
    }

    /** A new document: the name was free. Any failure removes the document we made (and only that one). */
    private fun createSaf(context: Context, parentUri: Uri, fileName: String, data: ByteArray): String {
        val target: Uri = DocumentsContract.createDocument(context.contentResolver, parentUri, "application/octet-stream", fileName)
            ?: throw SubtitleException("CANT_WRITE", "Maglev can't create the subtitle file")
        fun fail(e: SubtitleException): Nothing {
            deleteQuietly(context, target)
            throw e
        }
        // The provider may have renamed it (a clash it did not tell us about, or an added extension).
        if (queryNameSize(context, target).first != fileName) fail(SubtitleException("VERIFY_FAILED", "The saved subtitle did not check out"))
        try {
            writeDocument(context, target, data)
        } catch (e: SubtitleException) {
            fail(e)
        }
        val (name, size) = queryNameSize(context, target)
        if (name != fileName || !sizeOk(size, data.size)) fail(SubtitleException("VERIFY_FAILED", "The saved subtitle did not check out"))
        return target.toString()
    }

    /**
     * Replace on a folder picked with the file picker (NATIVE_CONTRACT 39.1 S2, S5). The existing document is never
     * deleted or truncated before the new content has been written in full to a temporary document and checked.
     * The old file is then renamed aside, the new one renamed into place, and the old one deleted last; if a step
     * fails the old file is renamed back.
     */
    // NATIVE_CONTRACT 39.1 S2
    private fun replaceSaf(context: Context, parentUri: Uri, existing: Uri, fileName: String, data: ByteArray): String {
        val resolver = context.contentResolver
        val tmp: Uri = DocumentsContract.createDocument(resolver, parentUri, "application/octet-stream", tempName(fileName))
            ?: throw SubtitleException("CANT_WRITE", "Maglev can't create the subtitle file")
        try {
            writeDocument(context, tmp, data)
            if (!sizeOk(queryNameSize(context, tmp).second, data.size)) throw SubtitleException("VERIFY_FAILED", "The saved subtitle did not check out")
        } catch (e: SubtitleException) {
            deleteQuietly(context, tmp)
            throw e
        }

        if (!supportsRename(context, tmp) || !supportsRename(context, existing)) {
            // No rename here. The temporary copy proved the provider can take the data, so write over the original.
            // NATIVE_CONTRACT 39.1 S2: keep the original's bytes first (subtitles are small) and put them back if the
            // overwrite fails partway, so a failed Replace never leaves the old subtitle cut off or empty.
            val original: ByteArray = try {
                resolver.openInputStream(existing)?.use { it.readBytes() }
            } catch (_: Exception) {
                null
            } ?: run {
                deleteQuietly(context, tmp)
                throw SubtitleException("REPLACE_DENIED", "That file belongs to another app")
            }
            try {
                writeDocument(context, existing, data)
            } catch (e: SubtitleException) {
                try { writeDocument(context, existing, original) } catch (_: Exception) {}
                deleteQuietly(context, tmp)
                throw e
            }
            deleteQuietly(context, tmp)
            val (name, size) = queryNameSize(context, existing)
            if (name != fileName || !sizeOk(size, data.size)) {
                try { writeDocument(context, existing, original) } catch (_: Exception) {}
                throw SubtitleException("VERIFY_FAILED", "The saved subtitle did not check out")
            }
            return existing.toString()
        }

        // Step 1: move the old file aside. If this is refused, the old file is untouched. NATIVE_CONTRACT 39.1 S5.
        val backup: Uri? = try {
            DocumentsContract.renameDocument(resolver, existing, ".$fileName.maglev-old".let { if (it.toByteArray(Charsets.UTF_8).size <= 255) it else ".maglev-old-${System.nanoTime()}" })
        } catch (_: Exception) {
            null
        }
        if (backup == null) {
            deleteQuietly(context, tmp)
            throw SubtitleException("REPLACE_DENIED", "That file belongs to another app")
        }
        fun restore(): Unit {
            try { DocumentsContract.renameDocument(resolver, backup, fileName) } catch (_: Exception) {}
        }
        // Step 2: move the new file into place.
        val placed: Uri? = try { DocumentsContract.renameDocument(resolver, tmp, fileName) } catch (_: Exception) { null }
        if (placed == null) {
            deleteQuietly(context, tmp)
            restore()
            throw SubtitleException("CANT_WRITE", "Maglev can't write the subtitle file")
        }
        val (name, size) = queryNameSize(context, placed)
        if (name != fileName || !sizeOk(size, data.size)) {
            deleteQuietly(context, placed)
            restore()
            throw SubtitleException("VERIFY_FAILED", "The saved subtitle did not check out")
        }
        // Step 3: only now is the old file removed.
        deleteQuietly(context, backup)
        return placed.toString()
    }

    private fun supportsRename(context: Context, uri: Uri): Boolean {
        context.contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_FLAGS), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) return (c.getInt(0) and DocumentsContract.Document.FLAG_SUPPORTS_RENAME) != 0
        }
        return false
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
