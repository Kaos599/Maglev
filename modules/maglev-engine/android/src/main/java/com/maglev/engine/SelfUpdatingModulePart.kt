package com.maglev.engine

import android.content.Context
import com.maglev.engine.lists.ListsUpdater
import com.maglev.engine.videosites.VideoSites
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.ModuleDefinitionBuilder
import kotlinx.coroutines.launch

/**
 * The module functions for the parts that update themselves (yt-dlp and the ad block list). They live here, out of
 * MaglevEngineModule.definition(), which is near the JVM's 64 KB method limit; definition() calls this once.
 *
 * AsyncFunction DSL: https://docs.expo.dev/modules/module-api/#asyncfunction
 */
internal fun ModuleDefinitionBuilder.selfUpdatingFunctions(context: () -> Context?) {

    // The daily background ad list job: on with these addresses, or off. The job runs with Maglev closed, so it reads
    // the addresses saved here, not the app's own settings.
    AsyncFunction("listsConfigure") { enabled: Boolean, urls: List<String> ->
        context()?.let { ListsUpdater.apply(it, enabled, urls) }
        true
    }

    // What Settings says about yt-dlp: `{ version, lastCheckAt, result, error, builtIn }`, or null without a context.
    // Hashes the file once per change, so it runs off the main thread.
    AsyncFunction("videoSitesReport") { promise: Promise ->
        val c = context()
        if (c == null) {
            promise.resolve(null)
        } else {
            EngineHost.ioScope.launch {
                promise.resolve(
                    try {
                        VideoSites.report(c)
                    } catch (t: Throwable) {
                        null
                    },
                )
            }
        }
    }
}
