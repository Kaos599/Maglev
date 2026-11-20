// Source-level check: a default-network change reaches Rust as nativeNetworkChanged (contract section 17.x).
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
};

const A = 'modules/maglev-engine/android/src/main/java/com/maglev/engine/';
const native = read(A + 'NativeCore.kt');
const host = read(A + 'EngineHost.kt');
const mgr = read(A + 'network/NetworkGovernanceManager.kt');
const jni = read('native/maglev-core/src/jni.rs');
const engine = read('native/maglev-core/src/engine.rs');
const drv = read('native/maglev-core/src/http_dl/driver.rs');

check('Kotlin declares nativeNetworkChanged(): String', /@JvmStatic external fun nativeNetworkChanged\(\): String/.test(native));
const sig = jni.match(/pub extern "system" fn Java_com_maglev_engine_NativeCore_nativeNetworkChanged\(([^)]*)\)\s*->\s*jstring/);
check('jni.rs exports Java_com_maglev_engine_NativeCore_nativeNetworkChanged returning jstring', !!sig);
check('jni.rs takes only env and class (no extra arguments)', !!sig && sig[1].split(',').filter((x) => x.trim()).length === 2);
check('jni.rs calls Engine::network_changed', /e\.network_changed\(\)/.test(jni));
check('Engine forwards to downloads.network_changed', /fn network_changed\(&self\)[\s\S]{0,200}self\.downloads\.network_changed\(\)/.test(engine));
check('Downloads::network_changed restarts Downloading and Resolving tasks', /pub fn network_changed[\s\S]{0,900}State::Downloading[\s\S]{0,200}State::Resolving/.test(drv));
check('manager reports a switch only through the tracker', /tracker\.available\(network\)/.test(mgr) && /if \(switched\) onSwitched\(\)/.test(mgr));
check('EngineHost wires onSwitched to nativeNetworkChanged', /onSwitched = \{[^\n]*nativeNetworkChanged\(\)/.test(host));
check('no fake-unvalidated hold is left', !/SWITCH_HOLD_MS|endSwitch/.test(mgr));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nnetwork-change: all checks passed');
