#!/usr/bin/env node
// Watch for a title (docs/contracts-0.19/watch.md). Pure logic: matching, new-vs-seen, filters, scheduling,
// store round-trip and cap, notification text, the background cycle, and the assistant tool -> proposal card.
// Needs Node 22.18+ (runs the TypeScript sources directly). No network, no device.
process.removeAllListeners('warning');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra !== undefined ? ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})` : ''}`);
  }
}

const GB = 1024 * 1024 * 1024;
const H = 3600000;
const hash = (c) => c.repeat(40);
const row = (o) => ({
  providerId: 'knaben', name: 'x', infoHash: hash('a'), magnet: `magnet:?xt=urn:btih:${hash('a')}`, sizeBytes: 12 * GB, seeders: 340,
  category: 'movies', sources: ['knaben'], ...o,
});

async function main() {
  const L = await import('../utils/watch/logic.ts');
  const { createWatchStore } = await import('../utils/watch/storeCore.ts');
  const { runWatchCycle } = await import('../utils/watch/cycle.ts');
  const { createToolRunner } = await import('../utils/assistant/toolRunner.ts');
  const { validateArgs, TOOLS, PROPOSAL_TOOLS } = await import('../utils/assistant/tools.ts');
  const { buildSystemPrompt } = await import('../utils/assistant/systemPrompt.ts');

  const NOW = 1_800_000_000_000;
  const mkId = (id, o = {}) => ({ ...mk(o), id });
  const mk = (o = {}) => L.newWatch({ query: 'Primetime', category: 'movies', ...o }, NOW, () => 0.123456);

  console.log('watch: creation and defaults');
  const w0 = mk();
  check('defaults: 6 h, Wi-Fi only, not paused, nothing seen', w0.intervalHours === 6 && w0.mobileData === false && w0.paused === false && w0.seen.length === 0 && w0.lastCheckedAt === 0, w0);
  check('id looks like w_<...>', /^w_[0-9a-z]+$/.test(w0.id), w0.id);
  check('a bad interval falls back to 6 h', mk({ intervalHours: 5 }).intervalHours === 6);
  check('1, 6 and 24 are kept', [1, 6, 24].every((h) => mk({ intervalHours: h }).intervalHours === h));
  check('query is trimmed and capped', mk({ query: '  Dune  ' }).query === 'Dune' && mk({ query: 'x'.repeat(500) }).query.length <= 120);
  check('a bad category becomes all', mk({ category: 'nope' }).category === 'all');
  check('min resolution only 480/720/1080/2160', mk({ minResolution: 2160 }).minResolution === 2160 && mk({ minResolution: 999 }).minResolution === undefined);
  check('max size must be positive', mk({ maxSizeGb: 0 }).maxSizeGb === undefined && mk({ maxSizeGb: 15 }).maxSizeGb === 15);

  console.log('watch: result keys and new-vs-seen');
  const a = row({ name: 'Primetime.2025.2160p.WEB-DL.DDP5.1.H265-GRP', infoHash: hash('a') });
  check('hash key is lower-case', L.resultKeys(row({ infoHash: 'ABCDEF'.padEnd(40, '0') })).includes('abcdef'.padEnd(40, '0')));
  check('name key ignores case, dots and spaces', L.normName('Primetime.2025.2160p') === L.normName('PRIMETIME 2025 2160p'));
  const ev1 = L.evaluateWatch(w0, [a], NOW);
  check('first run: records what matches, announces nothing', ev1.first === true && ev1.fresh.length === 0 && ev1.nextSeen.length >= 1, ev1);
  const w1 = { ...w0, lastCheckedAt: NOW, seen: ev1.nextSeen };
  const b = row({ name: 'Primetime.2025.2160p.UHD.BluRay.x265-NEW', infoHash: hash('b'), seeders: 12 });
  const ev2 = L.evaluateWatch(w1, [a, b], NOW + H);
  check('second run: only the new hash is fresh', ev2.fresh.length === 1 && ev2.fresh[0].infoHash === hash('b'), ev2.fresh.map((r) => r.name));
  const aOtherHash = row({ ...a, infoHash: hash('c'), providerId: 'tpb' });
  check('same name under another hash is not new', L.evaluateWatch(w1, [aOtherHash], NOW + H).fresh.length === 0);
  const bSameHashOtherName = row({ ...b, infoHash: hash('a'), name: 'Primetime.2025.2160p.REPACK-X' });
  check('same hash under another name is not new', L.evaluateWatch(w1, [bSameHashOtherName], NOW + H).fresh.length === 0);
  check('no repeat after the new one is recorded', L.evaluateWatch({ ...w1, seen: ev2.nextSeen }, [a, b], NOW + 2 * H).fresh.length === 0);
  const many = Array.from({ length: 600 }, (_, i) => row({ name: `Primetime.2025.1080p.Cut${i}-G`, infoHash: String(i).padStart(40, '0') }));
  const evMany = L.evaluateWatch(w0, many, NOW);
  check('seen list is capped', evMany.nextSeen.length <= L.MAX_SEEN, evMany.nextSeen.length);
  const best = L.evaluateWatch(w1, [row({ name: 'Primetime.2025.2160p.WEB-DL-LOW', infoHash: hash('d'), seeders: 5 }), row({ name: 'Primetime.2025.2160p.WEB-DL-HIGH', infoHash: hash('e'), seeders: 500 })], NOW + H);
  check('best fresh match is the most shared', best.best && best.best.infoHash === hash('e') && best.fresh.length === 2, best.best?.name);
  check('all fresh ones are recorded as seen', best.nextSeen.includes(hash('d')) && best.nextSeen.includes(hash('e')));

  console.log('watch: title matching reuses the assistant scoring');
  const spaced = mk({ query: 'prime time' });
  const sp = L.evaluateWatch({ ...spaced, seen: ['zz'] }, [a], NOW);
  check('"prime time" matches "Primetime"', sp.fresh.length === 1, sp);
  const other = row({ name: 'Prime.Suspect.2025.1080p.WEB-DL-X', infoHash: hash('f') });
  check('a different title does not match', L.evaluateWatch({ ...w0, seen: ['zz'] }, [other], NOW).fresh.length === 0);
  const cam = row({ name: 'Primetime.2025.HDCAM.x264-JUNK', infoHash: hash('9') });
  check('a cinema recording does not match', L.evaluateWatch({ ...w0, seen: ['zz'] }, [cam], NOW).fresh.length === 0);
  const seq = row({ name: 'Primetime.Part.Two.2025.1080p.WEB-DL-X', infoHash: hash('8') });
  check('a sequel does not match', L.evaluateWatch({ ...w0, seen: ['zz'] }, [seq], NOW).fresh.length === 0);

  console.log('watch: filters');
  const r2160 = row({ name: 'Primetime.2025.2160p.WEB-DL-X', infoHash: hash('1'), sizeBytes: 20 * GB });
  const r1080 = row({ name: 'Primetime.2025.1080p.WEB-DL-X', infoHash: hash('2'), sizeBytes: 4 * GB });
  const rNone = row({ name: 'Primetime.2025.WEB-DL-X', infoHash: hash('3'), sizeBytes: undefined });
  const seed = (w) => ({ ...w, seen: ['zz'] });
  const names = (w, rs) => L.evaluateWatch(seed(w), rs, NOW).fresh.map((r) => r.infoHash);
  check('min resolution 2160 keeps only 2160p', names(mk({ minResolution: 2160 }), [r2160, r1080, rNone]).join() === hash('1'), names(mk({ minResolution: 2160 }), [r2160, r1080, rNone]));
  check('min resolution 1080 keeps 1080p and 2160p', names(mk({ minResolution: 1080 }), [r2160, r1080]).length === 2);
  check('max size drops bigger, keeps unknown size', (() => { const n = names(mk({ maxSizeGb: 10 }), [r2160, r1080, rNone]); return n.includes(hash('2')) && n.includes(hash('3')) && !n.includes(hash('1')); })());
  check('must-contain words are all required', names(mk({ mustContain: ['2160p', 'web-dl'] }), [r2160, r1080]).join() === hash('1'));
  check('must-contain is case-insensitive', names(mk({ mustContain: ['WEB-dl'] }), [r2160]).length === 1);
  check('mustContain is trimmed and emptied', mk({ mustContain: [' hdr ', '', '  '] }).mustContain.join() === 'hdr');
  check('filters apply before "new": a filtered-out row is not recorded as seen', !L.evaluateWatch(mk({ minResolution: 2160 }), [r1080], NOW).nextSeen.includes(hash('2')));

  console.log('watch: scheduling math');
  check('never checked is due', L.isDue(w0, NOW));
  check('paused is never due', !L.isDue({ ...w0, paused: true }, NOW));
  const wc = { ...w0, lastCheckedAt: NOW };
  check('6 h watch is not due after 5 h', !L.isDue(wc, NOW + 5 * H));
  check('6 h watch is due after 6 h', L.isDue(wc, NOW + 6 * H));
  check('inexact timing: due at 90 % of the interval', L.isDue(wc, NOW + 5.5 * H) && !L.isDue(wc, NOW + 5.3 * H));
  check('1 h watch is due after 1 h', L.isDue({ ...wc, intervalHours: 1 }, NOW + H));
  check('job interval is the shortest active interval in minutes', L.jobIntervalMinutes([w0, { ...w0, intervalHours: 24 }]) === 360 && L.jobIntervalMinutes([w0, { ...w0, intervalHours: 1 }]) === 60);
  check('paused watches do not set the job interval', L.jobIntervalMinutes([{ ...w0, paused: true, intervalHours: 1 }, w0]) === 360);
  check('no active watch: 360 and nothing to run', L.jobIntervalMinutes([]) === 360 && L.hasActive([]) === false && L.hasActive([w0]) === true);
  check('job interval is never under 15 minutes', L.jobIntervalMinutes([w0]) >= 15);
  check('network rule: Wi-Fi only blocks metered', L.networkAllows({ ...w0, mobileData: false }, { connected: true, unmetered: false, globalWifiOnly: false }) === false);
  check('network rule: Wi-Fi allows unmetered', L.networkAllows(w0, { connected: true, unmetered: true, globalWifiOnly: false }) === true);
  check('network rule: mobile data allowed when the watch says so', L.networkAllows({ ...w0, mobileData: true }, { connected: true, unmetered: false, globalWifiOnly: false }) === true);
  check('network rule: the app-wide Wi-Fi only setting still wins', L.networkAllows({ ...w0, mobileData: true }, { connected: true, unmetered: false, globalWifiOnly: true }) === false);
  check('network rule: offline blocks', L.networkAllows({ ...w0, mobileData: true }, { connected: false, unmetered: false, globalWifiOnly: false }) === false);

  console.log('watch: store round-trip and the 20 cap');
  const mem = new Map();
  const storage = { getItemSync: (k) => mem.get(k) ?? null, setItemSync: (k, v) => void mem.set(k, v) };
  const store = createWatchStore(storage);
  check('empty store lists nothing', store.list().length === 0);
  const added = store.add({ query: 'Primetime', category: 'movies', minResolution: 2160, maxSizeGb: 20, mustContain: ['hdr'], intervalHours: 24, mobileData: true }, NOW);
  check('add returns the watch', added.ok && added.watch.query === 'Primetime', added);
  const reread = createWatchStore(storage).list();
  check('round-trips through storage', reread.length === 1 && reread[0].minResolution === 2160 && reread[0].maxSizeGb === 20 && reread[0].mustContain[0] === 'hdr' && reread[0].intervalHours === 24 && reread[0].mobileData === true, reread);
  check('duplicate query and category is refused plainly', (() => { const r = store.add({ query: ' primetime ', category: 'movies' }, NOW); return r.ok === false && /already/i.test(r.error); })());
  check('same query, other category is fine', store.add({ query: 'Primetime', category: 'tv' }, NOW).ok === true);
  store.update(added.watch.id, { paused: true });
  check('update persists', createWatchStore(storage).list().find((w) => w.id === added.watch.id).paused === true);
  store.remove(added.watch.id);
  check('remove persists', !createWatchStore(storage).list().some((w) => w.id === added.watch.id));
  for (let i = store.list().length; i < L.MAX_WATCHES; i++) store.add({ query: `Title ${i}`, category: 'all' }, NOW);
  check('the store holds exactly 20', store.list().length === 20 && L.MAX_WATCHES === 20, store.list().length);
  const over = store.add({ query: 'One too many', category: 'all' }, NOW);
  check('the 21st is refused with a plain message', over.ok === false && /20/.test(over.error) && store.list().length === 20, over);
  mem.set('maglev.watch.v1', '{not json');
  check('corrupt storage reads as empty, never throws', createWatchStore(storage).list().length === 0);
  mem.set('maglev.watch.v1', JSON.stringify([{ id: 'w_1', query: 'Ok', category: 'movies', intervalHours: 99, seen: 'nope' }, { nonsense: true }, null]));
  const odd = createWatchStore(storage).list();
  check('bad rows are dropped, bad fields are repaired', odd.length === 1 && odd[0].intervalHours === 6 && Array.isArray(odd[0].seen), odd);
  mem.set('maglev.watch.v1', JSON.stringify(Array.from({ length: 30 }, (_, i) => ({ id: `w_${i}`, query: `Q${i}`, category: 'all' }))));
  check('a stored list over the cap is cut to 20', createWatchStore(storage).list().length === 20);

  console.log('watch: notification text');
  const n = L.watchNotificationText(mk(), row({ name: 'Primetime.2025.2160p.WEB-DL.DDP5.1.H265-GRP', sizeBytes: 12.4 * GB, seeders: 340 }));
  check('title names the release and resolution', n.title === 'Primetime 2160p is up', n);
  check('body has size and sharing', n.text === '12.4 GB · 340 sharing', n);
  const n2 = L.watchNotificationText(mk(), row({ name: 'Primetime.2025.WEB-DL-X', sizeBytes: undefined, seeders: undefined }));
  check('unknown size and sharing are left out, never invented', n2.title === 'Primetime is up' && n2.text === 'New result', n2);
  const n3 = L.watchNotificationText(mk(), row({ name: 'Primetime.2025.1080p.WEB-DL-X', sizeBytes: 3 * GB, seeders: 1 }));
  check('one person sharing', n3.text === '3.0 GB · 1 sharing', n3);
  check('open link carries query and category', L.openUrl(mk({ query: 'Prime time', category: 'tv' })) === 'maglev://search?q=Prime%20time&c=tv', L.openUrl(mk({ query: 'Prime time', category: 'tv' })));
  check('download link is the Add screen with the magnet', L.downloadUrl(row({})) === `maglev://add-torrent?source=${encodeURIComponent(`magnet:?xt=urn:btih:${hash('a')}`)}`);
  check('no magnet, no download link', L.downloadUrl(row({ magnet: '' })) === undefined);
  check('a stand-in non-magnet string is not a download link', L.downloadUrl(row({ magnet: 'http://x' })) === undefined);
  check('notification id is stable and in range', L.notificationId('w_abc') === L.notificationId('w_abc') && L.notificationId('w_abc') >= 7000 && L.notificationId('w_abc') < 7000 + 65536);

  console.log('watch: list copy');
  check('last checked text', L.lastCheckedText(0, NOW) === 'Not checked yet' && L.lastCheckedText(NOW - 2 * H, NOW) === 'Checked 2 h ago' && L.lastCheckedText(NOW - 5 * 60000, NOW) === 'Checked 5 min ago' && L.lastCheckedText(NOW - 30000, NOW) === 'Checked just now' && L.lastCheckedText(NOW - 50 * H, NOW) === 'Checked 2 days ago');
  check('filters line', L.filtersLine(mk({ minResolution: 2160, maxSizeGb: 15, mustContain: ['hdr'] })) === '2160p or better · up to 15 GB · hdr' && L.filtersLine(mk()) === 'Any quality');
  check('interval label', L.intervalLabel(1) === 'Every hour' && L.intervalLabel(6) === 'Every 6 hours' && L.intervalLabel(24) === 'Every day');

  console.log('watch: the background cycle');
  function cycleWorld(o = {}) {
    const w = {
      list: [mkId('w_one', {  })],
      searches: [],
      notes: [],
      results: [a],
      net: { connected: true, unmetered: true, globalWifiOnly: false },
      fail: false,
      ...o,
    };
    w.deps = {
      now: () => NOW,
      list: () => w.list,
      save: (next) => { w.list = next; },
      network: async () => w.net,
      search: async (q, c) => {
        w.searches.push([q, c]);
        if (w.fail) throw new Error('down');
        return w.results;
      },
      notify: async (p) => { w.notes.push(p); return true; },
    };
    return w;
  }
  {
    const w = cycleWorld();
    const r1 = await runWatchCycle(w.deps);
    check('first cycle searches, records, stays silent', w.searches.length === 1 && w.notes.length === 0 && r1.checked === 1 && w.list[0].lastCheckedAt === NOW && w.list[0].seen.length > 0, { r1, list: w.list });
    const r2 = await runWatchCycle({ ...w.deps, now: () => NOW + 1 * H });
    check('not due yet: nothing is searched', w.searches.length === 1 && r2.checked === 0, r2);
    w.results = [a, b];
    const r3 = await runWatchCycle({ ...w.deps, now: () => NOW + 7 * H });
    check('a new result notifies once', w.notes.length === 1 && r3.notified === 1, w.notes);
    check('notification carries text, links and id', w.notes[0].title === 'Primetime 2160p is up' && w.notes[0].text === '12.0 GB · 12 sharing' && w.notes[0].openUrl.startsWith('maglev://search?q=Primetime') && w.notes[0].downloadUrl.startsWith('maglev://add-torrent?source=') && w.notes[0].id === 'w_one', w.notes[0]);
    check('lastNewAt and lastNewName are set', w.list[0].lastNewAt === NOW + 7 * H && /Primetime/.test(w.list[0].lastNewName), w.list[0]);
    const r4 = await runWatchCycle({ ...w.deps, now: () => NOW + 14 * H });
    check('the same results never notify twice', w.notes.length === 1 && r4.notified === 0);
  }
  {
    const w = cycleWorld({ net: { connected: true, unmetered: false, globalWifiOnly: false } });
    const r = await runWatchCycle(w.deps);
    check('metered network: skipped, not marked checked', w.searches.length === 0 && w.list[0].lastCheckedAt === 0 && r.skipped === 1, r);
  }
  {
    const w = cycleWorld({ fail: true });
    const r = await runWatchCycle(w.deps);
    check('a failed search is not marked checked and does not throw', w.list[0].lastCheckedAt === 0 && r.failed === 1 && w.notes.length === 0, r);
  }
  {
    const w = cycleWorld({ list: [{ ...mkId('w_p'), paused: true }] });
    const r = await runWatchCycle(w.deps);
    check('paused watch is not run', w.searches.length === 0 && r.checked === 0);
  }
  {
    const w = cycleWorld({ list: [mkId('w_1', { query: 'A one' }), mkId('w_2', { query: 'B two' })] });
    w.deps.search = async (q) => { if (q === 'A one') throw new Error('x'); return [a]; };
    const r = await runWatchCycle(w.deps);
    check('one failing watch does not stop the others', r.failed === 1 && r.checked === 1 && w.list.find((x) => x.id === 'w_2').lastCheckedAt === NOW, r);
  }
  {
    const w = cycleWorld({ list: [{ ...mkId('w_u', {  }), seen: ['old'], lastCheckedAt: NOW - 7 * H }] });
    w.deps.notify = async () => false;
    await runWatchCycle(w.deps);
    check('a notification that could not post is retried next run', w.list[0].seen.every((k) => k === 'old') && w.list[0].lastNewAt === 0, w.list[0]);
  }
  {
    const w = cycleWorld({ list: [{ ...mkId('w_m', { mobileData: true }) }], net: { connected: true, unmetered: false, globalWifiOnly: false } });
    const r = await runWatchCycle(w.deps);
    check('mobile data allowed: runs on a metered network', r.checked === 1);
  }

  console.log('watch: assistant tool and proposal card');
  check('watch_title is a proposal tool the model sees', PROPOSAL_TOOLS.has('watch_title') && TOOLS.some((t) => t.function.name === 'watch_title'));
  const def = TOOLS.find((t) => t.function.name === 'watch_title').function;
  check('schema is closed and requires the query', def.parameters.additionalProperties === false && def.parameters.required.includes('query') && def.parameters.properties.min_resolution && def.parameters.properties.max_size_gb && def.parameters.properties.category, def.parameters);
  const eng = {
    async listTorrents() { return { ok: true, torrents: [], downloads: [] }; },
    async getFreeSpace() { return { ok: true, path: '/x', freeBytes: 50 * GB, totalBytes: 128 * GB, mode: 'direct' }; },
  };
  let watchCalls = [];
  let existing = [];
  const watchApi = {
    count: () => existing.length,
    has: (q, c) => existing.some((e) => e.q === q.toLowerCase() && e.c === c),
    add: (input) => { watchCalls.push(input); existing.push({ q: input.query.toLowerCase(), c: input.category }); return { ok: true }; },
  };
  const runner = createToolRunner({
    async search() { return { results: [], sources: [], done: true }; },
    searchPrefs: () => ({ warnUnsafe: true, providers: new Map() }),
    async resolveResult(r) { return r; },
    engine: eng,
    playbackSupport: async () => null,
    now: () => NOW,
    watch: watchApi,
  });
  const v = validateArgs('watch_title', { query: 'Primetime', category: 'movies', min_resolution: 2160, max_size_gb: 15, reason: 'You asked to be told.' }, runner.registry);
  check('valid arguments pass', v.ok === true, v);
  check('a bad resolution fails', validateArgs('watch_title', { query: 'Primetime', min_resolution: 999 }, runner.registry).ok === false);
  const extra = validateArgs('watch_title', { query: 'Primetime', interval: 1 }, runner.registry);
  check('an unknown field (interval) never reaches the card', extra.ok === false || !('interval' in extra.args), extra);
  const card = await runner.prepareCard('c1', 'watch_title', v.args);
  check('builds a confirm card, nothing created yet', !('error' in card) && card.tool === 'watch_title' && card.title === 'Watch for this title?' && card.confirmLabel === 'Watch' && watchCalls.length === 0, card);
  check('card facts say interval, network and filters', card.facts.some((f) => /6 hours/.test(f) && /Wi-Fi only/.test(f)) && card.facts.some((f) => /2160p/.test(f) && /15 GB/.test(f)) && card.facts.some((f) => /0 of 20|1 of 20|of 20/.test(f)), card.facts);
  check('card shows the query as the source name', card.sourceName === 'Primetime', card.sourceName);
  check('card is not danger', card.danger === false && card.risky === false);
  const rv = await runner.revalidate('c1');
  check('revalidate passes with room', rv.ok === true, rv);
  const done = await runner.execute('c1');
  check('Confirm creates the watch with the filters', done.ok === true && watchCalls.length === 1 && watchCalls[0].query === 'Primetime' && watchCalls[0].category === 'movies' && watchCalls[0].minResolution === 2160 && watchCalls[0].maxSizeGb === 15, { done, watchCalls });
  const again = await runner.execute('c1');
  check('a second Confirm does not create a second watch', watchCalls.length === 1 && again.ok === true);
  const dupCard = await runner.prepareCard('c2', 'watch_title', validateArgs('watch_title', { query: 'primetime', category: 'movies' }, runner.registry).args);
  check('already watching: plain error, no card', 'error' in dupCard && /already/i.test(dupCard.error), dupCard);
  existing = Array.from({ length: 20 }, (_, i) => ({ q: `q${i}`, c: 'all' }));
  const capCard = await runner.prepareCard('c3', 'watch_title', validateArgs('watch_title', { query: 'Another', category: 'all' }, runner.registry).args);
  check('at 20 watches: plain error, no card', 'error' in capCard && /20/.test(capCard.error), capCard);
  const bare = createToolRunner({ search: async () => ({ results: [], sources: [], done: true }), searchPrefs: () => ({ warnUnsafe: true, providers: new Map() }), async resolveResult(r) { return r; }, engine: eng, playbackSupport: async () => null, now: () => NOW });
  const noApi = await bare.prepareCard('c4', 'watch_title', validateArgs('watch_title', { query: 'Primetime' }, bare.registry).args);
  check('without a watch store the tool says so plainly', 'error' in noApi, noApi);

  console.log('watch: system prompt');
  const p = buildSystemPrompt({ now: new Date('2026-11-12T12:10:00Z'), timeZone: 'Asia/Kolkata' });
  check('the prompt tells the model to use watch_title and that it only proposes', /watch_title \(a card\)/.test(p.split('<approach>')[1].split('</approach>')[0]));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
