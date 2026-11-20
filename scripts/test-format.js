#!/usr/bin/env node
// Byte and speed formatters must be total: never "undefined" or "NaN" (docs/UI_SPEC_PHASE2.md S11.4).
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

async function main() {
  const { formatBytes, formatSpeed } = await import('../constants/format.ts');
  const odd = [0, -1, 0.0039, 0.5, 0.999, 1, 1023, 1024, 4.1 * 1024, 1e6, 5e12, 1e15, 1e30, NaN, Infinity, -Infinity, undefined, null, '12'];
  for (const v of odd) {
    for (const [name, fn] of [['formatBytes', formatBytes], ['formatSpeed', formatSpeed]]) {
      const out = fn(v);
      check(`${name}(${String(v)}) is clean`, typeof out === 'string' && !/undefined|NaN|Infinity/.test(out), out);
    }
  }
  check('sub-byte speed reads 0 B/s', formatSpeed(0.0039) === '0 B/s', formatSpeed(0.0039));
  check('1 B', formatBytes(1) === '1 B');
  check('huge values clamp to TB', /TB$/.test(formatBytes(1e30)));
  // Whole numbers from 100 up: "412 MB", not "412.0 MB". Below 100 one decimal stays useful.
  check('412 MB has no decimal', formatBytes(412 * 1024 * 1024) === '412 MB');
  check('1.2 GB keeps one decimal', formatBytes(1.2 * 1024 ** 3) === '1.2 GB');
  check('45.5 MB keeps one decimal', formatBytes(45.5 * 1024 * 1024) === '45.5 MB');
  check('999.96 MB rolls up to 1.0 GB, never 1000 MB', formatBytes(1023.96 * 1024 * 1024) === '1.0 GB');
  // Speeds: 3 significant digits, and the unit moves up at 1000, so a speed is always 7-9 characters
  // ("62.5 MB/s", "125 MB/s", "0.98 MB/s") and the status line's speed slot can be 9 wide (owner pick 2026-11-20).
  const M = 1024 * 1024;
  const sp = [
    [0, '0 B/s'], [512, '512 B/s'], [999, '999 B/s'], [1000, '0.98 KB/s'], [4.1 * 1024, '4.10 KB/s'],
    [62.5 * 1024, '62.5 KB/s'], [250 * 1024, '250 KB/s'], [999.4 * 1024, '999 KB/s'], [1000 * 1024, '0.98 MB/s'],
    [2 * M, '2.00 MB/s'], [3.2 * M, '3.20 MB/s'], [9.996 * M, '10.0 MB/s'], [62.5 * M, '62.5 MB/s'], [99.96 * M, '100 MB/s'],
    [125 * M, '125 MB/s'], [625 * M, '625 MB/s'], [999.6 * M, '0.98 GB/s'], [1.25 * 1024 * M, '1.25 GB/s'],
  ];
  for (const [bps, want] of sp) check(`speed ${bps} B/s reads ${want}`, formatSpeed(bps) === want, formatSpeed(bps));
  let widest = 0;
  for (let e = 0; e <= 40; e += 0.01) widest = Math.max(widest, formatSpeed(2 ** e).length);
  check('no speed is wider than 9 characters', widest <= 9, String(widest));
  check('sizes keep their own format', formatBytes(3.2 * M) === '3.2 MB' && formatBytes(412 * M) === '412 MB');

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nformat tests passed');
}
main();
