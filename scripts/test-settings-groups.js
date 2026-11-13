#!/usr/bin/env node
// Settings tab grouping (0.14): four titled groups, About alone, merged Speed & queue, Notifications page.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failed = 0;
const check = (name, ok) => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failed++;
    console.log(`FAIL ${name}`);
  }
};

const index = read('app/(tabs)/settings.tsx');
const at = (s) => index.indexOf(s);

// Group titles, in order.
const titles = ['App', 'Finding things', 'Downloads', 'Connection'];
const tpos = titles.map((t) => at(`<SectionHeader title="${t}"`));
check('all four group titles exist', tpos.every((p) => p > 0));
check('groups run App, Finding things, Downloads, Connection', tpos.every((p, i) => i === 0 || p > tpos[i - 1]));

// Rows by group. Each group renders a named row list; the lists hold the rows.
const aboutPos = at('<SettingsRow {...aboutRow} />');
const jsx = {
  App: index.slice(tpos[0], tpos[1]),
  'Finding things': index.slice(tpos[1], tpos[2]),
  Downloads: index.slice(tpos[2], tpos[3]),
  Connection: index.slice(tpos[3], aboutPos),
};
const listOf = (name) => {
  const m = index.match(new RegExp(`const ${name}\\b[^=]*=([\\s\\S]*?);\\n`));
  return m ? m[1] : '';
};
const expected = {
  App: ['appRows', ['Appearance', 'Notifications', 'Assistant']],
  'Finding things': ['findRows', ['Search providers', 'Auto-download', 'Browser']],
  Downloads: [null, ['Storage', 'Speed & queue', 'Scheduling']],
  Connection: ['connectionRows', ['Network', 'Power']],
};
for (const [g, [list, rows]] of Object.entries(expected)) {
  if (list) check(`${g} renders ${list}`, jsx[g].includes(`${list}.map`));
  let last = -1;
  for (const r of rows) {
    const where = list ? listOf(list) : jsx[g] + listOf('speedRow') + listOf('scheduleRow');
    const ok = r === 'Storage' ? /<StorageRow/.test(jsx[g]) : where.includes(`title: '${r}'`);
    check(`${r} is in ${g}`, ok);
  }
}
check('Downloads renders Storage, Speed & queue, Scheduling in order', (() => {
  const d = jsx.Downloads;
  const p = ['<StorageRow', '{...speedRow}', '{...scheduleRow}'].map((x) => d.indexOf(x));
  return p.every((x, i) => x >= 0 && (i === 0 || x > p[i - 1]));
})());
check('About comes after Connection', aboutPos > tpos[3] && !/SectionHeader title="About"/.test(index));
check('NeedsAttention banners sit above the groups', at('<NeedsAttention />') > 0 && at('<NeedsAttention />') < tpos[0]);
check('Interface row is titled Appearance, route kept', /title: 'Appearance'[^}]*route: 'interface'/.test(index) && !/title: 'Interface'/.test(index));
check('merged row shows limits and queue', /`\$\{limits\} · \$\{queue\}`/.test(index) && /route: 'speed'/.test(index));
check('Notifications row uses the bell icon', /icon: 'bell', title: 'Notifications'/.test(index));
check('old Bandwidth and Torrents & queue rows are gone', !/title: 'Bandwidth'/.test(index) && !/Torrents & queue/.test(index));

// Appearance page.
const iface = read('app/settings/interface.tsx');
check('interface.tsx page title is Appearance', /SettingsPage title="Appearance"/.test(iface));
check('interface.tsx no longer holds the notification rows', !/Finished-download alerts/.test(iface) && !/Live progress in status bar/.test(iface));

// Notifications page.
const notif = read('app/settings/notifications.tsx');
check('notifications.tsx has both moved rows', /Finished-download alerts/.test(notif) && /Live progress in status bar/.test(notif));
check('notifications.tsx uses SettingsPage and Card', /<SettingsPage title="Notifications"/.test(notif) && /Card/.test(notif));
check('notifications.tsx keeps the API 36 gate', /Platform\.Version/.test(notif));

// Speed & queue.
const speed = read('app/settings/speed.tsx');
check('speed.tsx renders SpeedSection under a Speed header', /<SectionHeader title="Speed"/.test(speed) && /<SpeedSection/.test(speed));
check('speed.tsx renders QueueSection under a Queue header', /<SectionHeader title="Queue"/.test(speed) && /<QueueSection/.test(speed));
check('speed section holds the limits', /Download limit/.test(read('components/settings/SpeedSection.tsx')) && /Connections per torrent/.test(read('components/settings/SpeedSection.tsx')));
check('queue section holds the queue', /Active downloads/.test(read('components/settings/QueueSection.tsx')) && /Share for at most/.test(read('components/settings/QueueSection.tsx')));
for (const f of ['bandwidth', 'queue']) {
  const src = read(`app/settings/${f}.tsx`);
  check(`${f}.tsx redirects to /settings/speed`, /<Redirect href=\{?['"]\/settings\/speed['"]/.test(src) && !/SettingsPage/.test(src));
}

// Routes registered.
const layout = read('app/_layout.tsx');
for (const r of ['speed', 'notifications', 'interface', 'bandwidth', 'queue']) check(`layout registers settings/${r}`, layout.includes(`name="settings/${r}"`));

// Assistant knows the new sections.
check('assistant open_screen lists speed and notifications', /'speed'/.test(read('utils/assistant/tools.ts')) && /notifications: '\/settings\/notifications'/.test(read('utils/assistant/chatView.ts')) && /speed: '\/settings\/speed'/.test(read('utils/assistant/chatView.ts')));

// No leftover copy.
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const stale = ['app', 'components', 'constants', 'utils'].flatMap(walk).filter((f) => /\.(tsx?|js)$/.test(f) && /When to download/.test(fs.readFileSync(path.join(root, f), 'utf8')));
check('no "When to download" string', stale.length === 0);

console.log(failed ? `\nsettings groups: ${failed} failed` : '\nsettings groups: all passed');
process.exit(failed ? 1 : 0);
