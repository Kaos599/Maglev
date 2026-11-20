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
}
