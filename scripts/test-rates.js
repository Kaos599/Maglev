#!/usr/bin/env node
// Rate smoothing and ETA label tests (docs/UI_SPEC_PHASE2.md S10.2). Pure functions, no engine.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

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
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

async function main() {
  const { smoothRate, etaSecs, formatEta, etaLabelSecs, TAU_MS, RESET_GAP_MS } = await import('../utils/rates.ts');

  // smoothRate: exponential moving average, tau = 5 s
  check('tau is 5 s and reset gap is 15 s', TAU_MS === 5000 && RESET_GAP_MS === 15000);
  check('smoothRate: no previous value takes the sample', smoothRate(null, 1000, 1000) === 1000);
  const one = smoothRate(0, 1000, 5000);
  check('smoothRate: one tau closes 63.2% of the gap', near(one, 1000 * (1 - Math.exp(-1)), 1e-6), String(one));
  check('smoothRate: small dt moves a little', smoothRate(1000, 0, 100) > 970 && smoothRate(1000, 0, 100) < 1000);
  check('smoothRate: gap over 15 s resets to the sample', smoothRate(9999, 123, 15001) === 123);
  check('smoothRate: gap of exactly 15 s still smooths', smoothRate(1000, 0, 15000) > 0);
  check('smoothRate: dt 0 keeps previous value', smoothRate(500, 900, 0) === 500);
  check('smoothRate: negative or NaN sample clamps to 0', smoothRate(100, -5, 1000) >= 0 && smoothRate(null, NaN, 1000) === 0);
  let v = 0;
  for (let i = 0; i < 60; i++) v = smoothRate(v, 2_000_000, 1000);
  check('smoothRate: converges to a steady sample', Math.abs(v - 2_000_000) < 2000, String(v));
  let spike = 1_000_000;
  spike = smoothRate(spike, 10_000_000, 1000);
  check('smoothRate: a one-second spike barely moves the value', spike < 2_800_000, String(spike));

  // etaSecs
  check('etaSecs: under 1 KB/s is unknown', etaSecs(1e6, 1023) === -1 && etaSecs(1e6, 0) === -1);
  check('etaSecs: remaining over rate, rounded up', etaSecs(10_000, 1024) === 10);
  check('etaSecs: nothing left is 0', etaSecs(0, 1e6) === 0);
  check('etaSecs: negative remaining is 0', etaSecs(-5, 1e6) === 0);

  // formatEta: steps
  check('formatEta: unknown is a dash', formatEta(-1, null) === '—' && formatEta(NaN, null) === '—');
  check('formatEta: under a minute', formatEta(0, null) === 'under a minute' && formatEta(45, null) === 'under a minute');
  check('formatEta: whole minutes', formatEta(12 * 60, null) === '12 min' && formatEta(90, null) === '2 min');
  check('formatEta: 59 minutes still minutes', formatEta(59 * 60, null) === '59 min');
  check('formatEta: hours in 5 minute steps', formatEta(4800, null) === '1 h 20 min' && formatEta(4800 + 100, null) === '1 h 20 min');
  check('formatEta: exact hour has no minutes', formatEta(7200, null) === '2 h');
  check('formatEta: over a day', formatEta(90_000, null) === 'over a day' && formatEta(86_400, null) === 'over a day');

  // formatEta: hysteresis
  check('hysteresis: label stands for its value', etaLabelSecs('12 min') === 720 && etaLabelSecs('1 h 20 min') === 4800 && etaLabelSecs('under a minute') < 60);
  check('hysteresis: within 10% keeps the previous label', formatEta(11.5 * 60, '12 min') === '12 min' && formatEta(12.5 * 60, '12 min') === '12 min');
  check('hysteresis: outside 10% changes the label', formatEta(10 * 60, '12 min') === '10 min' && formatEta(14 * 60, '12 min') === '14 min');
  check('hysteresis: crossing a step boundary changes at once', formatEta(50, '2 min') === 'under a minute' && formatEta(3700, '58 min') === '1 h');
  check('hysteresis: a flicker series stays put', (() => {
    let label = formatEta(600, null);
    const seen = new Set([label]);
    for (const s of [610, 590, 605, 598, 620, 585, 612]) {
      label = formatEta(s, label);
      seen.add(label);
    }
    return seen.size === 1;
  })());
  check('hysteresis: unknown resets to a dash then recovers', formatEta(-1, '12 min') === '—' && formatEta(720, '—') === '12 min');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('test run crashed:', e);
  process.exit(1);
});
