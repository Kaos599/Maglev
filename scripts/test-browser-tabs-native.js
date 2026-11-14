#!/usr/bin/env node
// Browser tabs, link menu, pop-ups and redirects (NATIVE_CONTRACT 24.10): static checks on the Kotlin.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const base = 'modules/maglev-engine/android/src/main/java/com/maglev/engine';
const view = read(`${base}/browser/MaglevBrowserView.kt`);
const wipe = read(`${base}/browser/HistoryWipe.kt`);
const host = read(`${base}/browser/RegistrableHost.kt`);
const mod = read(`${base}/MaglevEngineModule.kt`);
const fn = (src, re) => { const m = re.exec(src); return m ? m[0] : ''; };
// Body of a Kotlin function from its signature to the next 4-space-indented closing brace.
const body = (name) => fn(view, new RegExp(`fun ${name}\\([\\s\\S]*?\\n    \\}\\n`));

console.log('window settings and onCreateWindow');
check('javaScriptCanOpenWindowsAutomatically = true', /javaScriptCanOpenWindowsAutomatically\s*=\s*true/.test(view));
check('setSupportMultipleWindows(true)', view.includes('setSupportMultipleWindows(true)'));
const create = fn(view, /override fun onCreateWindow[\s\S]*?\n        \}\n/);
check('onCreateWindow exists with the capture WebView', create.includes('WebViewTransport') && create.includes('javaScriptEnabled = false'));
check('onCreateWindow never loads the target (loadUrl)', create && !/loadUrl\(/.test(create));
check('no loadUrl with the popup target anywhere (openPopupTarget removed)', !view.includes('openPopupTarget'));
const nw = body('handleNewWindow');
check('handleNewWindow drops empty and about:blank', /isEmpty\(\)/.test(nw) && /about:blank/.test(nw));
check('handleNewWindow runs mainFrameRefusal then refuse', /mainFrameRefusal\(/.test(nw) && /refuse\(url, reason\)/.test(nw));
check('handleNewWindow: gesture emits onNewWindow gesture true', /if \(gesture\)[\s\S]*?onNewWindow\(mapOf\("url" to url, "gesture" to true\)\)/.test(nw));
check('handleNewWindow: untapped follows the policy (open, ask, block)', /onNewWindow\(mapOf\("url" to url, "gesture" to false\)\)/.test(nw) && /emitRequest\(url, "window"\)/.test(nw) && /emitBlocked\(url, "window"\)/.test(nw));
check('the capture handler calls handleNewWindow', /handleNewWindow\(url, isUserGesture\)/.test(create));

console.log('redirects');
const sou = fn(view, /override fun shouldOverrideUrlLoading[\s\S]*?\n        \}\n/);
check('held redirect: !request.hasGesture()', /!request\.hasGesture\(\)/.test(sou));
check('held redirect: !request.isRedirect', /!request\.isRedirect/.test(sou));
check('held redirect: loadedOnce', /&&\s*loadedOnce/.test(sou));
check('held redirect: registrable part differs', /!RegistrableHost\.same\(uri\.host, currentHost\(\)\)/.test(sou));
check('held redirect: kind "redirect" for ask and block', /emitRequest\(uri\.toString\(\), "redirect"\)/.test(sou) && /emitBlocked\(uri\.toString\(\), "redirect"\)/.test(sou));
check('allowed or allow lets the redirect load (return false)', /PopupRules\.OPEN -> return false/.test(sou));
check('loadedOnce is set in onPageFinished', /onPageFinished[\s\S]*?loadedOnce = true/.test(view));
check('loadedOnce resets in onPageStarted only for a non-redirect load', /if \(!redirectInFlight\) loadedOnce = false/.test(view));
check('followRedirect uses mainFrameRefusal and a one-shot allowance', /fun followRedirect[\s\S]*?mainFrameRefusal[\s\S]*?followAllowUrl = url/.test(view) && /followAllowUrl == uri\.toString\(\)/.test(sou));
check('registrable host: last two labels, or three under a fixed second-level list (co.uk style)', /takeLast\(take\)/.test(host) && /second in SECOND_LEVEL/.test(host) && /length == 2/.test(host) && /"co", "com"/.test(host));
check('PopupRules.decide: untapped app is always blocked', /kind == "app" && !gesture\) return BLOCK/.test(host));

console.log('other apps');
check('app schemes are separated from refused schemes', /isAppScheme\(scheme\)/.test(sou) && /DANGEROUS_SCHEMES = setOf\("file", "content", "javascript", "data"/.test(view));
const app = body('handleAppNavigation');
check('app navigation: ask emits onPopupRequest kind app, block emits onPopupBlocked kind app', /emitRequest\(url, "app"\)/.test(app) && /emitBlocked\(url, "app"\)/.test(app));
check('app navigation: gesture decides, none means blocked', /decide\(gesture, "app"\)/.test(app) && /kind == "app" && !gesture/.test(host));
check('magnet keeps its own rule', /scheme == "magnet"[\s\S]*?onMagnet/.test(sou));

console.log('openApp sanitising');
const start = body('startApp');
check('Intent.parseUri with URI_INTENT_SCHEME', /Intent\.parseUri\(url, Intent\.URI_INTENT_SCHEME\)/.test(start));
check('CATEGORY_BROWSABLE added', /addCategory\(Intent\.CATEGORY_BROWSABLE\)/.test(start));
check('component and selector null', /intent\.component = null/.test(start) && /intent\.selector = null/.test(start));
check('FLAG_ACTIVITY_NEW_TASK', /FLAG_ACTIVITY_NEW_TASK/.test(start));
check('file, content, javascript, data are never started', /NEVER_START_SCHEMES = DANGEROUS_SCHEMES/.test(view) && /if \(scheme in NEVER_START_SCHEMES\) return Pair\(false, null\)/.test(start));
check('browser_fallback_url only when http(s)', /browser_fallback_url/.test(start) && /isWebUrl\(it\)/.test(start));
check('ActivityNotFoundException returns opened false', /catch \(_: ActivityNotFoundException\)/.test(start) && /catch \(_: Throwable\)/.test(start));
check('openApp resolves {opened, fallbackUrl} and rejects VIEW_GONE', /"opened" to result\.first, "fallbackUrl" to result\.second/.test(view) && /fun openApp[\s\S]*?VIEW_GONE/.test(view));

console.log('long press');
check('setOnLongClickListener', /setOnLongClickListener/.test(view));
const lp = body('onLongPressed');
for (const t of ['SRC_ANCHOR_TYPE', 'IMAGE_TYPE', 'SRC_IMAGE_ANCHOR_TYPE']) check(`hit test type ${t}`, lp.includes(`WebView.HitTestResult.${t}`));
check('other types return false', /else -> return false/.test(lp));
check('inactive or destroyed views ignore long presses', /destroyed \|\| !active/.test(lp));
check('imageLink href comes from requestFocusNodeHref "url"', /requestFocusNodeHref/.test(view) && /getString\("url"\)/.test(view));
check('only http(s) and magnet for links', /s == "http" \|\| s == "https" \|\| \(allowMagnet && s == "magnet"\)/.test(view));
check('the touch listener is kept', /setOnTouchListener[\s\S]*?requestDisallowInterceptTouchEvent\(true\)/.test(view));

console.log('active prop');
const act = body('applyActive');
const pn = body('pauseNow');
check('inactive: onPause and media paused (pauseNow)', /webView\.onPause\(\)/.test(pn) && /PAUSE_MEDIA_JS/.test(pn) && /querySelectorAll\('video,audio'\)\.forEach/.test(view) && /pauseNow\(\)/.test(act));
check('active: onResume', /webView\.onResume\(\)/.test(act));
check('never pauseTimers', !/pauseTimers\s*\(/.test(view));

console.log('section 30: intent sanitising');
check('launch flags cleared, then only NEW_TASK', /intent\.flags = 0\s*\n\s*intent\.addFlags\(Intent\.FLAG_ACTIVITY_NEW_TASK\)/.test(start) && !/addFlags\(Intent\.FLAG_(?!ACTIVITY_NEW_TASK)/.test(start));
check('clipData, component, selector null', /intent\.clipData = null/.test(start) && /intent\.component = null/.test(start) && /intent\.selector = null/.test(start));
check('browser_fallback_url extra removed after it was read', /removeExtra\("browser_fallback_url"\)/.test(start) && start.indexOf('getStringExtra("browser_fallback_url")') < start.indexOf('removeExtra("browser_fallback_url")'));
check('refuses package == context.packageName', /intent\.`package` == context\.packageName/.test(start));
check('refuses the maglev data scheme', /dataScheme == "maglev"/.test(start));

console.log('section 30: pop-up captures');
check('at most 3 captures: constant', /MAX_CAPTURES = 3/.test(view));
check('over the cap: onCreateWindow emits onPopupBlocked window and returns false without sending resultMsg', /captures\.size >= MAX_CAPTURES[\s\S]{0,160}emitBlocked\("", "window"\)\s*\n\s*return false/.test(create));
check('a capture is tracked when created', /captures\.add\(capture\)/.test(create));
check('a 3 s timeout destroys an unresolved capture', /CAPTURE_TIMEOUT_MS = 3000L/.test(view) && /postDelayed\(\{[\s\S]{0,120}destroyCapture\(capture\)[\s\S]{0,40}CAPTURE_TIMEOUT_MS/.test(create));
check('a resolved capture is destroyed through destroyCapture', /destroyCapture\(capture\)\s*\n\s*if \(!destroyed\) handleNewWindow/.test(create));
const dbr = body('destroyBrowser');
check('destroyBrowser destroys every capture', /for \(c in captures\.toList\(\)\) destroyCapture\(c\)/.test(dbr));
check('destroyCapture stops, destroys and forgets', /captures\.remove\(c\)/.test(body('destroyCapture')) && /c\.destroy\(\)/.test(body('destroyCapture')));

console.log('section 30: background first load');
check('hidden view pauses after the first onPageFinished', /if \(!firstLoadDone\) \{\s*firstLoadDone = true\s*\n\s*if \(!active && pausePending\) pauseNow\(\)/.test(view));
check('or after 10 s', /FIRST_LOAD_PAUSE_MS = 10_000L/.test(view) && /postDelayed\(\{ if \(pausePending && !destroyed && !active\) pauseNow\(\) \}, FIRST_LOAD_PAUSE_MS\)/.test(view));
check('applyActive defers when the first load is not done', /else if \(firstLoadDone\) \{\s*pauseNow\(\)/.test(act) && /pausePending = true/.test(act));
check('resuming cancels a pending pause', /if \(active\) \{\s*pausePending = false/.test(act));

console.log('HistoryWipe');
check('the wipe counter is bumped only after a real wipe', /fun wipeCount\(context: Context\): Int/.test(wipe) && /bumpWipeCount\(context\)/.test(wipe) && wipe.indexOf('db.close()') < wipe.indexOf('bumpWipeCount(context)') && wipe.indexOf('if (!isArmed(context)) return') < wipe.indexOf('bumpWipeCount(context)'));
check('getHistoryWipeCount is an AsyncFunction in the module and the TS bridge', /AsyncFunction\("getHistoryWipeCount"\)/.test(mod) && /HistoryWipe\.wipeCount\(c\)/.test(mod) && /export async function getHistoryWipeCount/.test(read('modules/maglev-engine/src/MaglevBrowser.tsx')));
check('deletes pages', /DELETE FROM pages/.test(wipe));
check('tabs deleted in its own try', /try \{\s*db\.execSQL\("DELETE FROM tabs"\)\s*\} catch/.test(wipe));
check('active_tab deleted in its own try', /try \{\s*db\.execSQL\("DELETE FROM meta WHERE key='active_tab'"\)\s*\} catch/.test(wipe));

console.log('module registration');
const events = /Events\(([^)]*)\)/.exec(mod.slice(mod.indexOf('View(MaglevBrowserView::class)')));
for (const e of ['onNewWindow', 'onPopupRequest', 'onPopupBlocked', 'onLongPress']) {
  check(`${e} in Events(...)`, !!events && events[1].includes(`"${e}"`));
  check(`${e} has an EventDispatcher`, new RegExp(`private val ${e} by EventDispatcher`).test(view));
}
for (const p of ['active', 'popupPolicy', 'popupAllowHosts']) check(`Prop ${p}`, new RegExp(`Prop\\("${p}"\\)`).test(mod));
for (const c of ['followRedirect', 'openApp']) check(`AsyncFunction ${c}`, new RegExp(`AsyncFunction\\("${c}"\\)\\s*\\{\\s*view:`).test(mod));
check('popupAllowHosts matched by suffix', /h == it \|\| h\.endsWith\("\.\$it"\)/.test(view) && /popupAllowHosts\.any/.test(view));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall browser tabs native checks passed');
