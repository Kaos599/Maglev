package com.maglev.engine.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager

/** Watches the default network and reports whether it is Wi-Fi or Ethernet and which SSID it carries. */
class NetworkGovernanceManager(context: Context, private val onChanged: () -> Unit) {
    private val appContext = context.applicationContext
    private val cm = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private var callback: ConnectivityManager.NetworkCallback? = null

    @Volatile
    var unmeteredLink: Boolean = false
        private set

    @Volatile
    var connected: Boolean = false
        private set

    /** False when the callback could not be registered. Governance then treats the link as unknown. */
    val monitoring: Boolean get() = callback != null

    fun start() {
        val manager = cm ?: return
        if (callback != null) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = refresh(network)
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = update(caps)
            override fun onLost(network: Network) {
                connected = false
                unmeteredLink = false
                onChanged()
            }
        }
        try {
            manager.registerDefaultNetworkCallback(cb)
            callback = cb
        } catch (_: Exception) {
            // Missing ACCESS_NETWORK_STATE or too many callbacks. Governance then treats the link as unknown.
        }
        refresh(manager.activeNetwork)
    }

    fun stop() {
        val cb = callback ?: return
        try {
            cm?.unregisterNetworkCallback(cb)
        } catch (_: Exception) {
        }
        callback = null
    }

    private fun refresh(network: Network?) {
        val caps = network?.let { cm?.getNetworkCapabilities(it) }
        if (caps == null) {
            connected = false
            unmeteredLink = false
            onChanged()
        } else {
            update(caps)
        }
    }

    private fun update(caps: NetworkCapabilities) {
        connected = true
        unmeteredLink = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        onChanged()
    }

    /**
     * Current SSID, or null when it cannot be read. Modern Android hides it without location permission.
     * Callers must treat null as "not enforceable", never as "blocked".
     */
    @Suppress("DEPRECATION")
    fun currentSsid(): String? {
        return try {
            val wm = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return null
            val raw = wm.connectionInfo?.ssid ?: return null
            val ssid = raw.removeSurrounding("\"")
            if (ssid.isEmpty() || ssid == WifiManager.UNKNOWN_SSID) null else ssid
        } catch (_: Exception) {
            null
        }
    }
}
