#!/usr/bin/env node
// "Stop waiting for peers after" (NATIVE_CONTRACT 20.1): the setting round trip, migration, the Settings row,
// the search entry, and the Rust wiring. Rust behaviour itself is covered by the unit tests in scheduler.rs.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const { readPrivateDoc } = require('./lib/privateDocs');
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

async function main() {
  const types = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  const { migrateSettings } = await import('../modules/maglev-engine/src/MaglevSettingsStore.ts');
  const { toNativeConfig } = await import('../modules/maglev-engine/src/toNativeConfig.ts');
  const { SETTINGS_INDEX, searchSettings } = await import('../utils/settingsIndex.ts');
  const { DEFAULT_SETTINGS, PEER_TIMEOUT_OPTIONS } = types;

  console.log('settings');
  check('default is 10 minutes', DEFAULT_SETTINGS.bandwidth.peerTimeoutMins === 10);
  check('options are 10, 30, 60, 360 and Never (0)', JSON.stringify([...PEER_TIMEOUT_OPTIONS]) === '[10,30,60,360,0]');
  check('missing value reads as 10', migrateSettings({ settings: { bandwidth: { maxActiveDownloads: 2 } } }).bandwidth.peerTimeoutMins === 10);
  check('empty payload reads as 10', migrateSettings(null).bandwidth.peerTimeoutMins === 10);
  for (const bad of [7, -1, '30', null, 1e9, NaN]) {
    const v = migrateSettings({ settings: { bandwidth: { peerTimeoutMins: bad } } }).bandwidth.peerTimeoutMins;
    check(`invalid ${String(bad)} reads as 10`, v === 10, String(v));
  }
  for (const ok of PEER_TIMEOUT_OPTIONS) {
    const v = migrateSettings({ settings: { bandwidth: { peerTimeoutMins: ok } } }).bandwidth.peerTimeoutMins;
    check(`${ok} survives a save and load`, v === ok, String(v));
  }
  const saved = migrateSettings(JSON.parse(JSON.stringify({ settings: { bandwidth: { peerTimeoutMins: 0 } } })));
  check('Never survives (0 is not mistaken for missing)', saved.bandwidth.peerTimeoutMins === 0);

  console.log('native config');
  const cfg = (mins) => {
    const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    s.bandwidth.peerTimeoutMins = mins;
    return toNativeConfig(s);
  };
  check('default sends 600 s', cfg(10).peer_timeout_secs === 600);
  check('30 min sends 1800 s', cfg(30).peer_timeout_secs === 1800);
  check('1 hour sends 3600 s', cfg(60).peer_timeout_secs === 3600);
  check('6 hours sends 21600 s', cfg(360).peer_timeout_secs === 21600);
  check('Never sends 0', cfg(0).peer_timeout_secs === 0);

  console.log('mock engine echoes it');
  const { MaglevMockEngine } = await import('../modules/maglev-engine/src/MaglevMockEngine.ts');
  const eng = new MaglevMockEngine();
  const echoed = async (mins) => {
    await eng.applyConfig(cfg(mins));
    const eff = await eng.getEffectiveConfig();
    return eff.peer_timeout_secs;
  };
  check('effective config returns what was set', (await echoed(60)) === 3600 && (await echoed(0)) === 0);

  console.log('settings row and search');
  const q = read('components/settings/QueueSection.tsx');
  check('row label', /label="Stop waiting for peers after"/.test(q));
  check('options 10 min, 30 min, 1 hour, 6 hours, Never', ['10 min', '30 min', '1 hour', '6 hours', 'Never'].every((l) => q.includes(`label: '${l}'`)));
  check('row writes peerTimeoutMins', /peerTimeoutMins: v/.test(q));
  const entry = SETTINGS_INDEX.find((x) => x.title === 'Stop waiting for peers after');
  check('search entry exists on the speed page', !!entry && entry.page === 'speed');
  for (const kw of ['timeout', 'peers', 'stalled', 'stuck', 'waiting']) {
    check(`searching "${kw}" finds it`, searchSettings(kw).some((r) => (r.entry ?? r).title === 'Stop waiting for peers after'));
  }

  console.log('Rust wiring');
  const cfgRs = read('native/maglev-core/src/config.rs');
  check('config has peer_timeout_secs with a 600 default', /pub peer_timeout_secs: u32/.test(cfgRs) && /peer_timeout_secs: DEFAULT_PEER_TIMEOUT_SECS/.test(cfgRs));
  const sch = read('native/maglev-core/src/scheduler.rs');
  check('default constant is 10 minutes', /DEFAULT_PEER_TIMEOUT_SECS: u32 = 10 \* 60/.test(sch));
  check('no fixed 10 minute constant left', !/NO_PEERS_AFTER_MS/.test(sch + read('native/maglev-core/src/engine.rs')));
  check('stall rule and clock tests exist', /fn stall_exclusions\(/.test(sch) && /fn a_peer_one_tick_before_the_limit_resets_the_clock\(/.test(sch) && /fn never_does_not_run_the_stall_clock\(/.test(sch) && /fn a_live_config_change_applies_to_the_running_clock\(/.test(sch));
  const eng2 = read('native/maglev-core/src/engine.rs');
  check('tick uses the stall rule', /is_waiting_for_peers\(&StallInputs/.test(eng2) && /stall_step\(/.test(eng2));
  check('Never clears no_peers tags on config apply', /peer_timeout_is_never\(&self\.config\.lock\(\)\)/.test(eng2) && /set_health\(&id, ""\)/.test(eng2));
  check('Keep trying resets the stall clock', /m\.stalled_since_ms = None;/.test(eng2));
  check('snapshot exports stalled_secs', /pub stalled_secs: Option<i64>/.test(read('native/maglev-core/src/types.rs')));
  check('meta keeps stalled_since_ms in memory only (fresh window per process)', /#\[serde\(skip\)\]\s*pub stalled_since_ms: Option<i64>/.test(read('native/maglev-core/src/meta.rs')));
  {
    const contract = readPrivateDoc('NATIVE_CONTRACT.md');
    if (contract !== null) check('contract section exists', /### 20\.1 Stop waiting for peers after/.test(contract));
  }

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll peer timeout checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
