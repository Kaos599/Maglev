#!/usr/bin/env node
// NATIVE_CONTRACT 35: why transfers are held. One copy table, the banner order, the override table,
// the per-item lines, and the native and mock sources that feed them.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const exists = (p) => fs.existsSync(path.join(__dirname, '..', p));

async function main() {
  check('reasons.ts exists', exists('utils/blocks/reasons.ts'));
  if (!exists('utils/blocks/reasons.ts')) return;
  const R = await import('../utils/blocks/reasons.ts');
  const model = await import('../components/transfers/model.ts');
  const copy = await import('../utils/downloadCopy.ts');

  // 1. Every PausedBy value, every ActiveBlockTag and 'queued' have copy.
  const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
  const pausedBlock = /export type PausedBy =([\s\S]*?);/.exec(types)[1];
  const pausedBy = [...pausedBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const health = [...(/HEALTH_TAGS[^=]*=\s*\[([\s\S]*?)\]/.exec(types)[1]).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  const tagBlock = /export type ActiveBlockTag =([\s\S]*?);/.exec(types)[1];
  const tags = [...tagBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  check('found PausedBy values and block tags', pausedBy.length >= 10 && health.length === 5 && tags.length === 9, `${pausedBy.length}/${health.length}/${tags.length}`);
  const keys = [...new Set([...pausedBy, ...health, ...tags, 'queued'])];
  for (const k of keys) {
    const r = R.reasonFor(k, { blocks: [{ tag: k, sinceMs: 1, thresholdPct: 20, levelPct: 15 }], queueLimit: 3 });
    const ok = r && [r.short, r.title, r.body].every((s) => typeof s === 'string' && s.length > 0) && typeof r.override === 'boolean' &&
      (r.setting === null || (typeof r.setting.label === 'string' && /^\/settings\//.test(r.setting.route)));
    check(`copy for ${k}`, !!ok, JSON.stringify(r));
  }
  check('unknown or empty key has no reason', R.reasonFor('nope') === null && R.reasonFor(null) === null && R.reasonFor(undefined) === null);

  // 2. The contract's wording.
  const ctx = (b, q) => ({ blocks: b, queueLimit: q });
  const wm = R.reasonFor('wifi_only', ctx([{ tag: 'wifi_only', cause: 'metered', sinceMs: 1 }]));
  check('wifi metered copy', wm.title === 'Waiting for Wi-Fi' && wm.body === 'Wi-Fi only is on, and this connection is metered.');
  const ws = R.reasonFor('wifi_only', ctx([{ tag: 'wifi_only', cause: 'ssid', sinceMs: 1 }]));
  check('wifi ssid copy', ws.title === 'Waiting for an allowed Wi-Fi' && ws.body === "This Wi-Fi isn't in your allowed networks." && ws.override === false);
  const bat = R.reasonFor('battery', ctx([{ tag: 'battery', thresholdPct: 20, levelPct: 17, sinceMs: 1 }]));
  check('battery copy fills the numbers', bat.title === 'Battery below 20%' && bat.body === "Transfers pause when the battery is under 20% and not charging. It's at 17%.");
  check('charging copy', R.reasonFor('charging_only').title === 'Waiting for the charger' && R.reasonFor('charging_only').body === 'Charging only is on.');
  check('unvalidated copy', R.reasonFor('network_unvalidated').title === 'Waiting for internet' && R.reasonFor('network_unvalidated').body === "This network can't reach the internet. If it has a sign-in page, open it.");
  check('vpn copy', R.reasonFor('vpn_required').title === 'Waiting for VPN' && R.reasonFor('vpn_required').body === 'VPN only is on, and no VPN is connected.');
  check('offline copy', R.reasonFor('offline').title === 'No internet connection' && R.reasonFor('offline').body === "Transfers continue when you're back online.");
  const at = new Date(2026, 0, 1, 7, 5).getTime();
  const sch = R.reasonFor('schedule', { ...ctx([{ tag: 'schedule', resumesAtMs: at, sinceMs: 1 }]), nowMs: at - 60_000 });
  check('schedule copy with a time', sch.title === 'Paused by your schedule' && sch.body === 'Resumes at 07:05.', sch.body);
  const past = R.reasonFor('schedule', { ...ctx([{ tag: 'schedule', resumesAtMs: at, sinceMs: 1 }]), nowMs: at + 60_000 });
  check('schedule copy drops a time that has passed', past.body === "Your schedule doesn't allow transfers now.", past.body);
  check('schedule copy drops a time that is exactly now', R.reasonFor('schedule', { ...ctx([{ tag: 'schedule', resumesAtMs: at, sinceMs: 1 }]), nowMs: at }).body === "Your schedule doesn't allow transfers now.");
  check('schedule copy without a time', R.reasonFor('schedule').body === "Your schedule doesn't allow transfers now.");
  check('storage copy', R.reasonFor('storage_full').title === 'Storage almost full' && R.reasonFor('storage_full').body === 'Maglev keeps some space free on your phone. Free up space to continue.');
  check('seed_metered copy', R.reasonFor('seed_metered').title === 'Sharing waits for Wi-Fi' && R.reasonFor('seed_metered').body === 'Seeding on mobile data is off.');
  check('fgs_timeout copy', R.reasonFor('fgs_timeout').title === 'Stopped in the background' && R.reasonFor('fgs_timeout').body === 'Android stopped Maglev after running a long time in the background. Tap Resume.');
  const q = R.reasonFor('queued', ctx([], 3));
  check('queued copy', q.title === 'Queued' && q.body === '3 downloads run at a time. This one starts when one finishes.' && q.short === 'Queued · 3 at a time');
  check('no jargon or dots in copy', keys.every((k) => { const r = R.reasonFor(k); return !/[●•]|\bpaused_by\b|\bgovernance\b/i.test(`${r.short}${r.title}${r.body}`); }));

  // 3. Settings routes.
  const route = (k, c) => R.reasonFor(k, c)?.setting?.route;
  check('routes: network', route('wifi_only') === '/settings/network' && route('vpn_required') === '/settings/network' && route('seed_metered') === '/settings/network' && route('wifi_only', ctx([{ tag: 'wifi_only', cause: 'ssid', sinceMs: 1 }])) === '/settings/network');
  check('routes: power', route('battery') === '/settings/power' && route('charging_only') === '/settings/power');
  check('routes: schedule, queue, storage, peers', route('schedule') === '/settings/scheduling' && route('queued') === '/settings/speed' && route('storage_full') === '/settings/storage' && route('no_peers') === '/settings/speed');
  check('no setting for offline, unvalidated', R.reasonFor('offline').setting === null && R.reasonFor('network_unvalidated').setting === null);

  // 4. Override table.
  const ov = (k, c) => R.reasonFor(k, c).override;
  check('override true: battery, charging_only, schedule, wifi metered', ov('battery') && ov('charging_only') && ov('schedule') && ov('wifi_only') && ov('wifi_only', ctx([{ tag: 'wifi_only', cause: 'metered', sinceMs: 1 }])));
  check('override false: unvalidated, vpn, offline, storage_full', !ov('network_unvalidated') && !ov('vpn_required') && !ov('offline') && !ov('storage_full'));

  // 5. Banner order and visibility.
  check('banner order', JSON.stringify(R.BANNER_ORDER) === JSON.stringify(['storage_full', 'offline', 'network_unvalidated', 'vpn_required', 'wifi_only', 'charging_only', 'battery', 'schedule', 'seed_metered']));
  const B = (tag, extra = {}) => ({ tag, sinceMs: 1, ...extra });
  const shown = R.visibleBlocks([B('battery'), B('wifi_only'), B('storage_full'), B('seed_metered')], { hasUnfinished: true, hasSeedEligible: false });
  check('blocks are sorted and seed_metered hidden without a seeding torrent', shown.map((b) => b.tag).join() === 'storage_full,wifi_only,battery', shown.map((b) => b.tag).join());
  check('seed_metered shows when a finished torrent can seed', R.visibleBlocks([B('seed_metered')], { hasUnfinished: false, hasSeedEligible: true }).length === 1);
  check('nothing unfinished: only seed_metered can show', R.visibleBlocks([B('offline'), B('seed_metered')], { hasUnfinished: false, hasSeedEligible: true }).map((b) => b.tag).join() === 'seed_metered');
  check('empty list shows nothing', R.visibleBlocks([], { hasUnfinished: true, hasSeedEligible: true }).length === 0);

  // 5b. "+N more" counts only what holds a download.
  check('moreCount: one entry has no more', R.moreCount(['battery']) === 0 && R.moreCount([]) === 0);
  check('moreCount: seed_metered is not counted next to a download hold', R.moreCount(['wifi_only', 'seed_metered']) === 0 && R.moreCount(['storage_full', 'battery', 'seed_metered']) === 1);
  check('moreCount: download holds are all counted', R.moreCount(['offline', 'wifi_only', 'battery']) === 2);
  check('moreCount: seed-only entries count when nothing holds a download', R.moreCount(['seed_metered', 'seed_metered']) === 1);

  // 5c. The Wi-Fi override only shows when the network is the only download hold.
  check('wifi override allowed alone or with seed_metered', R.wifiOverrideAllowed([]) && R.wifiOverrideAllowed(undefined) && R.wifiOverrideAllowed([B('wifi_only'), B('seed_metered')]));
  check('wifi override hidden when battery, charger, schedule or storage also hold', ['battery', 'charging_only', 'schedule', 'storage_full'].every((tag) => !R.wifiOverrideAllowed([B('wifi_only'), B(tag)])));
  const wctx = (...tags) => ({ blocks: tags.map((x) => B(x, x === 'wifi_only' ? { cause: 'metered' } : {})) });
  check('canResumeAnyway: wifi alone offers it, wifi plus battery does not', model.canResumeAnyway('wifi_only', wctx('wifi_only')) && !model.canResumeAnyway('wifi_only', wctx('wifi_only', 'battery')));
  check('card: wifi plus charging_only points at the setting, not mobile data', model.torrentCardAction({ state: 'PAUSED', pausedBy: 'wifi_only' }, wctx('wifi_only', 'charging_only')).kind === 'setting');
  const dlw = { id: 'd', name: 'd', state: 'paused', pausedBy: 'wifi_only', size: 1, downloaded: 0 };
  check('link: mobile-data button only when wifi is the only hold', copy.downloadActions(dlw, wctx('wifi_only')).some((a) => a.label === 'Download now on mobile data') && !copy.downloadActions(dlw, wctx('wifi_only', 'battery')).some((a) => a.label === 'Download now on mobile data'));

  // 6. Per item.
  const item = (o) => ({ finished: false, paused: false, queued: false, downloading: false, pausedBy: null, ...o });
  const all = [B('offline'), B('wifi_only', { cause: 'metered' }), B('battery', { thresholdPct: 20, levelPct: 10 })];
  const held = R.reasonsForItem(item({ paused: true, pausedBy: 'wifi_only' }), all, 3);
  check('detail lists every block that applies, not just its own tag', held.map((r) => r.key).join() === 'offline,wifi_only,battery', held.map((r) => r.key).join());
  check('detail lists its own tag even before blocks load', R.reasonsForItem(item({ paused: true, pausedBy: 'vpn_required' }), [], 3).map((r) => r.key).join() === 'vpn_required');
  check('a user pause is not explained by blocks', R.reasonsForItem(item({ paused: true, pausedBy: 'user' }), all, 3).length === 0);
  check('queued item lists the queue', R.reasonsForItem(item({ queued: true }), [], 3).map((r) => r.key).join() === 'queued');
  check('a finished item lists nothing', R.reasonsForItem(item({ finished: true }), all, 3).length === 0);

  const t = (state, pausedBy = null) => ({ id: 'a', name: 'a', state, pausedBy, downloadSpeedBytes: 0, uploadSpeedBytes: 0, downloadedBytes: 0, totalSizeBytes: 1000, includedBytes: 0, progressPercent: 0, etaSeconds: -1, error: null });
  const off = model.torrentStatus(t('DOWNLOADING'), '—', { blocks: [B('offline')] });
  check('downloading with offline shows "No internet connection"', off.lead === 'No internet connection' && off.value === '1000 B' && off.slot === 'size', JSON.stringify(off));
  check('downloading without offline is unchanged (a Wi-Fi block does not hide Connecting)', model.torrentStatus(t('DOWNLOADING'), '—', { blocks: [B('wifi_only')] }).lead === 'Connecting to peers');
  check('queued torrent says how many run at a time', model.torrentStatus(t('QUEUED'), '—', { queueLimit: 3 }).lead === 'Queued · 3 at a time', model.torrentStatus(t('QUEUED'), '—', { queueLimit: 3 }).lead);
  check('queued without a limit says Queued', model.torrentStatus(t('QUEUED'), '—').lead === 'Queued');

  // 7. One copy: card, detail and link cards agree.
  for (const k of ['wifi_only', 'battery', 'charging_only', 'schedule', 'network_unvalidated', 'vpn_required', 'fgs_timeout']) {
    const short = R.reasonFor(k).short;
    check(`card line for ${k} is the table's short`, model.torrentStatus(t('PAUSED', k), '—').lead === short, model.torrentStatus(t('PAUSED', k), '—').lead);
    const link = copy.downloadStatus({ id: 'd', name: 'd', state: 'paused', pausedBy: k, size: 1000, downloaded: 0, downBps: 0, eta: -1 });
    check(`link line for ${k} is the table's short`, link.lead === short, link.lead);
  }
  check('charging never reads "Paused to save battery"', !/save battery/i.test(read('components/detail/torrentLabels.ts')) && R.reasonFor('charging_only').short === 'Waiting for the charger');
  check('detail label reads the table', /reasonFor/.test(read('components/detail/torrentLabels.ts')) && /utils\/blocks\/reasons/.test(read('components/detail/torrentLabels.ts')));
  check('offline link says No internet connection', copy.downloadStatus({ id: 'd', name: 'd', state: 'paused', pausedBy: 'offline', size: 1, downloaded: 0, downBps: 0, eta: -1 }).lead === 'No internet connection');
  check('queued link says how many run at a time', copy.downloadStatus({ id: 'd', name: 'd', state: 'queued', size: 1, downloaded: 0, downBps: 0, eta: -1 }, undefined, { queueLimit: 3 }).lead === 'Queued · 3 at a time');

  // 8. Actions follow the override table.
  const kinds = (by, c) => model.torrentCardAction(t('PAUSED', by), c)?.kind ?? null;
  check('card: battery still resumes anyway', kinds('battery') === 'resumeAnyway');
  check('card: vpn_required shows the setting, not Resume', kinds('vpn_required') === 'setting' && model.torrentCardAction(t('PAUSED', 'vpn_required')).route === '/settings/network');
  check('card: network_unvalidated has no button that re-pauses', kinds('network_unvalidated') === null);
  check('card: wifi on an unlisted network shows the setting', kinds('wifi_only', ctx([B('wifi_only', { cause: 'ssid' })])) === 'setting');
  check('card: wifi on mobile data still resumes anyway', kinds('wifi_only', ctx([B('wifi_only', { cause: 'metered' })])) === 'resumeAnyway');
  check('card: storage full still frees space', kinds('storage_full') === 'freeSpace');
  check('canResumeAnyway follows the table', model.canResumeAnyway('schedule') && !model.canResumeAnyway('vpn_required') && !model.canResumeAnyway('network_unvalidated') && !model.canResumeAnyway('storage_full'));
  const dact = (by, c) => copy.downloadActions({ id: 'd', name: 'd', state: 'paused', pausedBy: by, size: 1, downloaded: 0 }, c).map((a) => a.kind).join();
  check('link: vpn_required offers the setting only', dact('vpn_required') === 'openNetworkSettings');
  check('link: schedule offers Resume anyway then the setting', dact('schedule') === 'resumeAnyway,openNetworkSettings');
  check('link: the setting button carries its route', copy.downloadActions({ id: 'd', name: 'd', state: 'paused', pausedBy: 'schedule', size: 1, downloaded: 0 }).at(-1).route === '/settings/scheduling');
  check('link: offline has no button', dact('offline') === '');

  // 9. No pause copy left in the three consumers.
  const OLD = /Paused: |(?:waiting for charger|Paused to save battery|Waiting for Wi-Fi|Scheduled pause|battery is low|Waiting for a connection|waiting for VPN|stopped in background|by schedule)/;
  const OLD_I = /waiting for charger|paused to save battery|waiting for wi-fi|scheduled pause|battery is low|waiting for a connection|waiting for vpn|stopped in background|by schedule/i;
  for (const f of ['components/transfers/model.ts', 'components/detail/torrentLabels.ts', 'utils/downloadCopy.ts']) {
    const src = read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(`${f} holds no pause strings`, !OLD.test(src) && !OLD_I.test(src), (OLD.exec(src) || OLD_I.exec(src) || [])[0]);
  }

  // 10. Banner, hook and screens.
  check('hook exists and unsubscribes', exists('utils/blocks/useActiveBlocks.ts') && /addBlocksListener/.test(read('utils/blocks/useActiveBlocks.ts')) && /getActiveBlocks/.test(read('utils/blocks/useActiveBlocks.ts')) && /return \(\) =>/.test(read('utils/blocks/useActiveBlocks.ts')));
  const banner = exists('components/transfers/BlockBanner.tsx') ? read('components/transfers/BlockBanner.tsx') : '';
  check('BlockBanner uses Banner, Sheet and the table', /Banner/.test(banner) && /Sheet/.test(banner) && /visibleBlocks/.test(banner) && /router\.push/.test(banner));
  check('BlockBanner names each setting and offers "+N more" inside the banner', /setting\.label|s\.label/.test(banner) && /moreCount/.test(banner) && /extraAction/.test(banner) && !/styles\.more/.test(banner));
  check('BlockBanner closes its sheet when there is nothing to show', /useEffect/.test(banner) && /setOpen\(false\)/.test(banner));
  const idx = read('app/(tabs)/index.tsx');
  check('Transfers tab shows the block banner', /<BlockBanner/.test(idx));
  check('Transfers tab has one banner for holds (low space merged in)', !/<Banner[^>]*lowSpace/.test(idx) && !/title=\{lowSpace\.title\}/.test(idx));
  const why = read('components/transfers/WhyHeld.tsx');
  check('"Why it\'s paused" lists reasons, each with its setting button', /Why it's paused/.test(why) && /reasonsForItem/.test(why) && /router\.push/.test(why));
  check('torrent detail shows "Why it\'s paused"', /<WhyHeld/.test(read('app/torrent/[id].tsx')));
  const sheet = read('app/download/[id].tsx');
  check('link detail shows "Why it\'s paused"', /<WhyHeld/.test(sheet));

  // 11. Native and mock sources.
  const diff = await import('../modules/maglev-engine/src/blocksDiff.ts');
  const b1 = [{ tag: 'battery', thresholdPct: 20, levelPct: 15, sinceMs: 1 }];
  check('mock: a battery level change alone is a change', diff.blocksChanged([{ ...b1[0], levelPct: 5 }], b1) && !diff.blocksChanged([{ ...b1[0] }], b1));
  check('mock: a new or removed block is a change', diff.blocksChanged([], b1) && diff.blocksChanged(b1, []));
  const kt = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/EngineHost.kt');
  const mod = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt');
  check('Kotlin: getActiveBlocks function and event registered', /AsyncFunction\("getActiveBlocks"\)/.test(mod) && /Events\([^)]*"onBlocksChanged"/.test(mod) && /fun activeBlocksList/.test(kt));
  check('Kotlin: setBlock reports a levelPct change', !/it != "levelPct"/.test(kt) && /keys\.any \{ old\[it\] != fields\[it\] \}/.test(kt));
  check('Kotlin: onBlocksChanged', /onBlocksChanged/.test(kt));
  check('Kotlin: ssid branch', /"ssid"/.test(kt));
  const mock = read('modules/maglev-engine/src/MaglevMockEngine.ts');
  check('mock engine: getActiveBlocks and addBlocksListener', /getActiveBlocks/.test(mock) && /addBlocksListener/.test(mock));
}

main().then(() => {
  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nblocks tests passed');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
