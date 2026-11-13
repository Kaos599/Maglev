package com.maglev.engine.appicon

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager

/**
 * Launcher icon choice (docs/NATIVE_CONTRACT.md section 26).
 *
 * plugins/withAppIcons.js writes one `<activity-alias>` per icon into the manifest, each with the MAIN/LAUNCHER
 * filter and `targetActivity=".MainActivity"`. Exactly one alias is enabled. Choosing an icon enables its alias
 * and disables the others with [PackageManager.setComponentEnabledSetting] and `DONT_KILL_APP`.
 *
 * Some launchers close the app, or flash the icon, when the switch happens in the foreground. So [request] only
 * records the choice, and [applyPending] makes the switch when the app leaves the foreground
 * (MaglevEngineModule: OnActivityEntersBackground and OnDestroy). The target is enabled before the others are
 * disabled, so the app never has zero launcher entries.
 *
 * Pure parts ([isValid], [aliasClass], [stateFor]) have no Android dependency beyond the constants.
 */
object AppIconManager {
    const val DEFAULT = "teal"

    /** Same ids, same order as plugins/withAppIcons.js ICON_IDS and constants/appIcons.ts. */
    val IDS: List<String> = listOf(
        "teal", "all-dark", "lime", "cyan", "mono", "mono-black", "mono-white", "mono-gray",
        "m-keycap-teal", "m-keycap-lime", "m-keycap-light", "m-keycap-mono", "m-keycap-cyan",
        "m-bare-lime", "m-bare-teal", "m-bare-mono", "nose", "dash", "crt", "amber",
    )

    private const val PACKAGE = "com.maglev"

    /** The icon chosen in this session but not applied yet. */
    @Volatile
    private var pending: String? = null

    fun isValid(id: String): Boolean = id in IDS

    /** Fully qualified alias class, as written by the plugin: `com.maglev.MaglevIcon_all_dark`. */
    fun aliasClass(id: String): String = "$PACKAGE.MaglevIcon_" + id.replace('-', '_')

    private fun component(context: Context, id: String) = ComponentName(context.packageName, aliasClass(id))

    /** Whether the alias for [id] is enabled, given the raw PackageManager state. DEFAULT means the manifest value. */
    fun isEnabledState(id: String, state: Int): Boolean =
        state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED ||
            (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && id == DEFAULT)

    /** The icon the launcher shows now (the enabled alias), or [DEFAULT] when none can be read. */
    fun applied(context: Context): String {
        val pm = context.packageManager
        return IDS.firstOrNull { id ->
            try {
                isEnabledState(id, pm.getComponentEnabledSetting(component(context, id)))
            } catch (e: IllegalArgumentException) {
                false // alias missing from this build
            }
        } ?: DEFAULT
    }

    /** What the picker should show: the pending choice if there is one, else what is applied. */
    fun current(context: Context): String = pending ?: applied(context)

    /** Remembers [id] to apply when the app leaves the foreground. Returns an error message, or null. */
    fun request(id: String): String? {
        if (!isValid(id)) return "Unknown app icon \"$id\"."
        pending = id
        return null
    }

    /** Applies the pending choice, if any. Safe to call often. Returns true when it changed something. */
    fun applyPending(context: Context): Boolean {
        val id = pending ?: return false
        pending = null
        return try {
            apply(context, id)
        } catch (e: Throwable) {
            false // icon switching is cosmetic: never crash the app over it
        }
    }

    /** Enables [id], then disables every other alias. Skips calls that would not change anything. */
    fun apply(context: Context, id: String): Boolean {
        require(isValid(id)) { "Unknown app icon \"$id\"." }
        val pm = context.packageManager
        var changed = false
        val target = component(context, id)
        if (!isEnabledState(id, pm.getComponentEnabledSetting(target))) {
            pm.setComponentEnabledSetting(target, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
            changed = true
        }
        for (other in IDS) {
            if (other == id) continue
            val c = component(context, other)
            if (pm.getComponentEnabledSetting(c) != PackageManager.COMPONENT_ENABLED_STATE_DISABLED) {
                pm.setComponentEnabledSetting(c, PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
                changed = true
            }
        }
        return changed
    }
}
