/**
 * The script that runs inside the page and finds the image or video under a long press. Pure: a string builder,
 * so scripts/test-media-hit.js can read it. The payload shape is parsed and checked by utils/browser/mediaHit.ts
 * (parseMediaHit).
 *
 * Plain ES5 inside a string, wrapped in one function: no globals leak. The only two properties it adds to
 * `window` are non-enumerable (the install marker and `__maglevMediaHit`, which the native side can call after
 * its own long-press fires and which returns the last hit as a JSON string, or '' when there is none).
 * Injecting it twice does nothing the second time.
 *
 * Channel: `window.ReactNativeWebView.postMessage` when it exists, else the page bridge `window.MaglevScan.report`
 * with the per-page nonce (see PageScan.kt). It calls preventDefault on `contextmenu` only when it found media,
 * so selecting plain text keeps working. It never touches touch events' default action.
 */
const SOURCE = String.raw`
(function () {
  try {
    if (window.__maglevMH) return;
    Object.defineProperty(window, '__maglevMH', { value: 1, enumerable: false });
    var NONCE = "%NONCE%";
    var TYPE = 'maglev-media-hit';
    var last = null, lastAt = 0, timer = 0, sx = 0, sy = 0;
    var LAZY = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url'];

    function s(v) { return typeof v === 'string' ? v : ''; }
    function abs(u) { try { return new URL(u, document.baseURI).href; } catch (e) { return s(u); } }

    // The largest candidate of a srcset: by w descriptor, else by x descriptor, else the last one.
    function largest(set) {
      var best = '', bv = -1;
      s(set).split(',').forEach(function (part) {
        var a = part.trim().split(/\s+/);
        if (!a[0]) return;
        var d = a[1] || '', v = parseFloat(d) || 1;
        if (d.charAt(d.length - 1) === 'x') v = v * 1000;
        if (v >= bv) { bv = v; best = a[0]; }
      });
      return best;
    }

    function imageSrc(img) {
      var u = s(img.currentSrc);
      if (!u || /^data:/i.test(u)) u = largest(img.getAttribute('srcset')) || s(img.getAttribute('src'));
      if (!u || /^data:/i.test(u)) {
        for (var i = 0; i < LAZY.length; i++) { var l = img.getAttribute(LAZY[i]); if (l) { u = l; break; } }
      }
      if (!u) {
        var pic = img.parentNode;
        if (pic && pic.tagName === 'PICTURE') {
          var srcs = pic.querySelectorAll('source[srcset]');
          for (var j = 0; j < srcs.length && !u; j++) u = largest(srcs[j].getAttribute('srcset'));
        }
      }
      return u ? abs(u) : '';
    }

    function videoSrc(v) {
      var u = s(v.currentSrc) || s(v.getAttribute('src'));
      if (!u) { var src = v.querySelector('source[src]'); if (src) u = s(src.getAttribute('src')); }
      return u ? abs(u) : '';
    }

    function mediaOf(el) {
      if (!el || el.nodeType !== 1) return null;
      var m = el.closest ? el.closest('img,video,picture,source') : null;
      if (!m) return null;
      if (m.tagName === 'PICTURE') m = m.querySelector('img') || m;
      else if (m.tagName === 'SOURCE') m = m.closest('video') || (m.parentNode && m.parentNode.querySelector('img')) || m;
      return m && (m.tagName === 'IMG' || m.tagName === 'VIDEO') ? m : null;
    }

    function find(t, x, y) {
      var m = mediaOf(t);
      if (m) return m;
      // A transparent overlay often sits on top of the picture: look through the stack under the finger.
      if (document.elementsFromPoint && typeof x === 'number') {
        var stack = document.elementsFromPoint(x, y) || [];
        for (var i = 0; i < stack.length && i < 8; i++) { m = mediaOf(stack[i]); if (m) return m; }
      }
      return null;
    }

    function hitFor(t, x, y) {
      try {
        var m = find(t, x, y);
        if (!m) return null;
        var link = m.closest ? m.closest('a[href]') : null;
        var o = { type: TYPE, kind: 'image', src: '', pageUrl: location.href };
        if (m.tagName === 'VIDEO') {
          o.kind = 'video';
          o.src = videoSrc(m);
          var p = s(m.getAttribute('poster'));
          if (p) o.poster = abs(p);
          o.alt = s(m.getAttribute('aria-label')) || s(m.title);
        } else {
          o.src = imageSrc(m);
          o.alt = s(m.getAttribute('alt')) || s(m.title);
        }
        if (!o.src && !o.poster) return null;
        if (link) o.linkHref = s(link.href);
        return o;
      } catch (e) { return null; }
    }

    function post(o) {
      try {
        var json = JSON.stringify(o);
        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) window.ReactNativeWebView.postMessage(json);
        else if (window.MaglevScan && window.MaglevScan.report) { o.n = NONCE; window.MaglevScan.report(JSON.stringify({ n: NONCE, mediaHit: o })); }
      } catch (e) {}
    }

    function send(o) {
      var now = Date.now();
      if (now - lastAt < 800) return;
      lastAt = now;
      post(o);
    }

    function clearTimer() { if (timer) { clearTimeout(timer); timer = 0; } }

    Object.defineProperty(window, '__maglevMediaHit', {
      value: function () { try { return last ? JSON.stringify(last) : ''; } catch (e) { return ''; } },
      enumerable: false
    });

    // Android WebView fires contextmenu on a long press on most versions; the timer covers the rest.
    document.addEventListener('contextmenu', function (e) {
      try {
        var o = hitFor(e.target, e.clientX, e.clientY);
        if (!o) return;
        last = o;
        e.preventDefault();
        send(o);
      } catch (x) {}
    }, true);

    document.addEventListener('touchstart', function (e) {
      try {
        clearTimer();
        last = null;
        if (!e.touches || e.touches.length !== 1) return;
        var t = e.touches[0];
        sx = t.clientX; sy = t.clientY;
        var o = hitFor(e.target, sx, sy);
        if (!o) return;
        last = o;
        timer = setTimeout(function () { timer = 0; send(o); }, 550);
      } catch (x) {}
    }, { capture: true, passive: true });

    document.addEventListener('touchmove', function (e) {
      try {
        var t = e.touches && e.touches[0];
        if (t && (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10)) { clearTimer(); last = null; }
      } catch (x) {}
    }, { capture: true, passive: true });

    var end = function () { clearTimer(); last = null; };
    document.addEventListener('touchend', end, { capture: true, passive: true });
    document.addEventListener('touchcancel', end, { capture: true, passive: true });
  } catch (e) {}
})();
`;

/** The script for one page load. `nonce` is the page-scan nonce, used only when the page bridge is the channel. */
export function mediaHitScript(nonce = ''): string {
  return SOURCE.replace('%NONCE%', nonce.replace(/[^A-Za-z0-9_-]/g, ''));
}
