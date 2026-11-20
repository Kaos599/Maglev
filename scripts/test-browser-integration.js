#!/usr/bin/env node
// Browser integration (NATIVE_CONTRACT 24.10a): start page, bookmark toggle, media long-press, pull to reload,
// dark pages and "Clear this site's data". Kotlin is not compiled here (CI does that), so these read the source.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const scr = read('app/browser.tsx');
const tab = read('components/browser/TabWebView.tsx');
const wrap = read('modules/maglev-engine/src/MaglevBrowser.tsx');
const kt = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/browser/MaglevBrowserView.kt');
const mod = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt');
const gradle = read('modules/maglev-engine/android/build.gradle');
const prefs = read('utils/prefs/browser.ts');
const settings = read('app/settings/browser.tsx');
const index = read('utils/settingsIndex.ts');
const copy = read('constants/copy.ts');

// ---- start page and bookmarks ----
check('a blank tab mounts StartPage', /<StartPage[\s\S]{0,300}privateMode=\{prefs\.privateBrowsing\}/.test(scr) && /\{!hasPage \? \(\s*<StartPage/.test(scr));
check('StartPage opens a new tab or the current one', /o\?\.newTab\) openTabChecked\(\{ url \}\)[\s\S]{0,40}else go\(url\)/.test(scr));
check('RecentHistory is gone', !fs.existsSync(path.join(root, 'components/browser/RecentHistory.tsx')) && !/RecentHistory/.test(scr));
check('the page menu has the bookmark toggle', /<BookmarkToggle url=\{page\?\.url \?\? tab\?\.url \?\? ''\} title=\{page\?\.title \?\? tab\?\.title \?\? ''\} onDone=\{\(\) => setMenuOpen\(false\)\} \/>/.test(scr));
check('the toggle sits after Copy page link, inside the page-only rows', /Copy page link[\s\S]*?<BookmarkToggle[\s\S]*?<\/>\s*\) : null\}/.test(scr));

// ---- media long press ----
check('TS: onMediaHit is a wrapper prop and a native event', /onMediaHit\?: \(e: BrowserMediaHitEvent\) => void;/.test(wrap) && /onMediaHit\?: \(e: NativeEvent<BrowserMediaHitEvent>\) => void;/.test(wrap) && /onMediaHit=\{onMediaHit \? \(e\) => onMediaHit\(e\.nativeEvent\)/.test(wrap));
check('TS: the view gets mediaHitScript(\'\') (no nonce is needed)', /mediaHitScript\(''\)/.test(tab) && /mediaHitScript=\{MEDIA_HIT_SCRIPT\}/.test(tab) && /onMediaHit=\{\(e\) => h\.onMediaHit\(id, e\)\}/.test(tab));
check('screen: only a video hit for the active tab opens the media menu', /onMediaHit: \(id, e\) => \{\s*if \(id !== activeIdRef\.current\) return;\s*const hit = parseMediaHit\(e\.json\);\s*if \(hit && hit\.kind === 'video' && hasMenu\(buildMediaMenu\(hit\)\)\) setMediaHit\(hit\);/.test(scr));
check('screen: MediaMenu is wired to save, stream, tab, copy, share, files and link options', /<MediaMenu[\s\S]*?onSave=[\s\S]*?onStream=\{streamFromHit\}[\s\S]*?onOpenNewTab=[\s\S]*?onCopy=[\s\S]*?onShare=[\s\S]*?Share\.share[\s\S]*?onShowFound=\{\(\) => setTrayOpen\(true\)\}[\s\S]*?onLinkOptions=/.test(scr));
check('screen: Back closes the media menu', /if \(mediaHit\) \{\s*setMediaHit\(null\);\s*return true;/.test(scr));
check('Kotlin: onMediaHit is registered in the view events and as a dispatcher', /"onFindResult", "onMediaHit"\)/.test(mod) && /private val onMediaHit by EventDispatcher/.test(kt));
check('Kotlin: the long press asks the page for __maglevMediaHit and emits the decoded payload', /evaluateJavascript\("window\.__maglevMediaHit && window\.__maglevMediaHit\(\)"\)/.test(kt) && /JSONTokener\(value\)\.nextValue\(\) as\? String/.test(kt) && /optString\("type"\) != "maglev-media-hit"/.test(kt) && /onMediaHit\(mapOf\("json" to payload\)\)/.test(kt));
check('Kotlin: text selection is kept (the listener returns false for a non-image, non-link hit)', /askMediaHit\(w\)\s*return false/.test(kt));
check('Kotlin: the media script is injected at both PageScan call sites', (kt.match(/if \(mediaHitJs\.isNotEmpty\(\)\) (?:webView|view)\.evaluateJavascript\(mediaHitJs, null\)/g) || []).length === 2 && /Prop\("mediaHitScript"/.test(mod));
check('images stay on the link menu', /kind: 'link', url: href/.test(scr) && /hit\.kind === 'video'/.test(scr));

// ---- pull to reload ----
check('Kotlin: the WebView sits in a SwipeRefreshLayout', /import androidx\.swiperefreshlayout\.widget\.SwipeRefreshLayout/.test(kt) && /private val refresh = SwipeRefreshLayout\(context\)/.test(kt) && (kt.match(/refresh\.addView\(webView/g) || []).length === 2);
check('Kotlin: a pull reloads, and the child-scroll callback blocks it off the top, in find and in a selection', /refresh\.setOnRefreshListener/.test(kt) && /setOnChildScrollUpCallback \{ _, _ -> selectionHold \|\| findActive \|\| webView\.canScrollVertically\(-1\) \}/.test(kt));
check('Kotlin: the spinner stops when the load ends and has a safety timeout', /refresh\.isRefreshing = false/.test(kt) && /PULL_SAFETY_MS/.test(kt));
check('Kotlin: props pullToRefresh, refreshColor and refreshBackground', /Prop\("pullToRefresh"/.test(mod) && /Prop\("refreshColor"/.test(mod) && /Prop\("refreshBackground"/.test(mod) && /setColorSchemeColors/.test(kt) && /setProgressBackgroundColorSchemeColor/.test(kt));
check('TS: the screen passes pullToRefresh and theme colours', /pullToRefresh\s+refreshColor=\{colors\.accent\}\s+refreshBackground=\{colors\.surface\}/.test(scr) && /pullToRefresh\?: boolean;/.test(wrap));
check('gradle: swiperefreshlayout dependency', /androidx\.swiperefreshlayout:swiperefreshlayout:1\.1\.0/.test(gradle));

// ---- dark pages ----
check('Kotlin: algorithmic darkening only when the feature is supported', /WebViewFeature\.isFeatureSupported\(WebViewFeature\.ALGORITHMIC_DARKENING\)[\s\S]{0,120}WebSettingsCompat\.setAlgorithmicDarkeningAllowed\(w\.settings, darkPages\)/.test(kt) && /Prop\("darkPages"/.test(mod));
check('gradle: androidx.webkit dependency', /androidx\.webkit:webkit:/.test(gradle));
check('pref: darkPages defaults on and only false turns it off', /darkPages: boolean;/.test(prefs) && /darkPages: true,/.test(prefs) && /darkPages: o\.darkPages !== false,/.test(prefs));
check('screen: darkPages is the pref and the app being dark', /darkPages=\{prefs\.darkPages && dark\}/.test(scr) && /const \{ colors, dark \} = useTheme\(\)/.test(scr));
check('settings: a Dark pages row with a caption', /browserTabs\.settings\.darkPages\}\s+subtitle=\{browserTabs\.settings\.darkPagesSubtitle\}/.test(settings) && /darkPages: 'Dark pages'/.test(copy) && /Darken pages that only have a light look, when Maglev is dark\./.test(copy));
check('settings index: Dark pages with keywords', /"browser-dark-pages",\s*"Dark pages",\s*"browser",\s*"Browser",\s*\[[^\]]*"dark"[^\]]*"night"[^\]]*"pages"[^\]]*"websites"[^\]]*"theme"/.test(index));
check('backup restores the pref through normalizeBrowserPrefs', /normalizeBrowserPrefs\(value\)/.test(read('utils/backup/io.ts')));

// ---- clear this site's data ----
check('Kotlin: clearSiteStorage clears local and session storage and is a view command', /localStorage\.clear\(\);sessionStorage\.clear\(\)/.test(kt) && /AsyncFunction\("clearSiteStorage"/.test(mod));
check('TS: clearSiteStorage is on the ref', /clearSiteStorage\(\): Promise<void>;/.test(wrap) && /clearSiteStorage: \(\) => nativeRef\.current\?\.clearSiteStorage\(\)/.test(wrap));
check('screen: cookies of the host and parents, minus Search hosts, then storage, then reload, then the notice', /hostsToWipe\(\[url\], keepHosts\(\)\)[\s\S]*?clearCookies\(targets\)[\s\S]*?clearSiteStorage\(\)[\s\S]*?\.reload\(\)[\s\S]*?clearSiteDone/.test(scr) && /export function keepHosts/.test(read('utils/browser/privateSession.ts')));
check('screen: the row asks first, in a Dialog, with a danger Clear and Cancel', /<Dialog\s+visible=\{clearSiteOpen\}[\s\S]*?clearSiteTitle[\s\S]*?clearSiteAction\}\s+variant="danger"[\s\S]*?Cancel/.test(scr) && /clearSiteBody\(pageHost\)/.test(scr));
check('screen: the row is for http(s) pages and opens the Dialog, not the action', /\^https\?:\\\/\\\/\/i\.test\(page\?\.url \?\? ''\)[\s\S]{0,200}clearSiteRow[\s\S]{0,160}setClearSiteOpen\(true\)/.test(scr));
check('copy follows the contract', /clearSiteRow: "Clear this site's data"/.test(copy) && /clearSiteDone: "Cleared this site's data"/.test(copy) && /clearSiteBody: \(host: string\) => `You'll be signed out of \$\{host\}\.`/.test(copy));

// ---- motion and accessibility ----
const swipeTabs = read('components/browser/AddressSwipe.tsx');
check('AddressSwipe: slide uses motion.duration.base and is instant under reduce motion', /useReduceMotion\(\)/.test(swipeTabs) && /reduceMotion \? 0 : motion\.duration\.base/.test(swipeTabs) && !/SLIDE_MS/.test(swipeTabs));
const swipeRow = read('components/transfers/SwipeRow.tsx');
check('SwipeRow: the hidden panels are out of the accessibility tree', /importantForAccessibility="no-hide-descendants" accessibilityElementsHidden/.test(swipeRow));
check('the cards expose Pause/Resume and Remove as accessibility actions', /name: action\.kind/.test(read('components/transfers/DownloadCard.tsx')) && /name: "remove"/.test(read('components/TransferCard.tsx')) && /name: 'remove'/.test(read('components/transfers/DownloadCard.tsx')));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nbrowser integration: all checks passed');
