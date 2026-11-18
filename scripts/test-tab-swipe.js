#!/usr/bin/env node
// Address bar swipe (tabs): the pure decisions and the browser pref. Needs Node 22.18+ (runs the TypeScript source).
process.removeAllListeners('warning');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const stubs = {
  'expo-sqlite/kv-store': `export default { getItemSync: () => null, setItemSync: () => {} };`,
  react: `export const useSyncExternalStore = () => 0;`,
};
require('node:module').registerHooks({
  resolve(spec, ctx, next) {
    if (stubs[spec]) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[spec]), shortCircuit: true, format: 'module' };
    try { return next(spec, ctx); } catch (e) {
      if (spec.startsWith('.') && !/\.\w+(\?.*)?$/.test(spec)) return next(spec + '.ts', ctx);
      throw e;
    }
  },
});
const path = require('path');
const s = require(path.join(__dirname, '../utils/browser/tabSwipe.ts'));
const prefs = require(path.join(__dirname, '../utils/prefs/browser.ts'));
const fs = require('fs');

console.log('decideSwipe');
check('left past distance goes to next', s.decideSwipe(-80, 0, 0, 3) === 'next');
check('right past distance goes to previous', s.decideSwipe(80, 0, 2, 3) === 'prev');
check('short slow drag does nothing', s.decideSwipe(-30, -100, 0, 3) === 'none');
check('fast flick switches on a short drag', s.decideSwipe(-24, -900, 0, 3) === 'next');
check('flick against the drag direction does not count', s.decideSwipe(-24, 900, 0, 3) === 'none');
check('tiny jitter with high velocity does nothing', s.decideSwipe(-6, -2000, 0, 3) === 'none');
check('no wrap at the last tab', s.decideSwipe(-200, -900, 2, 3) === 'none');
check('no wrap at the first tab', s.decideSwipe(200, 900, 0, 3) === 'none');
check('one tab does nothing', s.decideSwipe(-200, -900, 0, 1) === 'none' && s.decideSwipe(200, 900, 0, 1) === 'none');
check('no tabs does nothing', s.decideSwipe(-200, 0, 0, 0) === 'none');
check('bad index does nothing', s.decideSwipe(-200, 0, 5, 3) === 'none' && s.decideSwipe(-200, 0, -1, 3) === 'none');
check('NaN does nothing', s.decideSwipe(NaN, 0, 0, 3) === 'none');
check('middle tab moves both ways', s.decideSwipe(-80, 0, 1, 3) === 'next' && s.decideSwipe(80, 0, 1, 3) === 'prev');

console.log('neighbourIndex and dragOffset');
check('neighbour left drag', s.neighbourIndex(-10, 1, 3) === 2);
check('neighbour right drag', s.neighbourIndex(10, 1, 3) === 0);
check('no neighbour at the ends', s.neighbourIndex(-10, 2, 3) === null && s.neighbourIndex(10, 0, 3) === null);
check('no neighbour with one tab', s.neighbourIndex(-10, 0, 1) === null);
check('drag follows 1:1 and clamps', s.dragOffset(-30, true) === -30 && s.dragOffset(-500, true) === -s.SWIPE_MAX_DRAG_DP);
check('rubber band at an end is smaller and capped', s.dragOffset(-30, false) === -10 && s.dragOffset(-500, false) === -s.SWIPE_MAX_DRAG_DP / 4);

console.log('edges and vertical');
check('left edge start rejected', s.swipeStartsAtEdge(10, 400) === true);
check('right edge start rejected', s.swipeStartsAtEdge(390, 400) === true);
check('middle start accepted', s.swipeStartsAtEdge(24, 400) === false && s.swipeStartsAtEdge(200, 400) === false);
check('unknown width rejects', s.swipeStartsAtEdge(200, NaN) === true);
check('down swipe opens the switcher', s.decideVertical(60, 0) === 'switcher' && s.decideVertical(20, 800) === 'switcher');
check('up swipe and short pull do not', s.decideVertical(-80, -900) === 'none' && s.decideVertical(10, 100) === 'none');

console.log('pref');
check('default on', prefs.defaultBrowserPrefs().swipeTabs === true);
check('missing field is on', prefs.normalizeBrowserPrefs({}).swipeTabs === true);
check('false is kept', prefs.normalizeBrowserPrefs({ swipeTabs: false }).swipeTabs === false);
check('junk falls back to on', prefs.normalizeBrowserPrefs({ swipeTabs: 'no' }).swipeTabs === true);

console.log('wiring');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
check('settings screen has the switch', read('app/settings/browser.tsx').includes('swipeTabs'));
check('browser screen uses the swipe bar', read('app/browser.tsx').includes('AddressSwipe') && read('app/browser.tsx').includes('swipeTabs'));
check('swipe component turns off while editing', /enabled/.test(read('components/browser/AddressSwipe.tsx')));

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall tab swipe checks passed');
