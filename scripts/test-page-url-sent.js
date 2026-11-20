#!/usr/bin/env node
// The app must send the page the user was on as `pageUrl` with every browser download, so the engine can keep it
// (NATIVE_CONTRACT "Auto-refresh"). Field path: TS options.pageUrl -> MaglevNativeBridge.addDownload -> Kotlin
// MaglevEngineModule "addDownload" -> EngineHost.addDownload (Json.snakeify) -> Rust DownloadOptions.page_url.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}

// Load a TS file; `extra` supplies its relative imports.
function load(file, extra = {}) {
  const js = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, require: (n) => extra[n] ?? require(n), Promise }, { filename: file });
  return mod.exports;
}

// 1. The helper: a web page is sent, anything else is not (never invent one).
const helperPath = 'components/browser/pageUrlOption.ts';
const hasHelper = fs.existsSync(path.join(__dirname, '..', helperPath));
check('pageUrlOption.ts exists', hasHelper);
let pageUrlOption = () => { throw new Error('missing'); };
let startFound = null;
if (hasHelper) {
  let privateOn = false;
  ({ pageUrlOption } = load(helperPath, { '../../utils/prefs/browser': { getBrowserPrefs: () => ({ privateBrowsing: privateOn }) } }));
  privateOn = true;
  check('nothing is sent while Private browsing is on', JSON.stringify(pageUrlOption('https://site.test/watch')) === '{}');
  privateOn = false;
  ({ startFound } = load('components/browser/startFound.ts', { './pageUrlOption': { pageUrlOption } }));
}
const safe = (f) => { try { return f(); } catch { return 'threw'; } };
check('https page is sent', JSON.stringify(safe(() => pageUrlOption('https://site.test/watch?v=1'))) === '{"pageUrl":"https://site.test/watch?v=1"}');
check('empty, undefined, about: and file: are not sent', ['', undefined, null, 'about:blank', 'file:///x', 'javascript:1'].every((u) => JSON.stringify(safe(() => pageUrlOption(u))) === '{}'));

(async () => {
  // 2. startFound (found items and the batch sheet) passes it to startDownload.
  if (startFound) {
    let seen = null;
    const deps = {
      headersFor: async () => ({}),
      probeUrl: async () => ({ ok: true }),
      startDownload: async (_u, o) => { seen = o; return { ok: true, id: 'dl_1' }; },
    };
    await startFound(deps, { url: 'https://cdn.test/a.mp4', pageUrl: 'https://site.test/p', userAgent: 'ua' });
    check('startFound sends pageUrl to startDownload', !!seen && seen.pageUrl === 'https://site.test/p');
    await startFound(deps, { url: 'https://cdn.test/a.mp4', pageUrl: '', userAgent: 'ua' });
    check('startFound sends no pageUrl when it has none', !!seen && !('pageUrl' in seen));
  } else {
    check('startFound sends pageUrl to startDownload', false);
  }

  // 3. Every other start path.
  const found = read('components/browser/FoundDownload.tsx');
  const stream = read('components/browser/StreamSheet.tsx');
  const browser = read('app/browser.tsx');
  check('FoundDownloadSheet start() sends the page (single file, long-press media menu)', /startDownload\(t\.url, \{[^}]*pageUrlOption\(t\.pageUrl\)/s.test(found));
  check('StreamSheet start() sends the page (stream sheet, media-menu manifests)', /startDownload\(it\.url, \{[\s\S]*?pageUrlOption\(it\.pageUrl \|\| pageUrl\)/.test(stream));
  check('batch sheet goes through startFound with the page', /startFound\(deps, \{ url: item\.url, pageUrl: item\.pageUrl \|\| page\?\.url/.test(browser));
  check('the media menu link and stream paths carry the page they were on', /pageUrl: d\.page\?\.url \?\? ''/.test(browser) && /pageUrl: hit\.pageUrl \|\| d\.page\?\.url/.test(browser));
  check('add-download (typed link, share) never invents a page', !/pageUrlOption/.test(read('app/add-download.tsx')));

  // 4. The native side keeps the field.
  const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
  const host = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/EngineHost.kt');
  const rs = read('native/maglev-core/src/http_dl/driver.rs');
  check('bridge forwards the options object unchanged', /addDownload\(url: string, options: DownloadOptions = \{\}\)[\s\S]{0,120}route\('addDownload', url, options\)/.test(bridge));
  check('EngineHost snakeifies options (pageUrl -> page_url)', /Json\.snakeify\(options\)/.test(host.slice(host.indexOf('fun addDownload('), host.indexOf('fun pauseDownload('))));
  check('Rust DownloadOptions reads page_url', /pub page_url: Option<String>,/.test(rs));

  process.exit(failed ? 1 : 0);
})();
