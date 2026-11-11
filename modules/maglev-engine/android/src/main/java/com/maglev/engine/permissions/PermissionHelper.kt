package com.maglev.engine.permissions

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.maglev.engine.EngineHost

object PermissionHelper {
    private const val PREFS = "maglev_permissions"
    private const val KEY_ASKED_NOTIF = "asked_notifications"

    fun markNotificationsAsked(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ASKED_NOTIF, true).apply()
    }

    private fun notifications(context: Context): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
            if (granted) return "granted"
            val asked = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ASKED_NOTIF, false)
            return if (asked) "denied" else "undetermined"
        }
        return if (NotificationManagerCompat.from(context).areNotificationsEnabled()) "granted" else "denied"
    }

    private fun legacyStorage(context: Context): String {
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P) return "n/a"
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
            PackageManager.PERMISSION_GRANTED
        return if (granted) "granted" else "denied"
    }

    /** "n/a" below API 36 (no Live Updates). Otherwise NotificationManager.canPostPromotedNotifications(). */
    private fun liveUpdates(context: Context): String {
        if (Build.VERSION.SDK_INT < 36) return "n/a"
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return "n/a"
        return try {
            if (nm.canPostPromotedNotifications()) "granted" else "denied"
        } catch (_: Throwable) {
            "n/a"
        }
    }

    fun status(context: Context): Map<String, Any?> {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        return linkedMapOf(
            "ok" to true,
            "notifications" to notifications(context),
            "batteryUnrestricted" to (pm?.isIgnoringBatteryOptimizations(context.packageName) == true),
            "legacyStorage" to legacyStorage(context),
            "liveUpdates" to liveUpdates(context),
            "backgroundKills" to context.getSharedPreferences(EngineHost.PREFS, Context.MODE_PRIVATE)
                .getInt(EngineHost.KEY_KILLS, 0),
            "oemHint" to oemHint(),
        )
    }

    /** Vendors whose battery managers are known to kill background apps. See dontkillmyapp.com. */
    fun oemHint(): String? {
        val m = Build.MANUFACTURER.lowercase()
        return when {
            "xiaomi" in m || "redmi" in m || "poco" in m -> "xiaomi"
            "samsung" in m -> "samsung"
            "huawei" in m || "honor" in m -> "huawei"
            "oneplus" in m -> "oneplus"
            "oppo" in m || "realme" in m -> "oppo"
            "vivo" in m || "iqoo" in m -> "vivo"
            else -> null
        }
    }

    /** Opens the exemption dialog, falling back to the battery optimization list. Returns an error message or null. */
    fun openBatterySettings(context: Context): String? {
        val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:" + context.packageName))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(direct)
            return null
        } catch (_: Exception) {
            // fall through
        }
        return try {
            context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            null
        } catch (e: Exception) {
            e.message ?: "Battery settings are not available"
        }
    }

    /** Opens the Live Updates page of this app's settings. Returns an error message or null. */
    fun openLiveUpdateSettings(context: Context): String? {
        val pkg = Uri.parse("package:" + context.packageName)
        if (Build.VERSION.SDK_INT >= 36) {
            try {
                context.startActivity(
                    // Literal of Settings.ACTION_MANAGE_APP_PROMOTED_NOTIFICATIONS (API 36), so compile
                    // never depends on the SDK stub carrying the constant; the catch falls back.
                    Intent("android.settings.MANAGE_APP_PROMOTED_NOTIFICATIONS").setData(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                return null
            } catch (_: Exception) {
                // fall through to the app notification settings
            }
        }
        return try {
            context.startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            null
        } catch (e: Exception) {
            e.message ?: "Notification settings are not available"
        }
    }
}
