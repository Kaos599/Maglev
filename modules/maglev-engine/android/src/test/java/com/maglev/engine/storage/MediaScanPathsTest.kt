package com.maglev.engine.storage

import org.junit.Assert.assertEquals
import org.junit.Test

class MediaScanPathsTest {
    private val pub = "/storage/emulated/0"
    private val priv = listOf("/storage/emulated/0/Android/data/app/files/Download/Staging", "/data/user/0/app/files")
    private fun sel(base: String, files: List<String>, exists: Boolean = true) =
        MediaScanPaths.select(base, files, pub, priv) { exists }

    @Test fun keepsPublicFiles() =
        assertEquals(listOf("$pub/Download/Maglev/a/b.mkv"), sel("$pub/Download/Maglev", listOf("a/b.mkv")))

    @Test fun skipsStaging() =
        assertEquals(emptyList<String>(), sel(priv[0], listOf("a.mkv")))

    @Test fun skipsAppPrivateAndAndroidDir() {
        assertEquals(emptyList<String>(), sel("/data/user/0/app/files/x", listOf("a.mkv")))
        assertEquals(emptyList<String>(), sel("$pub/Android/data/other", listOf("a.mkv")))
    }

    @Test fun skipsOtherVolumes() =
        assertEquals(emptyList<String>(), sel("/storage/ABCD-1234/Movies", listOf("a.mkv")))

    @Test fun skipsTraversal() =
        assertEquals(emptyList<String>(), sel("$pub/Download/Maglev", listOf("../../Android/data/x.bin")))

    @Test fun skipsMissingFiles() =
        assertEquals(emptyList<String>(), sel("$pub/Download", listOf("a.mkv"), exists = false))

    @Test fun dedupesAndSkipsEmpty() =
        assertEquals(listOf("$pub/Download/a.mkv"), sel("$pub/Download", listOf("a.mkv", "", "a.mkv")))
}
