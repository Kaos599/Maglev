#!/usr/bin/env node
// Swipe actions on Transfers rows: which actions each state gets, the setting, and the wiring.
// Swipe right = Pause/Resume, swipe left = Remove from the list (files kept, with Undo). Needs Node 22.18+.
process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

(async () => {
  const { swipePlan } = await import('../components/transfers/swipe.ts');
  const M = await import('../components/transfers/model.ts');
  const D = await import('../utils/downloadCopy.ts');
  const base = { busy: false, selectionMode: false, enabled: true };

  console.log('[plan]');
  const pause = { kind: 'pause', label: 'Pause' };
  const resume = { kind: 'resume', label: 'Resume' };
  check('running: Pause right, Remove left', JSON.stringify(swipePlan({ ...base, action: pause })) === '{"right":{"kind":"pause","label":"Pause"},"left":true}');
  check('paused: Resume right, Remove left', swipePlan({ ...base, action: resume }).right.kind === 'resume' && swipePlan({ ...base, action: resume }).left);
  check('failed torrent: Retry is a Resume swipe', swipePlan({ ...base, action: { kind: 'resume', label: 'Retry' } }).right.label === 'Retry');
  for (const kind of ['open', 'keepTrying', 'resumeAnyway', 'freeSpace', 'setting', 'retry', 'newLink', 'pickFolder']) {
    check(`${kind} button never becomes a right swipe`, swipePlan({ ...base, action: { kind, label: 'x' } }).right === null);
  }
  check('finished (Open): no right swipe, Remove left stays', swipePlan({ ...base, action: { kind: 'open', label: 'Open' } }).left === true);
  check('no button: Remove only', (() => { const p = swipePlan({ ...base, action: null }); return p.right === null && p.left; })());
  check('busy row: nothing', swipePlan({ ...base, action: pause, busy: true }).right === null && !swipePlan({ ...base, action: pause, busy: true }).left);
  check('moving files: no Remove, Pause rule unchanged', !swipePlan({ ...base, action: null, moving: true }).left);
  check('selection mode: nothing', (() => { const p = swipePlan({ ...base, action: pause, selectionMode: true }); return p.right === null && !p.left; })());
  check('setting off: nothing', (() => { const p = swipePlan({ ...base, action: pause, enabled: false }); return p.right === null && !p.left; })());

  console.log('[panel visibility]');
  // The panels sit under the card with the same rounded corners; drawn at rest, they bleed a 1-2 px red or
  // lime line through the card's anti-aliased corners. A panel is drawn only while its own side is revealed.
  const { panelOpacity } = await import('../components/transfers/swipe.ts');
  check('at rest: hidden', panelOpacity(0, 72) === 0);
  check('a sub-pixel leftover after the spring back: hidden', panelOpacity(0.4, 72) === 0);
  check('the other side is being revealed (negative): hidden', panelOpacity(-30, 72) === 0);
  check('dragging, before the trigger: shown dimmed', panelOpacity(10, 72) === 0.85 && panelOpacity(71, 72) === 0.85);
  check('past the trigger: full', panelOpacity(72, 72) === 1 && panelOpacity(140, 72) === 1);

  console.log('[states: torrents]');
  const t = (state, pausedBy) => swipePlan({ ...base, action: M.torrentCardAction({ state, pausedBy }) }).right?.kind ?? null;
  check('DOWNLOADING -> pause', t('DOWNLOADING') === 'pause');
  check('SEEDING -> pause', t('SEEDING') === 'pause');
  check('PAUSED (user) -> resume', t('PAUSED', 'user') === 'resume');
  check('PAUSED by seed limit -> none (button is Open)', t('PAUSED', 'seed_limit') === null);
  check('PAUSED by no peers -> none (button is Keep trying)', t('PAUSED', 'no_peers') === null);
  check('PAUSED storage full -> none', t('PAUSED', 'storage_full') === null);
  check('ERROR -> resume (Retry)', t('ERROR') === 'resume');
  check('CHECKING / INITIALIZING / MOVING -> none', t('CHECKING') === null && t('INITIALIZING') === null && t('MOVING') === null);

  console.log('[states: link downloads]');
  const d = (state, extra = {}) => swipePlan({ ...base, action: D.downloadAction({ state, ...extra }) }).right?.kind ?? null;
  check('downloading -> pause', d('downloading') === 'pause');
  check('queued -> pause', d('queued') === 'pause');
  check('paused -> resume', d('paused') === 'resume');
  check('finished -> none', d('finished') === null);
  check('needs_link -> none', d('needs_link') === null);

  console.log('[setting]');
  const types = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  const Store = await import('../modules/maglev-engine/src/MaglevSettingsStore.ts');
  check('default is on', types.DEFAULT_SETTINGS.appearance.swipeActions === true);
  check('older payload without the field gets on', Store.migrateSettings({ settings: { appearance: { mode: 'dim' } } }).appearance.swipeActions === true);
  check('a saved off survives migrate', Store.migrateSettings({ settings: { appearance: { swipeActions: false } } }).appearance.swipeActions === false);
  check('a non-boolean becomes on', Store.migrateSettings({ settings: { appearance: { swipeActions: 'no' } } }).appearance.swipeActions === true);
  const nativeCfg = read('modules/maglev-engine/src/toNativeConfig.ts');
  check('UI only: toNativeConfig never reads it', !/swipeActions/.test(nativeCfg));

  const ui = read('app/settings/interface.tsx');
  check('Interface has the switch with the agreed copy', /Swipe to pause or remove/.test(ui) && /Swipe a download right to pause or resume it, or left to remove it from the list\. Files are kept\./.test(ui) && /swipeActions/.test(ui));

  console.log('[wiring]');
  const row = read('components/transfers/SwipeRow.tsx');
  const card = read('components/TransferCard.tsx');
  const dl = read('components/transfers/DownloadCard.tsx');
  const screen = read('app/(tabs)/index.tsx');
  const layout = read('app/_layout.tsx');
  check('root has GestureHandlerRootView', /<GestureHandlerRootView/.test(layout));
  check('SwipeRow uses ReanimatedSwipeable and a haptic', /react-native-gesture-handler\/ReanimatedSwipeable/.test(row) && /scheduleOnRN\(haptic, 'select'\)/.test(row));
  check('SwipeRow panels take their opacity from panelOpacity', /useAnimatedStyle\(\(\) => \(\{ opacity: panelOpacity\(sign \* translation\.value, TRIGGER\) \}\)\)/.test(row));
  check('panelOpacity is a worklet (it runs on the UI thread)', /export function panelOpacity[^{]*\{\s*'worklet';/.test(read('components/transfers/swipe.ts')));
  check('SwipeRow has a horizontal activation offset', /dragOffsetFromLeft/.test(row) && /dragOffsetFromRight/.test(row));
  check('SwipeRow colours come from the theme', !/#[0-9A-Fa-f]{3,8}\b/.test(row) && /colors\.download/.test(row) && /colors\.danger/.test(row) && /colors\.accent\b/.test(row));
  check('both cards wrap in SwipeRow and use swipePlan', /<SwipeRow/.test(card) && /<SwipeRow/.test(dl) && /swipePlan\(/.test(card) && /swipePlan\(/.test(dl));
  check('with the setting off there is no wrapper', /swipeEnabled\s*\?\s*\(?\s*<SwipeRow/.test(card) || /swipeEnabled[\s\S]{0,60}<SwipeRow/.test(card));
  check('cards expose Remove to accessibility regardless of the setting', /name: 'remove'|name: "remove"/.test(card) && /name: 'remove'/.test(dl));
  check('memo comparators include the swipe props', /swipeEnabled/.test(card.split('function sameCard')[1]) && /swipeEnabled/.test(dl.split('function same(')[1]));
  check('swipe remove keeps files: removeTransfers, never a delete', /removeTransfers\(\[id\], \[\]\)/.test(screen) && /removeTransfers\(\[\], \[id\]\)/.test(screen) && !/onSwipeRemove[\s\S]{0,200}deleteTorrent/.test(screen));
  check('list closes an open row on scroll', /onScrollBeginDrag=\{closeOpenSwipe\}/.test(screen) && /closeOpenSwipe/.test(row));
  check('screen passes the setting to both cards', (screen.match(/swipeEnabled=\{swipeEnabled\}/g) || []).length === 2);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
