#!/usr/bin/env node
// New-feature highlight (docs/NATIVE_CONTRACT.md section 37.4): the decision, the 0.28 entry and its route,
// the setting, the sheet and where it is mounted. Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

(async () => {
  console.log('Highlights');
  const H = await import('../utils/highlights.ts');
  const { HIGHLIGHTS } = await import('../constants/highlights.ts');
  const title = (x) => (x ? x.title : null);

  console.log('[decision]');
  check('first install never shows', H.highlightToShow('0.28', null, true, true) === null && H.highlightToShow('0.28', '0.20', true, true) === null);
  check('first install does not advance either (onboarding sets the version)', H.highlightPlan('0.28', null, true, true).advanceSilently === false);
  check('an upgrade across 0.28 shows Subtitles', title(H.highlightToShow('0.28', '0.27', false, true)) === 'Subtitles');
  check('an install that never stored a version counts as an upgrade', title(H.highlightToShow('0.28', null, false, true)) === 'Subtitles');
  check('the same version shows nothing', H.highlightToShow('0.28', '0.28', false, true) === null);
  check('a downgrade shows nothing and does not move the version', H.highlightToShow('0.27', '0.28', false, true) === null && H.highlightPlan('0.27', '0.28', false, true).advanceSilently === false);
  check('versions compare numerically, not as text (0.9 < 0.28)', H.compareVersions('0.28', '0.9') > 0 && H.compareVersions('0.9', '0.28') < 0 && H.compareVersions('1.0', '0.99') > 0 && H.compareVersions('0.28.0', '0.28') === 0);
  check('0.100 shows after 0.28 numerically', title(H.highlightToShow('0.100', '0.28', false, true, { '0.100': { title: 'Big', body: '', icon: 'check', tryRoute: '/', tryLabel: 'x' } })) === 'Big');

  const T = (t) => ({ title: t, body: 'b', icon: 'check', tryRoute: '/x', tryLabel: 'Go' });
  const table = { '0.26': T('Old'), '0.28': T('Mid'), '0.30': T('New'), '0.40': T('Future') };
  check('skipped versions show the newest entry up to the installed one', title(H.highlightToShow('0.31', '0.25', false, true, table)) === 'New');
  check('an entry above the installed version is not shown', title(H.highlightToShow('0.29', '0.25', false, true, table)) === 'Mid');
  check('an entry at or below the last seen version is not shown', H.highlightToShow('0.29', '0.28', false, true, table) === null);
  check('with no entry in the range nothing shows and the version moves forward silently', H.highlightToShow('0.27', '0.26', false, true, table) === null && H.highlightPlan('0.27', '0.26', false, true, table).advanceSilently === true);
  check('with the switch off nothing shows and the version moves forward', H.highlightToShow('0.28', '0.27', false, false) === null && H.highlightPlan('0.28', '0.27', false, false).advanceSilently === true);
  check('a plan that shows does not also advance (closing the sheet does)', H.highlightPlan('0.28', '0.27', false, true).advanceSilently === false && H.highlightPlan('0.28', '0.27', false, true).show.version === '0.28');

  console.log('[launch]');
  check('a launcher start is plain', H.isPlainLaunch(null) && H.isPlainLaunch('') && H.isPlainLaunch(undefined) && H.isPlainLaunch('maglev://') && H.isPlainLaunch('maglev:///'));
  check('a magnet, file, share, torrent link or deep link is not plain', ['magnet:?xt=urn:btih:abc', 'content://x/y.torrent', 'file:///sdcard/a.torrent', 'https://example.com/v', 'maglev://torrent/dl_ab12', 'maglev://browser?url=x'].every((u) => !H.isPlainLaunch(u)));

  console.log('[entry]');
  const e = HIGHLIGHTS['0.28'];
  check('0.28 entry is exactly the contract text', e && e.title === 'Subtitles' && e.body === "Find and save subtitles for videos you've downloaded, from dozens of free sources." && e.icon === 'subtitles' && e.tryRoute === '/settings/subtitles' && e.tryLabel === 'Set up subtitles');
  const gen = read('components/icons.generated.ts');
  check('the entry icon exists in the icon set', gen.includes(`"${e.icon}":`));
  const routeFile = `app${e.tryRoute}.tsx`;
  check('the entry route is a real screen, registered in the layout', exists(routeFile) && read('app/_layout.tsx').includes(`name="${e.tryRoute.slice(1)}"`));
  check('every entry key is major.minor', Object.keys(HIGHLIGHTS).every((k) => /^\d+\.\d+$/.test(k)));

  console.log('[setting]');
  const prefs = await import('../utils/prefs/update.ts');
  check('showHighlights defaults on; only false turns it off', prefs.defaultUpdatePrefs().showHighlights === true && prefs.normalizeUpdatePrefs({ showHighlights: false }).showHighlights === false && prefs.normalizeUpdatePrefs({ showHighlights: 0 }).showHighlights === true);
  check('UI only: toNativeConfig never reads it', !/showHighlights|highlights/i.test(read('modules/maglev-engine/src/toNativeConfig.ts')));
  const updates = read('app/settings/updates.tsx');
  check('Settings > Updates has "Show new features after updates"', /highlightCopy\.settingTitle/.test(updates) && /prefs\.showHighlights/.test(updates) && /settingTitle: 'Show new features after updates'/.test(read('constants/copy.ts')));
  const { SETTINGS_INDEX } = await import('../utils/settingsIndex.ts');
  check('the setting is in the search index under Updates', SETTINGS_INDEX.some((x) => x.title === 'Show new features after updates' && x.page === 'updates'));
  const kv = await import('../utils/prefs/highlights.ts');
  check('lastSeenVersion starts unset, then round-trips through kv', kv.getLastSeenVersion() === null && (kv.setLastSeenVersion('0.28'), kv.getLastSeenVersion() === '0.28'));

  console.log('[sheet]');
  const sheet = read('components/HighlightSheet.tsx');
  const copy = await import('../constants/copy.ts');
  check('sheet copy is the contract text', copy.highlightCopy.notNow === 'Not now' && copy.highlightCopy.allNotes === 'All release notes' && copy.highlightCopy.footer === 'You can turn these off in Settings → Updates');
  check('the sheet shows icon, title, body, the try button, Not now, All release notes and the footer', /highlight\.icon/.test(sheet) && /title=\{highlight\.title\}/.test(sheet) && /highlight\.body/.test(sheet) && /highlight\.tryLabel/.test(sheet) && /highlightCopy\.notNow/.test(sheet) && /highlightCopy\.allNotes/.test(sheet) && /highlightCopy\.footer/.test(sheet));
  check('it reuses the Sheet from components/ui, which closes with Back', /Sheet\b[^;]*from '\.\/ui'/.test(sheet) && /onClose=\{onNotNow\}/.test(sheet));
  check('the primary button goes to tryRoute and All release notes to What\'s new', /router\.push\(route as never\)/.test(sheet) && /'\/settings\/whats-new'/.test(sheet) && exists('app/settings/whats-new.tsx'));
  check('every way of closing records the installed version', /const close = useCallback\(\(\) => \{\s*setLastSeenVersion\(INSTALLED\)/.test(sheet) && /tryIt[\s\S]*close\(\)/.test(sheet) && /notes = useCallback\(\(\) => \{\s*close\(\)/.test(sheet));
  check('it asks the plan once per launch, and only for an onboarded user on a plain launch', /decided \|\| plain !== true \|\| !onboarded/.test(sheet) && /highlightPlan\(INSTALLED, getLastSeenVersion\(\), false, prefs\.showHighlights\)/.test(sheet) && /advanceSilently\) setLastSeenVersion/.test(sheet));
  check('a launch link, at start or later, keeps it from showing', /Linking\.getInitialURL/.test(sheet) && /isPlainLaunch\(url\)/.test(sheet) && /addEventListener\('url', \(\) => setPlain\(false\)\)/.test(sheet));
  const layout = read('app/_layout.tsx');
  check('mounted at the app root next to the star prompt, inside the signed-in guard only', /\{main \? <HighlightSheet \/> : null\}/.test(layout) && layout.indexOf('<HighlightSheet') > layout.indexOf('</Stack>'));
  const onb = read('app/onboarding.tsx');
  check('onboarding sets lastSeenVersion on both ways of finishing', (onb.match(/markHighlightsSeen\(\);/g) || []).length === 2 && /setLastSeenVersion\(v\)/.test(onb));
  check('not shown during onboarding: the sheet is not mounted until the user is onboarded', !/<HighlightSheet/.test(onb));

  console.log(failed ? `\n${failed} failed` : '\nhighlights: all passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
