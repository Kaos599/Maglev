// Smart Download for the Maglev site. Hand-written, no dependencies.
// In the browser it points every Download button at the right APK of the newest release.
// In node it exports the same pure functions for scripts/test-site-download.js.
// Without this file, or if GitHub's API is down, the buttons keep the link baked in by build-site.mjs.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.MaglevDownload = api; if (typeof document !== 'undefined') api.init(); }
})(typeof self !== 'undefined' ? self : this, function () {
  var API = 'https://api.github.com/repos/Kaos599/Maglev/releases?per_page=6';
  var ALL_RELEASES = 'https://github.com/Kaos599/Maglev/releases';
  var CACHE_KEY = 'maglev-releases-v1';
  var TIMEOUT_MS = 5000;

  var FILES = [
    { kind: 'arm64', part: 'arm64-v8a', label: 'Most phones from the last six years' },
    { kind: 'armeabi-v7a', part: 'armeabi-v7a', label: 'Older 32-bit phones' },
    { kind: 'x86_64', part: 'x86_64', label: 'Chromebooks and emulators' },
    { kind: 'universal', part: 'universal', label: 'Any device, if you are not sure' },
  ];

  function isApk(a) { return !!a && typeof a.name === 'string' && /\.apk$/i.test(a.name) && !!a.browser_download_url; }
  function apks(release) { return ((release && release.assets) || []).filter(isApk); }
  function when(r) { var t = Date.parse(r && r.published_at); return isNaN(t) ? 0 : t; }

  /** Usable releases, newest first: not a draft, not a prerelease, with at least one APK. */
  function recentReleases(releases, limit) {
    if (!Array.isArray(releases)) return [];
    var list = releases.filter(function (r) { return r && !r.draft && !r.prerelease && apks(r).length > 0; });
    list = list.map(function (r, i) { return { r: r, i: i }; })
      .sort(function (a, b) { return when(b.r) - when(a.r) || a.i - b.i; })
      .map(function (x) { return x.r; });
    return typeof limit === 'number' ? list.slice(0, limit) : list;
  }

  function pickLatest(releases) { return recentReleases(releases)[0] || null; }

  function findFile(release, part) {
    var re = new RegExp('-' + part.replace(/[-_]/g, '[-_]') + '\\.apk$', 'i');
    return apks(release).filter(function (a) { return re.test(a.name); })[0] || null;
  }

  /**
   * env: { userAgent, platform, uaPlatform, architecture, bitness } (all optional strings).
   * Browsers mostly hide the CPU, so a wrong guess is worse than the big file: arm64 and x86_64 need a
   * positive signal on Android; every other Android gets the universal file; everything else is desktop mode.
   */
  function classify(env) {
    env = env || {};
    var ua = String(env.userAgent || ''), plat = String(env.platform || '');
    var arch = String(env.architecture || '').toLowerCase(), bits = String(env.bitness || '');
    var android = /android/i.test(ua) || String(env.uaPlatform || '').toLowerCase() === 'android';
    if (!android) return 'desktop';
    if (/armv[78]l/i.test(plat)) return 'universal'; // 32-bit userland, even on a 64-bit chip
    var both = plat + ' ' + ua;
    if ((arch === 'arm' && bits === '64') || /aarch64|arm64/i.test(both)) return 'arm64';
    if ((arch === 'x86' && bits === '64') || /x86[_-]64/i.test(both)) return 'x86_64';
    return 'universal';
  }

  /** The file to offer and why: { asset, kind: 'arm64' | 'universal' | 'x86_64' | 'desktop' }. */
  function pickAsset(release, env) {
    if (!release || !apks(release).length) return null;
    var kind = classify(env);
    var universal = findFile(release, 'universal');
    var want = kind === 'arm64' ? findFile(release, 'arm64-v8a') : kind === 'x86_64' ? findFile(release, 'x86_64') : null;
    if (want) return { asset: want, kind: kind };
    var asset = universal || findFile(release, 'arm64-v8a') || apks(release)[0];
    return { asset: asset, kind: kind === 'desktop' ? 'desktop' : 'universal' };
  }

  function formatSize(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes <= 0) return '';
    var mb = bytes / 1e6; // decimal, like Android's file manager
    if (mb < 1) return Math.round(bytes / 1000) + ' KB';
    return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + ' MB';
  }

  function versionOf(tag) { return String(tag || '').replace(/^v/i, ''); }

  function buttonLabel(release, asset) {
    var size = formatSize(asset && asset.size);
    return 'Download ' + versionOf(release.tag_name) + (size ? ' \u00b7 ' + size : '');
  }

  function fileLabel(kind) {
    var f = FILES.filter(function (x) { return x.kind === kind; })[0];
    return f ? f.label : kind;
  }

  /** Browser only: resolves to the env pickAsset needs. Never rejects. */
  function detectEnv() {
    var n = typeof navigator !== 'undefined' ? navigator : {};
    var env = { userAgent: n.userAgent || '', platform: n.platform || '' };
    var d = n.userAgentData;
    if (!d) return Promise.resolve(env);
    env.uaPlatform = d.platform || '';
    if (typeof d.getHighEntropyValues !== 'function') return Promise.resolve(env);
    var timeout = new Promise(function (res) { setTimeout(res, 800); });
    var ask = d.getHighEntropyValues(['architecture', 'bitness', 'platform']).then(function (v) {
      env.architecture = v.architecture || ''; env.bitness = v.bitness || '';
      if (v.platform) env.uaPlatform = v.platform;
    }, function () {});
    return Promise.race([ask, timeout]).then(function () { return env; });
  }

  // ------------------------------------------------------------ browser wiring

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function fetchReleases() {
    try {
      var cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
      if (Array.isArray(cached) && cached.length) return Promise.resolve(cached);
    } catch (e) {}
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUT_MS);
    return fetch(API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        clearTimeout(timer);
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (e) {}
        return data;
      }, function (err) { clearTimeout(timer); throw err; });
  }

  function releaseHead(r) {
    var head = el('p', 'ver-head');
    head.appendChild(el('span', 'ver-name', 'Maglev ' + versionOf(r.tag_name)));
    var day = String(r.published_at || '').slice(0, 10);
    if (day) head.appendChild(el('span', 'ver-date', ' ' + day));
    return head;
  }

  // The newest release: one plain-English line per file.
  function latestFiles(r) {
    var files = el('ul', 'ver-files');
    FILES.forEach(function (f) {
      var a = findFile(r, f.part);
      if (!a) return;
      var item = el('li');
      var link = el('a', null, f.label);
      link.href = a.browser_download_url; link.rel = 'noopener';
      item.appendChild(link);
      item.appendChild(el('span', 'ver-size', ' ' + f.part + ', ' + formatSize(a.size)));
      files.appendChild(item);
    });
    return files;
  }

  // Older releases: one wrapped row of small links, the plain-English name kept as title and aria-label.
  function compactFiles(r) {
    var row = el('ul', 'ver-row');
    FILES.forEach(function (f) {
      var a = findFile(r, f.part);
      if (!a) return;
      var item = el('li');
      var link = el('a', null, f.part + ' \u00b7 ' + formatSize(a.size));
      link.href = a.browser_download_url; link.rel = 'noopener';
      link.title = f.label; link.setAttribute('aria-label', f.label + ' (' + f.part + '), ' + formatSize(a.size));
      item.appendChild(link);
      row.appendChild(item);
    });
    return row;
  }

  function renderVersions(box, list) {
    box.textContent = '';
    var cur = el('div', 'ver');
    cur.appendChild(releaseHead(list[0]));
    cur.appendChild(latestFiles(list[0]));
    box.appendChild(cur);
    if (list.length > 1) {
      var d = el('details', 'older');
      d.appendChild(el('summary', null, 'Older versions'));
      list.slice(1).forEach(function (r) {
        var v = el('div', 'ver');
        v.appendChild(releaseHead(r));
        v.appendChild(compactFiles(r));
        d.appendChild(v);
      });
      box.appendChild(d);
    }
    var more = el('p', 'ver-all');
    var all = el('a', null, 'All releases on GitHub');
    all.href = ALL_RELEASES; all.rel = 'noopener';
    more.appendChild(all);
    box.appendChild(more);
  }

  function applyRelease(release, picked) {
    var asset = picked.asset;
    document.querySelectorAll('[data-dl]').forEach(function (a) {
      a.href = asset.browser_download_url;
      if (a.getAttribute('data-dl') === 'main') {
        var label = a.querySelector('[data-dl-label]');
        if (label) label.textContent = buttonLabel(release, asset);
      }
    });
  }

  function init() {
    var envP = detectEnv();
    // Desktop mode does not need GitHub: show the QR code as soon as we know it is not an Android phone.
    envP.then(function (env) {
      if (classify(env) !== 'desktop') return;
      document.querySelectorAll('[data-dl-qr]').forEach(function (q) { q.hidden = false; });
      document.querySelectorAll('[data-dl-note]').forEach(function (n) { n.hidden = true; });
      document.querySelectorAll('[data-dl-note-desktop]').forEach(function (n) { n.hidden = false; });
    });
    Promise.all([envP, fetchReleases()]).then(function (res) {
      var list = recentReleases(res[1], 5);
      var latest = list[0];
      if (!latest) return;
      var picked = pickAsset(latest, res[0]);
      if (picked) applyRelease(latest, picked);
      document.querySelectorAll('[data-dl-versions]').forEach(function (box) { renderVersions(box, list); });
    }).catch(function () { /* the baked links stay */ });
  }

  return {
    pickLatest: pickLatest, pickAsset: pickAsset, detectEnv: detectEnv, formatSize: formatSize,
    recentReleases: recentReleases, versionOf: versionOf, buttonLabel: buttonLabel, fileLabel: fileLabel,
    classify: classify, init: init,
  };
});
