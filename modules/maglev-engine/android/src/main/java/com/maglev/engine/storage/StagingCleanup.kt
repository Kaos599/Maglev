package com.maglev.engine.storage

import java.io.File

/**
 * Frees a staging torrent's files once the user's folder holds a verified copy. Pure JVM, no android.* imports.
 * Seeding reads from staging (docs/NATIVE_CONTRACT.md section 5), so callers must only run this when the
 * torrent is removed or seeding has stopped. Never touches anything outside [stagingRoot].
 */
object StagingCleanup {
    /** True when [f] is inside [root] after resolving `..` and symlinks. */
    fun isInside(root: File, f: File): Boolean {
        val r = root.canonicalFile
        val c = f.canonicalFile
        return c != r && c.path.startsWith(r.path + File.separator)
    }

    /**
     * Deletes `folder/rel` for each [relPaths] entry whose copy [verified] accepts (the caller compares sizes in
     * the user's tree), then removes parent folders left empty, never above [stagingRoot]. Returns bytes freed.
     */
    fun free(stagingRoot: File, folder: File, relPaths: List<String>, verified: (String, File) -> Boolean): Long {
        var freed = 0L
        for (rel in relPaths) {
            val f = File(folder, rel)
            if (!f.isFile || !isInside(stagingRoot, f)) continue
            if (!verified(rel, f)) continue
            val size = f.length()
            if (!f.delete()) continue
            freed += size
            var dir = f.parentFile
            while (dir != null && isInside(stagingRoot, dir) && dir.isDirectory && dir.list()?.isEmpty() == true) {
                if (!dir.delete()) break
                dir = dir.parentFile
            }
        }
        return freed
    }
}
