package com.maglev.engine

import com.maglev.engine.storage.StreamMuxer
import java.io.File

/** One stream download that waits for its video and audio parts to be joined (contract 24.8). */
internal data class MuxJob(val id: String, val folder: String, val name: String) {
    val video: File get() = File(folder, "$name.video.part")
    val audio: File get() = File(folder, "$name.audio.part")
    val output: File get() = File(folder, name)
}

/**
 * Which waiting downloads still need a join started. A download is handed out once per wait: the id is remembered
 * until the download leaves `verifying` (the join finished, failed, or was removed) or [release] is called.
 * Pure: no Android, no I/O. Guarded by itself; callers may use it from several threads.
 */
internal class MuxTracker {
    private val started = HashSet<String>()

    /** The downloads in [downloads] that are waiting for a join and have not been handed out yet. */
    fun claim(downloads: List<Map<String, Any?>>): List<MuxJob> {
        val jobs = ArrayList<MuxJob>()
        synchronized(started) {
            val waiting = HashSet<String>()
            for (d in downloads) {
                val id = d["id"] as? String ?: continue
                if (d["state"] == "verifying" && d["mux_needed"] == true) {
                    waiting.add(id)
                    if (started.add(id)) {
                        val folder = d["folder"] as? String
                        val name = d["name"] as? String
                        if (folder != null && name != null) jobs.add(MuxJob(id, folder, name))
                    }
                }
            }
            started.retainAll(waiting)
        }
        return jobs
    }

    /** Lets the next poll hand [id] out again (Rust could not be told, so the join must be reported again). */
    fun release(id: String) {
        synchronized(started) { started.remove(id) }
    }
}

/** What [MuxRunner.run] did. */
internal enum class MuxOutcome {
    /** The join is in place (done now, or found done) and Rust was told. */
    JOINED,

    /** The join failed and Rust was told (`MUX_FAILED`, Retry joins again). */
    FAILED_REPORTED,

    /** Rust could not be told. Nothing is left behind except the parts; the next poll tries again. */
    NOT_REPORTED,
}

internal object MuxRunner {
    /**
     * Joins one download's parts, then reports the result through [finish] (`nativeFinishMux`: id, ok, message; it
     * returns true when Rust accepted the report). [mux] is [StreamMuxer.mux] in production. Blocking.
     *
     * - A part that is missing fails at once with a plain message, without starting the muxer.
     * - An output that already exists means an earlier run finished the join (the muxer renames its temp file only
     *   when it has stopped cleanly) and the app died before Rust was told. The output is reported as joined instead
     *   of failing with "already exists" on every retry. Rust makes the name unique before the download starts, so
     *   the file is ours. An empty file is not a join: it is removed and the join runs again.
     * - If Rust cannot be told, a file this run created is removed so no orphan stays behind.
     */
    fun run(
        job: MuxJob,
        mux: (File, File, File) -> Unit,
        finish: (id: String, ok: Boolean, message: String) -> Boolean,
    ): MuxOutcome {
        val out = job.output
        var ok = false
        var message: String? = null
        var createdNow = false
        try {
            if (out.isFile && out.length() > 0) {
                ok = true
            } else if (!job.video.isFile || !job.audio.isFile) {
                message = "A downloaded part is missing"
            } else {
                if (out.exists()) out.delete()
                mux(job.video, job.audio, out)
                ok = true
                createdNow = true
            }
        } catch (e: StreamMuxer.MuxException) {
            message = e.message
        } catch (t: Throwable) {
            message = t.javaClass.simpleName
        }
        val told = finish(job.id, ok, message ?: "")
        if (told) return if (ok) MuxOutcome.JOINED else MuxOutcome.FAILED_REPORTED
        if (ok && createdNow) {
            try {
                out.delete()
            } catch (_: Throwable) {
                // nothing more to do; the next poll joins again over it
            }
        }
        return MuxOutcome.NOT_REPORTED
    }
}
