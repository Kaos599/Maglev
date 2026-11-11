package com.maglev.engine

import java.nio.ByteBuffer

/**
 * JNI holder. Symbols resolve to `Java_com_maglev_engine_NativeCore_<name>` (docs/NATIVE_CONTRACT.md section 2).
 * Every call takes and returns UTF-8 JSON, except the bitfield buffer.
 * Call these only from a background dispatcher, never from the JS or main thread.
 */
object NativeCore {
    @JvmField
    val loaded: Boolean

    @JvmField
    val loadError: String?

    init {
        var ok = false
        var err: String? = null
        try {
            System.loadLibrary("maglev_core")
            // A stale .so with old symbols loads fine but throws here. That must read as unavailable.
            nativeVersion()
            ok = true
        } catch (e: LinkageError) {
            err = e.message ?: "maglev_core could not be loaded"
        } catch (e: SecurityException) {
            err = e.message ?: "maglev_core load denied"
        }
        loaded = ok
        loadError = err
    }

    @JvmStatic external fun nativeInit(configJson: String, sessionDir: String, defaultDownloadDir: String): String
    @JvmStatic external fun nativeShutdown(): String
    @JvmStatic external fun nativeResolveMetadata(source: String, timeoutMs: Long): String
    @JvmStatic external fun nativeResolveActivity(infoHash: String): String
    @JvmStatic external fun nativeCancelResolve(infoHash: String): String
    @JvmStatic external fun nativeAddTorrent(source: String, optionsJson: String): String
    @JvmStatic external fun nativeListTorrents(): String
    @JvmStatic external fun nativeGetDetail(id: String): String
    @JvmStatic external fun nativePause(id: String): String
    @JvmStatic external fun nativeResume(id: String): String
    @JvmStatic external fun nativeRecheck(id: String): String
    @JvmStatic external fun nativeDelete(id: String, deleteFiles: Boolean): String
    @JvmStatic external fun nativeSetIncludedFiles(id: String, indicesJson: String): String
    @JvmStatic external fun nativeSetFilePriorities(id: String, json: String): String
    @JvmStatic external fun nativeRemoveFiles(id: String, indicesJson: String): String
    @JvmStatic external fun nativeReannounce(id: String): String
    @JvmStatic external fun nativeSetGlobalLimits(downBps: Long, upBps: Long): String
    @JvmStatic external fun nativeApplyConfig(configJson: String): String
    @JvmStatic external fun nativeGetEffectiveConfig(): String
    @JvmStatic external fun nativeSetTransfersAllowed(allowed: Boolean, reason: String): String
    @JvmStatic external fun nativeGetPieceBitfield(id: String, out: ByteBuffer): Int
    @JvmStatic external fun nativeSetTorrentLimits(id: String, json: String): String
    @JvmStatic external fun nativeMoveStorage(id: String, destDir: String): String
    @JvmStatic external fun nativeStreamUrl(id: String, fileIndex: Int): String
    @JvmStatic external fun nativeVersion(): String
}
