#!/usr/bin/env node
// Tab prefs: which tabs show and in what order. Pure helpers plus static wiring checks.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const t = require(path.join(root, 'components/tabs/tabPrefs.ts'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Defaults reproduce today's bar: Transfers, Search, Feeds, Settings, Assistant; Browser off.
const d = t.defaultTabPrefs();
check('default order is today\'s bar, Browser last', same(d.order, ['index', 'search', 'feeds', 'settings', 'assistant', 'browse']));
check('default hides only Browser', same(d.hidden, ['browse']));
check('default visible matches today (assistant on)', same(t.visibleTabs(d, { assistantEnabled: true }), ['index', 'search', 'feeds', 'settings', 'assistant']));
check('assistant setting off removes the assistant tab', same(t.visibleTabs(d, { assistantEnabled: false }), ['index', 'search', 'feeds', 'settings']));

// normalize
check('normalize(null) is defaults', same(t.normalizeTabPrefs(null), d));
check('normalize({}) is defaults', same(t.normalizeTabPrefs({}), d));
check('normalize(garbage) is defaults', same(t.normalizeTabPrefs('x'), d));
const old = t.normalizeTabPrefs({ order: ['settings', 'index'], hidden: [] });
check('missing ids are appended in default order', same(old.order, ['settings', 'index', 'search', 'feeds', 'assistant', 'browse']));
check('a new id (browse) is hidden by default when absent from stored order', old.hidden.includes('browse'));
check('unknown ids are dropped', same(t.normalizeTabPrefs({ order: ['nope', 'index', 'index', 'search'] }).order.slice(0, 2), ['index', 'search']));
check('duplicates are dropped', t.normalizeTabPrefs({ order: ['index', 'index'] }).order.length === 6);
const locked = t.normalizeTabPrefs({ order: d.order, hidden: ['index', 'settings', 'feeds', 'bogus'] });
check('Transfers and Settings cannot be hidden', !locked.hidden.includes('index') && !locked.hidden.includes('settings'));
check('other tabs can be hidden', locked.hidden.includes('feeds'));
check('unknown hidden ids are dropped', !locked.hidden.includes('bogus'));
check('browse can be turned on', !t.normalizeTabPrefs({ order: d.order, hidden: [] }).hidden.includes('browse'));

// setTabShown
check('setTabShown hides a tab', t.setTabShown(d, 'search', false).hidden.includes('search'));
check('setTabShown shows a tab', !t.setTabShown(d, 'browse', true).hidden.includes('browse'));
check('setTabShown ignores locked tabs', !t.setTabShown(d, 'index', false).hidden.includes('index'));

// moveTab
check('move down swaps with the next', same(t.moveTab(d, 'index', 'down').order.slice(0, 2), ['search', 'index']));
check('move up swaps with the previous', same(t.moveTab(d, 'search', 'up').order.slice(0, 2), ['search', 'index']));
check('move up at the top is a no-op', same(t.moveTab(d, 'index', 'up'), d));
check('move down at the bottom is a no-op', same(t.moveTab(d, 'browse', 'down'), d));
check('move skips rows that are not listed', same(t.moveTab(d, 'settings', 'down', ['index', 'search', 'feeds', 'settings', 'browse']).order, ['index', 'search', 'feeds', 'browse', 'assistant', 'settings']));
check('move does not change which tabs are hidden', same(t.moveTab(d, 'feeds', 'up').hidden, d.hidden));
check('move does not mutate its input', (() => { const c = t.defaultTabPrefs(); t.moveTab(c, 'index', 'down'); return same(c, d); })());

// visibleTabs follows order
const moved = t.setTabShown(t.moveTab(t.moveTab(d, 'settings', 'up'), 'settings', 'up'), 'browse', true);
check('visibleTabs follows saved order and shown flags', same(t.visibleTabs(moved, { assistantEnabled: true }), ['index', 'settings', 'search', 'feeds', 'assistant', 'browse']));
check('visibleTabs never returns an empty bar', t.visibleTabs({ order: [], hidden: [] }, { assistantEnabled: false }).length >= 2);

// Static wiring
const layout = read('app/(tabs)/_layout.tsx');
const iface = read('app/settings/interface.tsx');
const section = read('components/tabs/TabsSection.tsx');
check('layout reads the tab prefs', /useTabPrefs\(\)/.test(layout) && /visibleTabs\(/.test(layout));
check('layout renders Tabs.Screen from the saved order', /prefs\.order\.map|order\.map/.test(layout));
check('layout still asks the assistant setting', /useAssistantPrefs\(\)/.test(layout) && /assistant\.enabled/.test(layout));
check('layout declares the browser tab with the network icon', /tab\('browse', 'Browser', 'network'/.test(layout));
check('layout falls back to Transfers when the open tab is hidden', /go\('index'\)/.test(layout));
check('layout draws non-glyph icons with PixelIcon', /PixelIcon/.test(layout) && /TAB_GLYPHS/.test(layout));
check('browse tab route reuses the browser screen', /from '\.\.\/browser'/.test(read('app/(tabs)/browse.tsx')));
check('interface screen shows the Tabs section', /TabsSection/.test(iface));
// 0.15: arrow buttons became hold-and-drag; Move up / Move down stay as accessibility actions on the grip.
check('section reorders by drag and keeps Move up / Move down for TalkBack', /GestureDetector/.test(section) && /Move up/.test(section) && /Move down/.test(section) && /accessibilityActions/.test(section));
check('section captions locked tabs "Always shown"', /alwaysShown/.test(section) && /Always shown/.test(read('constants/copy.ts')));
check('section hides the Assistant row when the assistant is off', /assistant\.enabled/.test(section));
check('section uses a 44px target', /touch\./.test(section) || /44/.test(section));
check('section uses no raw hex colours', !/#[0-9a-fA-F]{3,8}\b/.test(section));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
