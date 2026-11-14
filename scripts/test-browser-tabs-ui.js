#!/usr/bin/env node
// Browser tabs, link menu, pop-up card and settings (NATIVE_CONTRACT 24.10): static checks on the screens.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const HEX = /#[0-9a-fA-F]{3,8}\b/;

const scr = read('app/browser.tsx');
const view = read('components/browser/TabWebView.tsx');
const hook = read('components/browser/useTabs.ts');
const store = read('utils/browser/tabStore.ts');
const shared = read('utils/browser/tabData.ts');
const opener = read('utils/browser/openBrowser.ts');
const sw = read('components/browser/TabSwitcher.tsx');
const menu = read('components/browser/LinkMenu.tsx');
const card = read('components/browser/PopupCard.tsx');
const set = read('app/settings/browser.tsx');
const copy = read('constants/copy.ts');
const pkg = read('package.json');

console.log('one view per live tab');
check('the screen maps liveTabs to TabWebView', /liveTabs\(tabsState\)[\s\S]{0,600}<TabWebView/.test(scr));
check('each view is keyed by its tab id and gets active={t.id === activeId}', /key=\{t\.id\}/.test(scr) && /active=\{focused && appForeground && t\.id === activeId\}/.test(scr));
check('the screen no longer mounts MaglevBrowser itself', !/<MaglevBrowser\b/.test(scr));
check('the view forwards active to the native view', /active=\{active\}/.test(view));
check('an inactive view is hidden: opacity 0 and pointerEvents none', /opacity: 0/.test(view) && /pointerEvents=\{active \? 'auto' : 'none'\}/.test(view));
check('views are stacked with absolute fill', /StyleSheet\.absoluteFill/.test(view));
check('every event handler gets the tab id', ['onPage', 'onFound', 'onBlockedCount', 'onDownloadRequest', 'onMagnet', 'onRefused', 'onCrashed', 'onPageNote', 'onNewWindow', 'onPopupRequest', 'onPopupBlocked', 'onLongPress'].every((n) => new RegExp(`${n}=\\{\\([^)]*\\) => h\\.${n}\\(id`).test(view)));
check('the view takes the pop-up policy and allow list', /popupPolicy=\{popupPolicy\}/.test(view) && /popupAllowHosts=\{popupAllowHosts\}/.test(view) && /popupPolicy=\{prefs\.popupPolicy\}/.test(scr) && /popupAllowHosts=\{prefs\.popupAllowHosts\}/.test(scr));
check('the initial address never follows the page', /initialUrls/.test(scr) && !/url=\{page\.url/.test(scr));
check('per-tab state is keyed by tab id (page, found, dismissed, blocked)', /new Map<string, TabData>/.test(shared) && /dismissed: ReadonlySet<string>/.test(shared) && /blocked: number/.test(shared));
check('a tab that sleeps or closes loses its page state', /!live\.has\(id\)\) tabData\.delete\(id\)/.test(scr));

console.log('tab state and saving');
check('first open restores through loadTabs and restoreTabs, else one blank tab', /deps\.load\(\)/.test(store) && /restoreTabs\(/.test(store) && /createTabsState\(/.test(store) && /load: loadTabs/.test(hook));
check('state is module-level and read with useSyncExternalStore', /let state: TabsState \| null/.test(store) && /export const tabStore = createTabStore\(\)/.test(store) && /useSyncExternalStore\(tabStore\.subscribe/.test(hook));
check('the hook holds no per-instance tab state', !/useState|useRef/.test(hook));
check('every change is saved with scheduleSave', /deps\.scheduleSave\(rows, activeId\)/.test(store) && /scheduleSave: scheduleSaveTabs/.test(hook));
check('tabs are flushed on blur and unmount', /flushTabs\(\)/.test(scr) && /tabStore\.flush\(\)/.test(hook));
check('Save history off: memory only, saved rows deleted when it turns off', /if \(!deps\.saveHistory\(\)\) return/.test(store) && /deps\.deleteSaved\(\)/.test(store) && /subscribePrefs: subscribeBrowserPrefs/.test(hook) && /deleteSaved: deleteSavedTabs/.test(hook));
check('a screen mount checks the native wipe count', /tabStore\.checkWipe\(\)/.test(hook) && /wipeCount: getHistoryWipeCount/.test(hook));

console.log('one screen, one tab set (section 30)');
check('only the owner instance renders TabWebView', /tabsState && isOwner\s*\?\s*liveTabs\(tabsState\)/.test(scr));
check('the owner token is set on focus and released on unmount', /setViewOwner\(instanceId\)/.test(scr) && /releaseViewOwner\(instanceId\)/.test(scr) && /export function setViewOwner/.test(shared));
check('a blur alone does not release the token (a blurred browser keeps its pages)', !/blur[\s\S]{0,80}releaseViewOwner/.test(scr));
check('active includes focus and app foreground', /useIsFocused\(\)/.test(scr) && /AppState\.addEventListener\('change'/.test(scr) && /active=\{focused && appForeground && t\.id === activeId\}/.test(scr));
check('found, page and pop-up state are shared between instances', /export const tabData = new Map/.test(shared) && /export function setPopupsState/.test(shared) && !/useReducer/.test(scr) && !/const dataRef/.test(scr));
const sites = ['app/(tabs)/index.tsx', 'app/(tabs)/search.tsx', 'app/add-download.tsx', 'app/browser-history.tsx'];
check('every /browser navigation goes through openBrowser', sites.every((f) => /openBrowser\(router/.test(read(f)) && /utils\/browser\/openBrowser/.test(read(f))));
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const raw = [...walk('app'), ...walk('components')].filter((f) => /\.tsx?$/.test(f)).filter((f) => /(push|replace|navigate|dismissTo)\(\s*(\{\s*pathname:\s*)?['"]\/browser['"]/.test(read(f)));
check('no raw push/replace/dismissTo to /browser outside the helper', raw.length === 0, raw.join());
check('the helper goes to the Browse tab when shown, else the stack route', /visibleTabs\(getTabPrefs\(\)/.test(opener) && /includes\('browse'\)/.test(opener) && /pathname: '\/browse'/.test(opener) && /pathname: '\/browser'/.test(opener) && /params: clean/.test(opener));

check('a route url opens a new active tab, prefill only fills the bar', /params\.url/.test(scr) && /openTabChecked\(\{ url: t\.url \}\)/.test(scr) && /setPrefillText\(params\.prefill\)/.test(scr));
check('the cap shows the notice and opens nothing', /r\.result === 'cap'/.test(scr) && /browserTabs\.capNotice/.test(scr));
check('a window request opens a tab with this tab as opener', /onNewWindow: \(id, e\) => void openTabChecked\(\{ url: e\.url, opener: id \}\)/.test(scr));

console.log('tab button');
check('beside the menu: count in a box, :D above 99', /tabCount > 99 \? browserTabs\.tabButtonMany : tabCount/.test(scr) && /browserTabs\.tabButtonLabel\(tabCount\)/.test(scr));
check('tap opens the switcher, long press opens a new tab', /setSwitcherOpen\(true\)/.test(scr) && /onLongPress=\{newTab\}/.test(scr));
check('the tab button is a 44 px target', /tabButton: \{ width: 44, height: 44/.test(scr));

console.log('switcher');
check('newest first through switcherOrder', /tabs=\{switcherOrder\(tabsState\)\}/.test(scr));
check('rows show title (host or New tab fallback), host and a close X', /browserTabs\.switcher\.blankTitle/.test(sw) && /hostOf\(t\.url\)/.test(sw) && /icon="close"/.test(sw));
check('the X says Close {title}', /browserTabs\.switcher\.closeTabLabel\(title\)/.test(sw));
check('the active row is highlighted', /rowActive/.test(sw) && /item\.id === activeId/.test(sw));
check('the header has New tab and a menu with Close all tabs', /browserTabs\.switcher\.newTab/.test(sw) && /browserTabs\.switcher\.menuLabel/.test(sw) && /browserTabs\.switcher\.closeAll/.test(sw));
check('closing one or all offers Undo for 5 s', /UNDO_MS = 5000/.test(scr) && /browserTabs\.closedTab/.test(scr) && /browserTabs\.closedAll/.test(scr) && /actionLabel: browserTabs\.undo/.test(scr) && /tabs\.undo\(u\)/.test(scr));
check('the X and menu targets are IconButtons (44 px)', /<IconButton[\s\S]{0,60}icon="close"/.test(sw) && /<IconButton icon="more"/.test(sw));

console.log('long-press menu');
check('is a FloatingSheet titled with the middle-truncated address', /<FloatingSheet visible=\{target != null\}/.test(menu) && /middleTruncate\(/.test(menu));
check('link rows', ['openNewTab', 'openBackground', 'copyLink', 'downloadLink', 'shareLink'].every((k) => new RegExp(`L\\.${k}\\b`).test(menu)));
check('image rows', ['openImageNewTab', 'downloadImage', 'copyImageLink', 'shareImageLink'].every((k) => new RegExp(`L\\.${k}\\b`).test(menu)));
check('imageLink: link rows, then Download image', /t\.kind === 'imageLink' && image\) out\.push\(\{ icon: 'download', title: L\.downloadImage/.test(menu) && /if \(link\) out\.push\(\.\.\.linkRows\(link\)\)/.test(menu));
check('magnet: Add torrent and Copy link only', /startsWith\('magnet:'\)[\s\S]{0,300}L\.addTorrent[\s\S]{0,200}L\.copyLink[\s\S]{0,100}return out/.test(menu));
check('copy uses expo-clipboard, share uses Share', /Clipboard\.setStringAsync/.test(menu) && /Share\.share/.test(menu));
check('Download goes through the found-file download card', /downloadLink/.test(scr) && /setTarget\(\{ url, name: nameFromUrl\(url\)/.test(scr) && /<FoundDownloadSheet target=\{target\}/.test(scr));
check('Open in background tab opens asleep and offers Switch', /background/.test(scr) && /browserTabs\.openedInNewTab/.test(scr) && /actionLabel: browserTabs\.switchTo/.test(scr));
check('a magnet goes to the add-torrent route', /addTorrent=\{toAddTorrent\}/.test(scr));
check('a tab switch closes the menu', /setLinkTarget\(null\);\s*setUndo\(null\);\s*\}, \[activeId\]\)/.test(scr));
check('only the active tab opens the menu', /if \(id === activeIdRef\.current\) setLinkTarget\(e\)/.test(scr));

console.log('pop-up card');
check('is a FloatingSheet with a title per kind', /<FloatingSheet visible=\{prompt != null\}/.test(card) && /browserTabs\.popup\.windowTitle/.test(card) && /browserTabs\.popup\.redirectTitle/.test(card) && /browserTabs\.popup\.appTitle/.test(card));
check('body shows the target host (scheme for an app) and "and N more blocked"', /kind === 'app'/.test(card) && /browserTabs\.popup\.moreBlocked\(p\.more\)/.test(card));
check('buttons Open, Block and "Always allow on {sourceHost}"', /browserTabs\.popup\.open/.test(card) && /browserTabs\.popup\.block/.test(card) && /browserTabs\.popup\.alwaysAllow\(sourceHost\)/.test(card));
check('scrim and Back count as Block', /onClose=\{onBlock\}/.test(card));
check('Open: window opens a tab with the opener, redirect follows, app opens the app', /req\.kind === 'window'[\s\S]{0,120}opener: id/.test(scr) && /followRedirect\(req\.url\)/.test(scr) && /openApp\(req\.url\)/.test(scr));
check('an app that does not open falls back or says no app', /r\.fallbackUrl[\s\S]{0,120}followRedirect\(r\.fallbackUrl\)/.test(scr) && /browserTabs\.popup\.noApp/.test(scr));
check('the card state is the T5 queue (request, noteBlocked, drop)', /popupsApi\.request\(/.test(scr) && /popupsApi\.noteBlocked\(/.test(scr) && /popupsApi\.drop\(p, id, 'navigated'\)/.test(scr) && /popupsApi\.drop\(p, id, 'closed'\)/.test(scr));
check('Always allow adds the source host to the allow list', /allowForSite\(/.test(scr) && /popupAllowHosts: r\.allowHosts/.test(scr));
check('the card shows for the active tab', /promptFor\(popups, activeId\)/.test(scr) && /<PopupCard prompt=\{prompt\}/.test(scr));

console.log('back');
check('back uses backTarget after the page cannot go back', /backTarget\(cur, activeId, !!page\?\.canGoBack\)/.test(scr));
check('goBack, close-and-switch to the opener, or leave', /next === 'goBack'/.test(scr) && /next === 'leave'\) return false/.test(scr) && /tabs\.close\(activeId\)/.test(scr));
const back = scr.slice(scr.indexOf('const handleBack'), scr.indexOf('useFocusEffect('));
check('order: address bar, switcher, menu, pop-up card, then the tab', ['editing', 'switcherOpen', 'linkTarget', 'prompt', 'backTarget'].map((k) => back.indexOf(k)).every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])));

console.log('This page menu');
check('"Pop-ups" row sits under the ads row', scr.indexOf('toggleAds}') > 0 && scr.indexOf('browserTabs.thisPage.popupsRow') > scr.indexOf('toggleAds}'));
check('subtitle is "N blocked on this page", hidden at 0', /popupsBlockedHere > 0 \? browserTabs\.thisPage\.blockedOnPage\(popupsBlockedHere\) : undefined/.test(scr));
check('tapping toggles the site in popupAllowHosts', /popupAllowHosts: toggleAllowedHost\(p\.popupAllowHosts, pageHost\)/.test(scr));

console.log('settings');
check('section "Pop-ups and redirects"', /browserTabs\.settings\.section/.test(set));
check('radio rows Ask, Block without asking, Allow write popupPolicy', /browserTabs\.settings\.ask/.test(set) && /browserTabs\.settings\.block/.test(set) && /browserTabs\.settings\.allow/.test(set) && /setPrefs\(\{ popupPolicy: c\.value \}\)/.test(set) && /selected=\{prefs\.popupPolicy === c\.value\}/.test(set));
check('"Sites allowed to open pop-ups" with Remove', /browserTabs\.settings\.allowedSites/.test(set) && /browserTabs\.settings\.remove/.test(set) && /popupAllowHosts: prefs\.popupAllowHosts\.filter/.test(set));

console.log('copy and style');
check('copy keys exist', ['tabButtonMany', 'capNotice', 'openedInNewTab', 'switchTo', 'closedTab', 'closedAll', 'popupsRow', 'blockedOnPage'].every((k) => copy.includes(k)));
check('no hex colours and no system monospace in the new files', [view, hook, sw, menu, card, set, scr].every((s) => !HEX.test(s) && !/fontFamily: 'monospace'/.test(s)));
check('icons come from PixelIcon only', [sw, menu, card].every((s) => !/@expo\/vector-icons/.test(s)));
check('the test is chained after test-browser-tabs.js', /node scripts\/test-browser-tabs\.js && node scripts\/test-browser-tabs-ui\.js/.test(pkg));

const tabRoute = read('app/(tabs)/browse.tsx');
check('in the tab bar the screen skips the bottom inset (the tab bar already pads for it)', /<BrowserScreen inTab \/>/.test(tabRoute) && /edges=\{inTab \? \['top', 'left', 'right'\] : \['top', 'left', 'right', 'bottom'\]\}/.test(scr));

// 24.11 history from a blank tab
const recentPath = path.join(root, 'components/browser/RecentHistory.tsx');
const recent = fs.existsSync(recentPath) ? fs.readFileSync(recentPath, 'utf8') : '';
check('⋮ is enabled on a blank tab (gated on ready, not on a page)', /icon="more" accessibilityLabel="More" disabled=\{!ready\}/.test(scr) && !/icon="more"[^\n]*disabled=\{!hasPage\}/.test(scr));
check('with no page the sheet is titled Browser', /title=\{hasPage \? historyCopy\.menuTitlePage : historyCopy\.menuTitleBlank\}/.test(scr) && /menuTitleBlank: 'Browser'/.test(read('constants/copy.ts')));
check('page-only rows sit behind hasPage; History and Browser settings do not', /\{hasPage \? \(\s*<>[\s\S]*?title="Forward"[\s\S]*?findCopy\.menuRow[\s\S]*?textSizeCopy\.menuRow[\s\S]*?Desktop site[\s\S]*?Copy page link[\s\S]*?<\/>\s*\) : null\}\s*<ListRow\s+icon="clock"/.test(scr));
check('a blank tab shows Recent, falling back to the start block', /<RecentHistory[\s\S]{0,200}fallback=\{<EmptyBlock icon="network"/.test(scr));
check('Recent lists 6 from history, refreshes on change, and links to the History screen', /listHistory\(\{ limit: RECENT_LIMIT \}\)/.test(recent) && /RECENT_LIMIT = 6/.test(recent) && /useHistoryVersion\(\)/.test(recent) && /\/browser-history/.test(recent) && /historyCopy\.recent\.seeAll/.test(recent));
check('Recent shows nothing when Save history is off or the store fails', /saveHistory/.test(recent) && /\(\) => \{\s*if \(live\) setRows\(\[\]\)/.test(recent));

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('all passed');
