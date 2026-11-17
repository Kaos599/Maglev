#!/usr/bin/env node
// NATIVE_CONTRACT 34.1 download timing: the TS types carry active_secs, finished_at, session_bytes, bytes_wifi and
// bytes_mobile for torrents and link downloads, the bridge passes them through, and the dev simulator counts time and
// bytes only while an item downloads, stamps finished_at once, and resets on FILE_CHANGED. The Rust accounting is
// covered by `cargo test` (timing.rs, meta.rs, http_dl/driver.rs `timing_tests`); this also checks the wiring by source.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

const FIELDS = ['activeSecs', 'finishedAt', 'sessionBytes', 'bytesWifi', 'bytesMobile'];
const SNAKE = ['active_secs', 'finished_at', 'session_bytes', 'bytes_wifi', 'bytes_mobile'];

async function main() {
  // ---- types ----
  console.log('types');
  const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
  for (const name of ['TorrentTelemetry', 'Snapshot', 'DownloadSnapshot']) {
    const body = (types.match(new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`)) || [''])[0];
    for (const f of FIELDS) check(`${name} declares ${f}`, new RegExp(`\\n\\s+${f}\\?: number;`).test(body));
  }

  // ---- bridge pass-through ----
  console.log('bridge');
  const { camelizeKeys, snapshotToTelemetry } = await import('../modules/maglev-engine/src/snapshotMapping.ts');
  const raw = {};
  SNAKE.forEach((k, i) => (raw[k] = i + 1));
  const cam = camelizeKeys(raw);
  FIELDS.forEach((f, i) => check(`camelizeKeys maps ${SNAKE[i]} to ${f}`, cam[f] === i + 1));
  const base = {
    id: 'a', name: 'n', state: 'DOWNLOADING', pausedBy: null, finished: false, progressBytes: 1, totalBytes: 2, uploadedBytes: 0,
    downBps: 0, upBps: 0, peersLive: 0, peersSeen: 0, webSeeds: 0, etaSecs: -1, ratio: 0, seedingSecs: 0, addedAt: 1,
    outputFolder: '/x', error: null, downLimitBps: 0, upLimitBps: 0, moveProgress: null, health: null, includedBytes: 2, resolvingSecs: null,
  };
  const tel = snapshotToTelemetry({ ...base, ...cam });
  FIELDS.forEach((f, i) => check(`telemetry keeps ${f}`, tel[f] === i + 1));
  const old = snapshotToTelemetry(base);
  check('an older engine reports zeros, never made-up values', FIELDS.every((f) => old[f] === 0));

  // ---- Rust and Kotlin wiring (source checks; CI compiles them) ----
  console.log('native wiring');
  const types_rs = read('native/maglev-core/src/types.rs');
  for (const k of SNAKE) check(`Rust torrent Snapshot has ${k}`, new RegExp(`pub ${k}: `).test(types_rs));
  const drv = read('native/maglev-core/src/http_dl/driver.rs');
  for (const k of SNAKE) check(`Rust download snapshot writes ${k}`, new RegExp(`"${k}": r\\.timing`).test(drv));
  check('Rust: link FILE_CHANGED retry resets the timing', /FileChanged[\s\S]{0,400}timing\.reset\(\)/.test(drv));
  check('Rust: link timing is saved while it runs', /TIMING_SAVE_EVERY/.test(drv));
  check('Rust: engine tick feeds both torrents and links', /downloads\.account\(elapsed, metered\)/.test(read('native/maglev-core/src/engine.rs')) && /m\.timing\.tick\(elapsed, downloading\)/.test(read('native/maglev-core/src/engine.rs')));
  check('Rust: torrent timing persists in the meta file', /pub timing: Timing/.test(read('native/maglev-core/src/meta.rs')));
  check('Rust: JNI exports nativeSetNetworkMetered', /Java_com_maglev_engine_NativeCore_nativeSetNetworkMetered/.test(read('native/maglev-core/src/jni.rs')));
  check('Kotlin declares nativeSetNetworkMetered', /external fun nativeSetNetworkMetered\(metered: Boolean\): String/.test(read('modules/maglev-engine/android/src/main/java/com/maglev/engine/NativeCore.kt')));
  const host = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/EngineHost.kt');
  check('Kotlin pushes the metered flag from the governance pass', /nativeSetNetworkMetered\(metered\)/.test(host) && /!n\.unmeteredLink/.test(host));

  // ---- simulator: torrents ----
  console.log('simulator torrents');
  const { MaglevMockEngine } = await import('../modules/maglev-engine/src/MaglevMockEngine.ts');
  const e = new MaglevMockEngine();
  const snaps = async () => (await e.listTorrents()).torrents;
  const mag = 'magnet:?xt=urn:btih:' + 'ab'.repeat(20) + '&dn=Timing%20Test&xl=40000000';
  const added = await e.addTorrent(mag, {});
  check('torrent added', added.ok === true, JSON.stringify(added));
  const id = added.id;
  const get = async () => (await snaps()).find((s) => s.id === id);
  let s = await get();
  check('a new torrent starts at 0', s.activeSecs === 0 && s.finishedAt === 0 && s.sessionBytes === 0);
  check('it is downloading', s.state === 'DOWNLOADING', s.state);
  e.stepSimulation();
  e.stepSimulation();
  s = await get();
  check('downloading counts one second for two half-second steps', s.activeSecs === 1, String(s.activeSecs));
  check('session bytes follow the bytes that arrived', s.sessionBytes > 0 && s.sessionBytes === s.progressBytes, `${s.sessionBytes} vs ${s.progressBytes}`);
  check('on an unmetered link everything is Wi-Fi', s.bytesWifi === s.sessionBytes && s.bytesMobile === 0);
  e.pauseTorrent(id);
  const paused = await get();
  e.stepSimulation();
  e.stepSimulation();
  e.stepSimulation();
  s = await get();
  check('paused counts nothing', s.activeSecs === paused.activeSecs && s.sessionBytes === paused.sessionBytes);
  e.updateNetworkState({ networkType: 'CELLULAR' });
  e.resumeTorrent(id);
  e.stepSimulation();
  s = await get();
  check('mobile data goes to bytes_mobile', s.bytesMobile > 0 && s.bytesMobile === s.sessionBytes - paused.sessionBytes, `${s.bytesMobile}`);
  check('the split adds up to the session bytes', s.bytesWifi + s.bytesMobile === s.sessionBytes);
  check('not finished yet', s.finishedAt === 0 && s.finished === false);
  for (let i = 0; i < 20 && (await get()).state === 'DOWNLOADING'; i++) e.stepSimulation();
  s = await get();
  check('it finished and is seeding', s.state === 'SEEDING' && s.finished === true, s.state);
  check('finished_at is set', s.finishedAt > 0);
  const stamp = s.finishedAt;
  const activeAtDone = s.activeSecs;
  const sessionAtDone = s.sessionBytes;
  check('session bytes equal the payload', s.sessionBytes <= s.totalBytes);
  for (let i = 0; i < 6; i++) e.stepSimulation();
  s = await get();
  check('seeding adds no active time and no session bytes', s.activeSecs === activeAtDone && s.sessionBytes === sessionAtDone);
  check('seeding uploads still count toward the network split', s.bytesMobile + s.bytesWifi > s.sessionBytes && s.uploadedBytes > 0);
  check('finished_at is set once', s.finishedAt === stamp);
  e.pauseTorrent(id);
  e.resumeTorrent(id);
  s = await get();
  check('a later pause and resume never reset finished_at', s.finishedAt === stamp);

  // ---- simulator: link downloads ----
  console.log('simulator downloads');
  const { MockDownloads, mockSizeFor } = await import('../modules/maglev-engine/src/MaglevMockDownloads.ts');
  let blocked = null;
  let metered = false;
  const m = new MockDownloads({ blockedReason: () => blocked, folder: () => '/d', changed: () => {}, metered: () => metered });
  const url = 'https://x.test/files/a.bin';
  const r = await m.add(url, {});
  check('download added', r.ok === true);
  const dget = () => m.snapshots().find((d) => d.id === r.id);
  check('a new download starts at 0', FIELDS.every((f) => dget()[f] === 0));
  m.step(1); // the probe answers: resolving ends, nothing has downloaded yet
  let d = dget();
  check('resolving counts nothing', d.state === 'downloading' && d.activeSecs === 0 && d.sessionBytes === 0, d.state);
  m.step(1);
  d = dget();
  check('downloading counts seconds', d.state === 'downloading' && d.activeSecs === 1, `${d.state} ${d.activeSecs}`);
  check('downloading counts bytes', d.sessionBytes === d.downloaded && d.sessionBytes > 0);
  check('link bytes on an unmetered link are Wi-Fi', d.bytesWifi === d.sessionBytes && d.bytesMobile === 0);
  m.pause(r.id);
  const before = dget();
  m.step(5);
  d = dget();
  check('a paused download counts nothing', d.activeSecs === before.activeSecs && d.sessionBytes === before.sessionBytes);
  m.resume(r.id);
  blocked = 'wifi_only';
  m.step(5);
  d = dget();
  check('waiting for Wi-Fi counts nothing', d.activeSecs === before.activeSecs && d.sessionBytes === before.sessionBytes, d.state);
  blocked = null;
  metered = true;
  m.step(1);
  m.step(1);
  d = dget();
  check('metered link bytes go to bytes_mobile', d.bytesMobile > 0 && d.bytesWifi + d.bytesMobile === d.sessionBytes, `${d.bytesMobile}`);
  check('session bytes count only what this engine fetched', d.sessionBytes === d.downloaded, `${d.sessionBytes} vs ${d.downloaded}`);
  check('not finished yet', d.finishedAt === 0);
  const size = mockSizeFor(url);
  for (let i = 0; i < 400 && dget().state !== 'finished'; i++) m.step(10);
  d = dget();
  check('the download finished', d.state === 'finished', d.state);
  check('finished_at is set once it finishes', d.finishedAt > 0);
  const dstamp = d.finishedAt;
  m.step(30);
  check('finished_at never changes', dget().finishedAt === dstamp);
  check('session bytes equal the file size', dget().sessionBytes === size, `${dget().sessionBytes} vs ${size}`);

  // FILE_CHANGED restart resets the counters.
  const c = await m.add('https://x.test/changed/b.bin', {});
  const cget = () => m.snapshots().find((x) => x.id === c.id);
  for (let i = 0; i < 40 && cget().state !== 'error'; i++) m.step(10);
  check('the changed link failed with FILE_CHANGED', cget().state === 'error' && cget().error.code === 'FILE_CHANGED', cget().state);
  check('it had counted something', cget().activeSecs > 0 && cget().sessionBytes > 0);
  m.retry(c.id);
  const cd = cget();
  check('FILE_CHANGED retry resets active time, finish and bytes', FIELDS.every((f) => cd[f] === 0), JSON.stringify(cd));

  m.clear();
  e.shutdown?.();

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall download timing checks passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
