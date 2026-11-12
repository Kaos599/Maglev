package com.maglev.engine.browser

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.maglev.engine.EngineHost

/**
 * The user's Wi-Fi-only and VPN-only rules (docs/NATIVE_CONTRACT.md section 6, 21) for the block list update.
 * EngineHost keeps its network watcher private, so this reads the same saved rules and asks Android for the
 * current network with the same tests EngineHost uses (NOT_METERED plus Wi-Fi or Ethernet; TRANSPORT_VPN).
 * The Wi-Fi name whitelist is not checked: a list update is a few hundred KB, and the name is often unreadable.
 */
object BrowserGovernance {
    /** A plain-English reason when a rule forbids the update right now, or null when it may go ahead. */
    fun blockedReason(context: Context): String? {
        val p = context.getSharedPreferences(EngineHost.GOV_PREFS, Context.MODE_PRIVATE)
        val wifiOnly = p.getBoolean("wifiOnly", false)
        val vpnOnly = p.getBoolean("vpnOnly", false)
        if (!wifiOnly && !vpnOnly) return null
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return null
        val found: NetworkCapabilities? = try {
            cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
        } catch (_: Exception) {
            null
        }
        // No network, or unknown: let the fetch fail as NETWORK.
        val caps = found ?: return null
        if (wifiOnly) {
            val unmetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
                (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
            if (!unmetered) return "Wi-Fi only is on, and this isn't Wi-Fi. Connect to Wi-Fi to update the list."
        }
        if (vpnOnly && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
            return "VPN only is on, and no VPN is connected. Turn on your VPN to update the list."
        }
        return null
    }
}
