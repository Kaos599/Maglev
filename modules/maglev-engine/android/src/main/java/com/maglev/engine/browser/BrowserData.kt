package com.maglev.engine.browser

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView

/**
 * Clears what the browser keeps (docs/NATIVE_CONTRACT.md section 24.9).
 * History is not cleared here: the JS store owns it, and the screen's back/forward list is cleared by the view.
 */
object BrowserData {
    /**
     * Runs on the main thread (WebView APIs require it) and calls [done] when finished.
     * [cookies] covers cookies and web storage (the Cloudflare checks' sign-ins go too); [cache] covers the WebView cache
     * and form data. [view] is the live WebView when the browser screen is open; otherwise a short-lived one clears the
     * shared cache.
     */
    fun clear(context: Context, view: WebView?, cookies: Boolean, cache: Boolean, done: () -> Unit) {
        val run = Runnable {
            var finished = false
            fun finish() {
                if (finished) return
                finished = true
                done()
            }
            try {
                if (cookies) {
                    try {
                        WebStorage.getInstance().deleteAllData()
                    } catch (_: Exception) {
                    }
                }
                if (cache) {
                    if (view != null) {
                        view.clearCache(true)
                        view.clearFormData()
                    } else {
                        val tmp = WebView(context.applicationContext)
                        tmp.clearCache(true)
                        tmp.clearFormData()
                        tmp.destroy()
                    }
                }
                if (cookies) {
                    val cm = CookieManager.getInstance()
                    cm.removeAllCookies { cm.flush(); finish() }
                } else {
                    finish()
                }
            } catch (_: Throwable) {
                finish()
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) run.run() else Handler(Looper.getMainLooper()).post(run)
    }
}
