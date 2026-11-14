#!/usr/bin/env node
// In-app updates (docs/NATIVE_CONTRACT.md section 27.10): tag parsing, asset choice per ABI, state machine U1,
// the 24 h gate, managed sources, skipped versions, network and safe-to-install rules, issue URL. Pure plus a fake
// fetch. Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');

const Module = require('module');

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

const SHA = 'a'.repeat(64);
const asset = (tag, abi, over = {}) => ({
  name: `Maglev-${tag}-${abi}.apk`,
  browser_download_url: `https://github.com/Kaos599/Maglev/releases/download/${tag}/Maglev-${tag}-${abi}.apk`,
  digest: `sha256:${SHA}`,
  size: 12345,
  ...over,
});
const release = (tag, over = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/Kaos599/Maglev/releases/tag/${tag}`,
  body: '## What\'s new\n- one',
  draft: false,
  prerelease: false,
  assets: ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'universal'].map((a) => asset(tag, a)),
  ...over,
});

(async () => {
  Module.registerHooks({
    resolve(spec, ctx, next) {
      if (spec === 'expo-sqlite/kv-store') return { url: `stub:${spec}`, shortCircuit: true, format: 'commonjs' };
      return next(spec, ctx);
    },
    load(url, ctx, next) {
      if (url.startsWith('stub:')) {
        return { format: 'commonjs', shortCircuit: true, source: 'module.exports = { default: { getItemSync: () => null, setItemSync() {} } };' };
      }
      return next(url, ctx);
    },
  });
  const c = await import('../utils/update/check.ts');
  const m = await import('../utils/update/machine.ts');
  const r = await import('../utils/update/rules.ts');
  const prefs = await import('../utils/prefs/update.ts');

  console.log('[tags]');
  check('v0.23 parses', JSON.stringify(c.parseTag('v0.23')) === '{"major":0,"minor":23}');
  check('beta, patch, bare and junk tags are ignored', ['v0.23-beta', 'v0.23.1', '0.23', 'v1', 'vx.y', '', null, 7].every((t) => c.parseTag(t) === null));
  check('minor and major compare', c.isNewer('v0.22', '0.21') && c.isNewer('v1.0', '0.99') && c.isNewer('v0.10', '0.9'));
  check('same or older is not newer', !c.isNewer('v0.21', '0.21') && !c.isNewer('v0.20', '0.21') && !c.isNewer('v0.9', '0.10'));
  check('a beta tag is never newer', !c.isNewer('v0.22-beta', '0.21'));

  console.log('\n[assets]');
  check('ABI digits', c.abiForVersionCode(214) === 'arm64-v8a' && c.abiForVersionCode(211) === 'armeabi-v7a' && c.abiForVersionCode(213) === 'x86_64' && c.abiForVersionCode(210) === 'universal');
  check('unknown digit or junk has no ABI', c.abiForVersionCode(215) === null && c.abiForVersionCode(-1) === null && c.abiForVersionCode(null) === null && c.abiForVersionCode(2.5) === null);
  for (const [vc, abi] of [[214, 'arm64-v8a'], [211, 'armeabi-v7a'], [213, 'x86_64'], [210, 'universal']]) {
    const info = c.parseRelease(release('v0.22'), { version: '0.21', versionCode: vc });
    check(`versionCode ${vc} picks ${abi}`, !!info && info.apkUrl.endsWith(`-${abi}.apk`) && info.sha256 === SHA && info.version === '0.22' && info.tag === 'v0.22' && info.size === 12345);
  }
  const noDigest = release('v0.22', { assets: [asset('v0.22', 'arm64-v8a', { digest: null })] });
  check('a missing digest means no update for this phone', c.parseRelease(noDigest, { version: '0.21', versionCode: 214 }) === null);
  check('a malformed digest means no update', c.parseRelease(release('v0.22', { assets: [asset('v0.22', 'arm64-v8a', { digest: 'sha1:abc' })] }), { version: '0.21', versionCode: 214 }) === null);
  check('a missing ABI asset means no update', c.parseRelease(release('v0.22', { assets: [asset('v0.22', 'universal')] }), { version: '0.21', versionCode: 214 }) === null);
  check('a wrongly named asset is skipped', c.parseRelease(release('v0.22', { assets: [asset('v0.22', 'arm64-v8a', { name: 'app-arm64.apk' })] }), { version: '0.21', versionCode: 214 }) === null);
  check('digest hex is lowercased', c.parseRelease(release('v0.22', { assets: [asset('v0.22', 'arm64-v8a', { digest: `sha256:${'A'.repeat(64)}` })] }), { version: '0.21', versionCode: 214 }).sha256 === SHA);
  check('not newer gives null', c.parseRelease(release('v0.21'), { version: '0.21', versionCode: 214 }) === null);
  check('draft and prerelease give null', c.parseRelease(release('v0.22', { draft: true }), { version: '0.21', versionCode: 214 }) === null && c.parseRelease(release('v0.22', { prerelease: true }), { version: '0.21', versionCode: 214 }) === null);
  check('notes are capped at 4,000 characters', c.parseRelease(release('v0.22', { body: 'x'.repeat(9000) }), { version: '0.21', versionCode: 214 }).notes.length === 4000);
  check('plain notes drop markdown', c.plainNotes('## Hi\n- **bold** [site](http://x)\n\n\n\nend') === 'Hi\n• bold site\n\nend');

  console.log('\n[fetch]');
  const calls = [];
  const okFetch = (json, ok = true, status = 200) => async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => json };
  };
  const inst = { version: '0.21', versionCode: 214 };
  const got = await c.checkForUpdate(okFetch(release('v0.22')), inst);
  check('request is GET releases/latest with the right headers only', calls[0].url === 'https://api.github.com/repos/Kaos599/Maglev/releases/latest' && calls[0].init.headers.Accept === 'application/vnd.github+json' && calls[0].init.headers['User-Agent'] === 'Maglev/0.21' && Object.keys(calls[0].init.headers).length === 2 && !('Authorization' in calls[0].init.headers));
  check('parsed result', got && got.version === '0.22');
  check('up to date gives null', (await c.checkForUpdate(okFetch(release('v0.21')), inst)) === null);
  const fails = async (f) => {
    try {
      await c.checkForUpdate(f, inst);
      return null;
    } catch (e) {
      return e.kind;
    }
  };
  check('network failure throws', (await fails(async () => { throw new Error('offline'); })) === 'network');
  check('HTTP error throws', (await fails(okFetch({}, false, 403))) === 'status');
  check('unreadable body throws', (await fails(async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }))) === 'parse');
  const abortFetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  check('timeout aborts the request', (await (async () => { try { await c.checkForUpdate(abortFetch, inst, 20); return null; } catch (e) { return e.kind; } })()) === 'network');

  console.log('\n[24 h gate and managed sources]');
  const NOW = 1_800_000_000_000;
  const H = 3600_000;
  check('never checked is due', m.autoCheckDue({ now: NOW, lastCheckAt: null, autoCheck: true, managedBy: null }));
  check('23 h ago is not due', !m.autoCheckDue({ now: NOW, lastCheckAt: NOW - 23 * H, autoCheck: true, managedBy: null }));
  check('24 h ago is due', m.autoCheckDue({ now: NOW, lastCheckAt: NOW - 24 * H, autoCheck: true, managedBy: null }));
  check('a clock set back is due', m.autoCheckDue({ now: NOW, lastCheckAt: NOW + H, autoCheck: true, managedBy: null }));
  check('the toggle off is never due', !m.autoCheckDue({ now: NOW, lastCheckAt: null, autoCheck: false, managedBy: null }));
  for (const by of ['fdroid', 'obtainium', 'play']) check(`managed by ${by} is never due`, !m.autoCheckDue({ now: NOW, lastCheckAt: null, autoCheck: true, managedBy: by }));

  console.log('\n[U1 transitions]');
  const info = c.parseRelease(release('v0.22'), inst);
  const run = (events, from = m.initialState) => events.reduce((s, e) => m.reduce(s, e), from);
  const kind = (s) => s.kind;
  const found = [{ type: 'check' }, { type: 'checked', info, skippedVersion: null, manual: false }];
  check('Idle -> Checking', kind(run([{ type: 'check' }])) === 'checking');
  check('Checking -> UpToDate', kind(run([{ type: 'check' }, { type: 'checked', info: null, skippedVersion: null, manual: true }])) === 'upToDate');
  check('Checking -> Available', kind(run(found)) === 'available');
  check('Checking -> CheckFailed', kind(run([{ type: 'check' }, { type: 'checkFailed' }])) === 'checkFailed');
  check('CheckFailed can check again', kind(run([{ type: 'check' }, { type: 'checkFailed' }, { type: 'check' }])) === 'checking');
  check('a check is ignored while checking', kind(run([{ type: 'check' }, { type: 'check' }])) === 'checking');
  check('Available -> Waiting in ask mode', kind(run([...found, { type: 'route', mode: 'ask', unmetered: true }])) === 'waiting');
  check('Available -> Downloading in download mode on Wi-Fi', kind(run([...found, { type: 'route', mode: 'download', unmetered: true }])) === 'downloading');
  check('Available -> Downloading in auto mode on Wi-Fi', kind(run([...found, { type: 'route', mode: 'auto', unmetered: true }])) === 'downloading');
  check('Available -> WaitingForWifi on mobile data', kind(run([...found, { type: 'route', mode: 'download', unmetered: false }])) === 'waitingForWifi');
  check('WaitingForWifi -> Downloading', kind(run([...found, { type: 'route', mode: 'download', unmetered: false }, { type: 'wifi' }])) === 'downloading');
  check('the user can start a download from Available, Waiting and WaitingForWifi', ['ask', 'download'].every((mode) => kind(run([...found, { type: 'route', mode, unmetered: false }, { type: 'download' }])) === 'downloading') && kind(run([...found, { type: 'download' }])) === 'downloading');
  const dl = [...found, { type: 'download' }];
  check('progress updates bytes and total', (() => { const s = run([...dl, { type: 'progress', bytes: 10, total: 100 }]); return s.bytes === 10 && s.total === 100; })());
  check('progress with unknown total keeps the known one', run([...dl, { type: 'progress', bytes: 10, total: 0 }]).total === info.size);
  check('Downloading -> Ready(path)', (() => { const s = run([...dl, { type: 'downloaded', path: '/x.apk' }]); return s.kind === 'ready' && s.path === '/x.apk'; })());
  check('Downloading -> DownloadFailed(code) -> Available', (() => { const f = run([...dl, { type: 'downloadFailed', code: 'NETWORK' }]); return f.kind === 'downloadFailed' && f.code === 'NETWORK' && kind(m.reduce(f, { type: 'dismissFailure' })) === 'available'; })());
  const ready = [...dl, { type: 'downloaded', path: '/x.apk' }];
  const inst1 = run([...ready, { type: 'readyRoute', mode: 'auto', safe: true }]);
  check('Ready -> Installing (silent) in auto mode when safe', inst1.kind === 'installing' && inst1.silent === true);
  check('Ready -> ReadyAsk in auto mode when not safe', kind(run([...ready, { type: 'readyRoute', mode: 'auto', safe: false }])) === 'readyAsk');
  check('Ready -> ReadyAsk in download and ask modes even when safe', ['download', 'ask'].every((mode) => kind(run([...ready, { type: 'readyRoute', mode, safe: true }])) === 'readyAsk'));
  check('ReadyAsk -> Installing when auto finds a safe moment', kind(run([...ready, { type: 'readyRoute', mode: 'auto', safe: false }, { type: 'readyRoute', mode: 'auto', safe: true }])) === 'installing');
  const tapped = run([...ready, { type: 'readyRoute', mode: 'download', safe: true }, { type: 'install' }]);
  check('ReadyAsk -> Installing on a tap (not silent)', tapped.kind === 'installing' && tapped.silent === false);
  check('Installing -> NeedsPermission', kind(run([{ type: 'installStatus', status: 'needs_permission' }], tapped)) === 'needsPermission');
  const perm = run([{ type: 'installStatus', status: 'needs_permission' }], tapped);
  const back = m.reduce(perm, { type: 'permissionReturned' });
  check('NeedsPermission -> Installing once on return', back.kind === 'installing' && back.retried === true);
  check('a second permission miss does not retry again', (() => { const p2 = m.reduce(back, { type: 'installStatus', status: 'needs_permission' }); return p2.kind === 'needsPermission' && m.reduce(p2, { type: 'permissionReturned' }) === p2; })());
  check('Installing -> NeedsUser', kind(run([{ type: 'installStatus', status: 'needs_user' }], tapped)) === 'needsUser');
  check('started keeps Installing', kind(run([{ type: 'installStatus', status: 'started' }], tapped)) === 'installing');
  check('Installing -> Done', kind(run([{ type: 'installed' }], tapped)) === 'done');
  check('NeedsUser -> Done', kind(run([{ type: 'installed' }], run([{ type: 'installStatus', status: 'needs_user' }], tapped))) === 'done');
  check('Installing -> InstallFailed, then a tap installs again', (() => { const f = run([{ type: 'installFailed', code: 'INSTALL_FAILED' }], tapped); return f.kind === 'installFailed' && kind(m.reduce(f, { type: 'install' })) === 'installing'; })());
  check('Restore: a file from an earlier run is Ready', kind(run([{ type: 'restore', info, path: '/x.apk' }])) === 'ready');
  check('Restore is ignored after a check started', kind(run([{ type: 'check' }, { type: 'restore', info, path: '/x.apk' }])) === 'checking');
  check('events that do not apply change nothing', (() => { const s = m.initialState; return m.reduce(s, { type: 'downloaded', path: '/x' }) === s && m.reduce(s, { type: 'installed' }) === s && m.reduce(s, { type: 'install' }) === s && m.reduce(s, { type: 'skip' }) === s; })());

  console.log('\n[skippedVersion]');
  const skipped = run([{ type: 'check' }, { type: 'checked', info, skippedVersion: '0.22', manual: false }]);
  check('the automatic check ignores a skipped version', skipped.kind === 'skipped' && skipped.version === '0.22');
  check('the manual check still shows it', kind(run([{ type: 'check' }, { type: 'checked', info, skippedVersion: '0.22', manual: true }])) === 'available');
  check('a newer version than the skipped one shows', kind(run([{ type: 'check' }, { type: 'checked', info, skippedVersion: '0.21', manual: false }])) === 'available');
  check('Available, Waiting, Ready and ReadyAsk can be skipped', [found, [...found, { type: 'route', mode: 'ask', unmetered: true }], ready, [...ready, { type: 'readyRoute', mode: 'ask', safe: true }]].every((evs) => { const s = m.reduce(run(evs), { type: 'skip' }); return s.kind === 'skipped' && s.version === '0.22'; }));
  check('Downloading cannot be skipped', kind(m.reduce(run(dl), { type: 'skip' })) === 'downloading');
  check('a skipped state can be checked again', kind(m.reduce(skipped, { type: 'check' })) === 'checking');

  console.log('\n[managed]');
  for (const by of ['fdroid', 'obtainium', 'play']) check(`Any -> Managed(${by})`, [m.initialState, run(found), run(ready), tapped].every((s) => { const x = m.reduce(s, { type: 'managed', by }); return x.kind === 'managed' && x.by === by; }));
  const managed = m.reduce(m.initialState, { type: 'managed', by: 'play' });
  check('Managed is final: no check, download or install', ['check', 'download', 'install', 'wifi'].every((t) => m.reduce(managed, { type: t }) === managed) && m.reduce(managed, { type: 'route', mode: 'auto', unmetered: true }) === managed);

  console.log('\n[network and safe-to-install]');
  const wifi = { connected: true, metered: false, vpn: false };
  const mobile = { connected: true, metered: true, vpn: false };
  const free = { wifiOnly: false, vpnOnly: false };
  check('offline blocks everything', !r.networkAllows({ ...wifi, connected: false }, free) && !r.networkAllows(null, free));
  check('mobile data is fine unless Wi-Fi only is on', r.networkAllows(mobile, free) && !r.networkAllows(mobile, { wifiOnly: true, vpnOnly: false }));
  check('VPN only blocks a link with no VPN', !r.networkAllows(wifi, { wifiOnly: false, vpnOnly: true }) && r.networkAllows({ ...wifi, vpn: true }, { wifiOnly: false, vpnOnly: true }));
  check('automatic downloads need an unmetered link', r.autoDownloadAllowed(wifi, free) && !r.autoDownloadAllowed(mobile, free));
  const facts = (over = {}) => ({ now: NOW, lastUploadAt: null, torrents: [], downloads: [], ...over });
  check('idle is safe', r.safeToInstall(facts()));
  check('a downloading torrent is not safe', !r.safeToInstall(facts({ torrents: [{ state: 'DOWNLOADING', upBps: 0 }] })));
  check('a torrent moving files is not safe', !r.safeToInstall(facts({ torrents: [{ state: 'MOVING' }] })));
  check('seeding with upload is not safe', !r.safeToInstall(facts({ torrents: [{ state: 'SEEDING', upBps: 5 }] })));
  check('seeding with no upload is safe', r.safeToInstall(facts({ torrents: [{ state: 'SEEDING', upBps: 0 }] })));
  check('upload in the last 60 s is not safe, older is', !r.safeToInstall(facts({ lastUploadAt: NOW - 59_000 })) && r.safeToInstall(facts({ lastUploadAt: NOW - 61_000 })));
  check('a running plain or stream download is not safe', ['downloading', 'resolving', 'verifying'].every((state) => !r.safeToInstall(facts({ downloads: [{ state }] }))));
  check('paused and finished transfers are safe', r.safeToInstall(facts({ torrents: [{ state: 'PAUSED' }, { state: 'COMPLETED' }], downloads: [{ state: 'paused' }, { state: 'finished' }] })));

  console.log('\n[prefs]');
  const d = prefs.defaultUpdatePrefs();
  check('defaults: download mode, auto check on', d.updateMode === 'download' && d.updateAutoCheck === true && d.lastCheckAt === null && d.skippedVersion === null && d.pending === null);
  check('junk falls back to defaults', JSON.stringify(prefs.normalizeUpdatePrefs({ updateMode: 'x', updateAutoCheck: 'no', lastCheckAt: 'now', skippedVersion: 3, pending: 7 })) === JSON.stringify({ ...d, updateAutoCheck: true }));
  check('modes and the toggle are kept', prefs.normalizeUpdatePrefs({ updateMode: 'auto', updateAutoCheck: false }).updateMode === 'auto' && prefs.normalizeUpdatePrefs({ updateAutoCheck: false }).updateAutoCheck === false);
  const pend = prefs.normalizeUpdatePrefs({ pending: { info, path: '/x.apk' } }).pending;
  check('a pending update survives normalizing', pend && pend.path === '/x.apk' && pend.info.sha256 === SHA && pend.info.version === '0.22');
  check('a pending update without a good hash is dropped', prefs.normalizeUpdatePrefs({ pending: { info: { ...info, sha256: 'zz' }, path: '/x.apk' } }).pending === null);
  check('round-trips through update', prefs.updateUpdatePrefs({ updateMode: 'ask', skippedVersion: '0.23', lastCheckAt: NOW }).updateMode === 'ask' && prefs.getUpdatePrefs().skippedVersion === '0.23' && prefs.getUpdatePrefs().lastCheckAt === NOW);

  console.log('\n[report a bug]');
  const url = c.buildIssueUrl({ version: '0.21', android: '14', device: 'Google Pixel 8 & Co/x?' });
  check('opens the bug form with every value encoded', url === 'https://github.com/Kaos599/Maglev/issues/new?template=bug.yml&version=0.21&android=14&device=Google%20Pixel%208%20%26%20Co%2Fx%3F');
  check('a hostile value cannot add a parameter', !/[?&]evil=/.test(c.buildIssueUrl({ version: '1&evil=1', android: '#', device: '"><b>' })) && c.buildIssueUrl({ version: '1&evil=1', android: '#', device: 'a' }).includes('version=1%26evil%3D1'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
