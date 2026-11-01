package com.maglev.engine

import android.util.Base64
import com.maglev.engine.service.MaglevTorrentService
import com.maglev.engine.storage.StorageManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer

class MaglevEngineModule : Module() {

    companion object {
        var isNativeLoaded = false
        var instance: MaglevEngineModule? = null

        init {
            try {
                System.loadLibrary("maglev_core")
                isNativeLoaded = true
            } catch (e: UnsatisfiedLinkError) {
                isNativeLoaded = false
            } catch (e: Exception) {
                isNativeLoaded = false
            }
        }

        @JvmStatic
        fun onTelemetryUpdate(jsonStr: String) {
            instance?.let { mod ->
                mod.sendEvent("onTelemetryUpdate", mapOf("payload" to jsonStr))
            }
        }
    }

    // Native JNI external declarations
    private external fun nativeInit(storageDir: String, listenPort: Int): Boolean
    private external fun nativeStartTorrent(magnetUri: String, savePath: String, sequential: Boolean): String
    private external fun nativePauseTorrent(infoHash: String): Boolean
    private external fun nativeResumeTorrent(infoHash: String): Boolean
    private external fun nativeDeleteTorrent(infoHash: String, deleteFiles: Boolean): Boolean
    private external fun nativeSetFilePriority(infoHash: String, fileIndex: Int, priority: Int): Boolean
    private external fun nativeGetPieceBitfieldDirect(infoHash: String): ByteBuffer?
    private external fun nativeGetTrackers(infoHash: String): String
    private external fun nativeAddTracker(infoHash: String, trackerUrl: String): Boolean
    private external fun nativeStartHttpStream(infoHash: String, fileIndex: Int): String
    private external fun nativeStopEngine()

    override fun definition() = ModuleDefinition {
        Name("MaglevEngine")

        Events("onTelemetryUpdate")

        OnCreate {
            instance = this@MaglevEngineModule
        }

        OnDestroy {
            if (instance == this@MaglevEngineModule) {
                instance = null
            }
            if (isNativeLoaded) {
                nativeStopEngine()
            }
        }

        Function("isNativeAvailable") {
            isNativeLoaded
        }

        Function("getDefaultStoragePath") {
            val context = appContext.reactContext ?: return@Function "/sdcard/Download"
            StorageManager.getDefaultDownloadDirectory(context).absolutePath
        }

        Function("initEngine") { listenPort: Int ->
            if (!isNativeLoaded) return@Function false
            val context = appContext.reactContext ?: return@Function false
            val defaultDir = StorageManager.getDefaultDownloadDirectory(context)
            nativeInit(defaultDir.absolutePath, listenPort)
        }

        AsyncFunction("startTorrent") { magnetUri: String, savePathOverride: String?, sequential: Boolean ->
            if (!isNativeLoaded) return@AsyncFunction ""
            val context = appContext.reactContext
            val defaultPath = context?.let { StorageManager.getDefaultDownloadDirectory(it).absolutePath } ?: ""
            val targetPath = if (!savePathOverride.isNullOrEmpty()) savePathOverride else defaultPath
            nativeStartTorrent(magnetUri, targetPath, sequential)
        }

        AsyncFunction("pauseTorrent") { infoHash: String ->
            if (!isNativeLoaded) return@AsyncFunction false
            nativePauseTorrent(infoHash)
        }

        AsyncFunction("resumeTorrent") { infoHash: String ->
            if (!isNativeLoaded) return@AsyncFunction false
            nativeResumeTorrent(infoHash)
        }

        AsyncFunction("deleteTorrent") { infoHash: String, deleteFiles: Boolean ->
            if (!isNativeLoaded) return@AsyncFunction false
            nativeDeleteTorrent(infoHash, deleteFiles)
        }

        AsyncFunction("setFilePriority") { infoHash: String, fileIndex: Int, priority: Int ->
            if (!isNativeLoaded) return@AsyncFunction false
            nativeSetFilePriority(infoHash, fileIndex, priority)
        }

        AsyncFunction("getPieceBitfield") { infoHash: String ->
            if (!isNativeLoaded) return@AsyncFunction ""
            val buffer = nativeGetPieceBitfieldDirect(infoHash) ?: return@AsyncFunction ""
            val bytes = ByteArray(256)
            buffer.get(bytes)
            Base64.encodeToString(bytes, Base64.NO_WRAP)
        }

        AsyncFunction("getTrackers") { infoHash: String ->
            if (!isNativeLoaded) return@AsyncFunction "[]"
            nativeGetTrackers(infoHash)
        }

        AsyncFunction("addTracker") { infoHash: String, trackerUrl: String ->
            if (!isNativeLoaded) return@AsyncFunction false
            nativeAddTracker(infoHash, trackerUrl)
        }

        AsyncFunction("startHttpStream") { infoHash: String, fileIndex: Int ->
            if (!isNativeLoaded) return@AsyncFunction ""
            nativeStartHttpStream(infoHash, fileIndex)
        }

        AsyncFunction("updateServiceTelemetry") { activeDown: Int, activeUp: Int, downSpeed: Long, upSpeed: Long ->
            val context = appContext.reactContext ?: return@AsyncFunction
            MaglevTorrentService.updateService(context, activeDown, activeUp, downSpeed, upSpeed)
        }

        AsyncFunction("stopService") {
            val context = appContext.reactContext ?: return@AsyncFunction
            MaglevTorrentService.stopService(context)
        }
    }
}
