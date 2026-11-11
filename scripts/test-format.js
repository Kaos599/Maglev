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
  check('4.1 KB/s', formatSpeed(4.1 * 1024) === '4.1 KB/s', formatSpeed(4.1 * 1024));
  check('1 B', formatBytes(1) === '1 B');
  check('huge values clamp to TB', /TB$/.test(formatBytes(1e30)));

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nformat tests passed');
}
main();
