package com.maglev.engine.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class StagingCleanupTest {
    private fun root(): File = Files.createTempDirectory("staging").toFile()

    @Test fun deletesVerifiedFileAndEmptyParents() {
        val root = root()
        val folder = File(root, "Show").also { it.mkdirs() }
        File(folder, "s1").mkdirs()
        File(folder, "s1/a.mkv").writeBytes(ByteArray(10))
        val freed = StagingCleanup.free(root, folder, listOf("s1/a.mkv")) { _, f -> f.length() == 10L }
        assertEquals(10L, freed)
        assertFalse(File(root, "Show").exists())
        assertTrue(root.exists())
    }

    @Test fun keepsFileWhenCopyNotVerified() {
        val root = root()
        val folder = File(root, "Show").also { it.mkdirs() }
        File(folder, "a.mkv").writeBytes(ByteArray(10))
        assertEquals(0L, StagingCleanup.free(root, folder, listOf("a.mkv")) { _, _ -> false })
        assertTrue(File(folder, "a.mkv").exists())
    }

    @Test fun neverLeavesTheStagingRoot() {
        val root = root()
        val outside = File(root.parentFile, "outside-" + System.nanoTime()).also { it.mkdirs() }
        File(outside, "x.bin").writeBytes(ByteArray(5))
        val freed = StagingCleanup.free(root, outside, listOf("x.bin")) { _, _ -> true }
        assertEquals(0L, freed)
        assertTrue(File(outside, "x.bin").exists())
    }

    @Test fun keepsFolderWithOtherFiles() {
        val root = root()
        val folder = File(root, "Show").also { it.mkdirs() }
        File(folder, "a.mkv").writeBytes(ByteArray(4))
        File(folder, "b.mkv").writeBytes(ByteArray(4))
        StagingCleanup.free(root, folder, listOf("a.mkv")) { _, _ -> true }
        assertTrue(File(folder, "b.mkv").exists())
    }
}
