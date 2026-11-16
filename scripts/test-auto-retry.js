#!/usr/bin/env node
// Retry failed downloads automatically: settings round trip and the Kotlin scheduler (codes, rounds, governance).
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const KT = 'modules/maglev-engine/android/src/main/java/com/maglev/engine/';

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function main() {
  const { DEFAULT_SETTINGS } = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  const { migrateSettings } = await import('../modules/maglev-engine/src/MaglevSettingsStore.ts');
  const { toGovernance, toNativeConfig } = await import('../modules/maglev-engine/src/toNativeConfig.ts');

  console.log('settings');
  const b = DEFAULT_SETTINGS.bandwidth;
  check('defaults: after, 5 min, not always', b.autoRetry === 'after' && b.autoRetryDelayMin === 5 && b.autoRetryAlways === false);
  const old = migrateSettings({ settings: { bandwidth: { maxActiveDownloads: 2 } } }).bandwidth;
  check('old payload gets the defaults', old.autoRetry === 'after' && old.autoRetryDelayMin === 5 && old.autoRetryAlways === false);
  const bad = migrateSettings({ settings: { bandwidth: { autoRetry: 'weird', autoRetryDelayMin: 7 } } }).bandwidth;
  check('bad values fall back', bad.autoRetry === 'after' && bad.autoRetryDelayMin === 5);
  const kept = migrateSettings({ settings: { bandwidth: { autoRetry: 'off', autoRetryDelayMin: 60, autoRetryAlways: true } } }).bandwidth;
  check('good values survive', kept.autoRetry === 'off' && kept.autoRetryDelayMin === 60 && kept.autoRetryAlways === true);
  const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  s.bandwidth.autoRetry = 'off';
  s.bandwidth.autoRetryDelayMin = 15;
  s.bandwidth.autoRetryAlways = true;
  const g = toGovernance(s);
  check('pushed to Kotlin in the governance payload', g.autoRetry === 'off' && g.autoRetryDelayMin === 15 && g.autoRetryAlways === true);
  check('not sent to Rust', !Object.keys(toNativeConfig(s)).some((k) => /retry/.test(k)));
  check('mock keeps them', /autoRetryDelayMin/.test(read('modules/maglev-engine/src/MaglevMockEngine.ts')));

  console.log('Kotlin');
  check('module saves them from setGovernance', /AutoRetry\.save\(/.test(read(KT + 'MaglevEngineModule.kt')));
  const w = read(KT + 'AutoRetryWorker.kt');
  check('worker is a CoroutineWorker', /class AutoRetryWorker[\s\S]{0,80}CoroutineWorker/.test(w));
  check('one-time work, unique per download, delayed', /OneTimeWorkRequest\.Builder\(AutoRetryWorker/.test(w) && /enqueueUniqueWork\(/.test(w) && /setInitialDelay\(/.test(w));
  check('needs a network', /NetworkType\.CONNECTED/.test(w));
  check('rounds kept in memory and SharedPreferences', /getSharedPreferences/.test(w) && /rounds/.test(w));
  check('gives up after 3 rounds unless Keep trying', /MAX_ROUNDS = 3/.test(w) && /always/.test(w));
  check('retries NETWORK and STALLED', /"NETWORK"/.test(w) && /"STALLED"/.test(w));
  check('retries HTTP_STATUS only for 408/429/5xx', /"HTTP_STATUS"/.test(w) && /408/.test(w) && /429/.test(w) && /502/.test(w));
  check('never retries sign-in, expired, disk, permission, bad source', !/"(AUTH_REQUIRED|LINK_EXPIRED|DISK_FULL|PERMISSION|FILE_CHANGED|NOT_A_FILE|LAN_ADDRESS)"\s*(,|->)/.test(w.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')));
  check('only the error state', /"error"/.test(w) && !/"needs_link"\s*->/.test(w));
  check('waits while a Wi-Fi or VPN rule blocks', /governanceBlocked\(\)/.test(w) || /governanceBlocked\(\)/.test(read(KT + 'EngineHost.kt')));
  check('cancels when the download is gone or the setting is off', /cancelUniqueWork\(/.test(w));
  const host = read(KT + 'EngineHost.kt');
  check('telemetry feeds the scheduler', /AutoRetry\.onDownloads\(/.test(host));
  check('engine retry entry point', /fun autoRetryDownload\(/.test(host) && /nativeRetryDownload/.test(host));

  console.log('UI');
  const sec = read('components/settings/RetrySection.tsx');
  check('title', /Retry failed downloads/.test(sec));
  check('options', /Off/.test(sec) && /After 1 min/.test(sec) && /After 5 min/.test(sec) && /After 15 min/.test(sec) && /After 1 hour/.test(sec));
  check('Keep trying toggle', /Keep trying/.test(sec) && /Off: stop after 3 tries\./.test(sec));
  const downloads = read('app/settings/downloads.tsx');
  check('rendered on the downloads page', /<RetrySection \/>/.test(downloads) && /<PartsSection \/>/.test(downloads));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nauto-retry: all checks passed');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
