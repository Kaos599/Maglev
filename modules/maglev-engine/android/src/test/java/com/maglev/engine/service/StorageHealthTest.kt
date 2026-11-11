package com.maglev.engine.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StorageHealthTest {
    private val mb = 1024L * 1024
    private fun t(
        id: String,
        folder: String? = "/storage/ABCD-1234/Maglev",
        health: String? = null,
        pausedBy: String? = null,
        included: Long = 1000 * mb,
        progress: Long = 400 * mb,
        state: String? = "DOWNLOADING",
    ) = HealthTorrent(id, "n$id", state, health, pausedBy, folder, included, progress)

    @Test fun roomNeedsRemainingPlusMargin() {
        // remaining 600 MB + 200 MB margin
        assertTrue(StorageHealth.hasRoom(800 * mb, 1000 * mb, 400 * mb))
        assertFalse(StorageHealth.hasRoom(800 * mb - 1, 1000 * mb, 400 * mb))
    }

    @Test fun finishedTorrentNeedsOnlyTheMargin() {
        assertEquals(0L, StorageHealth.remainingNeed(1000 * mb, 1200 * mb))
        assertTrue(StorageHealth.hasRoom(200 * mb, 1000 * mb, 1000 * mb))
    }

    @Test fun volumeMatchComparesWholeSegments() {
        assertTrue(StorageHealth.onVolume("/storage/ABCD-1234/Maglev", "/storage/ABCD-1234"))
        assertTrue(StorageHealth.onVolume("/storage/ABCD-1234", "/storage/ABCD-1234/"))
        assertFalse(StorageHealth.onVolume("/storage/ABCD-12345/Maglev", "/storage/ABCD-1234"))
        assertFalse(StorageHealth.onVolume("/storage/emulated/0/Download", "/storage/ABCD-1234"))
        assertFalse(StorageHealth.onVolume(null, "/storage/ABCD-1234"))
        assertFalse(StorageHealth.onVolume("/storage/ABCD-1234/x", null))
        assertFalse(StorageHealth.onVolume("/anything", "/"))
    }

    @Test fun unmountTagsOnlyUntaggedTorrentsOnThatVolume() {
        val list = listOf(
            t("a"),
            t("b", folder = "/storage/emulated/0/Download/Maglev"),
            t("c", health = "files_missing"),
            t("d", health = StorageHealth.UNAVAILABLE),
        )
        assertEquals(listOf("a"), StorageHealth.unmountTargets(list, "/storage/ABCD-1234"))
    }

    @Test fun mountClearsOnlyUnavailableOnTheSameVolume() {
        val list = listOf(
            t("a", health = StorageHealth.UNAVAILABLE),
            t("b", health = StorageHealth.UNAVAILABLE, folder = "/storage/EFGH-5678/Maglev"),
            t("c", health = StorageHealth.FULL),
            t("d"),
        )
        assertEquals(listOf("a"), StorageHealth.mountTargets(list, "/storage/ABCD-1234"))
    }

    @Test fun pollClearsFullTorrentsWithRoom() {
        val list = listOf(
            t("a", health = StorageHealth.FULL, folder = "/data/a"),
            t("b", health = StorageHealth.FULL, folder = "/data/b"),
            t("c", health = StorageHealth.FULL, folder = "/data/unknown"),
            t("d", folder = "/data/a"),
        )
        val free = mapOf("/data/a" to 900 * mb, "/data/b" to 700 * mb)
        assertEquals(listOf("a"), StorageHealth.recoveryTargets(list) { free[it] })
    }

    @Test fun userPausedTorrentIsNotCountedAsPausedByUs() {
        val list = listOf(
            t("a", health = StorageHealth.FULL, pausedBy = StorageHealth.FULL),
            t("b", health = StorageHealth.FULL, pausedBy = "user"),
            t("c", health = StorageHealth.UNAVAILABLE, pausedBy = StorageHealth.UNAVAILABLE),
        )
        assertEquals(1, StorageHealth.countPaused(list, StorageHealth.FULL))
        assertEquals(1, StorageHealth.countPaused(list, StorageHealth.UNAVAILABLE))
    }

    @Test fun notificationCopy() {
        assertEquals("Storage full · 1 download paused", StorageHealth.fullTitle(1))
        assertEquals("Storage full · 3 downloads paused", StorageHealth.fullTitle(3))
        assertEquals("SD card removed · 2 downloads paused", StorageHealth.removedTitle(2))
    }

    @Test fun parsesSnapshotMap() {
        val h = HealthTorrent.from(
            mapOf(
                "id" to "x", "name" to "Ubuntu", "state" to "ERROR", "health" to "storage_full",
                "paused_by" to "storage_full", "output_folder" to "/d", "included_bytes" to 10L, "progress_bytes" to 4,
                "error" to mapOf("code" to "DISK_FULL", "message" to "x"),
            ),
        )!!
        assertEquals("Ubuntu", h.name)
        assertEquals(10L, h.includedBytes)
        assertEquals(4L, h.progressBytes)
        assertEquals("DISK_FULL", h.errorCode)
        assertNull(HealthTorrent.from(mapOf("name" to "no id")))
        assertEquals("Torrent", HealthTorrent.from(mapOf("id" to "y"))!!.name)
        assertNull(HealthTorrent.from(mapOf("id" to "y"))!!.health)
    }

    // SM-36 background error notice

    @Test fun errorNoticeOnEdgeWhenAppIsAway() =
        assertTrue(ErrorNotice.shouldNotify("DOWNLOADING", "ERROR", seenBefore = true, appInFront = false))
    @Test fun noErrorNoticeWithAppInFront() =
        assertFalse(ErrorNotice.shouldNotify("DOWNLOADING", "ERROR", true, true))
    @Test fun noErrorNoticeForFirstSighting() =
        assertFalse(ErrorNotice.shouldNotify(null, "ERROR", false, false))
    @Test fun noRepeatWhileStillInError() =
        assertFalse(ErrorNotice.shouldNotify("ERROR", "ERROR", true, false))
    @Test fun noErrorNoticeForOtherStates() =
        assertFalse(ErrorNotice.shouldNotify("DOWNLOADING", "PAUSED", true, false))

    @Test fun errorCopyPerCode() {
        assertEquals("Ubuntu stopped: Storage full.", ErrorNotice.title("Ubuntu", "DISK_FULL"))
        assertEquals("Maglev can't write to this folder.", ErrorNotice.message("PERMISSION"))
        assertEquals("Some files are missing.", ErrorNotice.message("FILES_MISSING"))
        assertEquals("Can't reach anyone right now.", ErrorNotice.message("NETWORK"))
        assertEquals("Something went wrong.", ErrorNotice.message("INTERNAL"))
        assertEquals("Something went wrong.", ErrorNotice.message(null))
    }
}
