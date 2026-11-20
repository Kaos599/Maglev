package com.maglev.engine.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager

/**
 * Which network is the default one, kept apart from Android so it can be unit tested.
 *
 * A running transfer holds a socket on the network that was the default when it connected. When the default network
 * changes straight to another live one (Wi-Fi switched off with mobile data up, or the other way round), that socket
 * is dead but nothing tells the transfer until a read timeout. [available] reports that change so the engine can
 * reconnect (contract section 17.x).
 */
internal class DefaultNetworkTracker<N : Any> {
    private var current: N? = null

    /** The default network is [network]. Returns true when it replaced another live default network. */
    @Synchronized
    fun available(network: N): Boolean {
        val switched = current != null && current != network
        current = network
        return switched
    }

    /**
     * [network] was lost. Returns false for a network that is no longer the default: Android may report the old
     * network's loss after the new default is already up, and that must not mark the new one as gone.
     */
    @Synchronized
    fun lost(network: N): Boolean {
        val cur = current
        if (cur != null && cur != network) return false
        current = null
        return true
    }

    @Synchronized
    fun reset() {
        current = null
    }
}

/**
 * Watches the default network and reports whether it is Wi-Fi or Ethernet, whether Android validated its internet
 * access (captive portal check), whether it is a VPN, and which SSID it carries.
 *
 * [onGained] fires when a validated network becomes the default network, or the default network changes to another
 * validated one (contract section 21). It does not fire for the network that is already up when watching starts.
 */
class NetworkGovernanceManager(
    context: Context,
    private val onChanged: () -> Unit,
    private val onGained: () -> Unit = {},
    private val onSwitched: () -> Unit = {},
) {
    private val appContext = context.applicationContext
    private val cm = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private var callback: ConnectivityManager.NetworkCallback? = null
    private val tracker = DefaultNetworkTracker<Network>()

    @Volatile
    var unmeteredLink: Boolean = false
        private set

    @Volatile
    var connected: Boolean = false
        private set

    /** NET_CAPABILITY_VALIDATED: Android confirmed the network reaches the internet. False on a captive portal. */
    @Volatile
    var validated: Boolean = true
        private set

    /**
     * NET_CAPABILITY_CAPTIVE_PORTAL: the network is behind a sign-in page. Only this pauses transfers; an
     * unvalidated network without a portal (LAN-only Wi-Fi, a blocked connectivity check) keeps downloading.
     */
    @Volatile
    var captivePortal: Boolean = false
        private set

    /** The default network has TRANSPORT_VPN. */
    @Volatile
    var vpn: Boolean = false
        private set

    /** The network last reported as validated, so a repeat capability update is not a new gain. */
    @Volatile
    private var gainedFor: Network? = null

    /** False when the callback could not be registered. Governance then treats the link as unknown. */
    val monitoring: Boolean get() = callback != null

    fun start() {
        val manager = cm ?: return
        if (callback != null) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = refresh(network, announce = true)
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) =
                update(network, caps, announce = true)
            override fun onLost(network: Network) {
                if (!tracker.lost(network)) return
                connected = false
                unmeteredLink = false
                validated = true
                captivePortal = false
                vpn = false
                gainedFor = null
                onChanged()
            }
        }
        try {
            manager.registerDefaultNetworkCallback(cb)
            callback = cb
        } catch (_: Exception) {
            // Missing ACCESS_NETWORK_STATE or too many callbacks. Governance then treats the link as unknown.
        }
        refresh(manager.activeNetwork, announce = false)
    }

    fun stop() {
        val cb = callback ?: return
        try {
            cm?.unregisterNetworkCallback(cb)
        } catch (_: Exception) {
        }
        callback = null
        tracker.reset()
    }

    private fun refresh(network: Network?, announce: Boolean) {
        val caps = network?.let { cm?.getNetworkCapabilities(it) }
        if (network == null || caps == null) {
            if (network == null) tracker.reset()
            connected = false
            unmeteredLink = false
            validated = true
            captivePortal = false
            vpn = false
            onChanged()
        } else {
            update(network, caps, announce)
        }
    }

    private fun update(network: Network, caps: NetworkCapabilities, announce: Boolean) {
        val switched = if (announce) {
            tracker.available(network)
        } else {
            tracker.reset()
            tracker.available(network)
            false
        }
        connected = true
        validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        captivePortal = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL)
        vpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
        val gained = validated && gainedFor != network
        gainedFor = if (validated) network else null
        unmeteredLink = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) &&
            (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))
        onChanged()
        if (gained && announce) onGained()
        if (switched) onSwitched()
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
