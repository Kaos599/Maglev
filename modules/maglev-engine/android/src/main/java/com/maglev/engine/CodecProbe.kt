package com.maglev.engine

import android.content.Context
import android.hardware.display.DisplayManager
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import android.view.Display

/** One decoder or encoder as the platform describes it. Hand-built in unit tests. */
data class CodecDesc(
    val types: List<String>,
    val isEncoder: Boolean,
    /** True hardware, false software, null when the platform cannot say (below API 29). */
    val hardware: Boolean?,
    /** Profile ids per mime type, from CodecProfileLevel. */
    val profiles: Map<String, List<Int>> = emptyMap(),
)

/**
 * What this phone can decode and show. [map] is pure so it can be unit-tested;
 * [get] reads the platform once and caches the result for the process.
 * Codec fields: "hardware" | "software" | "none" | "unknown". Display fields: true | false | null.
 * Docs: https://developer.android.com/reference/android/media/MediaCodecInfo
 */
object CodecProbe {
    const val AVC = "video/avc"
    const val HEVC = "video/hevc"
    const val AV1 = "video/av01"
    const val VP9 = "video/x-vnd.on2.vp9"
    const val DV = "video/dolby-vision"

    // Display.HdrCapabilities.HDR_TYPE_* values.
    private const val HDR_HDR10 = 2
    private const val HDR_HLG = 3
    private const val HDR_HDR10_PLUS = 4

    private val HEVC_10 = listOf(
        MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10,
        MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10,
        MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10Plus,
    )
    private val AV1_10 = listOf(
        MediaCodecInfo.CodecProfileLevel.AV1ProfileMain10,
        MediaCodecInfo.CodecProfileLevel.AV1ProfileMain10HDR10,
        MediaCodecInfo.CodecProfileLevel.AV1ProfileMain10HDR10Plus,
    )

    @Volatile private var cached: Map<String, Any?>? = null

    /**
     * [sdk] gates what the platform can report. [hdrTypes] is the display's supported HDR types,
     * or null when the display could not be read.
     */
    fun map(codecs: List<CodecDesc>, sdk: Int, hdrTypes: IntArray?): Map<String, Any?> {
        fun decoders(mime: String, profileIds: List<Int>? = null): List<CodecDesc> = codecs.filter { c ->
            !c.isEncoder && c.types.any { it.equals(mime, ignoreCase = true) } &&
                (profileIds == null || c.profiles.entries.any { (t, ps) ->
                    t.equals(mime, ignoreCase = true) && ps.any { it in profileIds }
                })
        }
        fun level(found: List<CodecDesc>): String = when {
            found.isEmpty() -> "none"
            sdk < 29 -> "unknown"
            found.any { it.hardware == true } -> "hardware"
            found.all { it.hardware == false } -> "software"
            else -> "unknown"
        }
        fun hdr(type: Int, minSdk: Int): Boolean? =
            if (hdrTypes == null || sdk < minSdk) null else type in hdrTypes

        return linkedMapOf(
            "avc" to level(decoders(AVC)),
            "hevc" to level(decoders(HEVC)),
            "hevc10" to level(decoders(HEVC, HEVC_10)),
            "av1" to level(decoders(AV1)),
            "av1_10" to level(decoders(AV1, AV1_10)),
            "vp9" to level(decoders(VP9)),
            "dolbyVision" to level(decoders(DV)),
            "hdr10" to hdr(HDR_HDR10, 24),
            "hdr10plus" to hdr(HDR_HDR10_PLUS, 29),
            "hlg" to hdr(HDR_HLG, 24),
        )
    }

    /** Runs once, then returns the cached result. Never throws. */
    fun get(context: Context?): Map<String, Any?> {
        cached?.let { return it }
        val result: Map<String, Any?> = try {
            map(listCodecs(), Build.VERSION.SDK_INT, displayHdrTypes(context))
        } catch (e: Throwable) {
            linkedMapOf(
                "avc" to "unknown", "hevc" to "unknown", "hevc10" to "unknown",
                "av1" to "unknown", "av1_10" to "unknown", "vp9" to "unknown",
                "dolbyVision" to "unknown", "hdr10" to null, "hdr10plus" to null, "hlg" to null,
            )
        }
        cached = result
        return result
    }

    private fun listCodecs(): List<CodecDesc> =
        MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.map { info ->
            val profiles = HashMap<String, List<Int>>()
            for (t in info.supportedTypes) {
                try {
                    profiles[t] = info.getCapabilitiesForType(t).profileLevels.map { it.profile }
                } catch (e: IllegalArgumentException) {
                    // Some devices list a type they cannot describe; skip its profiles.
                }
            }
            val hw: Boolean? = if (Build.VERSION.SDK_INT >= 29) {
                info.isHardwareAccelerated && !info.isSoftwareOnly
            } else {
                null
            }
            CodecDesc(info.supportedTypes.toList(), info.isEncoder, hw, profiles)
        }

    @Suppress("DEPRECATION")
    private fun displayHdrTypes(context: Context?): IntArray? {
        if (context == null || Build.VERSION.SDK_INT < 24) return null
        val dm = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager ?: return null
        val display = dm.getDisplay(Display.DEFAULT_DISPLAY) ?: return null
        return if (Build.VERSION.SDK_INT >= 34) {
            display.mode.supportedHdrTypes
        } else {
            display.hdrCapabilities?.supportedHdrTypes ?: IntArray(0)
        }
    }
}
