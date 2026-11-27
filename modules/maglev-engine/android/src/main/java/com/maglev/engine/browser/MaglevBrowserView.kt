package com.maglev.engine.browser

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.view.KeyEvent
import android.view.MotionEvent
import org.json.JSONObject
import org.json.JSONTokener
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayInputStream
import java.net.URISyntaxException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * The in-app browser view: an ExpoView that hosts one android.webkit.WebView,
 * blocks ad hosts in `shouldInterceptRequest`, lists the media and files the page loads, and refuses what the browser rules refuse
 * (off-site app links, local-network hosts and the like). One page at a time; the WebView lives only while the view is mounted.
 */
@SuppressLint("ViewConstructor", "SetJavaScriptEnabled", "ClickableViewAccessibility")
class MaglevBrowserView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {

    // Event names are the property names; they must match Events(...) in MaglevEngineModule.
    private val onPage by EventDispatcher<Map<String, Any?>>()
    private val onFound by EventDispatcher<Map<String, Any?>>()
    private val onBlockedCount by EventDispatcher<Map<String, Any?>>()
    private val onDownloadRequest by EventDispatcher<Map<String, Any?>>()
    private val onMagnet by EventDispatcher<Map<String, Any?>>()
    private val onRefused by EventDispatcher<Map<String, Any?>>()
    private val onCrashed by EventDispatcher<Map<String, Any?>>()
    private val onPageNote by EventDispatcher<Map<String, Any?>>()
    private val onNewWindow by EventDispatcher<Map<String, Any?>>()
    private val onPopupRequest by EventDispatcher<Map<String, Any?>>()
    private val onPopupBlocked by EventDispatcher<Map<String, Any?>>()
    private val onLongPress by EventDispatcher<Map<String, Any?>>()
    private val onMediaHit by EventDispatcher<Map<String, Any?>>()
    private val onFindResult by EventDispatcher<Map<String, Any?>>()
    // Reload start / end.
    private val onReloadState by EventDispatcher<Map<String, Any?>>()

    override val shouldUseAndroidLayout: Boolean = true

    private val mainHandler = Handler(Looper.getMainLooper())
    private val tracker = FoundTracker()
    private val blockedPage = AtomicInteger(0)
    private val blockedTotal = AtomicInteger(0)
    private val flushScheduled = AtomicBoolean(false)
    private val flushRunnable = Runnable { flush() }
    // Delayed page scan after a same-document navigation. Main thread only.
    private val scanRunnable = Runnable { if (!destroyed) scan() }
    // resetFound() arrived while the page was loading: scan once the load ends.
    private var scanAfterLoad = false

    private var webView: WebView
    private var defaultUserAgent: String = ""
    @Volatile private var destroyed = false

    // Props. adBlock, allowHosts, pageHost, nonce and hlsSeen are read on WebView's background threads.
    @Volatile private var adBlock = true
    @Volatile private var allowHosts: List<String> = emptyList()
    private var desktopMode = false
    // 28: text size in percent, 50..200. Applied again to every WebView this view creates.
    private var textZoom = 100
    // Third-party cookies are blocked unless the user turns "Block cookies from other sites" off.
    // Declared before init, which builds the first WebView and reads it.
    private var blockThirdPartyCookies = true
    // "Try https first". Off: http:// addresses load as they are, with no https try.
    private var httpsFirst = true
    // Private browsing: the page cache is bypassed (LOAD_NO_CACHE). Cookies are wiped from JS when the browser is left.
    private var privateMode = false
    // Hosts whose https try failed in this view while private. Never shared with normal tabs; forgotten when private mode changes or the view is destroyed.
    private val privateFallbackHosts: MutableSet<String> =
        java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())
    private var pendingUrl: String? = null
    private var requestedUrl: String? = null

    // 24.10. Main thread only.
    private var active = true
    private var popupPolicy = "ask"
    private var popupAllowHosts: List<String> = emptyList()
    // Sites whose untapped pop-ups, redirects and app hand-offs are always refused. Main thread only.
    private var popupBlockHosts: List<String> = emptyList()
    // The current document has finished loading at least once. Redirects during its first load are part of the page.
    private var loadedOnce = false
    // A view mounted hidden finishes its first load before it is paused (a paused WebView may not load).
    private var firstLoadDone = false
    private var pausePending = false
    // Pop-up capture WebViews that exist right now. Main thread only.
    private val captures = HashSet<WebView>()
    // The last main-frame navigation was a server redirect: it continues the load, so it does not start a new document.
    private var redirectInFlight = false
    // One-shot allowance for the exact URL followRedirect loads, so the redirect rule does not hold it again.
    private var followAllowUrl: String? = null
    // When the last tap ended (uptimeMillis), 0 while a touch is still down. Main thread.
    private var tapAt = 0L
    // Windows and cross-site navigations already let through for the current tap. A second one in one tap is not the user's.
    private var tapUses = 0
    // Back-button hijacking: what made each history entry, whether the navigation in flight is the user's, and
    // how many entries and downloads the current tap has already vouched for.
    private val history = HistoryFlags()
    private var pendingUserNav = false
    private var entryTapUses = 0
    private var dlTapUses = 0
    // The https try that has not loaded yet. It ends only when its https page commits, it falls back, or a new
    // navigation replaces it. host/httpUrl are the address the user asked for (what a fallback loads and remembers);
    // hosts are every host the try has touched through redirects, so a failure or commit on any of them is its own;
    // seen are the http addresses already upgraded in this try, to spot a redirect loop.
    private class HttpsTry(val host: String, val httpsUrl: String, val httpUrl: String) {
        val hosts = mutableSetOf(HttpsFirst.bareHost(host))
        val seen = mutableSetOf(httpUrl)
        // The https address this try is loading now (the first one, or the latest redirect hop).
        var lastHttps = httpsUrl
        fun owns(url: String?): Boolean = HttpsFirst.hostOf(url)?.let { HttpsFirst.bareHost(it) in hosts } == true
    }
    private var upgrade: HttpsTry? = null
    // Failed https addresses whose error page WebView has not put in its history yet. The error page commits a moment
    // after the fallback starts, so it is marked "skip on Back" when it is recorded, not when the fallback begins.
    // Cleared once the http page that replaced them is recorded.
    private val failedHttpsPending = mutableSetOf<String>()
    private var fallbackHttpPending: String? = null
    // One timer per try, so a server that never answers https still falls back to http.
    private val upgradeTimeout = Runnable { onUpgradeTimeout() }
    // Which main-frame document the last tap vouches for. docEpoch changes with every new document.
    private var docEpoch = 0
    private var vouchEpoch = -1
    private var vouchCarry = false
    // When the last key press happened, and user activation since the previous history entry.
    private var keyAt = 0L
    private val activation = ActivationLatch()

    // Per page load.
    @Volatile private var pageHost: String? = null
    @Volatile private var curUrl: String = ""
    // URL of the current document, kept to tell a same-document navigation (pushState) from a fragment change.
    private var docUrl: String? = null
    @Volatile private var curTitle: String = ""
    @Volatile private var nonce: String = ""
    @Volatile private var hlsSeen = false
    @Volatile private var lastFlush = 0L
    private var progress = 0
    private var loading = false
    private var sslFailed = false
    private var lastSentPage = -1
    private var lastSentTotal = -1

    // What the user typed in the address bar (the url prop and loadUrl). Only those may open blocked or LAN pages.
    private var typedUrl: String? = null
    private var typedHost: String? = null
    // Where the url prop came from: "link" (a maglev:// deep link or the card) loads through the link-tap refusals and is never typed.
    private var urlFromLink = false
    // The tab this view shows (prop tabId), '' when unknown. Its page state is saved in TabStates when the view
    // is destroyed and restored instead of the first load when the tab wakes. restoreTried: only before the first load.
    private var tabId = ""
    private var restoreTried = false

    // Fullscreen video.
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var customViewHost: ViewGroup? = null
    private var previousOrientation: Int = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED

    private val bridge = PageScanBridge { json -> onScanReport(json) }

    // Pull to reload. The WebView sits inside this layout (https://developer.android.com/reference/androidx/swiperefreshlayout/widget/SwipeRefreshLayout).
    // The stock progress circle is shown and follows the finger on the UI thread; colours come from the refreshColor / refreshBackground props.
    private val refresh = SwipeRefreshLayout(context)
    private val density = context.resources.displayMetrics.density
    // SwipeRefreshLayout's trigger distance (72 dp), in px. Progress 1 is a drag of exactly this distance.
    private val pullTriggerPx = PULL_TRIGGER_DP * density
    // A text selection or the find bar is active, so a downward drag must not reload. Main thread.
    private var selectionHold = false
    private var findActive = false
    // One reload from start to end: `start` is sent once and `end` once per start. Main thread.
    private var reloadActive = false
    // The page has been seen loading during this reload; its end (loading false) then ends the reload.
    private var reloadSeenLoading = false
    // The injected script that finds media under a long press (prop mediaHitScript), and the dark pages switch.
    private var mediaHitJs = ""
    private var darkPages = false
    // Safety: a reload that never reports loaded ends after PULL_SAFETY_MS.
    private val reloadSafety = Runnable { if (!destroyed) endReload() }

    init {
        BlocklistStore.warm(context)
        refresh.setOnRefreshListener {
            reload()
            // A pull that could not reload (no page and no address) must not leave the layout refreshing.
            if (!reloadActive) refresh.isRefreshing = false
        }
        refresh.setOnChildScrollUpCallback { _, _ -> selectionHold || findActive || webView.canScrollVertically(-1) }
        // Dark-theme defaults (surfaceRaised disc, lime arc) until the refreshBackground / refreshColor props arrive.
        refresh.setProgressBackgroundColorSchemeColor(DEFAULT_REFRESH_DISC)
        refresh.setColorSchemeColors(DEFAULT_REFRESH_ARC)
        refresh.setDistanceToTriggerSync(pullTriggerPx.toInt())
        addView(refresh, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = createWebView()
        refresh.addView(webView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    // region Props and commands (called on the main thread)

    fun setUrl(url: String) {
        if (url == requestedUrl) return
        requestedUrl = url
        pendingUrl = url
    }

    /** "link" for a deep link or card URL (not typed), anything else for the address bar. Applied with the url. */
    fun setUrlSource(source: String) {
        urlFromLink = source == "link"
    }

    /** The tab id, read before the first load to find a saved page state (TabStates). */
    fun setTabId(value: String) {
        tabId = value
    }

    fun setAdBlock(value: Boolean) {
        adBlock = value
    }

    fun setAllowAdsHosts(hosts: List<String>) {
        allowHosts = hosts.map { it.trim().lowercase().trimStart('.') }.filter { it.isNotEmpty() }
    }

    fun setDesktopMode(value: Boolean) {
        if (value == desktopMode) return
        desktopMode = value
        applyUserAgent()
        if (!destroyed && webView.url != null) webView.reload()
    }

    /** 28: text size in percent. Clamped to 50..200. Pinch zoom is separate and stays on. */
    fun setTextZoom(value: Int) {
        val v = value.coerceIn(50, 200)
        if (v == textZoom) return
        textZoom = v
        if (!destroyed) webView.settings.textZoom = v
    }

    /**
     * "Block cookies from other sites". On (the default) means third-party cookies are refused. Applied to
     * the live WebView now and to every WebView created later (createWebView).
     */
    fun setBlockThirdPartyCookies(value: Boolean) {
        blockThirdPartyCookies = value
        if (!destroyed) CookieManager.getInstance().setAcceptThirdPartyCookies(webView, !value)
    }

    /** "Try https first". Read at each load, so it takes effect on the next load. */
    fun setHttpsFirst(value: Boolean) {
        httpsFirst = value
    }

    /** Private browsing: stop reading the page cache while on. */
    fun setPrivateMode(value: Boolean) {
        if (value == privateMode) return
        privateMode = value
        privateFallbackHosts.clear()
        if (!destroyed) webView.settings.cacheMode = if (value) WebSettings.LOAD_NO_CACHE else WebSettings.LOAD_DEFAULT
    }

    /** Pull to reload on or off. */
    fun setPullToRefresh(value: Boolean) {
        refresh.isEnabled = value
        if (!value) refresh.isRefreshing = false
    }

    /** The arc colour of the pull circle, `#RRGGBB`. A bad value keeps the previous colour. */
    fun setRefreshColor(value: String) {
        val color = try { Color.parseColor(value) } catch (e: IllegalArgumentException) { return }
        refresh.setColorSchemeColors(color)
    }

    /** The disc colour behind the arc, `#RRGGBB`. A bad value keeps the previous colour. */
    fun setRefreshBackground(value: String) {
        val color = try { Color.parseColor(value) } catch (e: IllegalArgumentException) { return }
        refresh.setProgressBackgroundColorSchemeColor(color)
    }

    /** The script from utils/browser/mediaHitScript.ts, injected next to the page scan. */
    fun setMediaHitScript(value: String) {
        mediaHitJs = value
    }

    /** Allow algorithmic darkening of pages that have no dark look. Takes effect on the next page load. */
    fun setDarkPages(value: Boolean) {
        darkPages = value
        if (!destroyed) applyDarkPages(webView)
    }

    // https://developer.android.com/reference/androidx/webkit/WebSettingsCompat#setAlgorithmicDarkeningAllowed(android.webkit.WebSettings,boolean)
    private fun applyDarkPages(w: WebView) {
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
                WebSettingsCompat.setAlgorithmicDarkeningAllowed(w.settings, darkPages)
            }
        } catch (_: Throwable) {
            // An old WebView: pages stay as they are.
        }
    }

    /** Forget this site's localStorage and sessionStorage (main frame only). The screen reloads afterwards. */
    fun clearSiteStorage() {
        if (destroyed || webView.url == null) return
        webView.evaluateJavascript("try{localStorage.clear();sessionStorage.clear()}catch(e){}", null)
    }

    /** 28: highlight matches of [query] in the page. An empty query clears them. Results come as onFindResult. */
    fun findInPage(query: String, promise: Promise) {
        if (destroyed) {
            promise.reject("VIEW_GONE", "The browser was closed.", null)
            return
        }
        findActive = query.isNotEmpty()
        if (query.isEmpty()) webView.clearMatches() else webView.findAllAsync(query)
        promise.resolve(null)
    }

    fun findNext(forward: Boolean, promise: Promise) {
        if (destroyed) {
            promise.reject("VIEW_GONE", "The browser was closed.", null)
            return
        }
        webView.findNext(forward)
        promise.resolve(null)
    }

    fun clearFind(promise: Promise) {
        if (destroyed) {
            promise.reject("VIEW_GONE", "The browser was closed.", null)
            return
        }
        findActive = false
        webView.clearMatches()
        promise.resolve(null)
    }

    fun setActive(value: Boolean) {
        if (value == active) return
        active = value
        if (destroyed) return
        applyActive()
    }

    /** Hidden tab: stop the WebView's rendering and silence media. Timers are never paused: that would stall every WebView in the process. */
    private fun applyActive() {
        if (active) {
            pausePending = false
            webView.onResume()
        } else if (firstLoadDone) {
            pauseNow()
        } else if (!pausePending) {
            // First load not finished: pause after onPageFinished, or after FIRST_LOAD_PAUSE_MS at the latest.
            pausePending = true
            mainHandler.postDelayed({ if (pausePending && !destroyed && !active) pauseNow() }, FIRST_LOAD_PAUSE_MS)
        }
    }

    private fun pauseNow() {
        pausePending = false
        webView.onPause()
        webView.evaluateJavascript(PAUSE_MEDIA_JS, null)
    }

    fun setPopupPolicy(value: String) {
        popupPolicy = when (value) {
            "block", "allow" -> value
            else -> "ask"
        }
    }

    fun setPopupAllowHosts(hosts: List<String>) {
        popupAllowHosts = hosts.map { PopupRules.normalizeSite(it) }.filter { it.isNotEmpty() }
    }

    fun setPopupBlockHosts(hosts: List<String>) {
        popupBlockHosts = hosts.map { PopupRules.normalizeSite(it) }.filter { it.isNotEmpty() }
    }

    /** Called after all props of an update are set. Loads the url prop when it changed. */
    fun applyProps() {
        val u = pendingUrl ?: return
        pendingUrl = null
        // A woken tab takes back its history and scroll position instead of loading the url again.
        if (!restoreTried) {
            restoreTried = true
            if (restoreSaved()) return
        }
        loadRequested(u)
    }

    /**
     * Restores the page state this tab saved when its view was destroyed. Must run before any load on the new
     * WebView: restoreState "should be called" before the WebView "has had a chance to build state (load pages, create a
     * back/forward list, etc.)" (https://developer.android.com/reference/android/webkit/WebView#restoreState(android.os.Bundle)).
     * True when WebView took it; false (nothing saved, or restoreState returned null) means the caller loads the url.
     */
    private fun restoreSaved(): Boolean {
        if (destroyed || tabId.isEmpty()) return false
        val saved = TabStates.take(tabId) ?: return false
        if (webView.url != null || webView.copyBackForwardList().size > 0) return false
        val list = try {
            webView.restoreState(saved.bundle)
        } catch (_: Throwable) {
            null
        }
        if (list == null || list.size == 0) return false
        typedUrl = saved.typedUrl
        typedHost = saved.typedHost
        history.restore(saved.history)
        pendingUserNav = false
        loadedOnce = false
        redirectInFlight = false
        upgrade = null
        mainHandler.removeCallbacks(upgradeTimeout)
        emitPage()
        return true
    }

    /**
     * Saves this tab's page state (back/forward list, with each entry's scroll position) for when it wakes.
     * A view with no page drops any older state instead. Called before the WebView is torn down. Main thread.
     * https://developer.android.com/reference/android/webkit/WebView#saveState(android.os.Bundle)
     */
    private fun saveForWake() {
        if (tabId.isEmpty() || privateMode) return
        try {
            if (webView.copyBackForwardList().size == 0) {
                TabStates.drop(tabId)
                return
            }
            val bundle = Bundle()
            val list = webView.saveState(bundle)
            if (list == null || list.size == 0) {
                TabStates.drop(tabId)
            } else {
                TabStates.put(tabId, TabStates.Saved(bundle, typedUrl, typedHost, history.snapshot()))
            }
        } catch (_: Throwable) {
            TabStates.drop(tabId)
        }
    }

    /** Loads the url prop the way its source says: a link through the link-tap refusals, a typed address as typed. */
    private fun loadRequested(url: String) {
        if (urlFromLink) loadFromLink(url) else loadTyped(url)
    }

    fun goBack() {
        if (destroyed) return
        // Back leaves fullscreen first (onPage.canGoBack is true while a video is fullscreen).
        if (customView != null) {
            exitFullscreen()
            return
        }
        if (!webView.canGoBack()) return
        cancelUpgrade()
        // Back steps over entries the page added without a tap, to the last one the user made.
        val steps = BackRules.steps(history.flags(), webView.copyBackForwardList().currentIndex)
        if (steps > 1) webView.goBackOrForward(-steps) else webView.goBack()
    }

    fun goForward() {
        if (destroyed || !webView.canGoForward()) return
        cancelUpgrade()
        webView.goForward()
    }

    fun reload() {
        if (destroyed) return
        // A reload during an https try reloads the https address: give it a fresh clock so it can still fall back.
        armUpgradeTimeout()
        if (webView.url != null) {
            beginReload()
            webView.reload()
        } else {
            requestedUrl?.let {
                beginReload()
                loadRequested(it)
            }
        }
    }

    /**
     * A reload started (pull, menu or command). Sends `start` once; every call restarts the safety timer.
     * The matching `end` comes from endReload(). Main thread.
     */
    private fun beginReload() {
        mainHandler.removeCallbacks(reloadSafety)
        mainHandler.postDelayed(reloadSafety, PULL_SAFETY_MS)
        if (reloadActive) return
        reloadActive = true
        reloadSeenLoading = false
        // A reload from the menu or a command shows the circle too (a pull already has it showing).
        if (refresh.isEnabled && !refresh.isRefreshing) refresh.isRefreshing = true
        onReloadState(mapOf("state" to "start"))
    }

    /** Ends the reload started by beginReload (one `end` per `start`) and stops the spinner. Main thread. */
    private fun endReload() {
        mainHandler.removeCallbacks(reloadSafety)
        if (refresh.isRefreshing) refresh.isRefreshing = false
        if (!reloadActive) return
        reloadActive = false
        reloadSeenLoading = false
        onReloadState(mapOf("state" to "end"))
    }

    fun stop() {
        if (destroyed) return
        webView.stopLoading()
        // stopLoading does not always end with onPageFinished; the bar must not stay on Stop.
        loading = false
        cancelUpgrade()
        endReload()
        emitPage()
    }

    /** A URL the user typed (or the screen set). Checked for scheme only; blocked and LAN hosts are allowed. */
    fun loadTyped(raw: String) {
        if (destroyed) return
        val url = raw.trim()
        val uri = Uri.parse(url)
        val scheme = uri.scheme?.lowercase()
        if (url != "about:blank" && scheme != "http" && scheme != "https") {
            onRefused(mapOf("url" to url, "reason" to "scheme"))
            return
        }
        typedUrl = url
        typedHost = uri.host?.lowercase()
        startLoad(url)
    }

    /**
     * A deep link or card URL (maglev://browser?url=). It is not typed, so it gets the same
     * main-frame refusals as a link tap (mainFrameRefusal: scheme, ad-blocked host, LAN host) and the refusal
     * notice (onRefused). Any earlier typed allowance of this view is dropped first.
     */
    fun loadFromLink(raw: String) {
        if (destroyed) return
        val url = raw.trim()
        typedUrl = null
        typedHost = null
        val reason = mainFrameRefusal(Uri.parse(url))
        if (reason != null) {
            refuse(url, reason)
            return
        }
        startLoad(url)
    }

    /** The load itself, shared by typed and link loads. The caller has already checked the URL. */
    private fun startLoad(url: String) {
        // Once the view has loaded something, a saved state may no longer be restored.
        restoreTried = true
        // A new load: its own script redirects are part of the page until it has finished once.
        loadedOnce = false
        redirectInFlight = false
        pendingUserNav = true
        failedHttpsPending.clear()
        fallbackHttpPending = null
        // A typed http:// address is tried as https:// first; this load replaces any earlier try.
        val https = httpsTryFor(url)
        val host = HttpsFirst.hostOf(https)
        upgrade = if (https != null && host != null) HttpsTry(host, https, url) else null
        armUpgradeTimeout()
        webView.loadUrl(https ?: url)
    }

    /** The https try for [url], or null when "Try https first" is off. Every other HttpsFirst rule still applies. */
    private fun httpsTryFor(url: String, method: String = "GET"): String? =
        if (httpsFirst) HttpsFirst.upgrade(url, fallbackHostsInUse(), method) else null

    /** Private tabs keep their own fallback hosts so normal tabs can't observe what was visited. */
    private fun fallbackHostsInUse(): MutableSet<String> = if (privateMode) privateFallbackHosts else httpsFallbackHosts

    /**
     * Loads a held redirect the user said yes to. Not typed, so the refusals (scheme, blocked host, LAN)
     * still apply. The redirect rule does not hold this exact URL again.
     */
    fun followRedirect(raw: String, promise: Promise) {
        if (destroyed) {
            promise.reject("VIEW_GONE", "The browser was closed.", null)
            return
        }
        val url = raw.trim()
        val reason = mainFrameRefusal(Uri.parse(url))
        if (reason != null) {
            refuse(url, reason)
        } else {
            cancelUpgrade()
            val https = httpsTryFor(url)
            val host = HttpsFirst.hostOf(https)
            if (https != null && host != null) {
                upgrade = HttpsTry(host, https, url)
                armUpgradeTimeout()
                followAllowUrl = https
                webView.loadUrl(https)
            } else {
                followAllowUrl = url
                webView.loadUrl(url)
            }
        }
        promise.resolve(null)
    }

    /**
     * Opens an intent:, market:, tel:, mailto: or custom-scheme URL in another app. Only called after the user
     * said yes (or the policy allows). Never throws: a failure is `opened:false`.
     */
    fun openApp(raw: String, promise: Promise) {
        if (destroyed) {
            promise.reject("VIEW_GONE", "The browser was closed.", null)
            return
        }
        val result = startApp(raw.trim())
        promise.resolve(mapOf("opened" to result.first, "fallbackUrl" to result.second))
    }

    /** Returns (opened, fallbackUrl). Never throws. */
    private fun startApp(url: String): Pair<Boolean, String?> {
        var fallback: String? = null
        try {
            val scheme = Uri.parse(url).scheme?.lowercase() ?: return Pair(false, null)
            if (scheme in NEVER_START_SCHEMES) return Pair(false, null)
            val intent: Intent
            if (scheme == "intent") {
                intent = try {
                    Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
                } catch (_: URISyntaxException) {
                    return Pair(false, null)
                }
                fallback = intent.getStringExtra("browser_fallback_url")?.takeIf { isWebUrl(it) }
                // The page chose these fields: drop the ones that could aim the intent at a specific component.
                intent.addCategory(Intent.CATEGORY_BROWSABLE)
                intent.component = null
                intent.selector = null
                intent.clipData = null
                intent.removeExtra("browser_fallback_url")
                // Never aim a page's intent at Maglev itself.
                if (intent.`package` == context.packageName) return Pair(false, fallback)
                val dataScheme = intent.data?.scheme?.lowercase()
                if (dataScheme != null && (dataScheme in DANGEROUS_SCHEMES || dataScheme == "maglev")) return Pair(false, fallback)
            } else {
                intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                intent.addCategory(Intent.CATEGORY_BROWSABLE)
            }
            // The page chose the flags. Clear them all (every FLAG_GRANT_*, CLEAR_TASK...) and keep only NEW_TASK.
            intent.flags = 0
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            return Pair(true, null)
        } catch (_: ActivityNotFoundException) {
            return Pair(false, fallback)
        } catch (_: Throwable) {
            return Pair(false, fallback)
        }
    }

    private fun isWebUrl(u: String): Boolean {
        val s = Uri.parse(u).scheme?.lowercase()
        return s == "http" || s == "https"
    }

    fun scan() {
        if (destroyed || webView.url == null) return
        webView.evaluateJavascript(PageScan.scanScript(nonce.ifEmpty { newNonce() }), null)
        if (mediaHitJs.isNotEmpty()) webView.evaluateJavascript(mediaHitJs, null)
        webView.evaluateJavascript(PageScan.RESCAN_JS, null)
    }

    /**
     * Forget what this document reported and scan again. Idempotent. A page still loading is scanned
     * when the load ends. A destroyed view rejects with VIEW_GONE.
     */
    fun resetFound(promise: Promise) {
        if (destroyed) {
            promise.reject("VIEW_GONE", "The browser was closed.", null)
            return
        }
        tracker.clear()
        if (loading) scanAfterLoad = true else scan()
        promise.resolve(null)
    }

    /** True when both URLs are the same document: scheme, host, path and query equal, fragment ignored. */
    private fun sameDocument(a: String?, b: String?): Boolean {
        if (a == null || b == null) return a == b
        val x = Uri.parse(a)
        val y = Uri.parse(b)
        return x.scheme.equals(y.scheme, ignoreCase = true) &&
            x.host.equals(y.host, ignoreCase = true) &&
            x.path.orEmpty() == y.path.orEmpty() &&
            x.query.orEmpty() == y.query.orEmpty()
    }

    fun clearData(cookies: Boolean, cache: Boolean) {
        if (destroyed) return
        BrowserData.clear(context, webView, cookies, cache) { }
    }

    /** Forgets this screen's back/forward list (history is cleared from the history screen's side too). Main thread. */
    fun clearHistoryList() {
        if (destroyed) return
        webView.clearHistory()
    }

    /** Called by React Native when the view is dropped (OnViewDestroys). */
    fun destroyBrowser() {
        if (destroyed) return
        saveForWake()
        destroyed = true
        privateFallbackHosts.clear()
        mainHandler.removeCallbacksAndMessages(null)
        for (c in captures.toList()) destroyCapture(c)
        exitFullscreen()
        tearDown(webView)
    }

    /** Stops and destroys one pop-up capture view. Safe to call twice. Main thread. */
    private fun destroyCapture(c: WebView) {
        if (!captures.remove(c)) return
        try {
            c.stopLoading()
            c.destroy()
        } catch (_: Throwable) {
        }
    }

    // endregion

    // region WebView setup

    private fun createWebView(): WebView {
        // Hardware key presses (dispatchKeyEvent) and IME actions or keys (InputConnection) count as user input.
        // https://developer.android.com/reference/android/view/View#dispatchKeyEvent(android.view.KeyEvent)
        // https://developer.android.com/reference/android/view/inputmethod/InputConnectionWrapper
        val w = object : WebView(context) {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                if (event.action == KeyEvent.ACTION_DOWN || event.action == KeyEvent.ACTION_UP) noteKey(event.keyCode)
                return super.dispatchKeyEvent(event)
            }

            override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
                val base = super.onCreateInputConnection(outAttrs) ?: return null
                return object : InputConnectionWrapper(base, true) {
                    override fun sendKeyEvent(event: KeyEvent): Boolean {
                        noteKey(event.keyCode)
                        return super.sendKeyEvent(event)
                    }

                    override fun performEditorAction(editorAction: Int): Boolean {
                        noteKey(KeyEvent.KEYCODE_ENTER)
                        return super.performEditorAction(editorAction)
                    }
                }
            }
        }
        w.setBackgroundColor(Color.BLACK)
        val s = w.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.setSupportMultipleWindows(true)
        // Untapped window.open must reach onCreateWindow so the view can decide (ask, block or allow).
        s.javaScriptCanOpenWindowsAutomatically = true
        s.mediaPlaybackRequiresUserGesture = true
        s.setSupportZoom(true)
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.textZoom = textZoom
        s.cacheMode = if (privateMode) WebSettings.LOAD_NO_CACHE else WebSettings.LOAD_DEFAULT
        applyDarkPages(w)
        w.setFindListener { ordinal, total, done ->
            if (!destroyed) onFindResult(mapOf("active" to ordinal, "total" to total, "done" to done))
        }
        s.useWideViewPort = true
        s.loadWithOverviewMode = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) s.setSafeBrowsingEnabled(true)
        if (defaultUserAgent.isEmpty()) defaultUserAgent = s.userAgentString
        s.userAgentString = if (desktopMode) desktopUserAgent(defaultUserAgent) else defaultUserAgent

        val cookies = CookieManager.getInstance()
        cookies.setAcceptCookie(true)
        cookies.setAcceptThirdPartyCookies(w, !blockThirdPartyCookies)

        w.addJavascriptInterface(bridge, PageScan.BRIDGE_NAME)
        w.webViewClient = browserClient()
        w.webChromeClient = chromeClient()
        w.setDownloadListener { url, userAgent, contentDisposition, mimeType, contentLength ->
            onDownload(url, userAgent, contentDisposition, mimeType, contentLength)
        }
        // Long press on a link or image opens the screen's menu instead of the system one.
        w.setOnLongClickListener { v -> onLongPressed(v as WebView) }
        // Let the page scroll inside React Native parents.
        w.setOnTouchListener { _, ev ->
            requestDisallowInterceptTouchEvent(true)
            // A new touch ends the hold a long press put on pull to reload (the selection is gone or being edited with handles).
            if (ev.actionMasked == MotionEvent.ACTION_DOWN) selectionHold = false
            noteTouch(ev.actionMasked)
            false
        }
        return w
    }

    private fun desktopUserAgent(ua: String): String =
        ua.replace(Regex("\\(Linux; Android[^)]*\\)"), "(X11; Linux x86_64)").replace(" Mobile", "")

    private fun applyUserAgent() {
        if (destroyed) return
        webView.settings.userAgentString = if (desktopMode) desktopUserAgent(defaultUserAgent) else defaultUserAgent
    }

    private fun tearDown(w: WebView) {
        try {
            w.stopLoading()
            w.removeJavascriptInterface(PageScan.BRIDGE_NAME)
            w.setWebChromeClient(null)
            w.webViewClient = WebViewClient()
            (w.parent as? ViewGroup)?.removeView(w)
            w.destroy()
        } catch (_: Throwable) {
            // Already gone.
        }
    }

    /** The renderer died: build a fresh WebView. It stays blank until the screen asks for a reload. */
    private fun recreateAfterCrash(dead: WebView) {
        if (destroyed || dead !== webView) return
        exitFullscreen()
        tearDown(dead)
        resetPageState()
        webView = createWebView()
        refresh.addView(webView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        endReload()
        loadedOnce = false
        redirectInFlight = false
        history.clear()
        pendingUserNav = false
        upgrade = null
        mainHandler.removeCallbacks(upgradeTimeout)
        failedHttpsPending.clear()
        fallbackHttpPending = null
        if (!active) webView.onPause()
        loading = false
        progress = 0
        onCrashed(emptyMap())
        emitPage()
    }

    // endregion

    // region Events

    private fun emitPage() {
        if (destroyed) return
        val w = webView
        val url = w.url ?: ""
        curUrl = url
        curTitle = w.title ?: ""
        // The reload ends once the page it started has been seen loading and has finished.
        if (reloadActive) {
            if (loading) {
                reloadSeenLoading = true
            } else if (reloadSeenLoading) {
                endReload()
            }
        }
        onPage(
            mapOf(
                "url" to url,
                "title" to curTitle,
                "canGoBack" to (customView != null || w.canGoBack()),
                "canGoForward" to w.canGoForward(),
                "loading" to loading,
                "progress" to progress,
                "secure" to (url.startsWith("https://", ignoreCase = true) && !sslFailed),
                "userAgent" to w.settings.userAgentString,
            ),
        )
    }

    private fun scheduleFlush() {
        if (destroyed) return
        if (!flushScheduled.compareAndSet(false, true)) return
        val wait = maxOf(0L, FLUSH_MS - (SystemClock.uptimeMillis() - lastFlush))
        mainHandler.postDelayed(flushRunnable, wait)
    }

    /** Sends new items and the blocked count. Runs on the main thread, at most once every [FLUSH_MS]. */
    private fun flush() {
        flushScheduled.set(false)
        lastFlush = SystemClock.uptimeMillis()
        if (destroyed) return
        val items = tracker.drain()
        if (items.isNotEmpty()) onFound(mapOf("items" to items.map { it.toMap() }))
        val p = blockedPage.get()
        val t = blockedTotal.get()
        if (p != lastSentPage || t != lastSentTotal) {
            lastSentPage = p
            lastSentTotal = t
            onBlockedCount(mapOf("page" to p, "total" to t))
        }
    }

    private fun refuse(url: String, reason: String) {
        onRefused(mapOf("url" to url, "reason" to reason))
    }

    // endregion

    // region Page state

    private fun newNonce(): String {
        val n = java.util.UUID.randomUUID().toString().replace("-", "")
        nonce = n
        return n
    }

    private fun resetPageState() {
        tracker.clear()
        blockedPage.set(0)
        hlsSeen = false
        sslFailed = false
        newNonce()
        lastSentPage = 0
        onBlockedCount(mapOf("page" to 0, "total" to blockedTotal.get()))
        lastSentTotal = blockedTotal.get()
    }

    private fun hostAllowsAds(host: String?): Boolean {
        if (host == null) return false
        val h = host.lowercase()
        return allowHosts.any { h == it || h.endsWith(".$it") }
    }

    private fun injectScripts(view: WebView) {
        // Main frame only: evaluateJavascript does not reach sub-frames.
        val n = nonce.ifEmpty { newNonce() }
        view.evaluateJavascript(PageScan.scanScript(n), null)
        if (mediaHitJs.isNotEmpty()) view.evaluateJavascript(mediaHitJs, null)
        if (adBlock && !hostAllowsAds(pageHost)) view.evaluateJavascript(PageScan.cosmeticScript, null)
    }

    private fun onScanReport(json: String) {
        // Runs on a WebView bridge thread. The report is untrusted: parse() checks nonce, size and fields.
        val report = PageScan.parse(json, nonce) ?: return
        var added = false
        for (e in report.entries) {
            val item = PageScan.toItem(e, curUrl, curTitle) ?: continue
            if (tracker.add(item)) added = true
        }
        if (added) scheduleFlush()
        if (report.eme) mainHandler.post { if (!destroyed) onPageNote(mapOf("note" to "drm")) }
        if (report.blob) mainHandler.post { if (!destroyed) onPageNote(mapOf("note" to "blob")) }
    }

    private fun onDownload(url: String?, userAgent: String?, disposition: String?, mime: String?, length: Long) {
        if (destroyed || url == null) return
        val norm = FoundClassifier.normalize(url) ?: return
        val cleanMime = mime?.takeIf { it.isNotBlank() && it != "application/octet-stream" }
        val name = URLUtil.guessFileName(norm, disposition, mime)
        val size = if (length > 0) length else null
        // A navigation that became a download never reaches onPageFinished.
        if (loading) {
            loading = false
            emitPage()
        }
        // A download counts as asked for when the user typed or tapped to get it. Otherwise it only joins the Files list.
        // The tap vouches for the same document for 30 s (and while its load is in flight).
        val tapped = DownloadRules.tapped(tapAge(), dlTapUses, pendingUserNav, vouchEpoch == docEpoch, loading)
        dlTapUses++
        pendingUserNav = false
        onDownloadRequest(
            mapOf(
                "tapped" to tapped,
                "url" to norm,
                "mime" to mime?.takeIf { it.isNotBlank() },
                "size" to size?.toDouble(),
                "name" to name,
                "userAgent" to (userAgent ?: webView.settings.userAgentString),
                "referer" to (webView.url ?: curUrl).ifEmpty { null },
            ),
        )
        val c = FoundClassifier.classifyPage(norm) ?: Classified(kindFromMime(cleanMime), FoundClassifier.extensionOf(norm), null, false)
        val item = FoundClassifier.item(norm, c, "download", curUrl, curTitle, mime = cleanMime, size = size)
        if (item != null && tracker.add(item)) scheduleFlush()
    }

    private fun kindFromMime(mime: String?): String = when {
        mime == null -> "other"
        mime.startsWith("video/") -> "video"
        mime.startsWith("audio/") -> "audio"
        mime.startsWith("image/") -> "image"
        mime == "application/pdf" || mime.startsWith("text/") -> "document"
        else -> "other"
    }

    // endregion

    // region Navigation rules

    private fun isTyped(uri: Uri): Boolean {
        val t = typedUrl ?: return false
        if (FoundClassifier.normalize(t) != null && FoundClassifier.normalize(t) == FoundClassifier.normalize(uri.toString())) return true
        // Moving around inside the site the user typed (a NAS login page, a router menu) stays allowed.
        val th = typedHost ?: return false
        return uri.host?.equals(th, ignoreCase = true) == true
    }

    /** The refusal reason for a main-frame navigation to [uri], or null when it may load. */
    private fun mainFrameRefusal(uri: Uri): String? {
        val scheme = uri.scheme?.lowercase()
        if (scheme == "about") return if (uri.toString() == "about:blank") null else "scheme"
        if (scheme != "http" && scheme != "https") return "scheme"
        if (isTyped(uri)) return null
        val host = uri.host
        if (adBlock && !hostAllowsAds(host) && BlocklistStore.peek().matches(host)) return "popup"
        if (LocalHost.isLanHost(host)) return "local"
        return null
    }

    /** Remembers when the user last tapped, so a pop-up or a jump to another site can be told from a tap on a real link. */
    private fun noteTouch(action: Int) {
        if (action == android.view.MotionEvent.ACTION_DOWN) {
            tapUses = 0
            entryTapUses = 0
            dlTapUses = 0
            tapAt = 0L
        } else if (action == android.view.MotionEvent.ACTION_UP) {
            tapAt = SystemClock.uptimeMillis()
            vouchEpoch = docEpoch // the tap vouches for this document
            activation.arm() // counts as user activation for Back history
        }
    }

    /** A key press reached the page (hardware key or IME). Enter and D-pad centre are user activation and count as input for the 1 s gesture rule for main-frame jumps. */
    private fun noteKey(keyCode: Int) {
        keyAt = SystemClock.uptimeMillis()
        if (ActivationLatch.isActivationKey(keyCode)) {
            activation.arm() // counts as user activation for Back history
            vouchEpoch = docEpoch // the tap vouches for this document
            tapUses = 0 // a new key press is a new input for the 1 s gesture rule for main-frame jumps
        }
    }

    /** Milliseconds since the last touch ended or key was pressed, whichever is newer; null when neither happened. */
    private fun inputAge(): Long? {
        val t = tapAge()
        val k = if (keyAt == 0L) null else SystemClock.uptimeMillis() - keyAt
        return if (t == null) k else if (k == null) t else minOf(t, k)
    }

    /** Milliseconds since the last tap ended, or null when there was none (or a touch is still down). */
    private fun tapAge(): Long? = if (tapAt == 0L) null else SystemClock.uptimeMillis() - tapAt

    private fun recentTap(): Boolean = tapAge()?.let { it in 0..PopupRules.TAP_MS } == true

    /** Writes the history entry WebView just made, with whether the user made it. */
    private fun recordHistory(url: String) {
        val index = webView.copyBackForwardList().currentIndex
        val key = HttpsFirst.historyKey(url)
        if (key in failedHttpsPending) {
            // The failed https try's error page: never a Back stop, and it must not use up the user's navigation,
            // which belongs to the http page loading next.
            failedHttpsPending.remove(key)
            history.visited(url, index, false)
            history.skipIfUrl(url)
            return
        }
        if (fallbackHttpPending == key) {
            fallbackHttpPending = null
            failedHttpsPending.clear()
        }
        // User-made when any user activation happened since the previous entry, not only within 3 s.
        val activated = activation.take()
        val userMade = pendingUserNav || activated
        pendingUserNav = false
        history.visited(url, index, userMade)
    }

    /**
     * The try is done only when an https page on one of its hosts shows. A late callback for the previous http page
     * says nothing about the try and must leave it (and its timer) alone.
     */
    private fun endTryIfCommitted(url: String?) {
        val up = upgrade ?: return
        if (url != null && url.startsWith("https://", ignoreCase = true) && up.owns(url)) cancelUpgrade()
    }

    /** Cancels any pending https-first upgrade and its timeout. */
    private fun cancelUpgrade() {
        upgrade = null
        mainHandler.removeCallbacks(upgradeTimeout)
    }

    /**
     * The https try failed (error, certificate, timeout or a redirect loop): load the original http address and, when
     * the device is online, never upgrade that host again this session. An offline failure says nothing about the
     * site, so the host is not remembered. The posted loadUrl does not go through shouldOverrideUrlLoading or
     * startLoad, so this http load is not upgraded a second time and cannot loop.
     */
    private fun fallBackToHttp(failedUrl: String? = null) {
        val up = upgrade ?: return
        cancelUpgrade()
        if (isOnline()) fallbackHostsInUse().add(up.host)
        // The failed https page (the first try or a redirect hop) must not be a Back stop, and the http load is still
        // the user's request.
        for (u in setOfNotNull(up.httpsUrl, up.lastHttps, failedUrl)) {
            history.skipIfUrl(u)
            failedHttpsPending.add(HttpsFirst.historyKey(u))
        }
        fallbackHttpPending = HttpsFirst.historyKey(up.httpUrl)
        pendingUserNav = true
        mainHandler.post { if (!destroyed) webView.loadUrl(up.httpUrl) }
    }

    /** Starts the clock for the https try in [upgrade] (none when there is no try). Redirect hops do not restart it. */
    private fun armUpgradeTimeout() {
        mainHandler.removeCallbacks(upgradeTimeout)
        if (upgrade != null) mainHandler.postDelayed(upgradeTimeout, HttpsFirst.TRY_MS)
    }

    private fun onUpgradeTimeout() {
        if (destroyed || upgrade == null) return
        fallBackToHttp()
    }

    /**
     * True when the device has a validated internet connection. ConnectivityManager.getNetworkCapabilities needs
     * ACCESS_NETWORK_STATE, which the manifest declares.
     * https://developer.android.com/reference/android/net/ConnectivityManager#getNetworkCapabilities(android.net.Network)
     */
    private fun isOnline(): Boolean = try {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    } catch (_: Exception) {
        true
    }

    /** True when the last tap ended recently on a link that leads to [host]'s site ("*": an image link, address unknown). */
    private fun tappedLinkTo(host: String?): Boolean {
        if (tapAt == 0L || SystemClock.uptimeMillis() - tapAt > PopupRules.TAP_MS) return false
        val hit = webView.hitTestResult
        val linkHost = when (hit.type) {
            WebView.HitTestResult.SRC_ANCHOR_TYPE -> hit.extra?.let { Uri.parse(it).host?.lowercase() }
            WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE -> "*"
            else -> null
        }
        return PopupRules.tapMatchesLink(linkHost, host)
    }

    /** Tap trust for a window or a jump to [host]; counts it so a second one from the same tap is not trusted. */
    private fun trustTap(gesture: Boolean, host: String?, jump: Boolean = false): Boolean {
        // A main-frame jump with a gesture within 1 s of a touch or key press is trusted off-link too.
        val ok = PopupRules.trusted(gesture, RegistrableHost.same(host, currentHost()), tappedLinkTo(host), tapUses) ||
            (jump && NavRules.trustedJump(gesture, tapUses, inputAge()))
        if (gesture) tapUses++
        return ok
    }

    private fun currentHost(): String? = webView.url?.let { Uri.parse(it).host } ?: pageHost

    private fun hostAllowsPopups(host: String?): Boolean = PopupRules.hostListed(host, popupAllowHosts)

    private fun hostBlocksPopups(host: String?): Boolean = PopupRules.hostListed(host, popupBlockHosts)

    /** T4 for the page now showing. [gesture] is the trusted-tap flag (see trustTap). */
    private fun decide(gesture: Boolean, kind: String): String {
        val page = currentHost() ?: pageHost
        return PopupRules.decide(popupPolicy, hostAllowsPopups(page), hostBlocksPopups(page), gesture, kind)
    }

    private fun sourceUrl(): String = webView.url ?: curUrl

    /** onPopupBlocked {url, kind, sourceUrl}: sourceUrl is the page that tried to open the target. */
    private fun emitBlocked(url: String, kind: String) {
        onPopupBlocked(mapOf("url" to url, "kind" to kind, "sourceUrl" to sourceUrl()))
    }

    private fun emitRequest(url: String, kind: String) {
        onPopupRequest(mapOf("url" to url, "kind" to kind, "sourceUrl" to sourceUrl()))
    }

    /** True for a scheme that hands the URL to another app, as opposed to web, magnet and the always-refused ones. */
    private fun isAppScheme(scheme: String?): Boolean =
        scheme != null && scheme != "http" && scheme != "https" && scheme != "about" && scheme != "magnet" &&
            scheme !in DANGEROUS_SCHEMES

    /** A main-frame navigation to another app's scheme. */
    private fun handleAppNavigation(url: String, gesture: Boolean) {
        when (decide(gesture, "app")) {
            PopupRules.OPEN -> {
                val r = startApp(url)
                // Same as the card's Open: an app that isn't there falls back to the page the link offers.
                val fb = r.second
                if (!r.first && fb != null && mainFrameRefusal(Uri.parse(fb)) == null) {
                    followAllowUrl = fb
                    webView.loadUrl(fb)
                }
            }
            PopupRules.ASK -> emitRequest(url, "app")
            else -> emitBlocked(url, "app")
        }
    }

    /** A new window the page asked for. Main thread. */
    private fun handleNewWindow(raw: String, gesture: Boolean) {
        val url = raw.trim()
        if (url.isEmpty() || url.equals("about:blank", ignoreCase = true)) return
        val reason = mainFrameRefusal(Uri.parse(url))
        if (reason != null) {
            refuse(url, reason)
            return
        }
        // A tap only opens a window freely when it was on a link to that site (or the site is the page's own), and only
        // the first window of a tap. Overlay taps and a burst of windows from one tap follow the pop-up setting instead.
        if (trustTap(gesture, Uri.parse(url).host)) {
            onNewWindow(mapOf("url" to url, "gesture" to true))
            return
        }
        when (decide(false, "window")) {
            PopupRules.OPEN -> onNewWindow(mapOf("url" to url, "gesture" to false))
            PopupRules.ASK -> emitRequest(url, "window")
            else -> emitBlocked(url, "window")
        }
    }

    /** Long press on a link or image. Returns true only when it emits, which suppresses the system menu. */
    private fun onLongPressed(w: WebView): Boolean {
        if (destroyed || !active || w !== webView) return false
        val hit = w.hitTestResult
        val extra = hit.extra
        when (hit.type) {
            WebView.HitTestResult.SRC_ANCHOR_TYPE -> {
                if (!isLongPressUrl(extra, allowMagnet = true)) return false
                requestLinkDetails(w, "link", extra, null)
                return true
            }
            WebView.HitTestResult.IMAGE_TYPE -> {
                if (!isLongPressUrl(extra, allowMagnet = false)) return false
                emitLongPress("image", null, extra, null)
                return true
            }
            WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE -> {
                if (!isLongPressUrl(extra, allowMagnet = false)) return false
                requestLinkDetails(w, "imageLink", null, extra)
                return true
            }
            else -> {
                // Usually UNKNOWN_TYPE over a <video>. The listener must answer now, so it answers false (a text
                // selection starts as usual) and asks the page script, which cached the hit on touch start. The page
                // script also cancels its own contextmenu event on a hit, so no system menu opens over the video.
                selectionHold = true
                askMediaHit(w)
                return false
            }
        }
    }

    /** Calls window.__maglevMediaHit() and emits onMediaHit when it returns a maglev-media-hit payload. */
    private fun askMediaHit(w: WebView) {
        w.evaluateJavascript("window.__maglevMediaHit && window.__maglevMediaHit()") { value ->
            if (destroyed || w !== webView || value.isNullOrEmpty() || value == "null") return@evaluateJavascript
            try {
                // The callback value is a JSON string literal: decode it once to get the payload text.
                val payload = JSONTokener(value).nextValue() as? String ?: return@evaluateJavascript
                if (payload.isEmpty() || payload.length > MAX_MEDIA_HIT_CHARS) return@evaluateJavascript
                if (JSONObject(payload).optString("type") != "maglev-media-hit") return@evaluateJavascript
                selectionHold = false
                onMediaHit(mapOf("json" to payload))
            } catch (_: Throwable) {
                // Not a payload: nothing to show.
            }
        }
    }

    private fun isLongPressUrl(u: String?, allowMagnet: Boolean): Boolean {
        if (u.isNullOrBlank()) return false
        val s = Uri.parse(u).scheme?.lowercase()
        return s == "http" || s == "https" || (allowMagnet && s == "magnet")
    }

    /**
     * Asks the WebView for the focused link's url and title (requestFocusNodeHref, "url" key). Emits once: from the
     * answer, or after 400 ms from what the hit test already gave.
     */
    private fun requestLinkDetails(w: WebView, kind: String, fallbackUrl: String?, imageUrl: String?) {
        val emitted = AtomicBoolean(false)
        fun emit(url: String?, title: String?, src: String?) {
            if (!emitted.compareAndSet(false, true) || destroyed) return
            val href = url?.takeIf { isLongPressUrl(it, allowMagnet = true) } ?: fallbackUrl?.takeIf { isLongPressUrl(it, allowMagnet = true) }
            val image = imageUrl ?: src?.takeIf { isLongPressUrl(it, allowMagnet = false) }
            val text = title?.trim()?.takeIf { it.isNotEmpty() }
            when {
                kind == "imageLink" && href == null -> if (image != null) emitLongPress("image", null, image, null)
                kind == "imageLink" -> emitLongPress("imageLink", href, image, text)
                href != null -> emitLongPress("link", href, null, text)
            }
        }
        val reply = Handler(Looper.getMainLooper()) { m ->
            val data = m.data
            emit(data?.getString("url"), data?.getString("title"), data?.getString("src"))
            true
        }
        mainHandler.postDelayed({ emit(null, null, null) }, 400L)
        w.requestFocusNodeHref(reply.obtainMessage())
    }

    private fun emitLongPress(kind: String, url: String?, imageUrl: String?, text: String?) {
        onLongPress(mapOf("kind" to kind, "url" to url, "imageUrl" to imageUrl, "text" to text))
    }

    // endregion

    // region Clients

    private fun browserClient() = object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            // Background thread. Touches only thread-safe state.
            if (destroyed) return null
            val uri = request.url ?: return null
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null
            val host = uri.host
            val page = pageHost
            if (adBlock && !request.isForMainFrame && host != null && !hostAllowsAds(page) &&
                !host.equals(page, ignoreCase = true) && BlocklistStore.matcher().matches(host)
            ) {
                blockedPage.incrementAndGet()
                blockedTotal.incrementAndGet()
                scheduleFlush()
                return emptyResponse()
            }
            // The miner list is its own check, whatever the ad-block setting or the site's ad allowance.
            if (!request.isForMainFrame && host != null && !host.equals(page, ignoreCase = true) && BlocklistStore.minerMatcher().matches(host)) {
                blockedPage.incrementAndGet()
                blockedTotal.incrementAndGet()
                scheduleFlush()
                return emptyResponse()
            }
            noteNetwork(uri.toString(), request.requestHeaders)
            return null
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val uri = request.url ?: return true
            val scheme = uri.scheme?.lowercase()
            if (scheme == "magnet") {
                if (request.hasGesture()) onMagnet(mapOf("uri" to uri.toString())) else refuse(uri.toString(), "scheme")
                return true
            }
            if (!request.isForMainFrame) {
                // Sub-frames: only web pages load; anything else is refused, but never reported as a refusal of the page.
                return scheme != "http" && scheme != "https" && uri.toString() != "about:blank"
            }
            redirectInFlight = request.isRedirect
            // A link the user tapped (or a navigation with a gesture) is theirs; a script's jump is not.
            if (!request.isRedirect) {
                pendingUserNav = request.hasGesture() || (recentTap() && entryTapUses++ == 0)
                if (pendingUserNav) vouchCarry = true // the new document inherits the tap vouch
            }
            if (isAppScheme(scheme)) {
                redirectInFlight = false
                handleAppNavigation(uri.toString(), request.hasGesture())
                return true
            }
            val reason = mainFrameRefusal(uri)
            if (reason != null) {
                redirectInFlight = false
                refuse(uri.toString(), reason)
                return true
            }
            // Held redirect: untapped, not a server redirect, after the document finished once, to another site.
            val allowedOnce = followAllowUrl != null && followAllowUrl == uri.toString()
            if (allowedOnce) followAllowUrl = null
            // Also held: a tap that is not on a link to that site (an invisible overlay, an onclick on a blank area).
            val held = !allowedOnce && scheme != "about" && !request.isRedirect && loadedOnce &&
                !RegistrableHost.same(uri.host, currentHost()) && !trustTap(request.hasGesture(), uri.host, jump = true)
            if (held) {
                when (decide(false, "redirect")) {
                    PopupRules.OPEN -> {
                        // The page goes elsewhere, so a pending https try is replaced and its timer must not fire.
                        cancelUpgrade()
                        return false
                    }
                    PopupRules.ASK -> emitRequest(uri.toString(), "redirect")
                    else -> emitBlocked(uri.toString(), "redirect")
                }
                redirectInFlight = false
                return true
            }
            // Like Chrome's HTTPS-Upgrades: a redirect hop stays inside the pending try; any other new navigation replaces it.
            val pending = upgrade
            val url = uri.toString()
            if (scheme == "http") {
                if (request.isRedirect && pending != null) {
                    if (pending.hosts.any { HttpsFirst.isLoop(it, url) } || url in pending.seen) {
                        // https sent us back to http, or the same http address came round again: give up on https.
                        fallBackToHttp()
                        return true
                    }
                    val https = httpsTryFor(url, request.method ?: "GET")
                    val host = HttpsFirst.hostOf(https)
                    if (https != null && host != null) {
                        // The hop joins the same try; its timer keeps running and a fallback still loads the original address.
                        pending.seen.add(url)
                        pending.hosts.add(HttpsFirst.bareHost(host))
                        pending.lastHttps = https
                        redirectInFlight = false
                        mainHandler.post { if (!destroyed) webView.loadUrl(https) }
                        return true
                    }
                    // A hop that can't be upgraded (excluded host) loads as http; the try ends because the page went elsewhere.
                    cancelUpgrade()
                    return false
                }
                // Only GET is ever upgraded. A new http navigation starts its own try and replaces any pending one.
                val https = httpsTryFor(url, request.method ?: "GET")
                val host = HttpsFirst.hostOf(https)
                if (https != null && host != null) {
                    upgrade = HttpsTry(host, https, url)
                    armUpgradeTimeout()
                    redirectInFlight = false
                    mainHandler.post { if (!destroyed) webView.loadUrl(https) }
                    return true
                }
            }
            if (pending != null) {
                // An https hop inside the try keeps it (its failure or commit is recognised); anything else replaces it.
                if (request.isRedirect && scheme == "https") HttpsFirst.hostOf(url)?.let { pending.hosts.add(HttpsFirst.bareHost(it)) }
                else cancelUpgrade()
            }
            return false
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            val pending = upgrade ?: return
            // Like Chrome, any main-frame failure of the try falls back, whatever the error code (an empty reply
            // arrives as ERROR_UNKNOWN). An http error status never gets here: the server answered.
            if (request.isForMainFrame && pending.owns(request.url?.toString())) fallBackToHttp(request.url?.toString())
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (destroyed) return
            pageHost = url?.let { Uri.parse(it).host?.lowercase() }
            docUrl = url
            // A new top-level load starts a new document; a server redirect hop continues the current load.
            if (!redirectInFlight) loadedOnce = false
            if (!redirectInFlight) {
                docEpoch++
                // A navigation the tap started carries the vouch to the new document.
                if (vouchCarry) vouchEpoch = docEpoch
                vouchCarry = false
            }
            redirectInFlight = false
            followAllowUrl = null
            mainHandler.removeCallbacks(scanRunnable)
            scanAfterLoad = false
            resetPageState()
            loading = true
            progress = 0
            emitPage()
            injectScripts(view)
        }

        override fun onPageCommitVisible(view: WebView, url: String?) {
            if (destroyed) return
            endTryIfCommitted(url)
            injectScripts(view)
            emitPage()
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (destroyed) return
            loading = false
            progress = 100
            loadedOnce = true
            endTryIfCommitted(url)
            if (!firstLoadDone) {
                firstLoadDone = true
                if (!active && pausePending) pauseNow()
            }
            injectScripts(view)
            if (scanAfterLoad) {
                scanAfterLoad = false
                scan()
            }
            emitPage()
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            if (destroyed) return
            if (url != null && !isReload) recordHistory(url)
            pageHost = url?.let { Uri.parse(it).host?.lowercase() } ?: pageHost
            // PushState/replaceState to another document URL never fires onPageStarted. Treat it as a new
            // document. A fragment-only change, a reload, or a URL we have already seen does nothing here.
            val prev = docUrl
            // While a load is in flight this is a server redirect or the load committing, not an SPA navigation:
            // remember the final URL but keep what the load has found so far.
            if (loading && url != null) {
                docUrl = url
                emitPage()
                return
            }
            if (!isReload && url != null && prev != null && !sameDocument(prev, url)) {
                docUrl = url
                mainHandler.removeCallbacks(scanRunnable)
                resetPageState()
                emitPage()
                mainHandler.postDelayed(scanRunnable, 600L)
                return
            }
            if (!isReload && url != null && prev == null) docUrl = url
            emitPage()
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            // A certificate problem on the https try is not shown as a refusal; the http address loads instead.
            if (upgrade?.owns(error.url) == true) {
                fallBackToHttp(error.url)
                return
            }
            sslFailed = true
            refuse(error.url ?: view.url ?: "", "ssl")
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            mainHandler.post { recreateAfterCrash(view) }
            return true
        }
    }

    private fun chromeClient() = object : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            if (destroyed) return
            progress = newProgress
            loading = newProgress < 100
            emitPage()
        }

        override fun onReceivedTitle(view: WebView, title: String?) {
            if (!destroyed) emitPage()
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            showFullscreen(view, callback)
        }

        override fun onHideCustomView() {
            exitFullscreen()
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
            if (destroyed) return false
            // At most MAX_CAPTURES at once. Returning false without sending resultMsg is valid
            // (WebChromeClient.onCreateWindow: "Otherwise, return false"; window.open then returns null).
            if (captures.size >= MAX_CAPTURES) {
                // The address is not known yet, so this only counts the blocked pop-up.
                emitBlocked("", "window")
                return false
            }
            val capture = WebView(view.context)
            capture.settings.javaScriptEnabled = false
            captures.add(capture)
            val handled = AtomicBoolean(false)
            fun handle(url: String) {
                if (!handled.compareAndSet(false, true)) return
                mainHandler.post {
                    destroyCapture(capture)
                    if (!destroyed) handleNewWindow(url, isUserGesture)
                }
            }
            // A capture that never reports a target is destroyed after CAPTURE_TIMEOUT_MS.
            mainHandler.postDelayed({
                handled.set(true)
                destroyCapture(capture)
            }, CAPTURE_TIMEOUT_MS)
            capture.webViewClient = object : WebViewClient() {
                // The capture view never loads anything: every request is answered empty.
                override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? {
                    if (r.isForMainFrame) handle(r.url.toString())
                    return emptyResponse()
                }

                override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                    handle(r.url.toString())
                    return true
                }

                override fun onPageStarted(v: WebView, url: String?, favicon: Bitmap?) {
                    if (url != null) handle(url)
                }
            }
            transport.webView = capture
            resultMsg.sendToTarget()
            return true
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            request.deny()
            mainHandler.post { if (!destroyed) refuse(request.origin?.toString() ?: "", "permission") }
        }

        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
            callback.invoke(origin, false, false)
            refuse(origin, "permission")
        }

        // JS dialogs are suppressed: alert, confirm and prompt cancel; leaving a page is allowed.
        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            result.cancel()
            return true
        }

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            result.cancel()
            return true
        }

        override fun onJsPrompt(view: WebView, url: String?, message: String?, defaultValue: String?, result: JsPromptResult): Boolean {
            result.cancel()
            return true
        }

        override fun onJsBeforeUnload(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            result.confirm()
            return true
        }

        // No file upload chooser.
        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            filePathCallback.onReceiveValue(null)
            return true
        }
    }

    private fun emptyResponse() =
        WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    /** A sub-resource or main request the page made. Background thread. */
    private fun noteNetwork(url: String, headers: Map<String, String>?) {
        var accept: String? = null
        var hasRange = false
        if (headers != null) {
            for ((k, v) in headers) {
                if (k.equals("Accept", ignoreCase = true)) accept = v
                if (k.equals("Range", ignoreCase = true)) hasRange = true
            }
        }
        val c = FoundClassifier.classifyNetwork(url, accept, hasRange, hlsSeen) ?: return
        if (c.stream == "hls") hlsSeen = true
        val item = FoundClassifier.item(url, c, "network", curUrl, curTitle) ?: return
        if (tracker.add(item)) scheduleFlush()
    }

    // endregion

    // region Fullscreen video

    private fun showFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (destroyed || customView != null) {
            callback.onCustomViewHidden()
            return
        }
        customView = view
        customViewCallback = callback
        view.setBackgroundColor(Color.BLACK)
        val activity = appContext.currentActivity
        if (activity != null) {
            // Over the whole screen, system bars hidden; landscape allowed while it lasts.
            val decor = activity.window.decorView as ViewGroup
            decor.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            customViewHost = decor
            previousOrientation = activity.requestedOrientation
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
            val controller = WindowCompat.getInsetsController(activity.window, decor)
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            addView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            customViewHost = this
        }
        emitPage()
    }

    private fun exitFullscreen() {
        val view = customView ?: return
        val host = customViewHost
        val callback = customViewCallback
        customView = null
        customViewCallback = null
        customViewHost = null
        host?.removeView(view)
        val activity = appContext.currentActivity
        if (activity != null && host != null && host !== this) {
            activity.requestedOrientation = previousOrientation
            WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                .show(WindowInsetsCompat.Type.systemBars())
        }
        try {
            callback?.onCustomViewHidden()
        } catch (_: Throwable) {
        }
        emitPage()
    }

    // endregion

    companion object {
        /** Found items and the blocked count go out at most this often. */
        const val FLUSH_MS = 250L

        /** Never handed to another app by openApp; web pages and about: are not "apps" either. */
        private val DANGEROUS_SCHEMES = setOf("file", "content", "javascript", "data", "blob")
        private val NEVER_START_SCHEMES = DANGEROUS_SCHEMES + setOf("http", "https", "about")

        /** Hosts whose https try failed this app session while online. They are not upgraded again. */
        private val httpsFallbackHosts: MutableSet<String> =
            java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())

        private const val PULL_SAFETY_MS = 15_000L
        /** SwipeRefreshLayout's trigger distance. */
        private const val PULL_TRIGGER_DP = 72f
        private const val DEFAULT_REFRESH_DISC = 0xFF161B22.toInt()
        private const val DEFAULT_REFRESH_ARC = 0xFFCCFF00.toInt()
        private const val MAX_MEDIA_HIT_CHARS = 20_000

        private const val MAX_CAPTURES = 3
        private const val CAPTURE_TIMEOUT_MS = 3000L
        private const val FIRST_LOAD_PAUSE_MS = 10_000L
        private const val PAUSE_MEDIA_JS = "document.querySelectorAll('video,audio').forEach(function(m){m.pause()})"
    }
}
