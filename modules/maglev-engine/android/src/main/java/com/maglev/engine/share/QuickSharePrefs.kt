package com.maglev.engine.share

import android.content.Context

/**
 * Settings the quick share card reads in its own activity, with no JS running (docs/contracts-0.19/quick-share.md section 6).
 * JS pushes them inside the `setGovernance` payload (`quickAdd`, `appearanceMode`); the module saves them here.
 */
object QuickSharePrefs {
    const val PREFS = "maglev_quickshare"
    const val KEY_ADD_WITHOUT_ASKING = "add_without_asking"
    const val KEY_APPEARANCE_MODE = "appearance_mode"

    /** Called from the module's setGovernance. Keys that are missing leave the saved value alone. */
    fun save(c: Context, rules: Map<String, Any?>) {
        val e = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        if (rules.containsKey("quickAdd")) e.putBoolean(KEY_ADD_WITHOUT_ASKING, rules["quickAdd"] == true)
        (rules["appearanceMode"] as? String)?.let { if (it in MODES) e.putString(KEY_APPEARANCE_MODE, it) }
        e.apply()
    }

    fun addWithoutAsking(c: Context): Boolean =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ADD_WITHOUT_ASKING, false)

    /** "oled", "dim", "light" or "system". Before the app ever pushed one: "oled" (the app default). */
    fun appearanceMode(c: Context): String =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_APPEARANCE_MODE, "oled") ?: "oled"

    private val MODES = setOf("oled", "dim", "light", "system")
}
