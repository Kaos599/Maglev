package com.maglev.engine.browser

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView

/** Clears what the browser keeps: cookies, cache, web storage and history (docs/NATIVE_CONTRACT.md section 24.5). */
object BrowserData {
    /**
     * Runs on the main thread (WebView APIs require it) and calls [done] when finished. [view] is the live WebView
     * when the browser screen is open; otherwise a short-lived one clears the shared cache. Cookies are app-wide:
     * the Cloudflare checks' sign-ins go too.
     */
    fun clear(context: Context, view: WebView?, done: () -> Unit) {
        val run = Runnable {
            var finished = false
            fun finish() {
                if (finished) return
                finished = true
                done()
            }
            try {
                try {
                    WebStorage.getInstance().deleteAllData()
                } catch (_: Exception) {
                }
                if (view != null) {
                    view.clearCache(true)
                    view.clearHistory()
                    view.clearFormData()
                } else {
                    val tmp = WebView(context.applicationContext)
                    tmp.clearCache(true)
                    tmp.clearHistory()
                    tmp.destroy()
                }
                val cm = CookieManager.getInstance()
                cm.removeAllCookies { cm.flush(); finish() }
            } catch (_: Throwable) {
                finish()
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) run.run() else Handler(Looper.getMainLooper()).post(run)
    }
}
