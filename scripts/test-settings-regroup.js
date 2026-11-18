#!/usr/bin/env node
// Settings regroup (0.25): General / Finding things / Downloads / Network and power / App, a Downloads page,
// Speed and sharing, Power with battery rows only, redirect pages gone, search index in step with the pages.
// Needs Node 22.18+ (imports the TypeScript index directly via type stripping).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
let failed = 0;
const check = (name, ok, extra) => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
};

async function main() {
  console.log('Settings regroup');
  const list = read('app/(tabs)/settings.tsx');
  const at = (s) => list.indexOf(s);

  // Main list: groups, order, rows.
  const groups = ['App', 'General', 'Finding things', 'Transfers', 'Network and power'];
  const gpos = groups.map((g) => at(`<SectionHeader title="${g}"`));
  check('all five group titles exist', gpos.every((p) => p > 0));
  check('groups run App, General, Finding things, Downloads, Network and power', gpos.every((p, i) => i === 0 || p > gpos[i - 1]));
  check('no leftover "Connection" group', !/SectionHeader title="Connection"/.test(list));
  const end = at('</ScrollView>');
  const jsx = groups.map((g, i) => list.slice(gpos[i], i + 1 < groups.length ? gpos[i + 1] : end));
  const listOf = (name) => {
    const m = list.match(new RegExp(`const ${name}\\b[^=]*=([\\s\\S]*?);\\n`));
    return m ? m[1] : '';
  };
  const titlesIn = (src) => [...src.matchAll(/title: ([^,]+),/g)].map((m) => m[1].replace(/['"]/g, ''));
  const orderOf = (g, listName, expected) => {
    const rows = titlesIn(listOf(listName));
    check(`${g} renders ${listName}`, jsx[groups.indexOf(g)].includes(`${listName}.map`));
    check(`${g} rows are ${expected.join(', ')}`, JSON.stringify(rows) === JSON.stringify(expected), rows.join(', '));
  };
  orderOf('General', 'generalRows', ['Appearance', 'Assistant', 'Notifications', 'Backup and restore']);
  orderOf('Finding things', 'findRows', ['Search sources', 'Auto-download', 'Subtitles']);
  orderOf('Network and power', 'networkRows', ['Network', 'Power', 'Browser']);
  orderOf('App', 'appRows', ['About', 'Updates']);
  {
    const d = jsx[groups.indexOf('Transfers')];
    const p = ['{...downloadsRow}', '{...speedRow}', '<StorageRow', '{...scheduleRow}', '{...watchRow}'].map((x) => d.indexOf(x));
    check('Downloads renders Downloads, Speed and sharing, Storage, Scheduling, Watches in order', p.every((x, i) => x >= 0 && (i === 0 || x > p[i - 1])));
  }
  check('Adding and finishing row opens settings/downloads', /title: 'Adding and finishing'[^}]*route: 'downloads'/.test(listOf('downloadsRow')));
  const icons = [...list.matchAll(/icon: '([a-z-]+)', title: 'Adding and finishing'/g)].map((m) => m[1]);
  const gen = read('components/icons.generated.ts');
  check('Downloads row icon exists in the icon set', icons.length === 1 && gen.includes(`"${icons[0]}":`), icons.join());
  check('Speed row is titled Speed and sharing', /title: 'Speed and sharing'.*route: 'speed'/.test(listOf('speedRow')));
  check('Watches row sits with Downloads, not Finding things', !listOf('findRows').includes('watchCopy'));

  // Downloads page.
  check('app/settings/downloads.tsx exists', exists('app/settings/downloads.tsx'));
  const dl = exists('app/settings/downloads.tsx') ? read('app/settings/downloads.tsx') : '';
  const dpos = ['Adding downloads', 'Link downloads', 'When downloads finish'].map((t) => dl.indexOf(`<SectionHeader title="${t}"`));
  check('downloads.tsx has the three sections in order', dpos.every((p, i) => p > 0 && (i === 0 || p > dpos[i - 1])));
  check('downloads.tsx title is Adding and finishing', /<SettingsPage title="Adding and finishing"/.test(dl));
  check('downloads.tsx has Add without asking and clipboard row', /quickShareCopy\.setting\.title/.test(dl) && /<ClipboardSetting/.test(dl));
  check('downloads.tsx renders Parts then Retry', dl.indexOf('<PartsSection') > 0 && dl.indexOf('<RetrySection') > dl.indexOf('<PartsSection'));
  check('downloads.tsx has Close when done and Resume after restart', /Close when done/.test(dl) && /Resume after restart/.test(dl) && /autoExitOnComplete/.test(dl) && /resumeAfterRestart/.test(dl));
  check('Link downloads sits between Adding and When downloads finish', dl.indexOf('<PartsSection') > dpos[1] && dl.indexOf('<RetrySection') < dpos[2]);
  check('layout registers settings/downloads', read('app/_layout.tsx').includes('name="settings/downloads"'));

  // Moved rows are gone from their old pages.
  const storage = read('app/settings/storage.tsx');
  check('storage.tsx no longer holds the adding rows', !/ClipboardSetting/.test(storage) && !/quickShareCopy/.test(storage) && !/Adding downloads/.test(storage));
  const speed = read('app/settings/speed.tsx');
  check('speed.tsx title is Speed and sharing', /<SettingsPage title="Speed and sharing"/.test(speed) && !/Speed & queue/.test(speed));
  check('speed.tsx keeps Speed and Queue only', /<SpeedSection/.test(speed) && /<QueueSection/.test(speed) && !/PartsSection|RetrySection/.test(speed));
  const power = read('app/settings/power.tsx');
  check('power.tsx has Charging only and Pause below', /Charging only/.test(power) && /Pause below/.test(power));
  check('power.tsx no longer holds the lifecycle rows', !/Close when done|Resume after restart|autoExitOnComplete|resumeAfterRestart/.test(power));

  // Redirect pages gone.
  const layout = read('app/_layout.tsx');
  for (const f of ['bandwidth', 'queue']) {
    check(`settings/${f}.tsx is deleted`, !exists(`app/settings/${f}.tsx`));
    check(`layout no longer registers settings/${f}`, !layout.includes(`name="settings/${f}"`));
  }

  // Assistant knows the page.
  check('assistant can open the Downloads page', /downloads/.test(read('utils/assistant/tools.ts')) && /downloads: '\/settings\/downloads'/.test(read('utils/assistant/chatView.ts')) && /downloads: 'Adding and finishing'/.test(read('utils/assistant/toolRunner.ts')));
  check('assistant names Speed and sharing', /speed: 'Speed and sharing'/.test(read('utils/assistant/toolRunner.ts')));

  // Search index.
  const { SETTINGS_INDEX } = await import(path.join(root, 'utils/settingsIndex.ts'));
  const byId = new Map(SETTINGS_INDEX.map((e) => [e.id, e]));
  check('every index entry points at an existing page', SETTINGS_INDEX.every((e) => exists(`app/settings/${e.page}.tsx`)), SETTINGS_INDEX.filter((e) => !exists(`app/settings/${e.page}.tsx`)).map((e) => e.id).join());
  const needSection = SETTINGS_INDEX.filter((e) => ['speed', 'downloads'].includes(e.page) && !(e.section && e.section.length));
  check('every speed and downloads entry has a section', needSection.length === 0, needSection.map((e) => e.id).join());
  const pageSrc = (p) => [`app/settings/${p}.tsx`, 'components/settings/SpeedSection.tsx', 'components/settings/QueueSection.tsx', 'components/settings/PartsSection.tsx', 'components/settings/RetrySection.tsx'].filter(exists).map(read).join('\n');
  const orphan = SETTINGS_INDEX.filter((e) => ['speed', 'downloads', 'storage', 'network', 'feeds', 'scheduling', 'search-providers'].includes(e.page) && e.section && !pageSrc(e.page).includes(e.section));
  check('every section on pages with literal headers appears in that page', orphan.length === 0, orphan.map((e) => `${e.id}:${e.section}`).join());
  const moved = {
    'storage-add-without-asking': 'Adding downloads',
    'storage-offer-links': 'Adding downloads',
    'speed-parts': 'Link downloads',
    'speed-retry': 'Link downloads',
    'speed-keep-trying': 'Link downloads',
    'power-close-when-done': 'When downloads finish',
    'power-resume-restart': 'When downloads finish',
  };
  for (const [id, section] of Object.entries(moved)) {
    const e = byId.get(id);
    check(`${id} points to downloads / ${section}`, !!e && e.page === 'downloads' && e.pageTitle === 'Adding and finishing' && e.section === section);
  }
  check('storage-hide-gallery is not under Adding downloads', byId.get('storage-hide-gallery')?.section !== 'Adding downloads');
  check('no entry still says Speed & queue', !SETTINGS_INDEX.some((e) => e.pageTitle === 'Speed & queue'));
  check('speed entries say Speed and sharing', SETTINGS_INDEX.filter((e) => e.page === 'speed').every((e) => e.pageTitle === 'Speed and sharing'));

  // Fixtures and flows.
  for (const f of ['.maestro/settings-roundtrip.yaml', '.maestro/settings-screens.yaml']) {
    check(`${f} says Speed and sharing`, !/Speed & queue/.test(read(f)) && /Speed and sharing/.test(read(f)));
  }

  console.log(failed ? `\nsettings regroup: ${failed} failed` : '\nsettings regroup: all passed');
  process.exit(failed ? 1 : 0);
}
main();
