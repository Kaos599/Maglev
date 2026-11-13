package com.maglev.engine

import com.maglev.engine.storage.StreamMuxer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** runPendingMuxes: which downloads get a join (MuxTracker) and what a join does (MuxRunner). Contract 24.8. */
class MuxJobsTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun dl(id: String, state: String = "verifying", mux: Boolean = true, folder: String = "/f", name: String = "a.mp4") =
        mapOf<String, Any?>("id" to id, "state" to state, "mux_needed" to mux, "folder" to folder, "name" to name)

    // ---- MuxTracker -----------------------------------------------------------------------------------------

    @Test fun nothingPendingGivesNoJobs() {
        val t = MuxTracker()
        assertTrue(t.claim(emptyList()).isEmpty())
        assertTrue(t.claim(listOf(dl("a", state = "downloading", mux = false), dl("b", state = "finished", mux = false))).isEmpty())
        // verifying without mux_needed is an ordinary download being checked
        assertTrue(t.claim(listOf(dl("c", mux = false))).isEmpty())
    }

    @Test fun onePendingGivesOneJobWithItsFiles() {
        val jobs = MuxTracker().claim(listOf(dl("a", folder = "/dl", name = "clip 720p.mp4")))
        assertEquals(1, jobs.size)
        assertEquals("a", jobs[0].id)
        assertEquals(File("/dl", "clip 720p.mp4.video.part"), jobs[0].video)
        assertEquals(File("/dl", "clip 720p.mp4.audio.part"), jobs[0].audio)
        assertEquals(File("/dl", "clip 720p.mp4"), jobs[0].output)
    }

    @Test fun aWaitIsHandedOutOnceNotOnEveryPoll() {
        val t = MuxTracker()
        assertEquals(1, t.claim(listOf(dl("a"))).size)
        assertTrue(t.claim(listOf(dl("a"))).isEmpty())
        assertTrue(t.claim(listOf(dl("a"))).isEmpty())
    }

    @Test fun retryAfterAFailureJoinsAgain() {
        val t = MuxTracker()
        assertEquals(1, t.claim(listOf(dl("a"))).size)
        // MUX_FAILED: the download is in error, so it leaves the waiting set and the id is forgotten
        assertTrue(t.claim(listOf(dl("a", state = "error", mux = false))).isEmpty())
        // Retry makes it verifying again
        assertEquals(1, t.claim(listOf(dl("a"))).size)
    }

    @Test fun releaseLetsTheNextPollRetryAnUnreportedJoin() {
        val t = MuxTracker()
        val job = t.claim(listOf(dl("a"))).single()
        assertTrue(t.claim(listOf(dl("a"))).isEmpty())
        t.release(job.id)
        assertEquals(1, t.claim(listOf(dl("a"))).size)
    }

    @Test fun aNewProcessStartsTheWaitAgain() {
        // After a restart the tracker is empty and the saved download is still waiting.
        assertEquals(1, MuxTracker().claim(listOf(dl("a"))).size)
        assertEquals(1, MuxTracker().claim(listOf(dl("a"))).size)
    }

    @Test fun twoWaitsAreIndependentAndEntriesWithoutFolderOrNameAreSkipped() {
        val t = MuxTracker()
        val jobs = t.claim(listOf(dl("a"), dl("b"), mapOf("id" to "c", "state" to "verifying", "mux_needed" to true)))
        assertEquals(listOf("a", "b"), jobs.map { it.id })
    }

    // ---- MuxRunner ------------------------------------------------------------------------------------------

    private class Told {
        val calls = ArrayList<Triple<String, Boolean, String>>()
        var accept = true
        fun finish(id: String, ok: Boolean, msg: String): Boolean {
            calls.add(Triple(id, ok, msg))
            return accept
        }
    }

    private fun job(withParts: Boolean = true): MuxJob {
        val dir = tmp.newFolder()
        val j = MuxJob("a", dir.path, "clip.mp4")
        if (withParts) {
            j.video.writeText("v")
            j.audio.writeText("a")
        }
        return j
    }

    private val writeOutput: (File, File, File) -> Unit = { _, _, o -> o.writeText("joined") }

    @Test fun successWritesTheOutputAndReportsOk() {
        val j = job()
        val told = Told()
        val r = MuxRunner.run(j, writeOutput, told::finish)
        assertEquals(MuxOutcome.JOINED, r)
        assertEquals(listOf(Triple("a", true, "")), told.calls)
        assertTrue(j.output.isFile)
    }

    @Test fun aMuxFailureIsReportedWithItsMessageAndLeavesThePartsForRetry() {
        val j = job()
        val told = Told()
        val r = MuxRunner.run(j, { _, _, _ -> throw StreamMuxer.MuxException("The video part has no video track") }, told::finish)
        assertEquals(MuxOutcome.FAILED_REPORTED, r)
        assertEquals(listOf(Triple("a", false, "The video part has no video track")), told.calls)
        assertTrue(j.video.isFile && j.audio.isFile) // Rust keeps the parts (Effect::KeepPart); Retry joins again
        assertFalse(j.output.exists())
    }

    @Test fun anUnexpectedErrorIsReportedByClassNameWithoutDetails() {
        val j = job()
        val told = Told()
        MuxRunner.run(j, { _, _, _ -> throw IllegalStateException("secret path /x/y") }, told::finish)
        assertEquals(Triple("a", false, "IllegalStateException"), told.calls.single())
    }

    @Test fun aMissingPartFailsWithoutStartingTheMuxer() {
        for (missing in listOf("video", "audio", "both")) {
            val j = job()
            if (missing != "audio") j.video.delete()
            if (missing != "video") j.audio.delete()
            var muxed = false
            val told = Told()
            val r = MuxRunner.run(j, { _, _, _ -> muxed = true }, told::finish)
            assertEquals(missing, MuxOutcome.FAILED_REPORTED, r)
            assertFalse(missing, muxed)
            assertEquals(false, told.calls.single().second)
            assertEquals("A downloaded part is missing", told.calls.single().third)
        }
    }

    @Test fun restartAfterAJoinThatRustNeverHeardAboutReportsItAsJoined() {
        // The app died after the muxer renamed its temp file and before nativeFinishMux. The output is there,
        // the parts are still there, and the muxer would refuse with "already exists" on every retry.
        val j = job()
        j.output.writeText("joined earlier")
        var muxed = false
        val told = Told()
        val r = MuxRunner.run(j, { _, _, _ -> muxed = true }, told::finish)
        assertEquals(MuxOutcome.JOINED, r)
        assertFalse("must not mux over the finished file", muxed)
        assertEquals(listOf(Triple("a", true, "")), told.calls)
        assertEquals("joined earlier", j.output.readText())
    }

    @Test fun anEmptyLeftoverOutputIsReplacedByANewJoin() {
        val j = job()
        j.output.writeText("")
        val told = Told()
        assertEquals(MuxOutcome.JOINED, MuxRunner.run(j, writeOutput, told::finish))
        assertEquals("joined", j.output.readText())
    }

    @Test fun ifRustCannotBeToldTheFileThisRunMadeIsRemoved() {
        val j = job()
        val told = Told().also { it.accept = false }
        val r = MuxRunner.run(j, writeOutput, told::finish)
        assertEquals(MuxOutcome.NOT_REPORTED, r)
        assertFalse(j.output.exists())
        assertTrue(j.video.isFile && j.audio.isFile)
    }

    @Test fun ifRustCannotBeToldAFileFromBeforeTheRestartIsKept() {
        val j = job()
        j.output.writeText("joined earlier")
        val told = Told().also { it.accept = false }
        assertEquals(MuxOutcome.NOT_REPORTED, MuxRunner.run(j, writeOutput, told::finish))
        assertTrue(j.output.isFile)
    }

    @Test fun runningTheSameJobTwiceAfterASuccessIsIdempotent() {
        val j = job()
        val told = Told()
        assertEquals(MuxOutcome.JOINED, MuxRunner.run(j, writeOutput, told::finish))
        assertEquals(MuxOutcome.JOINED, MuxRunner.run(j, { _, _, _ -> throw AssertionError("muxed twice") }, told::finish))
        assertEquals(2, told.calls.size)
    }
}
