package com.maglev.engine.storage

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer

/**
 * Joins the video part and the audio part of a saved HLS or DASH stream into one mp4, without re-encoding
 * (docs/NATIVE_CONTRACT.md section 24.8). The parts are MPEG-TS or fragmented MP4 files that Rust wrote by
 * concatenating segments; `MediaExtractor` reads both. Blocking: call it on an IO thread.
 *
 * Output goes to `<output>.mux.tmp` first and is renamed when the muxer has stopped cleanly. The temp file is
 * deleted on any failure. Nothing here logs a path or a link.
 */
object StreamMuxer {
    /** A failure with a message that is safe to hand to Rust (no paths, no links). */
    class MuxException(message: String) : Exception(message)

    private const val MIN_SAMPLE_BUFFER = 4 * 1024 * 1024

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

    private fun firstTrack(ex: MediaExtractor, prefix: String): Int {
        for (i in 0 until ex.trackCount) {
            val mime = ex.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith(prefix)) return i
        }
        return -1
    }

    /**
     * Remuxes [video] and [audio] into [output]. Throws [MuxException] when the parts can't be read or written.
     * [output] must not exist.
     */
    fun mux(video: File, audio: File, output: File) {
        if (output.exists()) throw MuxException("The output file already exists")
        val tmp = File(output.parentFile, output.name + ".mux.tmp")
        tmp.delete()
        var muxer: MediaMuxer? = null
        var started = false
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

            val m = MediaMuxer(tmp.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
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
            if (!tmp.renameTo(output)) throw MuxException("Couldn't move the joined file into place")
        } catch (e: MuxException) {
            cleanup(muxer, started, tmp)
            throw e
        } catch (t: Throwable) {
            cleanup(muxer, started, tmp)
            // The class name only: a platform message can carry a path.
            throw MuxException("The platform couldn't join the parts (${t.javaClass.simpleName})")
        } finally {
            try { vx.release() } catch (_: Throwable) {}
            try { ax.release() } catch (_: Throwable) {}
        }
    }

    private fun cleanup(muxer: MediaMuxer?, started: Boolean, tmp: File) {
        if (muxer != null) {
            try { if (started) muxer.stop() } catch (_: Throwable) {}
            try { muxer.release() } catch (_: Throwable) {}
        }
        tmp.delete()
    }
}
