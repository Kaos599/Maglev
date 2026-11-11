#!/usr/bin/env node
// NATIVE_CONTRACT 21 (TypeScript side): duplicate add merges trackers, and the VPN-only rule reaches governance.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).
process.removeAllListeners('warning');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

async function main() {
  const { MaglevMockEngine } = await import('../modules/maglev-engine/src/MaglevMockEngine.ts');
  const { toGovernance, GOVERNANCE_REASONS } = await import('../modules/maglev-engine/src/toNativeConfig.ts');
  const { DEFAULT_SETTINGS } = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');

  const hash = '0123456789abcdef0123456789abcdef01234567';
  const engine = new MaglevMockEngine();
  const first = await engine.addTorrent(`magnet:?xt=urn:btih:${hash}&tr=udp%3A%2F%2Fa.example.com%3A1%2Fannounce`, {});
  check('first add succeeds', first.ok === true);
  const dup = await engine.addTorrent(
    `magnet:?xt=urn:btih:${hash}&tr=udp%3A%2F%2Fa.example.com%3A1%2Fannounce&tr=udp%3A%2F%2Fb.example.com%3A1%2Fannounce`,
    {}
  );
  check('duplicate add fails with DUPLICATE', dup.ok === false && dup.code === 'DUPLICATE');
  check('duplicate add reports one merged tracker', dup.mergedTrackers === 1, String(dup.mergedTrackers));
  const again = await engine.addTorrent(`magnet:?xt=urn:btih:${hash}&tr=udp%3A%2F%2Fb.example.com%3A1%2Fannounce`, {});
  check('a second duplicate merges nothing', again.ok === false && again.mergedTrackers === 0, String(again.mergedTrackers));

  check('vpnOnly defaults to false', DEFAULT_SETTINGS.network.vpnOnly === false);
  const on = { ...DEFAULT_SETTINGS, network: { ...DEFAULT_SETTINGS.network, vpnOnly: true } };
  check('toGovernance carries vpnOnly', toGovernance(on).vpnOnly === true && toGovernance(DEFAULT_SETTINGS).vpnOnly === false);
  check('vpn_required is the vpnOnly reason', GOVERNANCE_REASONS.vpnOnly === 'vpn_required');

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nwave 2 edge tests passed');
}
main();
