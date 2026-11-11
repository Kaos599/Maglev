package com.maglev.engine.storage

import java.io.File

/**
 * Picks the files worth handing to MediaScannerConnection (docs/NATIVE_CONTRACT.md section 12.2).
 * Pure JVM so it can be unit tested. Only files under public shared storage qualify, never app-private
 * or staging directories, and never paths that escape the output folder.
 */
object MediaScanPaths {
    /**
     * @param baseDir the folder the relative [files] paths hang off (output folder, or the resolved SAF tree path)
     * @param files paths relative to [baseDir]
     * @param publicRoot e.g. Environment.getExternalStorageDirectory(); also treats `<publicRoot>/Android` as private
     * @param privateRoots extra directories to exclude (staging, getExternalFilesDir, filesDir)
     * @param exists injectable for tests
     */
    fun select(
        baseDir: String,
        files: List<String>,
        publicRoot: String,
        privateRoots: List<String>,
        exists: (File) -> Boolean = { it.isFile },
    ): List<String> {
        val root = canon(publicRoot) ?: return emptyList()
        val blocked = (privateRoots + File(publicRoot, "Android").path).mapNotNull { canon(it) }
        val out = LinkedHashSet<String>()
        for (rel in files) {
            if (rel.isEmpty()) continue
            val f = canon(File(baseDir, rel).path) ?: continue
            val base = canon(baseDir) ?: continue
            if (!under(f, base)) continue // ".." escape
            if (!under(f, root)) continue
            if (blocked.any { under(f, it) }) continue
            if (!exists(File(f))) continue
            out.add(f)
        }
        return out.toList()
    }

    private fun canon(p: String): String? = try {
        File(p).canonicalPath
    } catch (_: Exception) {
        null
    }

    private fun under(path: String, dir: String): Boolean = path == dir || path.startsWith(dir.trimEnd('/') + "/")
}
