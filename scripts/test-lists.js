#!/usr/bin/env node
// Self-updating lists (docs/NATIVE_CONTRACT.md section 31.7): schema validation, the serial rule, mirror precedence,
// disabled sources, trackers, the default ad list address rule, the 24 h gate, network rules, state machine L1, a
// full check with fakes, and a real signature round trip. Pure plus fakes. Needs Node 22.18+ (runs the TypeScript
// source directly). The signature check here uses node:crypto, which stands in for the Kotlin verifier.
process.removeAllListeners('warning');

const crypto = require('crypto');
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const T = (n) => Array.from({ length: n }, (_, i) => `udp://t${i}.example.org:80/announce`);
const base = (over = {}) => ({ schema: 1, serial: 2026111402, generatedAt: '2026-11-14T10:00:00Z', sources: {}, trackers: T(4), blocklistUrls: ['https://lists.example.org/hosts'], ...over });

(async () => {
  const S = await import('../utils/lists/schema.ts');
  const M = await import('../utils/lists/machine.ts');
  const C = await import('../utils/lists/check.ts');
  const store = await import('../utils/lists/store.ts');
  const agg = await import('../utils/search/aggregate.ts');
  const magnet = await import('../utils/search/magnet.ts');
  const prefsLists = await import('../utils/prefs/lists.ts');
  const browserPrefs = await import('../utils/prefs/browser.ts');
  const known = new Set(['nyaa', 'tpb', 'fake']);

  console.log('[schema]');
  const ok = S.validateFile(base({ sources: { nyaa: { mirrors: ['https://a.example', 'https://b.example'], enabled: true, note: 'Back soon', unsafeReason: null }, ghost: { enabled: false } } }), known);
  check('a good file passes', ok.ok && ok.file.serial === 2026111402);
  check('unknown provider ids are ignored', ok.ok && !('ghost' in ok.file.sources) && 'nyaa' in ok.file.sources);
  check('unsafeReason null is kept (it clears the warning)', ok.ok && ok.file.sources.nyaa.unsafeReason === null);
  check('a different schema number is rejected', !S.validateFile(base({ schema: 2 }), known).ok && S.validateFile(base({ schema: 2 }), known).reason === 'schema');
  check('a missing or non-integer serial is rejected', ['x', 1.5, -1, 0, undefined, null].every((serial) => !S.validateFile(base({ serial }), known).ok));
  check('not JSON, not an object', S.parseSourcesFile('nope', known).reason === 'schema' && S.parseSourcesFile('[]', known).reason === 'schema');
  check('over 256 KB is rejected as too big', S.parseSourcesFile(JSON.stringify(base({ pad: 'x'.repeat(S.MAX_FILE_BYTES) })), known).reason === 'size');
  check('exactly the cap is read', S.parseSourcesFile(JSON.stringify(base()), known).ok);
  const drop = (src) => S.validateFile(base({ sources: { nyaa: src } }), known).file.sources.nyaa;
  check('http mirrors drop the mirrors field, nothing else', eq(drop({ mirrors: ['http://a.example'], enabled: false }), { enabled: false }));
  check('more than 5 mirrors drops the field', drop({ mirrors: Array.from({ length: 6 }, (_, i) => `https://m${i}.example`), enabled: true }).mirrors === undefined);
  check('exactly 5 mirrors is fine', drop({ mirrors: Array.from({ length: 5 }, (_, i) => `https://m${i}.example`) }).mirrors.length === 5);
  check('mirror with credentials or spaces drops the field', drop({ mirrors: ['https://user:pw@a.example'] }).mirrors === undefined && drop({ mirrors: ['https://a b.example'] }).mirrors === undefined);
  check('enabled must be boolean', drop({ enabled: 'no' }).enabled === undefined);
  check('note over 140 characters is dropped', drop({ note: 'x'.repeat(141), enabled: false }).note === undefined && drop({ note: 'x'.repeat(140) }).note.length === 140);
  check('note with markup is dropped (plain text only)', drop({ note: '<b>hi</b>' }).note === undefined);
  check('a bad field never costs the other fields', eq(drop({ mirrors: 5, enabled: false, note: 'Gone' }), { enabled: false, note: 'Gone' }));
  const tr = (trackers) => S.validateFile(base({ trackers }), known).file.trackers;
  check('trackers: udp, http, https and wss pass', eq(tr(['udp://a.example:1/announce', 'http://b.example/announce', 'https://c.example/announce', 'wss://d.example/announce']).length, 4));
  check('trackers: ws, ftp and magnet are not announce schemes', tr(['udp://a.example:1', 'ws://b.example', 'udp://c.example:2']) === undefined && tr(['ftp://a.example', 'udp://b.example:1', 'udp://c.example:2']) === undefined);
  check('trackers: fewer than 3 or more than 40 drops the field', tr(T(2)) === undefined && tr(T(41)) === undefined && tr(T(3)).length === 3 && tr(T(40)).length === 40);
  check('trackers dropped, the rest still applies', (() => { const r = S.validateFile(base({ trackers: T(1) }), known); return r.ok && r.file.trackers === undefined && r.file.blocklistUrls.length === 1; })());
  const bl = (u) => S.validateFile(base({ blocklistUrls: u }), known).file.blocklistUrls;
  check('blocklistUrls: https only, 1 to 5', bl(['http://a.example']) === undefined && bl([]) === undefined && bl(Array.from({ length: 6 }, (_, i) => `https://l${i}.example/x`)) === undefined && bl(['https://a.example/x']).length === 1);

  console.log('[committed lists/sources.json]');
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lists', 'sources.json'), 'utf8'));
  const realOk = S.validateFile(real);
  check('it passes the schema', realOk.ok && realOk.file.serial === real.serial);
  check('its trackers are the built-in ones and its list address is the built-in one', eq(real.trackers, magnet.DEFAULT_TRACKERS) && eq(real.blocklistUrls, [browserPrefs.DEFAULT_BLOCKLIST_URL]));

  console.log('[serial and rollback rule]');
  check('higher applies', M.serialDecision(5, 4) === 'apply');
  check('equal is unchanged', M.serialDecision(4, 4) === 'unchanged');
  check('lower is a rollback', M.serialDecision(3, 4) === 'rollback');
  check('bundled defaults are serial 0', prefsLists.defaultListPrefs().appliedSerial === 0 && M.serialDecision(1, 0) === 'apply');
  check('stored serial follows the stored file', prefsLists.normalizeListPrefs({ sourcesFile: base(), appliedSerial: 7 }).appliedSerial === 2026111402);
  check('an invalid stored file means built-in defaults', prefsLists.normalizeListPrefs({ sourcesFile: { schema: 9 } }).appliedSerial === 0);
  check('auto update defaults to on', prefsLists.defaultListPrefs().listsAutoCheck === true && prefsLists.normalizeListPrefs({ listsAutoCheck: false }).listsAutoCheck === false);

  console.log('[mirror precedence: user override, then file, then built-in]');
  const seen = [];
  const fake = {
    id: 'fake', name: 'Fake', abbr: 'FK', homepage: 'https://built-in.example', mirrors: ['https://built-in.example', 'https://built-in2.example'], categories: ['other'], nsfw: false,
    unsafeReason: 'Built-in warning', enabledByDefault: false, method: 'json', canPage: false,
    async search(_q, _c, _p, ctx) { seen.push(ctx.baseUrl); return []; },
  };
  agg.PROVIDERS.push(fake);
  const run = async (mirrorOverride) => { seen.length = 0; await agg.searchAll('x', 'all', { enabled: ['fake'], mirrorOverride }); return seen[0]; };
  store.setAppliedFile(null);
  check('no file: built-in mirror', (await run(undefined)) === 'https://built-in.example');
  store.setAppliedFile(base({ sources: { fake: { mirrors: ['https://file.example'] } } }));
  check('file mirror beats built-in', (await run(undefined)) === 'https://file.example');
  check('user override beats file', (await run({ fake: 'https://mine.example' })) === 'https://mine.example');
  check('the built-in provider object is not changed', fake.mirrors[0] === 'https://built-in.example');
  check('the same override copy is returned for the same file', store.applyListOverrides(fake) === store.applyListOverrides(fake));
  console.log('[disabled sources, notes and warnings]');
  store.setAppliedFile(base({ sources: { fake: { enabled: false, note: 'Shut down for now' } } }));
  seen.length = 0;
  await agg.searchAll('x', 'all', { enabled: ['fake'] });
  check('enabled:false skips the source in search', seen.length === 0 && agg.eligibleProviders('all', { enabled: ['fake'] }).length === 0);
  check('the note is available for the row', eq(store.listDisabled('fake'), { note: 'Shut down for now' }));
  store.setAppliedFile(base({ sources: { fake: { enabled: true } } }));
  check('enabled:true brings it back', agg.eligibleProviders('all', { enabled: ['fake'] }).length === 1 && store.listDisabled('fake') === null);
  store.setAppliedFile(base({ sources: {} }));
  check('removing the entry brings it back too', agg.eligibleProviders('all', { enabled: ['fake'] }).length === 1);
  store.setAppliedFile(base({ sources: { fake: { unsafeReason: 'Fake uploads reported' } } }));
  check('unsafeReason replaces the built-in warning', store.applyListOverrides(fake).unsafeReason === 'Fake uploads reported');
  store.setAppliedFile(base({ sources: { fake: { unsafeReason: null } } }));
  check('unsafeReason null clears it', store.applyListOverrides(fake).unsafeReason === undefined && fake.unsafeReason === 'Built-in warning');
  store.setAppliedFile(null);
  check('without a file the warning is the built-in one', store.applyListOverrides(fake).unsafeReason === 'Built-in warning');
  agg.PROVIDERS.splice(agg.PROVIDERS.indexOf(fake), 1);

  console.log('[trackers]');
  const A = 'a'.repeat(40);
  store.setAppliedFile(null);
  check('built-in trackers without a file', magnet.buildMagnet(A, 'x').includes('tracker.opentrackr.org'));
  store.setAppliedFile(base({ trackers: T(3) }));
  const m = magnet.buildMagnet(A, 'x', ['udp://extra.example:1']);
  check('the file replaces the default trackers', m.includes(encodeURIComponent(T(3)[0])) && !m.includes('opentrackr'));
  check('a tracker the caller passes still comes first', m.indexOf('extra.example') < m.indexOf('t0.example'));
  store.setAppliedFile(base({ trackers: undefined }));
  check('a file without trackers keeps the built-in ones', magnet.defaultTrackers() === magnet.DEFAULT_TRACKERS);
  store.setAppliedFile(null);

  console.log('[default ad list address]');
  const DEF = [browserPrefs.DEFAULT_BLOCKLIST_URL];
  const NEW = ['https://lists.example.org/hosts'];
  check('replaces the user list when it still equals the previous default', eq(C.nextBlocklistUrls(DEF, DEF, NEW), NEW));
  check('keeps a list the user chose', C.nextBlocklistUrls(['https://mine.example/h'], DEF, NEW) === null);
  check('keeps a user list that has an extra address', C.nextBlocklistUrls([...DEF, 'https://mine.example/h'], DEF, NEW) === null);
  check('compares with the previous file, not the built-in one', eq(C.nextBlocklistUrls(NEW, NEW, ['https://other.example/h']), ['https://other.example/h']) && C.nextBlocklistUrls(DEF, NEW, ['https://other.example/h']) === null);
  check('no change when the file has no list or the same list', C.nextBlocklistUrls(DEF, DEF, undefined) === null && C.nextBlocklistUrls(DEF, DEF, DEF) === null);
  check('the default starts as the built-in address', eq(prefsLists.defaultListPrefs().blocklistDefault, DEF) && eq(prefsLists.getDefaultBlocklistUrls(), DEF));

  console.log('[sources changed count]');
  const f1 = base({ sources: { nyaa: { enabled: true }, tpb: { enabled: true } } });
  const f2 = base({ sources: { nyaa: { enabled: false }, tpb: { enabled: true }, fake: { mirrors: ['https://x.example'] } } });
  check('counts changed and added entries', C.countChangedSources(f1, f2) === 2 && C.countChangedSources(null, f1) === 2 && C.countChangedSources(f1, f1) === 0);

  console.log('[24 h gate and network rules]');
  const H = 3_600_000;
  const now = 1_000 * H;
  const due = (lastListCheckAt, autoCheck = true) => M.autoCheckDue({ now, lastListCheckAt, autoCheck });
  check('never checked is due', due(null));
  check('23 h ago is not due, 24 h is', !due(now - 23 * H) && due(now - 24 * H));
  check('a clock that went backwards is due', due(now + H));
  check('off means never due', !due(null, false));
  const net = (o) => ({ connected: true, metered: false, vpn: false, ...o });
  const free = { wifiOnly: false, vpnOnly: false };
  check('offline is a network failure', M.netVerdict(null, free) === 'network' && M.netVerdict(net({ connected: false }), free) === 'network');
  check('Wi-Fi only blocks a metered link', M.netVerdict(net({ metered: true }), { wifiOnly: true, vpnOnly: false }) === 'blocked' && M.netVerdict(net(), { wifiOnly: true, vpnOnly: false }) === 'ok');
  check('VPN only blocks a link with no VPN', M.netVerdict(net(), { wifiOnly: false, vpnOnly: true }) === 'blocked' && M.netVerdict(net({ vpn: true }), { wifiOnly: false, vpnOnly: true }) === 'ok');
  check('ad list: automatic needs unmetered', M.adListAllowed(net(), free, false) && !M.adListAllowed(net({ metered: true }), free, false));
  check('ad list: manual allows metered', M.adListAllowed(net({ metered: true }), free, true));
  check('ad list: manual still obeys Wi-Fi only', !M.adListAllowed(net({ metered: true }), { wifiOnly: true, vpnOnly: false }, true));
  check('ad list: offline never', !M.adListAllowed(null, free, true));

  console.log('[state machine L1]');
  const R = M.reduce;
  let s = M.initialState;
  check('idle at start', s.sources.kind === 'idle' && s.ad.kind === 'idle' && !M.busy(s));
  s = R(s, { type: 'start' });
  check('start: Checking', s.sources.kind === 'checking' && M.busy(s));
  check('start while busy is ignored', R(s, { type: 'start' }) === s);
  check('fetched outside Checking is ignored', R(M.initialState, { type: 'fetched' }) === M.initialState);
  s = R(s, { type: 'fetched' });
  check('fetched: Verifying', s.sources.kind === 'verifying');
  const results = [
    { kind: 'applied', changed: 2 }, { kind: 'unchanged' }, { kind: 'rejected', why: 'signature' }, { kind: 'rejected', why: 'schema' },
    { kind: 'rejected', why: 'serial' }, { kind: 'failed', why: 'network' }, { kind: 'failed', why: 'http' }, { kind: 'failed', why: 'blocked' },
  ];
  check('Verifying reaches every sources result', results.every((r) => eq(R(s, { type: 'sourcesResult', result: r }).sources, r)));
  check('Checking can fail without verifying (network, http)', R(R(M.initialState, { type: 'start' }), { type: 'sourcesResult', result: { kind: 'failed', why: 'http' } }).sources.kind === 'failed');
  check('a result with nothing running is ignored', R(M.initialState, { type: 'sourcesResult', result: { kind: 'unchanged' } }) === M.initialState);
  check('the ad list waits for the sources half', R(s, { type: 'adStart' }) === s);
  s = R(s, { type: 'sourcesResult', result: { kind: 'rejected', why: 'signature' } });
  s = R(s, { type: 'adStart' });
  check('a failed sources half does not block the ad list', s.ad.kind === 'downloading' && s.sources.kind === 'rejected');
  const adResults = [{ kind: 'updated', domains: 5 }, { kind: 'notModified' }, { kind: 'failed', why: 'network' }, { kind: 'failed', why: 'blocked' }, { kind: 'failed', why: 'invalid' }];
  check('Downloading reaches every ad result', adResults.every((r) => eq(R(s, { type: 'adResult', result: r }).ad, r)));
  check('skipped is reported straight from Idle', R(R(M.initialState, { type: 'start' }), { type: 'sourcesResult', result: { kind: 'unchanged' } }).ad.kind === 'idle' && R(R(R(M.initialState, { type: 'start' }), { type: 'sourcesResult', result: { kind: 'unchanged' } }), { type: 'adResult', result: { kind: 'skipped' } }).ad.kind === 'skipped');
  check('the ad list can run alone (Browser > Update now)', R(M.initialState, { type: 'adStart' }).ad.kind === 'downloading');
  check('a new check goes back to Idle for the ad half', R(R(s, { type: 'adResult', result: { kind: 'updated', domains: 1 } }), { type: 'start' }).ad.kind === 'idle');

  console.log('[a full check, with fakes]');
  const body = JSON.stringify(base({ serial: 10, sources: { nyaa: { enabled: false, note: 'Down' } } }));
  const ENDPOINTS = { src: C.SOURCES_URL, sig: C.SIGNATURE_URL };
  function harness(o = {}) {
    const log = { fetched: [], applied: [], ad: [], marked: [], states: [] };
    let st = M.initialState;
    const d = {
      now: () => 5_000,
      fetch: async (url, init) => {
        log.fetched.push({ url, init });
        if (o.fetchThrows) throw new TypeError('offline');
        const status = o.status ?? 200;
        return { ok: status === 200, status, text: async () => (url === ENDPOINTS.sig ? o.sig ?? 'SIG' : o.body ?? body) };
      },
      verify: async (b, sig) => (o.verify ? o.verify(b, sig) : true),
      known,
      net: async () => (o.net === undefined ? net() : o.net),
      rules: () => o.rules ?? free,
      appliedSerial: () => o.serial ?? 0,
      apply: (file) => { log.applied.push(file.serial); return 1; },
      updateAdList: async (c) => { log.ad.push(c); return o.ad ?? { ok: true, domains: 9, changed: true }; },
      dispatch: (e) => { st = M.reduce(st, e); log.states.push(st); return st; },
      isBusy: () => M.busy(st),
      markChecked: (at) => log.marked.push(at),
    };
    return { d, log, state: () => st };
  }
  let h = harness();
  check('runs and applies', (await C.runListCheck(h.d, { manual: false })) && h.log.applied[0] === 10 && eq(h.state().sources, { kind: 'applied', changed: 1 }));
  check('fetches the file and its signature with credentials omitted and no custom headers', h.log.fetched.length === 2 && h.log.fetched.every((f) => f.init.credentials === 'omit' && !f.init.headers) && eq(h.log.fetched.map((f) => f.url).sort(), [C.SIGNATURE_URL, C.SOURCES_URL].sort()));
  check('both go to harshdayal.dev/maglev/lists', C.SOURCES_URL === 'https://harshdayal.dev/maglev/lists/sources.json' && C.SIGNATURE_URL === `${C.SOURCES_URL}.sig`);
  check('the 24 h gate moves when a check starts', eq(h.log.marked, [5000]));
  check('then the ad list runs, conditional', eq(h.log.ad, [true]) && eq(h.state().ad, { kind: 'updated', domains: 9 }));
  h = harness({ serial: 10 });
  await C.runListCheck(h.d, { manual: false });
  check('same serial: unchanged, nothing applied', h.log.applied.length === 0 && h.state().sources.kind === 'unchanged');
  h = harness({ serial: 11 });
  await C.runListCheck(h.d, { manual: false });
  check('lower serial: rejected (serial), nothing applied', h.log.applied.length === 0 && eq(h.state().sources, { kind: 'rejected', why: 'serial' }));
  h = harness({ verify: () => false });
  await C.runListCheck(h.d, { manual: false });
  check('bad signature: rejected, nothing applied, ad list still runs', h.log.applied.length === 0 && eq(h.state().sources, { kind: 'rejected', why: 'signature' }) && h.log.ad.length === 1);
  h = harness({ verify: () => { throw new Error('native'); } });
  await C.runListCheck(h.d, { manual: false });
  check('a verifier that throws counts as a bad signature', eq(h.state().sources, { kind: 'rejected', why: 'signature' }));
  h = harness({ body: '{"schema":2,"serial":99}' });
  await C.runListCheck(h.d, { manual: false });
  check('bad schema: rejected (schema)', h.log.applied.length === 0 && eq(h.state().sources, { kind: 'rejected', why: 'schema' }));
  h = harness({ body: 'x'.repeat(300 * 1024) });
  await C.runListCheck(h.d, { manual: false });
  check('a file over 256 KB is rejected before it is verified', eq(h.state().sources, { kind: 'rejected', why: 'schema' }));
  h = harness({ fetchThrows: true });
  await C.runListCheck(h.d, { manual: false });
  check('network error: failed (network), the ad list still runs', eq(h.state().sources, { kind: 'failed', why: 'network' }) && h.log.ad.length === 1);
  h = harness({ status: 503 });
  await C.runListCheck(h.d, { manual: false });
  check('http error: failed (http)', eq(h.state().sources, { kind: 'failed', why: 'http' }));
  h = harness({ net: net({ metered: true }) });
  await C.runListCheck(h.d, { manual: false });
  check('automatic on a metered link: sources apply, ad list skipped', h.log.applied.length === 1 && h.log.ad.length === 0 && h.state().ad.kind === 'skipped');
  h = harness({ net: net({ metered: true }) });
  await C.runListCheck(h.d, { manual: true });
  check('manual on a metered link: the ad list runs', h.log.ad.length === 1);
  h = harness({ net: net({ metered: true }), rules: { wifiOnly: true, vpnOnly: false } });
  await C.runListCheck(h.d, { manual: true });
  check('manual with Wi-Fi only on mobile data: both blocked, nothing fetched', h.log.fetched.length === 0 && eq(h.state().sources, { kind: 'failed', why: 'blocked' }) && eq(h.state().ad, { kind: 'failed', why: 'blocked' }));
  h = harness({ net: null });
  await C.runListCheck(h.d, { manual: true });
  check('offline: failed (network)', eq(h.state().sources, { kind: 'failed', why: 'network' }));
  h = harness({ ad: { ok: false, code: 'BLOCKED' } });
  await C.runListCheck(h.d, { manual: false });
  check('ad list BLOCKED maps to blocked, sources unaffected', eq(h.state().ad, { kind: 'failed', why: 'blocked' }) && h.state().sources.kind === 'applied');
  check('ad result mapping', eq(C.adResultOf({ ok: true, domains: 3, changed: false }), { kind: 'notModified' }) && eq(C.adResultOf({ ok: true, domains: 3 }), { kind: 'updated', domains: 3 }) && eq(C.adResultOf({ ok: false, code: 'HTTP_STATUS' }), { kind: 'failed', why: 'http' }) && eq(C.adResultOf({ ok: false, code: 'LIST_INVALID' }), { kind: 'failed', why: 'invalid' }) && eq(C.adResultOf({ ok: false, code: 'NETWORK' }), { kind: 'failed', why: 'network' }));
  h = harness();
  const first = C.runListCheck(h.d, { manual: true });
  check('a second check while one runs is refused', (await C.runListCheck(h.d, { manual: true })) === false);
  await first;

  console.log('[a real signature round trip (node:crypto stands in for the Kotlin verifier)]');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signed = JSON.stringify(base({ serial: 20, sources: { nyaa: { mirrors: ['https://signed.example'] } } }));
  const sigB64 = crypto.sign('sha256', Buffer.from(signed), privateKey).toString('base64');
  const verifyWith = (pub) => async (b, sig) => { try { return crypto.verify('sha256', Buffer.from(b), pub, Buffer.from(sig, 'base64')); } catch { return false; } };
  check('the signature is DER (starts with 0x30)', Buffer.from(sigB64, 'base64')[0] === 0x30);
  h = harness({ body: signed, sig: sigB64 + '\n', verify: verifyWith(publicKey) });
  await C.runListCheck(h.d, { manual: false });
  check('a correctly signed file is applied', h.log.applied[0] === 20 && h.state().sources.kind === 'applied');
  h = harness({ body: signed.replace('signed.example', 'evil.example'), sig: sigB64, verify: verifyWith(publicKey) });
  await C.runListCheck(h.d, { manual: false });
  check('a tampered body is never applied', h.log.applied.length === 0 && eq(h.state().sources, { kind: 'rejected', why: 'signature' }));
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  h = harness({ body: signed, sig: sigB64, verify: verifyWith(other.publicKey) });
  await C.runListCheck(h.d, { manual: false });
  check('a signature from another key is never applied', h.log.applied.length === 0 && eq(h.state().sources, { kind: 'rejected', why: 'signature' }));
  h = harness({ body: signed, sig: 'not base64 !!', verify: verifyWith(publicKey) });
  await C.runListCheck(h.d, { manual: false });
  check('garbage in place of a signature is never applied', h.log.applied.length === 0);
  const embedded = Buffer.from(fs.readFileSync(path.join(__dirname, '..', 'modules/maglev-engine/android/src/main/java/com/maglev/engine/lists/ListKeys.kt'), 'utf8').match(/"([A-Za-z0-9+/=]{100,})"/)[1], 'base64');
  const embeddedKey = crypto.createPublicKey({ key: embedded, format: 'der', type: 'spki' });
  check('the embedded key is a P-256 public key', embeddedKey.asymmetricKeyType === 'ec' && embeddedKey.asymmetricKeyDetails.namedCurve === 'prime256v1');

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll list checks passed.');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
