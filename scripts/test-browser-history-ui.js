#!/usr/bin/env node
// Browser history UI (NATIVE_CONTRACT 24.9): static source checks for the wiring the screens need.
// No runtime import of React Native code; plain Node is enough.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const browser = read('app/browser.tsx');
const settings = read('app/settings/browser.tsx');
const layout = read('app/_layout.tsx');
const screen = read('app/browser-history.tsx');
const sheet = read('components/browser/ClearHistorySheet.tsx');
const sugg = read('components/browser/HistorySuggestions.tsx');
const copy = read('constants/copy.ts');

console.log('recording (H1)');
check('recordVisit is called from onPage', /onPage: \(id, e\) =>[\s\S]{0,1500}recordVisit\(/.test(browser));
check('recordVisit is guarded by loading === false', /e\.loading === false[^)]*\)\s*\{[^}]*recordVisit\(/.test(browser));
check('refused and crashed pages are never recorded', /!skipRecord\) \{[^}]*recordVisit/.test(browser) && /skipRecord = d\.crashed \|\| d\.refused != null/.test(browser) && /d\.refused = e\.reason/.test(browser) && /d\.crashed = true/.test(browser));
check('recordVisit is called nowhere else', (browser.match(/recordVisit\(/g) || []).length === 1);

console.log('browser menu and suggestions');
check('the menu has a History row that opens the screen', /title=\{historyCopy\.menuRow\}/.test(browser) && /router\.push\('\/browser-history'\)/.test(browser) && /menuRow: 'History'/.test(copy));
check('suggestions show only while editing', /\{editing \? \(\s*<HistorySuggestions/.test(browser));
check('suggestions are gated by suggestFromHistory', /prefs\.suggestFromHistory/.test(sugg));
check('suggestions are capped at 6 and ask the store', /suggestHistory\(query, 6\)/.test(sugg));
check('suggestions are debounced about 120 ms', /SUGGEST_DEBOUNCE_MS = 120/.test(sugg) && /setTimeout\([\s\S]{0,400}SUGGEST_DEBOUNCE_MS/.test(sugg));
check('a tapped suggestion loads through go()', /onPick=\{[\s\S]{0,200}go\(u\)/.test(browser));
check('typed text still goes through go(draft)', /go\(draft\)/.test(browser));

console.log('settings');
check('three history toggles', /prefs\.saveHistory/.test(settings) && /prefs\.suggestFromHistory/.test(settings) && /prefs\.clearHistoryOnClose/.test(settings));
check('toggles write their prefs', /setPrefs\(\{ saveHistory \}\)/.test(settings) && /setPrefs\(\{ suggestFromHistory \}\)/.test(settings) && /setPrefs\(\{ clearHistoryOnClose \}\)/.test(settings));
check('clear-on-close subtitle is exact', copy.includes("clearOnCloseSubtitle: 'Clears history when you close Maglev, and again when it next starts.'") && /historyCopy\.settings\.clearOnCloseSubtitle/.test(settings));
check('History row opens the screen', /router\.push\('\/browser-history'\)/.test(settings));
check('Clear history row opens the range sheet', /setClearMode\('range'\)/.test(settings));
check('Clear browsing data uses the shared sheet in browsing-data mode', /setClearMode\('browsing-data'\)/.test(settings) && /<ClearHistorySheet/.test(settings));
check('the old confirm sheet and wording are gone', !/saved pages and history/i.test(settings + copy) && !/confirmOpen/.test(settings) && !/clearBrowserData/.test(settings));

console.log('clear sheet (H3)');
check('three checkboxes', /accessibilityRole="checkbox"/.test(sheet) && /copy\.history/.test(sheet) && /copy\.cookies/.test(sheet) && /copy\.cache/.test(sheet));
check('all three start ticked', /useState<Data>\(\{ history: true, cookies: true, cache: true \}\)/.test(sheet));
check('Clear is disabled when nothing is ticked', /data\.history \|\| data\.cookies \|\| data\.cache/.test(sheet) && /disabled=\{!chosen \|\| busy\}/.test(sheet));
check('range mode has four ranges and starts with none chosen', /RANGES: ClearRange\[\] = \['hour', 'today', 'week', 'all'\]/.test(sheet) && /useState<ClearRange \| null>\(null\)/.test(sheet));
check('History clears with clearHistoryRange(all)', /clearHistoryRange\('all'\)/.test(sheet));
check('cookies and cache go through the bridge', /clearBrowserData\(\{ cookies: data\.cookies, cache: data\.cache \}\)/.test(sheet));
check('Done shows a notice, Failed offers Retry', /notices\.browser\.historyCleared/.test(sheet) && /notices\.browser\.dataCleared/.test(sheet) && /phase === 'failed' \? copy\.retry/.test(sheet));
check('copy has both notices', /historyCleared: 'History cleared\.'/.test(copy) && /dataCleared: 'Browsing data cleared\.'/.test(copy));

console.log('history screen (H2)');
check('screen is registered', /<Stack\.Screen name="browser-history" \/>/.test(layout));
check('initHistory is called in _layout', /import \{ initHistory \} from '\.\.\/utils\/history'/.test(layout) && /initHistory\(\)\.catch/.test(layout));
check('rows page 100 at a time', /const PAGE = 100/.test(screen) && /before: last\.lastVisited/.test(screen));
check('groups Today, Yesterday, weekday-date', /historyCopy\.today/.test(screen) && /historyCopy\.yesterday/.test(screen) && /weekday: 'long'/.test(screen));
check('tapping a row opens /browser with url', /pathname: '\/browser', params: \{ url \}/.test(screen));
check('row menu has Remove and Remove all from host, with a 5 s Undo through restorePages', /historyCopy\.remove\b/.test(screen) && /historyCopy\.removeHost/.test(screen) && /UNDO_MS = 5000/.test(screen) && /restorePages\(removed\)/.test(screen) && /actionLabel: 'Undo'/.test(screen));
check('Clear opens the range sheet', /<ClearHistorySheet visible=\{clearOpen\} mode="range"/.test(screen));
check('Empty, NoResults and Failed(Retry) states', /historyEmpty/.test(screen) && /historyNoResults/.test(screen) && /historyFailed/.test(screen) && /setAttempt/.test(screen));
check('the screen waits for initHistory (Loading until it ends)', /await initHistory\(\)/.test(screen));

console.log('imports and style');
const newFiles = ['app/browser-history.tsx', 'components/browser/ClearHistorySheet.tsx', 'components/browser/HistorySuggestions.tsx', 'scripts/test-browser-history-ui.js'];
check('history comes only from utils/history', [browser, settings, screen, sheet, sugg].every((s) => !/utils\/history\/(store|db)/.test(s)));
check('no hex colours in new or edited UI files', [...newFiles.slice(0, 3), 'app/browser.tsx', 'app/settings/browser.tsx'].every((f) => !/#[0-9a-fA-F]{3,8}\b/.test(read(f))));
check('no fontFamily monospace', ![screen, sheet, sugg].some((s) => /fontFamily/.test(s)));

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll browser history UI checks passed.');
