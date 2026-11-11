#!/usr/bin/env node
// Playback verdict check (docs/ASSISTANT_DESIGN.md D3). Runs on recorded probe outputs. No network.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

// Recorded probe shapes (CodecProbe.kt output).
const OLD_PHONE = { avc: 'hardware', hevc: 'hardware', hevc10: 'none', av1: 'none', av1_10: 'none', vp9: 'hardware', dolbyVision: 'none', hdr10: false, hdr10plus: false, hlg: false };
const FLAGSHIP = { avc: 'hardware', hevc: 'hardware', hevc10: 'hardware', av1: 'hardware', av1_10: 'hardware', vp9: 'hardware', dolbyVision: 'hardware', hdr10: true, hdr10plus: true, hlg: true };
const SOFT_AV1 = { ...FLAGSHIP, av1: 'software', av1_10: 'software' };
const NO_DV = { ...FLAGSHIP, dolbyVision: 'none' };
const UNKNOWN = { avc: 'unknown', hevc: 'unknown', hevc10: 'unknown', av1: 'unknown', av1_10: 'unknown', vp9: 'unknown', dolbyVision: 'unknown', hdr10: null, hdr10plus: null, hlg: null };

const NAMES = {
  h264: 'Harbor.Lights.S02E05.1080p.AMZN.WEB-DL.DDP5.1.H.264-LUMEN',
  hevc8: 'The.Last.Harbor.2023.1080p.WEB-DL.DDP5.1.H.265-LUMEN',
  hevc10: 'Old.Compass.2019.1080p.BluRay.x265.10bit.iNTERNAL-KRAKEN',
  hdr: 'The.Last.Harbor.2023.2160p.UHD.BluRay.REMUX.HDR10.HEVC.TrueHD.7.1.Atmos-KRAKEN',
  av1: 'Harbor.Lights.S03E01.1080p.WEB-DL.AV1.Opus-LUMEN',
  hi10: '[GrpX] Harbor Tale - 03 [BD 1080p Hi10P FLAC][Dual Audio][8E1F2A3B].mkv',
  nocodec: 'Some Movie 2020',
};

async function main() {
  const { parseRelease } = await import('../utils/assistant/releaseName.ts');
  const { playbackVerdict } = await import('../utils/assistant/playback.ts');
  const v = (name, support) => playbackVerdict(parseRelease(name), support);

  const cases = [
    ['old phone: H.264 smooth', NAMES.h264, OLD_PHONE, 'smooth'],
    ['old phone: HEVC 8-bit smooth', NAMES.hevc8, OLD_PHONE, 'smooth'],
    ['old phone: HEVC 10-bit needs other player', NAMES.hevc10, OLD_PHONE, 'needs_other_player'],
    ['old phone: HDR10 HEVC needs other player', NAMES.hdr, OLD_PHONE, 'needs_other_player'],
    ['old phone: AV1 needs other player', NAMES.av1, OLD_PHONE, 'needs_other_player'],
    ['old phone: Hi10P H.264 may stutter', NAMES.hi10, OLD_PHONE, 'may_stutter'],
    ['flagship: AV1 smooth', NAMES.av1, FLAGSHIP, 'smooth'],
    ['flagship: HEVC 10-bit smooth', NAMES.hevc10, FLAGSHIP, 'smooth'],
    ['flagship: HDR10 remux smooth', NAMES.hdr, FLAGSHIP, 'smooth'],
    ['software AV1 may stutter', NAMES.av1, SOFT_AV1, 'may_stutter'],
    ['no codec in name is unknown', NAMES.nocodec, FLAGSHIP, 'unknown'],
  ];
  const labels = { smooth: 'Plays smoothly', may_stutter: 'May stutter', needs_other_player: 'Needs another player' };
  for (const [name, rel, sup, want] of cases) {
    const out = v(rel, sup);
    check(name, out.verdict === want, `got ${out.verdict}: ${out.reason}`);
    if (labels[want]) check(`label: ${name}`, out.label === labels[want], String(out.label));
    check(`reason is one plain line: ${name}`, out.reason.length > 0 && !/\n|undefined|NaN/.test(out.reason));
  }

  // Unknown probe: never smooth, and no "needs another player" guess either.
  for (const [k, rel] of Object.entries(NAMES)) {
    const out = v(rel, UNKNOWN);
    check(`unknown probe: ${k} stays unknown or cautious`, out.verdict !== 'smooth' && out.verdict !== 'needs_other_player', out.verdict);
  }
  check('missing probe is unknown', v(NAMES.h264, undefined).verdict === 'unknown');
  check('null probe is unknown', v(NAMES.h264, null).verdict === 'unknown');
  check('unknown has no label', v(NAMES.h264, UNKNOWN).label === null);

  // Dolby Vision.
  const base = parseRelease(NAMES.hdr);
  const dv = playbackVerdict({ ...base, hdr: ['dv'], dvFallback: false }, NO_DV);
  check('DV without fallback, no DV decoder: needs other player', dv.verdict === 'needs_other_player', dv.verdict);
  const dvOk = playbackVerdict({ ...base, hdr: ['dv', 'hdr10'], dvFallback: true }, NO_DV);
  check('DV with HDR10 fallback plays', dvOk.verdict === 'smooth', dvOk.verdict);
  const dvUnknown = playbackVerdict({ ...base, hdr: ['dv'], dvFallback: false }, { ...FLAGSHIP, dolbyVision: 'unknown' });
  check('DV with unknown decoder is unknown', dvUnknown.verdict === 'unknown', dvUnknown.verdict);

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nplayback: all checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
