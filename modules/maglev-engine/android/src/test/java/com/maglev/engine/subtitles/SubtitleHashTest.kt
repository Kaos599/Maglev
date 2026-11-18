package com.maglev.engine.subtitles

import java.io.File
import java.io.RandomAccessFile
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class SubtitleHashTest {
    // Same vector as scripts/test-subtitles-native.js: 200000 bytes, byte[i] = (i * 31 + 7) and 0xFF.
    private val size = 200000
    private val expected = "5f9fe02060a3cd40"

    private fun pattern() = ByteArray(size) { i -> ((i * 31 + 7) and 0xFF).toByte() }

    @Test fun computeMatchesTheSharedVector() {
        val b = pattern()
        val head = b.copyOfRange(0, SubtitleHash.CHUNK)
        val tail = b.copyOfRange(size - SubtitleHash.CHUNK, size)
        assertEquals(expected, SubtitleHash.compute(size.toLong(), head, tail))
    }

    @Test fun channelReadMatchesTheSharedVector() {
        val f = File.createTempFile("maglev-hash", ".bin")
        try {
            f.writeBytes(pattern())
            RandomAccessFile(f, "r").use { raf ->
                val (hash, bytes) = SubtitleHash.hashChannel(raf.channel)
                assertEquals(expected, hash)
                assertEquals(size.toLong(), bytes)
            }
        } finally {
            f.delete()
        }
    }

    @Test fun wrapsModulo2Pow64AndPadsTo16Digits() {
        val ff = ByteArray(SubtitleHash.CHUNK) { 0xFF.toByte() }
        // 8192 words of 2^64-1 each wrap, twice: the sum is -16384 mod 2^64, plus the size.
        assertEquals("ffffffffffffc000", SubtitleHash.compute(0, ff, ff))
        assertEquals("0000000000000001", SubtitleHash.hex(1))
        assertEquals("0000000000020000", SubtitleHash.compute(131072, ByteArray(SubtitleHash.CHUNK), ByteArray(SubtitleHash.CHUNK)))
    }

    @Test fun littleEndianWord() {
        val buf = byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8)
        assertEquals("0807060504030201", SubtitleHash.hex(SubtitleHash.sumWords(buf)))
    }

    @Test fun tooSmallFileIsRejected() {
        val f = File.createTempFile("maglev-small", ".bin")
        try {
            f.writeBytes(ByteArray(131071))
            RandomAccessFile(f, "r").use { raf ->
                try {
                    SubtitleHash.hashChannel(raf.channel)
                    fail("expected FILE_TOO_SMALL")
                } catch (e: SubtitleException) {
                    assertEquals("FILE_TOO_SMALL", e.code)
                }
            }
        } finally {
            f.delete()
        }
    }
}
