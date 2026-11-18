package com.maglev.engine.subtitles

import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel

/** A subtitle call failed with a contract error code (NATIVE_CONTRACT section 36.6). */
class SubtitleException(val code: String, message: String) : Exception(message)

/**
 * The OpenSubtitles / BSPlayer "moviehash" (NATIVE_CONTRACT 36.6).
 * hash = file size + uint64 little-endian sum of the first 65536 bytes + the same sum of the last 65536 bytes,
 * all mod 2^64, printed as 16 lowercase hex digits. Reference: the OpenSubtitles "HashSourceCodes" wiki page
 * (https://trac.opensubtitles.org/projects/opensubtitles/wiki/HashSourceCodes) and the REST docs "moviehash".
 * Kotlin Long addition wraps on overflow, which is exactly mod 2^64.
 */
object SubtitleHash {
    const val CHUNK = 65536
    const val MIN_BYTES = 2L * CHUNK

    /** Sum of the little-endian uint64 words in the first [len] bytes of [buf] (a trailing partial word is ignored). */
    fun sumWords(buf: ByteArray, len: Int = buf.size): Long {
        var sum = 0L
        var i = 0
        while (i + 8 <= len) {
            var w = 0L
            for (k in 7 downTo 0) w = (w shl 8) or (buf[i + k].toLong() and 0xFF)
            sum += w
            i += 8
        }
        return sum
    }

    fun hex(v: Long): String = java.lang.Long.toHexString(v).padStart(16, '0')

    /** The hash from the file [size] and its first and last [CHUNK] bytes. */
    fun compute(size: Long, head: ByteArray, tail: ByteArray): String = hex(size + sumWords(head) + sumWords(tail))

    private fun readFully(ch: FileChannel, buf: ByteArray, position: Long) {
        val bb = ByteBuffer.wrap(buf)
        var pos = position
        while (bb.hasRemaining()) {
            val n = ch.read(bb, pos)
            if (n < 0) throw IOException("File ended early")
            pos += n
        }
    }

    /** Reads only the first and last [CHUNK] bytes of [ch]. Throws [SubtitleException] FILE_TOO_SMALL under 131072 bytes. */
    fun hashChannel(ch: FileChannel): Pair<String, Long> {
        val size = ch.size()
        if (size < MIN_BYTES) throw SubtitleException("FILE_TOO_SMALL", "This file is too small to match subtitles")
        val head = ByteArray(CHUNK)
        val tail = ByteArray(CHUNK)
        readFully(ch, head, 0L)
        readFully(ch, tail, size - CHUNK)
        return compute(size, head, tail) to size
    }
}
