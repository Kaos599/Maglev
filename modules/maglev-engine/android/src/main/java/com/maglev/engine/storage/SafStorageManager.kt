package com.maglev.engine.storage

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import androidx.documentfile.provider.DocumentFile
import java.io.File

/** Storage Access Framework helpers: persisted permission, tree to path, copy into a tree. */
object SafStorageManager {

    fun takePersistablePermission(context: Context, treeUri: Uri): Boolean {
        return try {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            context.contentResolver.takePersistableUriPermission(treeUri, flags)
            true
        } catch (_: Exception) {
            false
        }
    }

    /** True while the app still holds read and write on [treeUri]. */
    fun hasPersistedPermission(context: Context, treeUri: Uri): Boolean =
        context.contentResolver.persistedUriPermissions.any {
            it.uri == treeUri && it.isReadPermission && it.isWritePermission
        }

    /** `primary:Movies/X` becomes `/storage/emulated/0/Movies/X`. Other volumes map to `/storage/<id>/...`. */
    fun treeToPosixPath(treeUri: Uri): String? {
        return try {
            val docId = DocumentsContract.getTreeDocumentId(treeUri)
            val idx = docId.indexOf(':')
            if (idx < 0) return null
            val volume = docId.substring(0, idx)
            val rel = docId.substring(idx + 1)
            val root = if (volume == "primary") "/storage/emulated/0" else "/storage/$volume"
            if (rel.isEmpty()) root else "$root/$rel"
        } catch (_: Exception) {
            null
        }
    }

    fun displayName(context: Context, treeUri: Uri): String =
        DocumentFile.fromTreeUri(context, treeUri)?.name ?: treeUri.lastPathSegment ?: "Selected folder"

    /**
     * Copies [source] into the tree at [relativePath] (segments separated by `/`).
     * Skips files that already exist with the same size. Blocking, call from IO.
     * Returns null only when the target exists with the source size. A missing source is a failure.
     * Returns null on success or a plain-English error.
     */
    fun copyFileIntoTree(context: Context, treeUri: Uri, relativePath: String, source: File): String? {
        if (!source.exists()) return "Missing file: $relativePath"
        val root = DocumentFile.fromTreeUri(context, treeUri) ?: return "Folder is no longer available"
        val parts = relativePath.split('/').filter { it.isNotEmpty() }
        if (parts.isEmpty()) return null
        var dir: DocumentFile = root
        for (seg in parts.dropLast(1)) {
            val existing = dir.findFile(seg)
            dir = when {
                existing != null && existing.isDirectory -> existing
                else -> dir.createDirectory(seg) ?: return "Could not create folder $seg"
            }
        }
        val name = parts.last()
        val existing = dir.findFile(name)
        if (existing != null && existing.isFile && existing.length() == source.length() && source.length() > 0) return null
        existing?.delete()
        val target = dir.createFile(mimeFor(name), name) ?: return "Could not create $name"
        return try {
            context.contentResolver.openOutputStream(target.uri, "wt")?.use { out ->
                source.inputStream().use { it.copyTo(out, 256 * 1024) }
            } ?: return "Could not write $name"
            if (target.length() != source.length()) "Copy of $name is incomplete" else null
        } catch (e: Exception) {
            e.message ?: "Copy failed for $name"
        }
    }

    /** What [copyNewFileIntoTree] did. [error] is null on success; [uri] and [name] name the document it created. */
    data class CopyOutcome(val error: String?, val uri: Uri?, val name: String?)

    /**
     * Copies [source] into the root of the tree as a NEW file. It never overwrites or adopts an existing file: when
     * [name] is taken the copy gets a free name (`a (1).zip`). On success the created document is returned so the
     * caller can remember exactly it. A copy that fails deletes only the document it created itself.
     * Blocking, call from IO.
     */
    fun copyNewFileIntoTree(context: Context, treeUri: Uri, name: String, source: File): CopyOutcome {
        if (!source.exists()) return CopyOutcome("Missing file: $name", null, null)
        val root = DocumentFile.fromTreeUri(context, treeUri) ?: return CopyOutcome("Folder is no longer available", null, null)
        val finalName = FreeName.pick(name) { root.findFile(it) != null }
        val target = root.createFile(mimeFor(finalName), finalName)
            ?: return CopyOutcome("Could not create $finalName", null, null)
        // From here on the document is ours: a failure removes it.
        fun fail(message: String): CopyOutcome {
            try { target.delete() } catch (_: Exception) {}
            return CopyOutcome(message, null, null)
        }
        return try {
            context.contentResolver.openOutputStream(target.uri, "wt")?.use { out ->
                source.inputStream().use { it.copyTo(out, 256 * 1024) }
            } ?: return fail("Could not write $finalName")
            if (target.length() != source.length()) fail("Copy of $finalName is incomplete") else CopyOutcome(null, target.uri, target.name ?: finalName)
        } catch (e: Exception) {
            fail(e.message ?: "Copy failed for $finalName")
        }
    }

    /** Deletes one document by its URI. True when it is gone (a missing document counts). */
    fun deleteDocument(context: Context, uri: Uri): Boolean = try {
        DocumentsContract.deleteDocument(context.contentResolver, uri)
    } catch (_: java.io.FileNotFoundException) {
        true
    } catch (_: Exception) {
        false
    }

    /** True when the tree holds a file at [relativePath] with the same size as [source]. Blocking, call from IO. */
    fun copyMatches(context: Context, treeUri: Uri, relativePath: String, source: File): Boolean {
        val doc = try { findInTree(context, treeUri, relativePath) } catch (_: Exception) { null } ?: return false
        return doc.isFile && source.isFile && doc.length() == source.length()
    }

    /** Finds a document in the tree by relative path, or null. */
    fun findInTree(context: Context, treeUri: Uri, relativePath: String): DocumentFile? {
        var cur: DocumentFile = DocumentFile.fromTreeUri(context, treeUri) ?: return null
        for (seg in relativePath.split('/').filter { it.isNotEmpty() }) {
            cur = cur.findFile(seg) ?: return null
        }
        return cur
    }

    /**
     * Deletes the document at [relativePath] in the tree, then each parent folder it leaves empty.
     * True when nothing is left at that path (a missing document counts). Blocking, call from IO.
     */
    fun deleteFromTree(context: Context, treeUri: Uri, relativePath: String): Boolean {
        val doc = findInTree(context, treeUri, relativePath) ?: return true
        val deleted = try { doc.delete() } catch (_: Exception) { false }
        if (!deleted) return false
        var parent = relativePath.trimEnd('/').substringBeforeLast('/', "")
        while (parent.isNotEmpty()) {
            val dir = findInTree(context, treeUri, parent) ?: break
            val empty = try { dir.isDirectory && dir.listFiles().isEmpty() } catch (_: Exception) { false }
            if (!empty || !dir.delete()) break
            parent = parent.substringBeforeLast('/', "")
        }
        return true
    }

    fun mimeFor(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }
}
