#!/usr/bin/env node
// NATIVE_CONTRACT 41 (0.32): restartEngine, the blocklist status and the VPN rule at start. Static checks on the TS,
// Kotlin and Rust sources (Rust and Gradle are never run locally; CI compiles them). Rust unit tests cover the logic.
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
/** Body of the Kotlin function whose declaration matches `re`, by brace counting. */
function body(src, re) {
  const m = re.exec(src);
  if (!m) return '';
  const start = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  return src.slice(start);
}

const types = read('modules/maglev-engine/src/MaglevEngine.types.ts');
const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
const mock = read('modules/maglev-engine/src/MaglevMockEngine.ts');
const host = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/EngineHost.kt');
const mod = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt');
const nativeCore = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/NativeCore.kt');
const jni = read('native/maglev-core/src/jni.rs');
const engine = read('native/maglev-core/src/engine.rs');
const config = read('native/maglev-core/src/config.rs');

console.log('TS API and types');
check('EffectiveConfig extends NativeConfig with restartPending and blocklist',
  /export interface EffectiveConfig extends NativeConfig \{[^}]*restartPending: boolean;[^}]*blocklist: BlocklistStatus;/s.test(types));
check('BlocklistStatus is { state: off | on | unreadable, rules: number }',
  /export type BlocklistState = 'off' \| 'on' \| 'unreadable';/.test(types) && /export interface BlocklistStatus \{\s*state: BlocklistState;[^}]*rules: number;/s.test(types));
check('MaglevEngineApi has restartEngine(): Promise<EngineResult>', /restartEngine\(\): Promise<EngineResult>;/.test(types));
check('getEffectiveConfig returns EffectiveConfig', /getEffectiveConfig\(\): Promise<EngineResult<EffectiveConfig>>;/.test(types));
check('bridge forwards restartEngine to the native module', /public restartEngine\(\): Promise<EngineResult> \{\s*return this\.route\('restartEngine'\);/.test(bridge));
check('restartEngine is a read-class method (never auto-restarts on NOT_INITIALIZED)',
  /export const READ_METHODS[^;]*'restartEngine'/s.test(bridge));
check('bridge maps restart_pending to restartPending and normalises blocklist', /export function toEffectiveConfig/.test(bridge)
  && /restartPending: restart_pending === true/.test(bridge) && /'on' \|\| b\.state === 'unreadable'/.test(bridge));
check('mock engine implements restartEngine with an INVALID_STATE guard', /async restartEngine\(\)/.test(mock) && /restartRunning\) return fail\('INVALID_STATE'/.test(mock));
check('mock getEffectiveConfig reports restartPending and blocklist', /restartPending/.test(mock) && /state: 'unreadable'/.test(mock) && /state: 'off'/.test(mock));

console.log('Kotlin wiring');
check('module exposes AsyncFunction("restartEngine") calling EngineHost.restartEngine', /AsyncFunction\("restartEngine"\)[\s\S]{0,200}EngineHost\.restartEngine\(\)/.test(mod));
check('NativeCore declares nativeSetNetworkOff and Rust exports it',
  /external fun nativeSetNetworkOff\(off: Boolean\): String/.test(nativeCore) && /Java_com_maglev_engine_NativeCore_nativeSetNetworkOff/.test(jni));
const restart = body(host, /fun restartEngine\(\)/);
check('restartEngine fails with INVALID_STATE while one runs (compare-and-set flag)', /compareAndSet\(false, true\)/.test(restart) && /"INVALID_STATE"/.test(restart) && /restarting\.set\(false\)/.test(restart));
const cycle = body(host, /private fun cycleSessionLocked\(\)/);
check('restart stops the Rust session (nativeShutdown) then starts again from the saved config',
  cycle.indexOf('nativeShutdown') > 0 && cycle.lastIndexOf('startEngine("")') > cycle.indexOf('nativeShutdown'));
check('restart does not touch the service, the wanted flag or the user-shutdown flag', !/stopService|setWanted|KEY_USER_SHUTDOWN/.test(cycle));
check('restart refreshes telemetry (forceEmit + pollNow)', /forceEmit = true/.test(cycle) && /pollNow\(\)/.test(cycle));

console.log('Start order: governance before transfers');
const start = body(host, /private fun startEngine\(/);
const iWatch = start.indexOf('startGovernanceWatchers(c)');
const iOff = start.indexOf('nativeSetNetworkOff(networkOff)');
const iInit = start.indexOf('NativeCore.nativeInit(');
const iEval = start.indexOf('evaluateGovernance(force = true)');
const iRelease = start.indexOf('nativeSetTransfersAllowed(true, REASON_STARTUP)');
const iPoll = start.indexOf('startPolling()');
check('network watcher starts before the session is created', iWatch > 0 && iWatch < iInit);
check('network-off is decided before nativeInit', iOff > 0 && iOff < iInit);
check('first governance pass runs after init and before the start-up hold is released', iInit < iEval && iEval < iRelease);
check('polling starts only after the hold is released', iRelease < iPoll);
check('Rust holds every transfer with "startup" from engine creation until Kotlin releases it',
  /pub const STARTUP_HOLD: &str = "startup"/.test(engine) && /blocked\.push\(STARTUP_HOLD\.to_string\(\)\)/.test(engine) && /REASON_STARTUP = "startup"/.test(host));

console.log('VPN rule');
const vpn = body(host, /private fun vpnBlockedNow\(\)/);
check('unknown network blocks the VPN rule (no watcher, no callback, no network)',
  /!governance\.vpnOnly\) return false/.test(vpn) && /!\(n != null && n\.monitoring && n\.connected && n\.vpn\)/.test(vpn));
const gov = body(host, /private fun evaluateGovernance\(force: Boolean\)/);
check('evaluateGovernance uses vpnBlockedNow, not the "link known" shortcut', /val vpnBlocked = vpnBlockedNow\(\)/.test(gov) && !/linkKnown && n\?\.vpn == false/.test(gov));
check('Wi-Fi only and the other rules still treat an unknown network as not blocked', /val unvalidatedBlocked = linkKnown && n\?\.captivePortal == true/.test(gov));
check('the VPN verdict drives the network-off session', /reconcileNetworkOff\(networkOffWanted\(\)\)/.test(gov));
const wanted = body(host, /private fun networkOffWanted\(\)/);
check('no network at all keeps the current session (a Wi-Fi handoff does not cycle it)', /!n\.connected\) return networkOffApplied/.test(wanted));
check('a failed cycle retries with back-off', /scheduleEngineRetryLocked\(\)/.test(body(host, /private fun cycleSessionLocked\(\)/)) && /ENGINE_RETRY_BACKOFF_MS/.test(host));
const recon = body(host, /private fun reconcileNetworkOff\(/);
check('network-off cycle is debounced and reuses the restart path', /delay\(NETWORK_OFF_DEBOUNCE_MS\)/.test(recon) && /cycleSessionLocked\(\)/.test(recon));
check('Rust builds the session without DHT, listener, LSD and trackers when network-off',
  /enable_dht && !network_off/.test(engine) && /listen: if network_off \{\s*None/.test(engine) && /disable_trackers: network_off/.test(engine));

console.log('Rust status');
check('effective_config answers restart_pending and blocklist', /pub struct EffectiveConfig/.test(engine) && /restart_pending: bool/.test(engine) && /pub blocklist: BlocklistStatus/.test(engine));
check('restart_pending compares the session config with the saved one', /self\.session_config\.restart_required\(&config\)/.test(engine));
check('blocklist status has off / on / unreadable', /enum BlocklistState \{\s*(\/\/\/[^\n]*\n\s*)*Off,[\s\S]*?On,[\s\S]*?Unreadable,/.test(config));

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall engine restart checks passed');
