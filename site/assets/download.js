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
  var BASE = ''; // folder this script was loaded from, for the QR image (set in the browser)
  var WORDS = { arm64: 'For most phones', universal: 'For any device', x86_64: 'For Chromebooks and emulators', desktop: 'For any device' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** "2026-11-16T12:32:35Z" -> "16 Nov 2026"; '' when unknown. */
  function formatDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m && MONTHS[+m[2] - 1] ? (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1] : '';
  }

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

  // The visible label never changes; the version and size live in the title and aria-label.
  function buttonLabel() { return 'Download latest'; }

  function buttonTitle(release, asset) {
    var size = formatSize(asset && asset.size);
    return 'Download Maglev ' + versionOf(release.tag_name) + (size ? ', ' + size : '');
  }

  function fileLabel(kind) {
    var f = FILES.filter(function (x) { return x.kind === kind; })[0];
    return f ? f.label : kind;
  }

  /**
   * Everything the "download started" dialog shows, as plain data (the browser renders it with renderDialog).
   * releases: the usable releases, newest first (the first is `release`).
   */
  function buildDialog(release, env, releases) {
    var picked = pickAsset(release, env);
    if (!picked) return null;
    var desktop = picked.kind === 'desktop';
    var size = formatSize(picked.asset.size);
    var files = [];
    FILES.forEach(function (f) {
      var a = findFile(release, f.part);
      if (!a) return;
      var isPick = a.name === picked.asset.name;
      files.push({
        part: f.part, name: f.label, tech: f.part, size: formatSize(a.size), url: a.browser_download_url,
        picked: isPick, badge: isPick ? (desktop ? 'Recommended' : 'Picked for your phone') : '',
      });
    });
    var older = recentReleases(releases || [release], 5).filter(function (r) { return r.tag_name !== release.tag_name; }).map(function (r) {
      return {
        version: versionOf(r.tag_name), date: String(r.published_at || '').slice(0, 10),
        files: FILES.map(function (f) {
          var a = findFile(r, f.part);
          return a ? { part: f.part, label: f.label, size: formatSize(a.size), url: a.browser_download_url } : null;
        }).filter(Boolean),
      };
    });
    var date = formatDate(release.published_at);
    var part = (FILES.filter(function (f) { return findFile(release, f.part) === picked.asset; })[0] || {}).part || '';
    var version = versionOf(release.tag_name);
    // Desktop: nothing is downloaded, so no "started" or "tap the file" lines; the QR leads.
    return {
      heading: desktop ? 'Get Maglev on your phone' : 'Downloading Maglev ' + version,
      summary: desktop ? '' : [WORDS[picked.kind], part, size].filter(Boolean).join(' \u00b7 '),
      released: desktop ? 'Latest: Maglev ' + version + (date ? ' \u00b7 Released ' + date : '') : (date ? 'Released ' + date : ''),
      retryUrl: desktop ? '' : picked.asset.browser_download_url,
      next: desktop ? '' : 'Next: tap the file to install. Step 2 below shows how.',
      pickTitle: desktop ? 'Or download a file' : 'Pick a different file',
      files: files,
      olderTitle: 'Older versions',
      older: older,
      allReleasesUrl: ALL_RELEASES,
      desktop: desktop,
      qr: desktop ? { title: 'Scan with your Android phone', text: 'Maglev is an Android app. Scan this with your phone to get it.' } : null,
    };
  }

  /** The dialog when GitHub's API has not answered: the baked version and link, no file list. */
  function fallbackDialog(version, url, desktop) {
    return {
      heading: desktop ? 'Get Maglev on your phone' : 'Downloading Maglev ' + version,
      summary: desktop ? '' : 'For any device \u00b7 universal',
      released: desktop ? 'Latest: Maglev ' + version : '',
      retryUrl: desktop ? '' : url,
      next: desktop ? '' : 'Next: tap the file to install. Step 2 below shows how.',
      pickTitle: '', files: [], olderTitle: '', older: [],
      allReleasesUrl: ALL_RELEASES, desktop: !!desktop,
      qr: desktop ? { title: 'Scan with your Android phone', text: 'Maglev is an Android app. Scan this with your phone to get it.' } : null,
    };
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

  function link(href, text, cls) {
    var a = el('a', cls || null, text);
    a.href = href; a.rel = 'noopener';
    return a;
  }

  function renderDialog(d) {
    var dlg = el('dialog', 'dlg');
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    var inn = el('div', 'dlg-in');
    var close = el('button', 'btn small dlg-close', 'Close');
    close.type = 'button';
    close.addEventListener('click', function () { dlg.close(); });
    inn.appendChild(close);
    var h = el('h2', 'h3', d.heading); h.id = 'dlg-title';
    inn.appendChild(h);
    if (d.summary) inn.appendChild(el('p', 'dlg-sum', d.summary));
    if (d.released) inn.appendChild(el('p', 'dlg-date', d.released));
    if (d.retryUrl) {
      var again = el('p', 'dlg-again', 'Didn\u2019t start? ');
      again.appendChild(link(d.retryUrl, 'Download again'));
      inn.appendChild(again);
    }
    if (d.next) inn.appendChild(el('p', 'dlg-next', d.next));
    if (d.qr) {
      var q = el('div', 'dlg-qr');
      var img = el('img');
      img.src = BASE + 'qr-maglev.svg'; img.width = 176; img.height = 176; img.alt = 'QR code that opens this page on a phone';
      q.appendChild(img);
      var qt = el('div');
      qt.appendChild(el('p', 'dlg-qr-title', d.qr.title));
      qt.appendChild(el('p', null, d.qr.text));
      q.appendChild(qt);
      inn.appendChild(q);
    }
    if (d.files.length) inn.appendChild(el('h3', 'dlg-h', d.pickTitle));
    var rows = el('ul', 'dlg-files');
    d.files.forEach(function (f) {
      var li = el('li');
      var a = link(f.url, null, 'dlg-row' + (f.picked ? ' picked' : ''));
      var main = el('span', 'dlg-row-main');
      main.appendChild(el('strong', null, f.name));
      main.appendChild(el('span', 'dlg-row-sub', f.tech + ' \u00b7 ' + f.size));
      a.appendChild(main);
      if (f.badge) a.appendChild(el('span', 'dlg-badge', f.badge));
      li.appendChild(a);
      rows.appendChild(li);
    });
    if (d.files.length) inn.appendChild(rows);
    if (d.older.length) {
      var det = el('details', 'older');
      det.appendChild(el('summary', null, d.olderTitle));
      d.older.forEach(function (r) {
        var v = el('div', 'ver');
        var head = el('p', 'ver-head');
        head.appendChild(el('span', 'ver-name', 'Maglev ' + r.version));
        if (r.date) head.appendChild(el('span', 'ver-date', ' ' + r.date));
        v.appendChild(head);
        var row = el('ul', 'ver-row');
        r.files.forEach(function (f) {
          var li = el('li');
          var a = link(f.url, f.part + ' \u00b7 ' + f.size);
          a.title = f.label; a.setAttribute('aria-label', f.label + ' (' + f.part + '), ' + f.size);
          li.appendChild(a); row.appendChild(li);
        });
        v.appendChild(row);
        det.appendChild(v);
      });
      inn.appendChild(det);
    }
    var all = el('p', 'ver-all');
    all.appendChild(link(d.allReleasesUrl, 'All releases on GitHub'));
    inn.appendChild(all);
    dlg.appendChild(inn);
    // Backdrop click: the dialog element itself is the backdrop area (its content fills the box).
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    return { dlg: dlg, close: close };
  }

  var state = null; // { release, list, env } once GitHub has answered
  var open = null;

  var envNow = null; // set once detectEnv answers

  function showDialog(opener, e) {
    if (typeof HTMLDialogElement === 'undefined') return;
    var desktop = !!envNow && classify(envNow) === 'desktop';
    if (desktop && e) e.preventDefault(); // an APK is useless on a computer: show the QR instead
    var d = state && buildDialog(state.release, state.env, state.list);
    if (!d) {
      var v = /\/download\/v([^/]+)\//.exec(opener.href || '');
      if (!v) return;
      d = fallbackDialog(v[1], opener.href, desktop);
    }
    if (open) { open.dlg.remove(); open = null; }
    var r = renderDialog(d);
    document.body.appendChild(r.dlg);
    document.documentElement.classList.add('dlg-lock');
    r.dlg.addEventListener('close', function () {
      document.documentElement.classList.remove('dlg-lock');
      r.dlg.remove();
      if (open === r) open = null;
      if (opener && opener.focus) opener.focus();
    });
    open = r;
    r.dlg.showModal();
    r.close.focus();
  }

  function applyRelease(release, picked) {
    var asset = picked.asset;
    document.querySelectorAll('[data-dl]').forEach(function (a) {
      a.href = asset.browser_download_url;
      if (a.getAttribute('data-dl') === 'main') {
        var label = a.querySelector('[data-dl-label]');
        if (label) label.textContent = buttonLabel();
        a.title = buttonTitle(release, asset);
        a.setAttribute('aria-label', a.title);
      }
    });
  }

  function init() {
    // Wired at load, so a click before GitHub answers still shows the dialog (for the baked version).
    document.querySelectorAll('[data-dl]').forEach(function (a) { a.addEventListener('click', function (e) { showDialog(a, e); }); });
    try { var cs = document.currentScript; if (cs && cs.src) BASE = cs.src.replace(/[^\/]*$/, ''); } catch (e) {}
    var envP = detectEnv();
    // Desktop mode does not need GitHub: show the QR code as soon as we know it is not an Android phone.
    envP.then(function (env) {
      envNow = env;
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
      state = { release: latest, list: list, env: res[0] };
      if (picked) applyRelease(latest, picked);
    }).catch(function () { /* the baked links stay */ });
  }

  return {
    pickLatest: pickLatest, pickAsset: pickAsset, detectEnv: detectEnv, formatSize: formatSize,
    recentReleases: recentReleases, buildDialog: buildDialog, fallbackDialog: fallbackDialog, formatDate: formatDate, versionOf: versionOf, buttonLabel: buttonLabel, buttonTitle: buttonTitle, fileLabel: fileLabel,
    classify: classify, init: init,
  };
});
