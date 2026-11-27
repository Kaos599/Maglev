package com.maglev.engine.share

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Lets the app open its own quick share card for a link (the clipboard chip on Home). Register it in
 * modules/maglev-engine/expo-module.config.json. The card gets the same ACTION_SEND text a share from another app carries.
 */
class MaglevQuickShareModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("MaglevQuickShare")

        // Sent when the card leaves something in the store while the app runs; JS then takes it.
        Events("onShareWaiting")

        // The card runs in this process but is not a module, so it reaches the live module through a static emitter.
        OnCreate { emitter = { name, body -> sendEvent(name, body) } }
        OnDestroy { emitter = null }

        // The link the share card left for the app, once (see ShareHandoff). Null when none is waiting.
        // startUp is true for the start-up take (reads the disk and sweeps old copies) and false for a take while running.
        Function("takePendingShare") { startUp: Boolean ->
            appContext.reactContext?.let { ShareHandoff.take(it, startUp) }
        }

        // Clears the entry without reading it (a newer link arrived another way). No trusted mark is recorded.
        Function("dropPendingShare") {
            appContext.reactContext?.let { ShareHandoff.drop(it) }
            true
        }

        Function("open") { url: String ->
            val activity = appContext.currentActivity
            val context = activity ?: appContext.reactContext
            if (context == null) {
                false
            } else {
                val i = Intent(Intent.ACTION_SEND).apply {
                    setClass(context, QuickShareActivity::class.java)
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, url)
                    if (activity == null) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                try {
                    context.startActivity(i)
                    true
                } catch (e: Exception) {
                    false
                }
            }
        }
    }

    companion object {
        @Volatile private var emitter: ((String, Map<String, Any?>) -> Unit)? = null

        /** Tells JS something is waiting in [ShareHandoff]. Does nothing when no module instance is alive. */
        fun notifyWaiting() {
            try {
                emitter?.invoke("onShareWaiting", emptyMap())
            } catch (e: Throwable) {
                // JS may be shutting down; the next take still finds the entry.
            }
        }
    }
}
