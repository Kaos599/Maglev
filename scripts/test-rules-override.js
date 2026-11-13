#!/usr/bin/env node
/**
 * Rule pauses: "Resume anyway" per item, and seeding on mobile data (static contract, NATIVE_CONTRACT section 25).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const kt = 'modules/maglev-engine/android/src/main/java/com/maglev/engine/';
const src = 'modules/maglev-engine/src/';
const rs = 'native/maglev-core/src/';

const contract = require('./lib/privateDocs').readPrivateDoc('NATIVE_CONTRACT.md');
const host = read(kt + 'EngineHost.kt');
const mod = read(kt + 'MaglevEngineModule.kt');
const nativeCore = read(kt + 'NativeCore.kt');
const notif = read(kt + 'service/Notifications.kt');
const types = read(src + 'MaglevEngine.types.ts');
const bridge = read(src + 'MaglevNativeBridge.ts');
const mock = read(src + 'MaglevMockEngine.ts');
const mockDl = read(src + 'MaglevMockDownloads.ts');
const settingsTypes = read(src + 'MaglevSettings.types.ts');
const toNative = read(src + 'toNativeConfig.ts');
const sched = read(rs + 'scheduler.rs');
const engine = read(rs + 'engine.rs');
const meta = read(rs + 'meta.rs');
const jni = read(rs + 'jni.rs');
const dl = read(rs + 'http_dl/driver.rs');

let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}

if (contract) check('contract documents resumeAnyway and resumeDownloadAnyway', /resumeAnyway/.test(contract) && /resumeDownloadAnyway/.test(contract));
if (contract) check('contract documents seed_metered and seedOnMobileData', /seed_metered/.test(contract) && /seedOnMobileData/.test(contract));
if (contract) check('contract documents allowed_anyway', /allowed_anyway/.test(contract));

for (const fn of ['resumeAnyway', 'resumeDownloadAnyway']) {
  check(`module exposes ${fn}`, new RegExp(`AsyncFunction\\("${fn}"\\)`).test(mod));
  check(`TS interface declares ${fn}`, new RegExp(`${fn}\\(id: string\\): Promise<EngineResult>`).test(types));
  check(`bridge implements ${fn}`, new RegExp(`public ${fn}\\(`).test(bridge));
  check(`mock engine implements ${fn}`, new RegExp(`public async ${fn}\\(`).test(mock));
}
check('NativeCore declares both JNI calls', /nativeResumeAnyway/.test(nativeCore) && /nativeResumeDownloadAnyway/.test(nativeCore));
check('Rust exports both JNI calls', /NativeCore_nativeResumeAnyway/.test(jni) && /NativeCore_nativeResumeDownloadAnyway/.test(jni));
check('snapshots carry allowedAnyway (torrent and download)', (types.match(/allowedAnyway\?: boolean/g) || []).length >= 3);

check('settings default seedOnMobileData is false', /seedOnMobileData:\s*false/.test(settingsTypes));
check('toGovernance sends seedOnMobileData', /seedOnMobileData:\s*network\.seedOnMobileData/.test(toNative));
check('GovernanceConfig has seedOnMobileData', /seedOnMobileData: boolean/.test(types));
check('Kotlin Governance reads seedOnMobileData from the module call', /seedOnMobileData = rules\["seedOnMobileData"\]/.test(mod));
check('Kotlin persists seedOnMobileData', /putBoolean\("seedOnMobileData"/.test(host) && /getBoolean\("seedOnMobileData"/.test(host));

check('governance sends seed_metered', /send\("seed_metered"/.test(host));
check('seed_metered reuses the Wi-Fi only link check (unmeteredLink)', /seedMeteredBlocked[\s\S]{0,300}unmeteredLink/.test(host));
check('summarize treats seed_metered as rule-paused', /"seed_metered" -> \{ byRules\+\+/.test(host));
check('rule reason can be seed_metered', /"seed_metered"/.test((/val reason = when \{[\s\S]*?\n        \}/.exec(host) || [''])[0]));
check('notification copy: seeding waits for Wi-Fi', /Paused: seeding waits for Wi-Fi/.test(notif + host));

check('planner skips exempt items for the exemptable tags', /pub const EXEMPTABLE_TAGS/.test(sched) && /exempt/.test(sched));
check('exemptable set is exactly the five rule tags', /EXEMPTABLE_TAGS: \[&str; 5\] = \["wifi_only", "battery", "charging_only", "schedule", "seed_metered"\]/.test(sched));
check('seed_metered applies to finished torrents only (planner)', /seed_metered/.test(sched) && /finished/.test(sched));
check('meta persists allowed_anyway', /pub allowed_anyway: bool/.test(meta));
check('engine has resume_anyway and clears on user pause', /pub fn resume_anyway/.test(engine) && /allowed_anyway = false/.test(engine));
check('downloads persist allowed_anyway and skip exempt tags', /pub allowed_anyway: bool/.test(dl) && /EXEMPTABLE_TAGS|fn effective_blocked/.test(dl));
check('Kotlin resumeAnyway wakes the service', /fun resumeAnyway[\s\S]{0,600}(setWanted|requestResumeIfAllowed)/.test(host));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll rule-override checks passed');
