package com.maglev.engine

import android.media.MediaCodecInfo.CodecProfileLevel as P
import org.junit.Assert.assertEquals
import org.junit.Test

class CodecProbeTest {
    private fun dec(mime: String, hw: Boolean?, vararg profiles: Int) =
        CodecDesc(listOf(mime), false, hw, mapOf(mime to profiles.toList()))

    @Test fun flagshipWithAv1Hardware() {
        val m = CodecProbe.map(
            listOf(
                dec(CodecProbe.AVC, true),
                dec(CodecProbe.HEVC, true, P.HEVCProfileMain, P.HEVCProfileMain10),
                dec(CodecProbe.AV1, true, P.AV1ProfileMain8, P.AV1ProfileMain10),
                dec(CodecProbe.VP9, true),
                dec(CodecProbe.DV, true),
            ),
            sdk = 34, hdrTypes = intArrayOf(1, 2, 3, 4),
        )
        assertEquals("hardware", m["av1"])
        assertEquals("hardware", m["av1_10"])
        assertEquals("hardware", m["hevc10"])
        assertEquals("hardware", m["dolbyVision"])
        assertEquals(true, m["hdr10plus"])
        assertEquals(true, m["hlg"])
    }

    @Test fun oldPhoneNoHevc10() {
        val m = CodecProbe.map(
            listOf(
                dec(CodecProbe.AVC, true),
                dec(CodecProbe.HEVC, true, P.HEVCProfileMain),
                dec(CodecProbe.AV1, false, P.AV1ProfileMain8),
            ),
            sdk = 30, hdrTypes = intArrayOf(),
        )
        assertEquals("hardware", m["hevc"])
        assertEquals("none", m["hevc10"])
        assertEquals("software", m["av1"])
        assertEquals("none", m["av1_10"])
        assertEquals("none", m["dolbyVision"])
        assertEquals(false, m["hdr10"])
    }

    @Test fun encodersAreIgnored() {
        val enc = CodecDesc(listOf(CodecProbe.HEVC), true, true, mapOf(CodecProbe.HEVC to listOf(P.HEVCProfileMain10)))
        assertEquals("none", CodecProbe.map(listOf(enc), 34, null)["hevc"])
    }

    @Test fun belowApi29HardwareIsUnknownButMissingIsNone() {
        val m = CodecProbe.map(listOf(dec(CodecProbe.AVC, null)), sdk = 28, hdrTypes = intArrayOf(2))
        assertEquals("unknown", m["avc"])
        assertEquals("none", m["vp9"])
        assertEquals(true, m["hdr10"])
        assertEquals(null, m["hdr10plus"])
    }

    @Test fun unreadableDisplayIsNull() {
        val m = CodecProbe.map(emptyList(), 34, null)
        assertEquals(null, m["hdr10"])
        assertEquals(null, m["hlg"])
    }
}
