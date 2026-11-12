package com.maglev.engine.browser

import android.webkit.JavascriptInterface
import org.json.JSONObject

/** One thing the injected page script found. [type] is `video`, `audio`, `image`, `meta-image`, `meta-video` or `link`. */
data class ScanEntry(val url: String, val type: String, val width: Int, val height: Int)

/** What one report from the page holds. */
data class ScanReport(val entries: List<ScanEntry>, val eme: Boolean, val blob: Boolean)

/**
 * The page scan (docs/NATIVE_CONTRACT.md section 24.3 rule 2): the script we inject and the parser for what it sends back.
 * Everything the page sends is untrusted: [parse] checks the nonce, the size and every field.
 */
object PageScan {
    /** The only name the page sees. The bridge has one method. */
    const val BRIDGE_NAME = "MaglevScan"
    const val MAX_REPORT_CHARS = 256 * 1024
    const val MAX_ENTRIES = 300
    const val MAX_URL_CHARS = 2048
    private val types = setOf("video", "audio", "image", "meta-image", "meta-video", "link")

    /**
     * Installs the scan: finds media, large images, og tags and file links; reports on DOM changes at most once a
     * second; wraps `navigator.requestMediaKeySystemAccess` to report DRM once. Placeholder `%NONCE%` is replaced per
     * page load. Running it again with the same nonce only triggers a rescan. Injected into the main frame only
     * (`evaluateJavascript` runs there).
     */
    private val SCAN_JS = """
(function(){
  var B = window.MaglevScan, N = "%NONCE%";
  if (!B) return;
  if (window.__maglevN === N) { if (window.__maglevScanNow) window.__maglevScanNow(false); return; }
  window.__maglevN = N;
  var sent = {}, count = 0, MAX = 500, timer = 0, last = 0, emeSent = false, blobSeen = false, blobSent = false;
  var FILE = /\.(pdf|epub|mobi|djvu|docx?|xlsx?|pptx?|od[tsp]|txt|rtf|csv|md|zip|rar|7z|tar|gz|bz2|xz|iso|apk|exe|msi|dmg|bat|cmd|scr|torrent|srt|vtt|ass|mp4|m4v|webm|mkv|mov|avi|mp3|m4a|aac|flac|ogg|opus|wav|m3u8|mpd)([?#]|${'$'})/i;
  function post(o){ try { o.n = N; B.report(JSON.stringify(o)); } catch (e) {} }
  function abs(u){ try { return new URL(u, document.baseURI).href; } catch (e) { return ''; } }
  function eme(){ if (emeSent) return; emeSent = true; post({ items: [], eme: true }); }
  function push(list, u, t, w, h){
    if (!u || typeof u !== 'string') return;
    if (/^blob:/i.test(u)) { if (t === 'video' || t === 'audio') blobSeen = true; return; }
    if (/^data:/i.test(u)) return;
    u = abs(u);
    if (!/^https?:/i.test(u)) return;
    var k = t + ' ' + u;
    if (sent[k]) return;
    sent[k] = 1;
    if (++count > MAX) return;
    list.push({ u: u, t: t, w: w | 0, h: h | 0 });
  }
  function best(s){
    var out = '', bw = 0;
    String(s || '').split(',').forEach(function(p){
      var a = p.trim().split(/\s+/); if (!a[0]) return;
      var v = parseFloat(a[1] || '1') || 1;
      if (v >= bw) { bw = v; out = a[0]; }
    });
    return out;
  }
  function scan(){
    last = Date.now(); timer = 0;
    var list = [], i, j, els, m, t, ss;
    els = document.querySelectorAll('video,audio');
    for (i = 0; i < els.length; i++) {
      m = els[i]; t = m.tagName.toLowerCase();
      push(list, m.currentSrc, t); push(list, m.getAttribute('src'), t);
      ss = m.querySelectorAll('source');
      for (j = 0; j < ss.length; j++) push(list, ss[j].getAttribute('src'), t);
      if (m.mediaKeys) eme();
    }
    els = document.images;
    for (i = 0; i < els.length && i < 1000; i++) {
      m = els[i];
      if (m.naturalWidth >= 200 && m.naturalHeight >= 200) push(list, best(m.srcset) || m.currentSrc || m.src, 'image', m.naturalWidth, m.naturalHeight);
    }
    els = document.querySelectorAll('meta[property="og:image"],meta[property="og:image:url"],meta[property="og:image:secure_url"]');
    for (i = 0; i < els.length; i++) push(list, els[i].getAttribute('content'), 'meta-image');
    els = document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"]');
    for (i = 0; i < els.length; i++) push(list, els[i].getAttribute('content'), 'meta-video');
    els = document.querySelectorAll('a[href]');
    for (i = 0; i < els.length && i < 3000; i++) {
      var href = els[i].getAttribute('href');
      if (href && FILE.test(href)) push(list, href, 'link');
    }
    var blob = blobSeen && !blobSent;
    if (blob) blobSent = true;
    if (list.length || blob) post({ items: list, blob: blob });
  }
  function schedule(){
    if (timer) return;
    timer = setTimeout(scan, Math.max(0, 1000 - (Date.now() - last)));
  }
  window.__maglevScanNow = function(reset){ if (reset) { sent = {}; count = 0; } if (timer) { clearTimeout(timer); timer = 0; } scan(); };
  try {
    var nav = navigator, orig = nav.requestMediaKeySystemAccess;
    if (orig && !orig.__mg) {
      var w = function(){ eme(); return orig.apply(this, arguments); };
      w.__mg = 1;
      nav.requestMediaKeySystemAccess = w;
    }
  } catch (e) {}
  try {
    document.addEventListener('encrypted', eme, true);
    document.addEventListener('loadedmetadata', schedule, true);
    window.addEventListener('load', schedule);
    if (document.documentElement) new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href', 'srcset'] });
  } catch (e) {}
  scan();
})();
"""

    /** Hides common ad containers. Injected only when ad blocking is on for the site (section 24.4). */
    private val COSMETIC_JS = """
(function(){
  var id = '__mg_cosmetic';
  if (document.getElementById(id)) return;
  var s = document.createElement('style'); s.id = id;
  s.textContent = 'ins.adsbygoogle,.adsbygoogle,[id^="google_ads_iframe"],[id^="div-gpt-ad"],iframe[src*="doubleclick.net"],iframe[src*="googlesyndication.com"],.ad-banner,.ad-slot,.ad-container,.advertisement,#ad-banner,.adsbox{display:none!important}';
  (document.head || document.documentElement).appendChild(s);
})();
"""

    fun scanScript(nonce: String): String = SCAN_JS.replace("%NONCE%", nonce)

    val cosmeticScript: String get() = COSMETIC_JS

    /** Runs the scan again and resends everything (new items only reach JS; the tracker dedupes). */
    const val RESCAN_JS = "if (window.__maglevScanNow) window.__maglevScanNow(true);"

    private fun clamp(n: Int): Int = if (n < 0) 0 else if (n > 100_000) 100_000 else n

    /** Validates one report. Null when it is too big, not JSON, has a wrong nonce or holds nothing usable. */
    fun parse(json: String?, nonce: String): ScanReport? {
        if (json == null || json.length > MAX_REPORT_CHARS || nonce.isEmpty()) return null
        val o = try { JSONObject(json) } catch (_: Exception) { return null }
        if (o.optString("n", "") != nonce) return null
        val out = ArrayList<ScanEntry>()
        val arr = o.optJSONArray("items")
        if (arr != null) {
            var i = 0
            while (i < arr.length() && out.size < MAX_ENTRIES) {
                val e = arr.optJSONObject(i++) ?: continue
                val url = e.optString("u", "")
                val type = e.optString("t", "")
                if (url.isEmpty() || url.length > MAX_URL_CHARS || type !in types) continue
                if (FoundClassifier.normalize(url) == null) continue
                out.add(ScanEntry(url, type, clamp(e.optInt("w", 0)), clamp(e.optInt("h", 0))))
            }
        }
        return ScanReport(out, o.optBoolean("eme", false), o.optBoolean("blob", false))
    }

    /** Turns a scan entry into an item, or null when it doesn't qualify. */
    fun toItem(e: ScanEntry, pageUrl: String, pageTitle: String): FoundItem? {
        val c = when (e.type) {
            "video", "meta-video" -> FoundClassifier.classifyPage(e.url, "video")
            "audio" -> FoundClassifier.classifyPage(e.url, "audio")
            "image" -> if (e.width >= 200 && e.height >= 200) FoundClassifier.classifyPage(e.url, "image") else null
            "meta-image" -> FoundClassifier.classifyPage(e.url, "image")
            else -> FoundClassifier.classifyPage(e.url, null)
        } ?: return null
        return FoundClassifier.item(
            e.url, c, "page", pageUrl, pageTitle,
            width = e.width.takeIf { it > 0 }, height = e.height.takeIf { it > 0 },
        )
    }
}

/**
 * The one object the page can call. It has ONE method that takes a JSON string and hands it to [sink]; the sink
 * validates it with [PageScan.parse]. Nothing else is exposed.
 */
class PageScanBridge(private val sink: (String) -> Unit) {
    @JavascriptInterface
    fun report(json: String?) {
        if (json == null || json.length > PageScan.MAX_REPORT_CHARS) return
        sink(json)
    }
}
