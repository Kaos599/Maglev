package com.maglev.engine.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build

class NetworkGovernanceManager(private val context: Context) {

    interface NetworkStateListener {
        fun onNetworkStateChanged(networkType: String, ssid: String?, socketsClamped: Boolean)
    }

    private val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
    private val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager

    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var listener: NetworkStateListener? = null

    var isWifiOnly: Boolean = false
        private set
    var isSsidWhitelistEnabled: Boolean = false
        private set
    var allowedSsids: List<String> = emptyList()
        private set

    var currentNetworkType: String = "NONE"
        private set
    var currentSsid: String? = null
        private set
    var isSocketsClamped: Boolean = false
        private set

    fun setListener(listener: NetworkStateListener?) {
        this.listener = listener
    }

    fun configure(wifiOnly: Boolean, ssidWhitelistEnabled: Boolean, allowedSsids: List<String>) {
        this.isWifiOnly = wifiOnly
        this.isSsidWhitelistEnabled = ssidWhitelistEnabled
        this.allowedSsids = allowedSsids
        evaluateNetworkState()
    }

    fun startMonitoring() {
        if (connectivityManager == null || networkCallback != null) return

        networkCallback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                evaluateNetworkState()
            }

            override fun onLost(network: Network) {
                evaluateNetworkState()
            }

            override fun onCapabilitiesChanged(network: Network, networkCapabilities: NetworkCapabilities) {
                evaluateNetworkState()
            }
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                connectivityManager.registerDefaultNetworkCallback(networkCallback!!)
            } else {
                val request = NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build()
                connectivityManager.registerNetworkCallback(request, networkCallback!!)
            }
        } catch (e: Exception) {
            // Log warning
        }

        evaluateNetworkState()
    }

    fun stopMonitoring() {
        networkCallback?.let {
            try {
                connectivityManager?.unregisterNetworkCallback(it)
            } catch (e: Exception) {
                // Ignored
            }
        }
        networkCallback = null
    }

    fun evaluateNetworkState() {
        val cm = connectivityManager ?: return
        val activeNetwork = cm.activeNetwork
        val caps = if (activeNetwork != null) cm.getNetworkCapabilities(activeNetwork) else null

        if (caps == null || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
            currentNetworkType = "NONE"
            currentSsid = null
            isSocketsClamped = true
            listener?.onNetworkStateChanged(currentNetworkType, currentSsid, isSocketsClamped)
            return
        }

        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
            currentNetworkType = "WIFI"
            currentSsid = resolveCurrentSsid(caps)

            var clamp = false
            if (isSsidWhitelistEnabled && allowedSsids.isNotEmpty()) {
                val ssid = currentSsid
                if (ssid == null || !allowedSsids.contains(ssid)) {
                    clamp = true
                }
            }
            isSocketsClamped = clamp
        } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
            currentNetworkType = "CELLULAR"
            currentSsid = null
            // SLA CONTRACT-2.1: If Wi-Fi only is enforced, mobile data immediately clamps sockets (<300ms)
            isSocketsClamped = isWifiOnly
        } else {
            currentNetworkType = "OTHER"
            currentSsid = null
            isSocketsClamped = isWifiOnly
        }

        listener?.onNetworkStateChanged(currentNetworkType, currentSsid, isSocketsClamped)
    }

    private fun resolveCurrentSsid(caps: NetworkCapabilities): String? {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val transportInfo = caps.transportInfo
                if (transportInfo is WifiInfo) {
                    val rawSsid = transportInfo.ssid
                    if (rawSsid != null && rawSsid != "<unknown ssid>") {
                        return rawSsid.removeSurrounding("\"")
                    }
                }
            }
            val wifiInfo = wifiManager?.connectionInfo
            val raw = wifiInfo?.ssid
            if (raw != null && raw != "<unknown ssid>") {
                return raw.removeSurrounding("\"")
            }
        } catch (e: Exception) {
            // Permission or API restrictions
        }
        return null
    }
}
