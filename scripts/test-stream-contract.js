/**
 * Static checks for saving HLS and DASH streams (docs/NATIVE_CONTRACT.md section 24.8). Rust and Kotlin are never
 * compiled locally (CI is the compiler), so this reads the sources: the JNI names agree on all three sides, the error
 * codes and messages agree with the contract, the TS types are there, and the join runs before the copy into the
 * user's folder.
 *
 *   node scripts/test-stream-contract.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripKotlinComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

const KT = 'modules/maglev-engine/android/src/main/java/com/maglev/engine';
const contract = read('docs/NATIVE_CONTRACT.md');
const sec = contract.slice(contract.indexOf('### 24.8'));
const jni = read('native/maglev-core/src/jni.rs');
const errorRs = read('native/maglev-core/src/error.rs');
const machine = read('native/maglev-core/src/http_dl/machine.rs');
const nativeCore = stripKotlinComments(read(`${KT}/NativeCore.kt`));
const mod = stripKotlinComments(read(`${KT}/MaglevEngineModule.kt`));
const host = stripKotlinComments(read(`${KT}/EngineHost.kt`));
const muxJobs = stripKotlinComments(read(`${KT}/MuxJobs.kt`));
const muxer = stripKotlinComments(read(`${KT}/storage/StreamMuxer.kt`));
const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
const mock = read('modules/maglev-engine/src/MaglevMockEngine.ts');
const ctx = read('context/EngineContext.tsx');
const pkg = JSON.parse(read('package.json'));

const CALLS = [
  { jni: 'nativeProbeStream', kotlin: /external fun nativeProbeStream\(url: String, optionsJson: String, timeoutMs: Long\): String/ },
  { jni: 'nativeFinishMux', kotlin: /external fun nativeFinishMux\(id: String, ok: Boolean, errorMessage: String\): String/ },
];

check('JNI names match between jni.rs, NativeCore.kt and the module', () => {
  for (const c of CALLS) {
    assert(new RegExp(`Java_com_maglev_engine_NativeCore_${c.jni}\\b`).test(jni), `${c.jni} missing in jni.rs`);
    assert(c.kotlin.test(nativeCore), `${c.jni} missing or changed in NativeCore.kt`);
  }
  assert(/NativeCore\.nativeProbeStream\(/.test(host), 'EngineHost must call nativeProbeStream');
  assert(/NativeCore\.nativeFinishMux\(/.test(host), 'EngineHost must call nativeFinishMux');
  assert(/AsyncFunction\("probeStream"\)/.test(mod), 'module must expose probeStream');
  assert(/EngineHost\.probeStream\(/.test(mod), 'probeStream must go to EngineHost');
});

check('the contract names the same two calls', () => {
  assert(/nativeProbeStream\(url, optionsJson, timeoutMs\)/.test(sec));
  assert(/nativeFinishMux\(id, ok, errorMessage\|null\)/.test(sec));
});

const CODES = [
  ['STREAM_PROTECTED', 'STREAM_PROTECTED_MSG', "This stream is protected. Maglev can't save it."],
  ['STREAM_LIVE', 'STREAM_LIVE_MSG', 'This is a live stream. Maglev can only save videos that have an end.'],
  ['STREAM_UNSUPPORTED', 'STREAM_UNSUPPORTED_MSG', "Maglev can't save this kind of stream yet."],
  ['MUX_FAILED', 'MUX_FAILED_MSG', "Couldn't join the video and audio. Try again."],
];

check('error codes and messages in error.rs match section 24.8', () => {
  for (const [code, constName, message] of CODES) {
    assert(sec.includes(`\`${code}\``) && sec.includes(message), `${code} or its message is missing from the contract`);
    assert(errorRs.includes(`"${code}"`), `${code} missing in error.rs as_str`);
    const m = errorRs.match(new RegExp(`pub const ${constName}: &str = "((?:[^"\\\\]|\\\\.)*)";`));
    assert(m, `${constName} missing in error.rs`);
    assert.strictEqual(m[1].replace(/\\"/g, '"'), message, `${constName} text differs from the contract`);
    assert(machine.includes(`"${code}"`), `${code} missing in machine.rs (DlError::as_str)`);
  }
});

check('TS types and calls are present', () => {
  for (const code of CODES.map((c) => c[0])) assert(types.includes(`'${code}'`), `${code} missing in EngineErrorCode`);
  for (const t of ['StreamProbe', 'StreamVariant', 'StreamAudioTrack', 'StreamSelection', 'DownloadStream']) {
    assert(new RegExp(`export (interface|type) ${t}\\b`).test(types), `${t} missing`);
  }
  assert(/stream\?: StreamSelection;/.test(types), 'DownloadOptions.stream missing');
  assert(/stream\?: DownloadStream \| null;/.test(types), 'DownloadSnapshot.stream missing');
  assert(/probeStream\(url: string, options: DownloadOptions, timeoutMs: number\): Promise<EngineResult<StreamProbe>>/.test(types), 'engine interface probeStream missing');
  assert(/route\('probeStream'/.test(bridge), 'bridge probeStream must route to the module');
  assert(/probeStream\(/.test(mock), 'mock probeStream missing');
  assert(/probeStream: \(url: string, options\?: DownloadOptions\) => Promise<EngineResult<StreamProbe>>/.test(ctx), 'EngineContext must expose probeStream');
  for (const f of ['estBytes', 'durationSec', 'audioTracks', 'variantId', 'segmentsDone', 'segmentsTotal']) {
    assert(types.includes(f), `${f} missing in the TS types`);
  }
});

check('the mock engine never invents streams (AGENTS 4.1)', () => {
  const m = mock.slice(mock.indexOf('public probeStream'));
  const body = m.slice(0, m.indexOf('\n  }\n'));
  assert(/STREAM_UNSUPPORTED/.test(body), 'mock probeStream must refuse');
  assert(!/variants/.test(body), 'mock probeStream must not return variants');
});

check('the join runs before the copy into the user folder', () => {
  const poll = host.slice(host.indexOf('private fun pollLocked'));
  const mux = poll.indexOf('runPendingMuxes(downloads)');
  const copy = poll.indexOf('copyStagedDownloads(downloads)');
  assert(mux > 0 && copy > 0, 'both calls must be in pollLocked');
  assert(mux < copy, 'runPendingMuxes must come before copyStagedDownloads');
  const copyFn = host.slice(host.indexOf('private fun copyStagedDownloads'));
  assert(/if \(d\["state"\] != "finished"\) continue/.test(copyFn.slice(0, 600)), 'the copy must only look at finished downloads');
});

check('the join waits in verifying, once per wait, on an IO thread, then tells Rust', () => {
  const fn = host.slice(host.indexOf('private fun runPendingMuxes'));
  const body = fn.slice(0, fn.indexOf('\n    }\n\n') + 8);
  const jobs = stripKotlinComments(read(`${KT}/MuxJobs.kt`));
  assert(/"verifying"/.test(jobs) && /mux_needed/.test(jobs), 'must wait for verifying with mux_needed');
  assert(/started\.add\(id\)/.test(jobs), 'must start each wait once');
  assert(/muxTracker\.claim\(downloads\)/.test(body), 'must ask the tracker which waits are new');
  assert(/ioScope\.launch/.test(body), 'must run on the IO scope');
  assert(/StreamMuxer\.mux\(/.test(body) && /nativeFinishMux\(id, ok,/.test(body), 'must mux then call nativeFinishMux');
});

check('the muxer remuxes without re-encoding and writes through a temp file', () => {
  assert(/MediaExtractor/.test(muxer) && /MediaMuxer/.test(muxer), 'MediaExtractor and MediaMuxer');
  assert(!/MediaCodec\.(createEncoderByType|createDecoderByType|createByCodecName)/.test(muxer), 'no encoder or decoder');
  assert(/\.mux\.tmp/.test(muxer) && /renameTo\(output\)/.test(muxer), 'temp file then rename');
  assert(/tmp\.delete\(\)/.test(muxer), 'temp file removed on failure');
  const hint = muxer.indexOf('setOrientationHint');
  assert(hint > 0 && /containsKey\("rotation-degrees"\)/.test(muxer), 'orientation hint only when the format has one');
  assert(hint < muxer.indexOf('m.start()'), 'orientation hint must come before start()');
});

check('the part and temp names agree between Rust and Kotlin', () => {
  const rs = read('native/maglev-core/src/http_dl/stream/plan.rs');
  const driver = read('native/maglev-core/src/http_dl/driver.rs');
  assert(/\{name\}\.video\.part/.test(rs) && /\{name\}\.audio\.part/.test(rs), 'Rust part names');
  assert(/"\$name\.video\.part"/.test(muxJobs) && /"\$name\.audio\.part"/.test(muxJobs), 'Kotlin part names');
  assert(driver.includes('".mux.tmp"') && /\.mux\.tmp/.test(muxer), 'temp name on both sides');
});

check('Rust refuses what the contract refuses and never fetches a key by itself', () => {
  const hls = read('native/maglev-core/src/http_dl/stream/hls.rs');
  const dash = read('native/maglev-core/src/http_dl/stream/dash.rs');
  assert(/Some\("NONE"\)/.test(hls) && /Some\("AES-128"\)/.test(hls), 'NONE and AES-128 handled');
  assert(/Some\(_\) => Err\(StreamError::Protected\)/.test(hls), 'every other METHOD is protected');
  assert(/KEYFORMAT/.test(hls) && /identity/.test(hls), 'KEYFORMAT must be identity');
  assert(/is_http\(&abs\)/.test(hls), 'non-http(s) key links are protected');
  assert(/ContentProtection/.test(dash) && /StreamError::Protected/.test(dash), 'ContentProtection is protected');
  assert(/"dynamic"/.test(dash) && /StreamError::Live/.test(dash), 'dynamic is live');
  assert(/StreamError::Live/.test(hls), 'no ENDLIST is live');
  assert(/MAX_PLAYLIST_BYTES: u64 = 2 \* 1024 \* 1024/.test(read('native/maglev-core/src/http_dl/stream/mod.rs')), 'playlist limit 2 MB');
  assert(/MAX_SEGMENTS: usize = 20_000/.test(read('native/maglev-core/src/http_dl/stream/mod.rs')), '20,000 segments');
  assert(/MAX_IN_FLIGHT: usize = 3/.test(read('native/maglev-core/src/http_dl/stream/mod.rs')), '3 in flight');
});

check('AES-128: pinned crates, keys in memory only, 16 byte keys, PKCS#7 CBC', () => {
  const cargo = read('native/maglev-core/Cargo.toml');
  assert(/^aes = "=\d+\.\d+\.\d+"/m.test(cargo) && /^cbc = \{ version = "=\d+\.\d+\.\d+"/m.test(cargo), 'aes and cbc pinned exactly');
  assert(/^roxmltree = "=\d+\.\d+\.\d+"/m.test(cargo), 'roxmltree pinned exactly');
  const run = read('native/maglev-core/src/http_dl/driver/stream_run.rs');
  assert(/v\.len\(\) == 16/.test(run), 'keys must be exactly 16 bytes');
  assert(/HashMap<String, \[u8; 16\]>/.test(run), 'key cache is an in-memory map');
  assert(!/(info|warn|debug|error)!\([^)]*(k\.uri|key)/.test(run), 'keys and key links are never logged');
  const fetch = read('native/maglev-core/src/http_dl/stream/fetch.rs');
  assert(/Pkcs7/.test(fetch) && /Aes128CbcDec/.test(fetch), 'PKCS#7 CBC decryption');
  const sidecar = read('native/maglev-core/src/http_dl/sidecar.rs');
  assert(!/key|iv\b/i.test(sidecar.slice(sidecar.indexOf('pub struct TrackSide'), sidecar.indexOf('pub struct Sidecar'))), 'no key material in the sidecar');
  assert(/AES-128 \(HLS\)/.test(sec), 'contract documents AES-128');
});

check('segments go through the shared download rules', () => {
  const run = read('native/maglev-core/src/http_dl/driver/stream_run.rs');
  for (const needle of ['stall_step', 'stall_retry', 'after_break', 'transient(', 'pace_delay', 'prepare_for_download', 'free_space', 'client_for_id', 'pin_lan_host']) {
    assert(run.includes(needle), `${needle} must be used by the stream transfer`);
  }
  assert(/404 \| 410 =>/.test(run) && /Event::Auth/.test(run), '404/410 on a segment asks for a new link');
});

check('the snapshot carries stream and mux_needed', () => {
  const driver = read('native/maglev-core/src/http_dl/driver.rs');
  assert(/"stream": r\.stream/.test(driver) && /"segments_done"/.test(driver) && /"segments_total"/.test(driver), 'stream object');
  assert(/"mux_needed":/.test(driver), 'mux_needed');
  assert(/E::Verifying|S::Verifying, E::MuxFailed/.test(machine) || /\(S::Verifying, E::MuxFailed\)/.test(machine), 'MuxFailed row');
});

check('the contract test runs with npm test', () => {
  assert(pkg.scripts.test.includes('node scripts/test-stream-contract.js'), 'package.json test must run this file');
});

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall stream contract checks passed');
