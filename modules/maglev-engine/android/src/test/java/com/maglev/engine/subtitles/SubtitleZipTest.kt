package com.maglev.engine.subtitles

import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class SubtitleZipTest {
    private fun zip(vararg files: Pair<String, ByteArray>): ByteArray {
        val bos = ByteArrayOutputStream()
        ZipOutputStream(bos).use { z ->
            for ((name, data) in files) {
                z.putNextEntry(ZipEntry(name))
                z.write(data)
                z.closeEntry()
            }
        }
        return bos.toByteArray()
    }

    private fun code(block: () -> Unit): String {
        try {
            block()
        } catch (e: SubtitleException) {
            return e.code
        }
        fail("expected an error")
        return ""
    }

    @Test fun keepsOnlySubtitleMembersByBaseName() {
        val text = "1\n00:00:01,000 --> 00:00:02,000\nHi\n".toByteArray()
        val out = SubtitleZip.unzip(zip("sub/Show.S01E01.SRT" to text, "readme.txt" to "x".toByteArray(), "a/b.vtt" to text, "c.ass" to text, "d.ssa" to text))
        assertEquals(listOf("Show.S01E01.SRT", "b.vtt", "c.ass", "d.ssa"), out.map { it.name })
        assertEquals(String(text), String(out[0].bytes))
    }

    @Test fun zeroFilledBombIsRejected() {
        assertEquals("ARCHIVE_UNSAFE", code { SubtitleZip.unzip(zip("a.srt" to ByteArray(4 * 1024 * 1024))) })
    }

    @Test fun oversizedEntryIsRejected() {
        // Random-looking data keeps the ratio low so the 5 MB entry limit is what trips.
        val r = java.util.Random(1)
        val big = ByteArray(5 * 1024 * 1024 + 1).also { r.nextBytes(it) }
        assertEquals("ARCHIVE_UNSAFE", code { SubtitleZip.unzip(zip("a.srt" to big)) })
    }

    @Test fun tooManyEntriesIsRejected() {
        val files = (0..200).map { "f$it.txt" to "x".toByteArray() }.toTypedArray()
        assertEquals("ARCHIVE_UNSAFE", code { SubtitleZip.unzip(zip(*files)) })
    }

    @Test fun garbageHasNoSubtitles() {
        assertEquals(0, SubtitleZip.unzip("not a zip at all".toByteArray()).size)
    }
}
