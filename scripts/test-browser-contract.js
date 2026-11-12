/**
 * Static checks for the browser (docs/NATIVE_CONTRACT.md section 24): the Kotlin view, the module registration, the TS
 * binding and the bundled block list. Kotlin is never compiled locally (CI is the compiler), so this reads the source.
 *
 *   node scripts/test-browser-contract.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ENGINE = 'modules/maglev-engine';
const BROWSER = `${ENGINE}/android/src/main/java/com/maglev/engine/browser`;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripKotlinComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

const view = stripKotlinComments(read(`${BROWSER}/MaglevBrowserView.kt`));
const mod = stripKotlinComments(read(`${ENGINE}/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt`));
const ts = read(`${ENGINE}/src/MaglevBrowser.tsx`);
const scan = read(`${BROWSER}/PageScan.kt`);

// Section 24.2
const EVENTS = ['onPage', 'onFound', 'onBlockedCount', 'onDownloadRequest', 'onMagnet', 'onRefused', 'onCrashed'];
const COMMANDS = ['goBack', 'goForward', 'reload', 'stop', 'loadUrl', 'scan', 'clearData'];
const PROPS = ['url', 'adBlock', 'allowAdsHosts', 'desktopMode'];
const MODULE_FUNCTIONS = ['updateBlocklist', 'getBlocklistInfo', 'resetBlocklist', 'clearBrowserData'];

check('view is registered in MaglevEngineModule', () => {
  assert(/View\(MaglevBrowserView::class\)\s*\{/.test(mod), 'View(MaglevBrowserView::class) missing');
  assert(/class MaglevBrowserView\([^)]*\)\s*:\s*ExpoView\(/.test(view), 'MaglevBrowserView must extend ExpoView');
});

check('every event is declared natively, dispatched, and typed in the binding', () => {
  const eventsDecl = /View\(MaglevBrowserView::class\)\s*\{\s*Events\(([^)]*)\)/.exec(mod);
  assert(eventsDecl, 'Events(...) missing in the view definition');
  for (const e of EVENTS) {
    assert(eventsDecl[1].includes(`"${e}"`), `${e} not in Events(...)`);
    assert(new RegExp(`private val ${e} by EventDispatcher`).test(view), `${e} has no EventDispatcher in the view`);
    assert(new RegExp(`\\b${e}\\??:`).test(ts), `${e} missing in the TS binding`);
  }
});

check('every command is an AsyncFunction on the view and in the binding ref', () => {
  for (const c of COMMANDS) {
    assert(new RegExp(`AsyncFunction\\("${c}"\\)\\s*\\{\\s*view:`).test(mod), `${c} is not a view AsyncFunction`);
    assert(new RegExp(`\\b${c}\\(`).test(ts), `${c} missing in the TS binding`);
  }
});

check('every prop is declared natively and in the binding', () => {
  for (const p of PROPS) {
    assert(new RegExp(`Prop\\("${p}"\\)`).test(mod), `Prop ${p} missing`);
    assert(new RegExp(`\\b${p}\\??:`).test(ts), `${p} missing in the TS binding`);
  }
});

check('module functions exist natively and in the binding', () => {
  for (const f of MODULE_FUNCTIONS) {
    assert(new RegExp(`AsyncFunction\\("${f}"\\)\\s*\\{[^\\n]*promise`).test(mod), `${f} missing in the module`);
    assert(ts.includes(`'${f}'`), `${f} missing in the TS binding`);
  }
});

check('binding uses the native view manager and no fake data', () => {
  assert(/requireNativeViewManager<[^>]*>\('MaglevEngine', 'MaglevBrowserView'\)/.test(ts), 'requireNativeViewManager call');
  assert(/isn't available in this build/.test(ts), 'plain fallback message');
});

check('WebView settings', () => {
  assert(view.includes('setSupportMultipleWindows(true)'), 'setSupportMultipleWindows(true)');
  assert(view.includes('MIXED_CONTENT_NEVER_ALLOW'), 'MIXED_CONTENT_NEVER_ALLOW');
  assert(/mediaPlaybackRequiresUserGesture\s*=\s*true/.test(view), 'mediaPlaybackRequiresUserGesture = true');
  assert(/javaScriptCanOpenWindowsAutomatically\s*=\s*false/.test(view), 'javaScriptCanOpenWindowsAutomatically = false');
  assert(/allowFileAccess\s*=\s*false/.test(view), 'allowFileAccess = false');
  assert(/allowContentAccess\s*=\s*false/.test(view), 'allowContentAccess = false');
  assert(view.includes('setSafeBrowsingEnabled(true)'), 'safe browsing on');
  assert(/setAcceptThirdPartyCookies\(\w+, false\)/.test(view), 'third-party cookies off');
});

check('onReceivedSslError cancels and reports ssl', () => {
  const m = /override fun onReceivedSslError[\s\S]*?\n        \}/.exec(view);
  assert(m, 'onReceivedSslError missing');
  assert(m[0].includes('handler.cancel()'), 'must call handler.cancel()');
  assert(!m[0].includes('handler.proceed()'), 'must never proceed');
  assert(m[0].includes('"ssl"'), 'must report reason ssl');
});

check('onRenderProcessGone returns true and recreates', () => {
  const m = /override fun onRenderProcessGone[\s\S]*?\n        \}/.exec(view);
  assert(m, 'onRenderProcessGone missing');
  assert(/return true/.test(m[0]), 'must return true');
  assert(view.includes('recreateAfterCrash') && view.includes('onCrashed('), 'recreate and emit onCrashed');
});

check('permissions, dialogs and file chooser are denied', () => {
  assert(/onPermissionRequest[\s\S]*?request\.deny\(\)/.test(view), 'request.deny()');
  assert(/onGeolocationPermissionsShowPrompt[\s\S]*?callback\.invoke\(origin, false, false\)/.test(view), 'geolocation denied');
  assert(!/request\.grant\(/.test(view), 'must never grant a permission');
  for (const d of ['onJsAlert', 'onJsConfirm', 'onJsPrompt']) {
    assert(new RegExp(`${d}[\\s\\S]*?result\\.cancel\\(\\)`).test(view), `${d} must cancel`);
  }
  assert(/onShowFileChooser[\s\S]*?onReceiveValue\(null\)/.test(view), 'no file chooser');
  for (const r of ['"permission"', '"popup"', '"scheme"', '"local"', '"ssl"']) assert(view.includes(r), `refusal reason ${r}`);
});

check('request interception blocks with an empty 204 response and counts per page', () => {
  assert(view.includes('shouldInterceptRequest'), 'shouldInterceptRequest');
  assert(/WebResourceResponse\("text\/plain", "utf-8", 204, "No Content", emptyMap\(\), ByteArrayInputStream\(ByteArray\(0\)\)\)/.test(view), '204 response');
  assert(view.includes('blockedPage.set(0)'), 'blocked count resets per page');
  assert(/FLUSH_MS\s*=\s*250L/.test(view), 'batch every 250 ms');
});

check('scheme, magnet and local-network rules', () => {
  assert(/"magnet"/.test(view) && view.includes('request.hasGesture()'), 'magnet only on a gesture');
  assert(view.includes('LocalHost.isLanHost'), 'LAN rule');
  assert(view.includes('isTyped('), 'typed URLs may open LAN and blocked hosts');
});

check('fullscreen video uses the custom view callbacks', () => {
  assert(view.includes('onShowCustomView') && view.includes('onHideCustomView'), 'custom view callbacks');
});

check('popups use a capture view and need a user gesture', () => {
  assert(view.includes('onCreateWindow') && view.includes('WebViewTransport'), 'onCreateWindow with transport');
  assert(/if \(!gesture\)[\s\S]*?"popup"/.test(view), 'no gesture means refused popup');
});

check('the WebView is destroyed when the view is dropped', () => {
  assert(/OnViewDestroys\s*\{[^}]*destroyBrowser\(\)/.test(mod), 'OnViewDestroys calls destroyBrowser');
  assert(/\.destroy\(\)/.test(view), 'WebView.destroy()');
  assert(view.includes('removeJavascriptInterface'), 'bridge removed on destroy');
});

check('page scan bridge exposes exactly one method and validates input', () => {
  const bridge = /class PageScanBridge[\s\S]*$/.exec(scan)[0];
  assert.strictEqual((bridge.match(/@JavascriptInterface/g) || []).length, 1, 'one @JavascriptInterface');
  assert(scan.includes('MAX_REPORT_CHARS') && scan.includes('"n"'), 'size cap and nonce');
  assert(scan.includes('requestMediaKeySystemAccess'), 'EME detection');
  assert(/addJavascriptInterface\(bridge, PageScan\.BRIDGE_NAME\)/.test(view), 'only the scan bridge is added');
  assert.strictEqual((view.match(/addJavascriptInterface\(/g) || []).length, 1, 'no other JS interface');
});

check('blocklist store: https only, atomic write, 10 MB cap, 30 s timeouts', () => {
  const store = read(`${BROWSER}/BlocklistStore.kt`);
  const parser = read(`${BROWSER}/Blocklist.kt`);
  assert(/TIMEOUT_MS\s*=\s*30_000/.test(store) && store.includes('connectTimeout') && store.includes('readTimeout'), '30 s timeouts');
  assert(/MAX_BYTES\s*=\s*10 \* 1024 \* 1024/.test(parser), '10 MB cap');
  assert(store.includes('fd.sync()') && store.includes('renameTo'), 'tmp + fsync + rename');
  assert(store.includes('isHttpsUrl'), 'https only');
  assert(/LIST_INVALID/.test(parser) && /LIST_TOO_LARGE/.test(parser), 'error codes');
  for (const c of ['NETWORK', 'HTTP_STATUS', 'BLOCKED']) assert(store.includes(`"${c}"`), `${c} code`);
  assert(store.includes('BrowserGovernance.blockedReason'), 'governance check');
});

check('bundled blocklist asset: header, valid domains, <= 400 KB gzipped', () => {
  const file = path.join(ROOT, `${ENGINE}/android/src/main/assets/blocklist.txt`);
  const buf = fs.readFileSync(file);
  const gz = zlib.gzipSync(buf, { level: 9 }).length;
  assert(gz <= 400 * 1024, `asset is ${gz} bytes gzipped`);
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  const head = lines.filter((l) => l.startsWith('#')).join('\n');
  for (const key of ['Source: https://', 'License:', 'Date: 20', 'Domains: ']) assert(head.includes(key), `header lacks "${key}"`);
  const domains = lines.filter((l) => l && !l.startsWith('#'));
  const declared = Number(/Domains: (\d+)/.exec(head)[1]);
  assert.strictEqual(domains.length, declared, 'declared domain count matches');
  assert(domains.length >= 1000, 'at least 1000 domains');
  const bad = domains.filter((d) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d));
  assert.strictEqual(bad.length, 0, `invalid lines: ${bad.slice(0, 3).join(', ')}`);
  assert.strictEqual(new Set(domains).size, domains.length, 'no duplicates');
  assert(!domains.includes('localhost'), 'no localhost-type names');
  assert(read('scripts/build-blocklist.js').includes('MAX_GZ'), 'build script enforces the size');
});

check('Kotlin unit tests exist for the pure files', () => {
  for (const t of ['BlocklistTest', 'FoundClassifierTest', 'LocalHostTest']) {
    assert(fs.existsSync(path.join(ROOT, `${ENGINE}/android/src/test/java/com/maglev/engine/browser/${t}.kt`)), t);
  }
});

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\ntest-browser-contract: all checks passed');
