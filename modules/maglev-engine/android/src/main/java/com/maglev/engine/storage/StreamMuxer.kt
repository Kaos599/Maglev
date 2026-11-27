package com.maglev.engine.storage

import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Build
import android.os.StatFs
import android.os.SystemClock
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer

/**
 * Joins the video part and the audio part of a saved HLS or DASH stream into one mp4, without re-encoding. The parts
 * are MPEG-TS or fragmented MP4 files that Rust wrote by concatenating segments; `MediaExtractor` reads both.
 * Blocking: call it on an IO thread.
 *
 * The file under the real name only ever appears whole: the muxer writes to `<output>.mux.tmp` next to it, and a
 * rename in the same folder puts it in place once it is complete. Temp files are deleted on any failure. Nothing
 * here logs a path or a link.
 *
 * Why there are two routes: the muxer writes many small pieces and seeks back to patch headers. In a shared folder
 * such as Download/Maglev every one of those writes goes through Android's shared-storage layer, which made a 35 MB
 * join take over a minute. So when the save folder is shared storage and there is room, the join is written in the
 * app's own storage first and then copied over in large sequential writes, which that layer handles quickly.
 */
object StreamMuxer {
    /** A failure with a message that is safe to hand to Rust (no paths, no links). */
    class MuxException(message: String) : Exception(message)

    /** How one join went, for the timing log. Sizes and times only. */
    data class JoinReport(val route: String, val reason: String, val muxMs: Long, val copyMs: Long, val bytes: Long)

    private const val MIN_SAMPLE_BUFFER = 4 * 1024 * 1024
    private const val COPY_BUFFER = 1024 * 1024
    private const val WORK_DIR = "join"

    /** Room kept free on top of the joined file: the mp4 index and anything else writing at the same time. */
    private const val SPACE_MARGIN = 32L * 1024 * 1024

    /** Which extractor feeds the muxer next: the one whose next sample is earlier. -1 means that one has ended. */
    internal fun nextSource(videoTimeUs: Long, audioTimeUs: Long): Source = when {
        videoTimeUs < 0 && audioTimeUs < 0 -> Source.NONE
        audioTimeUs < 0 -> Source.VIDEO
        videoTimeUs < 0 -> Source.AUDIO
        videoTimeUs <= audioTimeUs -> Source.VIDEO
        else -> Source.AUDIO
    }

    internal enum class Source { VIDEO, AUDIO, NONE }

    /** Both tracks start at the same instant in the output: the earlier first sample becomes time zero. */
    internal fun timeBase(firstVideoUs: Long, firstAudioUs: Long): Long {
        val known = listOf(firstVideoUs, firstAudioUs).filter { it >= 0 }
        return known.minOrNull() ?: 0L
    }

    /** Rotation in degrees if the format has a valid one (0, 90, 180, 270), else null. */
    internal fun validRotation(degrees: Int?): Int? = degrees?.takeIf { it == 0 || it == 90 || it == 180 || it == 270 }

    /**
     * True when a join through app storage fits. The parts stay until the joined file is in place, so the join needs
     * one file of [need] bytes in app storage and one more in the save folder. When both are the same volume (the
     * usual case for internal storage, which reports the same total size through either path) both come out of
     * the same free space.
     */
    internal fun roomForWork(need: Long, workFree: Long, workTotal: Long, destFree: Long, destTotal: Long): Boolean {
        val sameVolume = workTotal == destTotal
        return if (sameVolume) workFree >= 2 * need + SPACE_MARGIN
        else workFree >= need + SPACE_MARGIN && destFree >= need + SPACE_MARGIN
    }

    /** A file name that is safe whatever the download id holds. */
    internal fun workName(id: String): String = id.replace(Regex("[^A-Za-z0-9_-]"), "_").take(80) + ".mp4"

    private fun workDir(context: Context): File = File(context.noBackupFilesDir, WORK_DIR)

    /**
     * Deletes every leftover join file in app storage. A join that was cut short (Android closed Maglev, the phone
     * restarted) leaves one behind, and nothing else would ever remove it. Call once per process, before any join
     * starts, so it can never delete a file a running join is writing.
     */
    fun sweepWork(context: Context): Int {
        val files = workDir(context).listFiles() ?: return 0
        var n = 0
        for (f in files) if (f.delete()) n++
        return n
    }

    /** True when [folder] is inside storage only this app can see, where writes are already fast. */
    private fun isAppStorage(context: Context, folder: File): Boolean {
        val roots = ArrayList<File>()
        context.filesDir.parentFile?.let { roots.add(it) }
        for (d in context.getExternalFilesDirs(null)) d?.parentFile?.let { roots.add(it) }
        val path = try { folder.canonicalPath } catch (_: Throwable) { folder.absolutePath }
        return roots.any { root ->
            val r = try { root.canonicalPath } catch (_: Throwable) { root.absolutePath }
            path == r || path.startsWith(r + File.separator)
        }
    }

    /**
     * Joins [video] and [audio] into [output] by the fastest safe route, and says which one it took. The work file
     * for download [id] lives in app storage and is gone when this returns, whatever happened.
     */
    fun mux(context: Context, id: String, video: File, audio: File, output: File): JoinReport {
        val bytes = video.length() + audio.length()
        val folder = output.parentFile ?: return direct(video, audio, output, "no folder", bytes)
        if (isAppStorage(context, folder)) return direct(video, audio, output, "parts in app storage", bytes)
        val dir = workDir(context)
        dir.mkdirs()
        val fits = try {
            val w = StatFs(dir.path)
            val d = StatFs(folder.path)
            roomForWork(bytes, w.availableBytes, w.totalBytes, d.availableBytes, d.totalBytes)
        } catch (_: IllegalArgumentException) {
            false
        }
        if (!fits) return direct(video, audio, output, "not enough free space for a copy", bytes)
        return viaWork(video, audio, output, File(dir, workName(id)), bytes)
    }

    private fun direct(video: File, audio: File, output: File, reason: String, bytes: Long): JoinReport {
        val t0 = SystemClock.elapsedRealtime()
        mux(video, audio, output)
        return JoinReport("save folder", reason, SystemClock.elapsedRealtime() - t0, 0L, bytes)
    }

    private fun viaWork(video: File, audio: File, output: File, work: File, bytes: Long): JoinReport {
        if (output.exists()) throw MuxException("The output file already exists")
        val tmp = File(output.parentFile, output.name + ".mux.tmp")
        work.delete()
        tmp.delete()
        var stage = "The platform couldn't join the parts"
        try {
            val t0 = SystemClock.elapsedRealtime()
            // No sync here: the work file is thrown away after the copy, and a cut-short join starts over.
            writeJoin(video, audio, work, durable = false)
            val t1 = SystemClock.elapsedRealtime()
            stage = "Couldn't copy the joined file into the save folder"
            copyDurably(work, tmp)
            work.delete()
            if (!tmp.renameTo(output)) throw MuxException("Couldn't move the joined file into place")
            return JoinReport("app storage", "save folder is shared storage", t1 - t0, SystemClock.elapsedRealtime() - t1, bytes)
        } catch (e: MuxException) {
            work.delete()
            tmp.delete()
            throw e
        } catch (t: Throwable) {
            work.delete()
            tmp.delete()
            // The class name only: a platform message can carry a path.
            throw MuxException("$stage (${t.javaClass.simpleName})")
        }
    }

    /** Copies [from] to [to] in large writes and syncs it, so a rename after this never shows an empty file. */
    private fun copyDurably(from: File, to: File) {
        FileInputStream(from).use { input ->
            FileOutputStream(to).use { out ->
                input.copyTo(out, COPY_BUFFER)
                out.flush()
                out.fd.sync()
            }
        }
    }

    /**
     * Remuxes [video] and [audio] into [output] through `<output>.mux.tmp` in the same folder. Throws [MuxException]
     * when the parts can't be read or written. [output] must not exist.
     */
    fun mux(video: File, audio: File, output: File) {
        if (output.exists()) throw MuxException("The output file already exists")
        val tmp = File(output.parentFile, output.name + ".mux.tmp")
        tmp.delete()
        try {
            writeJoin(video, audio, tmp, durable = true)
            if (!tmp.renameTo(output)) throw MuxException("Couldn't move the joined file into place")
        } catch (e: MuxException) {
            tmp.delete()
            throw e
        } catch (t: Throwable) {
            tmp.delete()
            throw MuxException("The platform couldn't join the parts (${t.javaClass.simpleName})")
        }
    }

    private fun firstTrack(ex: MediaExtractor, prefix: String): Int {
        for (i in 0 until ex.trackCount) {
            val mime = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith(prefix)) return i
        }
        return -1
    }

    /**
     * Writes the joined mp4 to [dest], which the caller deletes on failure. With [durable] the file is synced to
     * disk once at the end, so the rename that follows never exposes an empty file after a power cut.
     *
     * From Android 8 the muxer gets a descriptor opened plainly. Given a path instead, it opens the file in a mode
     * that syncs to disk on every write, and the muxer makes thousands of writes. Android 7 has only the path form.
     */
    private fun writeJoin(video: File, audio: File, dest: File, durable: Boolean) {
        var muxer: MediaMuxer? = null
        var started = false
        var raf: RandomAccessFile? = null
        val vx = MediaExtractor()
        val ax = MediaExtractor()
        try {
            FileInputStream(video).use { vin ->
                FileInputStream(audio).use { ain ->
                    // The extractor keeps its own handle; the descriptors may be closed after the call.
                    vx.setDataSource(vin.fd)
                    ax.setDataSource(ain.fd)
                }
            }
            val vIdx = firstTrack(vx, "video/")
            val aIdx = firstTrack(ax, "audio/")
            if (vIdx < 0) throw MuxException("The video part has no video track")
            if (aIdx < 0) throw MuxException("The audio part has no audio track")
            vx.selectTrack(vIdx)
            ax.selectTrack(aIdx)
            val vFormat = vx.getTrackFormat(vIdx)
            val aFormat = ax.getTrackFormat(aIdx)

            val m = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val f = RandomAccessFile(dest, "rw")
                raf = f
                f.setLength(0)
                MediaMuxer(f.fd, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            } else {
                MediaMuxer(dest.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            }
            muxer = m
            // Only when the stream says so ("rotation-degrees" is MediaFormat.KEY_ROTATION, API 23).
            val rotation = validRotation(if (vFormat.containsKey("rotation-degrees")) vFormat.getInteger("rotation-degrees") else null)
            if (rotation != null && rotation != 0) m.setOrientationHint(rotation)
            val vTrack = m.addTrack(vFormat)
            val aTrack = m.addTrack(aFormat)
            m.start()
            started = true

            val base = timeBase(vx.sampleTime, ax.sampleTime)
            var capacity = MIN_SAMPLE_BUFFER
            for (f in listOf(vFormat, aFormat)) {
                if (f.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) capacity = maxOf(capacity, f.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE))
            }
            val buf = ByteBuffer.allocate(capacity)
            val info = MediaCodec.BufferInfo()
            while (true) {
                val source = nextSource(vx.sampleTime, ax.sampleTime)
                if (source == Source.NONE) break
                val ex = if (source == Source.VIDEO) vx else ax
                val track = if (source == Source.VIDEO) vTrack else aTrack
                buf.clear()
                val size = ex.readSampleData(buf, 0)
                if (size < 0) {
                    // This extractor has nothing more; the loop moves on to the other one.
                    ex.unselectTrack(if (source == Source.VIDEO) vIdx else aIdx)
                    continue
                }
                val flags = if (ex.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
                info.set(0, size, maxOf(0L, ex.sampleTime - base), flags)
                m.writeSampleData(track, buf, info)
                ex.advance()
            }
            m.stop()
            started = false
            m.release()
            muxer = null
            if (durable) {
                val f = raf
                if (f != null) f.fd.sync() else FileOutputStream(dest, true).use { it.fd.sync() }
            }
        } finally {
            val mx = muxer
            if (mx != null) {
                try { if (started) mx.stop() } catch (_: Throwable) {}
                try { mx.release() } catch (_: Throwable) {}
            }
            try { raf?.close() } catch (_: Throwable) {}
            try { vx.release() } catch (_: Throwable) {}
            try { ax.release() } catch (_: Throwable) {}
        }
    }
}
