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
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.SystemClock
import android.view.View
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
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayInputStream
import java.net.URISyntaxException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * The in-app browser view (docs/NATIVE_CONTRACT.md section 24): an ExpoView that hosts one android.webkit.WebView,
 * blocks ad hosts in `shouldInterceptRequest`, lists the media and files the page loads, and refuses what
 * section 24.5 refuses. One page at a time; the WebView lives only while the view is mounted.
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
    private val onFindResult by EventDispatcher<Map<String, Any?>>()

    override val shouldUseAndroidLayout: Boolean = true

    private val mainHandler = Handler(Looper.getMainLooper())
    private val tracker = FoundTracker()
    private val blockedPage = AtomicInteger(0)
    private val blockedTotal = AtomicInteger(0)
    private val flushScheduled = AtomicBoolean(false)
    private val flushRunnable = Runnable { flush() }
    // Delayed page scan after a same-document navigation (24.6a). Main thread only.
    private val scanRunnable = Runnable { if (!destroyed) scan() }
    // resetFound() arrived while the page was loading: scan once the load ends (24.6a).
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
    private var pendingUrl: String? = null
    private var requestedUrl: String? = null

    // 24.10. Main thread only.
    private var active = true
    private var popupPolicy = "ask"
    private var popupAllowHosts: List<String> = emptyList()
    // The current document has finished loading at least once. Redirects during its first load are part of the page.
    private var loadedOnce = false
    // Section 30: a view mounted hidden finishes its first load before it is paused (a paused WebView may not load).
    private var firstLoadDone = false
    private var pausePending = false
    // Section 30: pop-up capture WebViews that exist right now. Main thread only.
    private val captures = HashSet<WebView>()
    // The last main-frame navigation was a server redirect: it continues the load, so it does not start a new document.
    private var redirectInFlight = false
    // One-shot allowance for the exact URL followRedirect loads, so the redirect rule does not hold it again.
    private var followAllowUrl: String? = null

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

    // Fullscreen video.
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var customViewHost: ViewGroup? = null
    private var previousOrientation: Int = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED

    private val bridge = PageScanBridge { json -> onScanReport(json) }

    init {
        BlocklistStore.warm(context)
        webView = createWebView()
        addView(webView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    // region Props and commands (called on the main thread)

    fun setUrl(url: String) {
        if (url == requestedUrl) return
        requestedUrl = url
        pendingUrl = url
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

    /** 28: highlight matches of [query] in the page. An empty query clears them. Results come as onFindResult. */
    fun findInPage(query: String, promise: Promise) {
        if (destroyed) {
            promise.reject("VIEW_GONE", "The browser was closed.", null)
            return
        }
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
        popupAllowHosts = hosts.map { it.trim().lowercase().trimStart('.') }.filter { it.isNotEmpty() }
    }

    /** Called after all props of an update are set. Loads the url prop when it changed. */
    fun applyProps() {
        val u = pendingUrl ?: return
        pendingUrl = null
        loadTyped(u)
    }

    fun goBack() {
        if (destroyed) return
        // Back leaves fullscreen first (onPage.canGoBack is true while a video is fullscreen).
        if (customView != null) {
            exitFullscreen()
            return
        }
        if (webView.canGoBack()) webView.goBack()
    }

    fun goForward() {
        if (!destroyed && webView.canGoForward()) webView.goForward()
    }

    fun reload() {
        if (destroyed) return
        if (webView.url != null) webView.reload() else requestedUrl?.let { loadTyped(it) }
    }

    fun stop() {
        if (destroyed) return
        webView.stopLoading()
        // stopLoading does not always end with onPageFinished; the bar must not stay on Stop.
        loading = false
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
        // A new typed load: its own script redirects are part of the page until it has finished once.
        loadedOnce = false
        redirectInFlight = false
        webView.loadUrl(url)
    }

    /**
     * 24.10: loads a held redirect the user said yes to. Not typed, so the 24.5 refusals (scheme, blocked host, LAN)
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
            followAllowUrl = url
            webView.loadUrl(url)
        }
        promise.resolve(null)
    }

    /**
     * 24.10: opens an intent:, market:, tel:, mailto: or custom-scheme URL in another app. Only called after the user
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
                // Section 30: never aim a page's intent at Maglev itself.
                if (intent.`package` == context.packageName) return Pair(false, fallback)
                val dataScheme = intent.data?.scheme?.lowercase()
                if (dataScheme != null && (dataScheme in DANGEROUS_SCHEMES || dataScheme == "maglev")) return Pair(false, fallback)
            } else {
                intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                intent.addCategory(Intent.CATEGORY_BROWSABLE)
            }
            // Section 30: the page chose the flags. Clear them all (every FLAG_GRANT_*, CLEAR_TASK...) and keep only NEW_TASK.
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
        webView.evaluateJavascript(PageScan.RESCAN_JS, null)
    }

    /**
     * 24.6a: forget what this document reported and scan again. Idempotent. A page still loading is scanned
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
        destroyed = true
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
        val w = WebView(context)
        w.setBackgroundColor(Color.BLACK)
        val s = w.settings
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.setSupportMultipleWindows(true)
        // 24.10: untapped window.open must reach onCreateWindow so the view can decide (ask, block or allow).
        s.javaScriptCanOpenWindowsAutomatically = true
        s.mediaPlaybackRequiresUserGesture = true
        s.setSupportZoom(true)
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.textZoom = textZoom
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
        cookies.setAcceptThirdPartyCookies(w, false)

        w.addJavascriptInterface(bridge, PageScan.BRIDGE_NAME)
        w.webViewClient = browserClient()
        w.webChromeClient = chromeClient()
        w.setDownloadListener { url, userAgent, contentDisposition, mimeType, contentLength ->
            onDownload(url, userAgent, contentDisposition, mimeType, contentLength)
        }
        // 24.10: long press on a link or image opens the screen's menu instead of the system one.
        w.setOnLongClickListener { v -> onLongPressed(v as WebView) }
        // Let the page scroll inside React Native parents.
        w.setOnTouchListener { _, _ ->
            requestDisallowInterceptTouchEvent(true)
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
        addView(webView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        loadedOnce = false
        redirectInFlight = false
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
        onDownloadRequest(
            mapOf(
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

    // region Navigation rules (section 24.5)

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

    private fun currentHost(): String? = webView.url?.let { Uri.parse(it).host } ?: pageHost

    private fun hostAllowsPopups(host: String?): Boolean {
        if (host == null) return false
        val h = host.lowercase()
        return popupAllowHosts.any { h == it || h.endsWith(".$it") }
    }

    private fun decide(gesture: Boolean, kind: String): String =
        PopupRules.decide(popupPolicy, hostAllowsPopups(currentHost() ?: pageHost), gesture, kind)

    private fun sourceUrl(): String = webView.url ?: curUrl

    private fun emitBlocked(url: String, kind: String) {
        onPopupBlocked(mapOf("url" to url, "kind" to kind))
    }

    private fun emitRequest(url: String, kind: String) {
        onPopupRequest(mapOf("url" to url, "kind" to kind, "sourceUrl" to sourceUrl()))
    }

    /** True for a scheme that hands the URL to another app (24.10), as opposed to web, magnet and the always-refused ones. */
    private fun isAppScheme(scheme: String?): Boolean =
        scheme != null && scheme != "http" && scheme != "https" && scheme != "about" && scheme != "magnet" &&
            scheme !in DANGEROUS_SCHEMES

    /** A main-frame navigation to another app's scheme (24.10 "Other apps"). */
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

    /** A new window the page asked for (24.10 onCreateWindow rules). Main thread. */
    private fun handleNewWindow(raw: String, gesture: Boolean) {
        val url = raw.trim()
        if (url.isEmpty() || url.equals("about:blank", ignoreCase = true)) return
        val reason = mainFrameRefusal(Uri.parse(url))
        if (reason != null) {
            refuse(url, reason)
            return
        }
        if (gesture) {
            onNewWindow(mapOf("url" to url, "gesture" to true))
            return
        }
        when (decide(false, "window")) {
            PopupRules.OPEN -> onNewWindow(mapOf("url" to url, "gesture" to false))
            PopupRules.ASK -> emitRequest(url, "window")
            else -> emitBlocked(url, "window")
        }
    }

    /** Long press on a link or image (24.10). Returns true only when it emits, which suppresses the system menu. */
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
            else -> return false
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
            // 24.10 held redirect: untapped, not a server redirect, after the document finished once, to another site.
            val allowedOnce = followAllowUrl != null && followAllowUrl == uri.toString()
            if (allowedOnce) followAllowUrl = null
            val held = !allowedOnce && scheme != "about" && !request.hasGesture() && !request.isRedirect && loadedOnce &&
                !RegistrableHost.same(uri.host, currentHost())
            if (held) {
                when (decide(false, "redirect")) {
                    PopupRules.OPEN -> return false
                    PopupRules.ASK -> emitRequest(uri.toString(), "redirect")
                    else -> emitBlocked(uri.toString(), "redirect")
                }
                redirectInFlight = false
                return true
            }
            return false
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (destroyed) return
            pageHost = url?.let { Uri.parse(it).host?.lowercase() }
            docUrl = url
            // A new top-level load starts a new document; a server redirect hop continues the current load.
            if (!redirectInFlight) loadedOnce = false
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
            injectScripts(view)
            emitPage()
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (destroyed) return
            loading = false
            progress = 100
            loadedOnce = true
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
            pageHost = url?.let { Uri.parse(it).host?.lowercase() } ?: pageHost
            // 24.6a: pushState/replaceState to another document URL never fires onPageStarted. Treat it as a new
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
            // Section 30: at most MAX_CAPTURES at once. Returning false without sending resultMsg is valid
            // (WebChromeClient.onCreateWindow: "Otherwise, return false"; window.open then returns null).
            if (captures.size >= MAX_CAPTURES) {
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
            // Section 30: a capture that never reports a target is destroyed after CAPTURE_TIMEOUT_MS.
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

    /** A sub-resource or main request the page made (section 24.3 rule 1). Background thread. */
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
        /** Found items and the blocked count go out at most this often (docs/NATIVE_CONTRACT.md section 24.2). */
        const val FLUSH_MS = 250L

        /** Never handed to another app by openApp (24.10); web pages and about: are not "apps" either. */
        private val DANGEROUS_SCHEMES = setOf("file", "content", "javascript", "data", "blob")
        private val NEVER_START_SCHEMES = DANGEROUS_SCHEMES + setOf("http", "https", "about")

        private const val MAX_CAPTURES = 3
        private const val CAPTURE_TIMEOUT_MS = 3000L
        private const val FIRST_LOAD_PAUSE_MS = 10_000L
        private const val PAUSE_MEDIA_JS = "document.querySelectorAll('video,audio').forEach(function(m){m.pause()})"
    }
}
