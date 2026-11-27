package com.maglev.engine.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities

/**
 * Tells JS when the phone goes online, offline, or between Wi-Fi and mobile data, so screens that depend on it
 * ("This waits for Wi-Fi.") follow the network while they are open.
 *
 * It owns a separate default-network callback and runs only while JS listens ([start] and [stop] map to the module's
 * observing hooks). [NetworkGovernanceManager] keeps its own callback for download rules and is not touched.
 * The metered test matches `EngineHost.networkState`: unmetered means Wi-Fi or Ethernet that is not marked metered.
 */
class NetworkWatcher(context: Context, private val emit: (String, Map<String, Any?>) -> Unit) {
    private val cm = context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private val lock = Any()
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var current: Network? = null
    private var lastSent: Pair<Boolean, Boolean>? = null

    /** Starts watching. Calling it twice does nothing. Android calls back at once with the current network. */
    fun start() {
        val manager = cm ?: return
        synchronized(lock) {
            if (callback != null) return
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    val unmetered = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
                        (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
                    report(network, connected = true, metered = !unmetered)
                }

                override fun onLost(network: Network) {
                    report(network, connected = false, metered = false)
                }
            }
            try {
                manager.registerDefaultNetworkCallback(cb)
                callback = cb
            } catch (_: Exception) {
                // Missing ACCESS_NETWORK_STATE or too many callbacks: JS keeps its first read.
            }
        }
    }

    fun stop() {
        synchronized(lock) {
            val cb = callback ?: return
            try {
                cm?.unregisterNetworkCallback(cb)
            } catch (_: Exception) {
            }
            callback = null
            current = null
            lastSent = null
        }
    }

    private fun report(network: Network, connected: Boolean, metered: Boolean) {
        val state = Pair(connected, metered)
        synchronized(lock) {
            if (callback == null) return
            if (connected) {
                current = network
            } else {
                // Android can report the old network lost after the new default is up; that is not "offline".
                val cur = current
                if (cur != null && cur != network) return
                current = null
            }
            if (state == lastSent) return
            lastSent = state
        }
        try {
            emit("onNetworkChanged", linkedMapOf("connected" to connected, "metered" to metered))
        } catch (_: Throwable) {
            // The JS side may be gone while the callback is still firing.
        }
    }
}
