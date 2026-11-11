#!/usr/bin/env node
// Share-intent queue parsing and the bulk-action summary line. Needs Node 22.18+ (runs TypeScript directly).
process.removeAllListeners('warning');
const assert = require('assert');

async function main() {
  const { parsePackedShare, setShareQueue, takeNextShared, sharedWaiting } = await import('../utils/shareQueue.ts');
  const { bulkSummary } = await import('../utils/bulkSummary.ts');

  const a = 'content://x/a.torrent';
  const b = 'content://x/b one.torrent';
  const packed = `maglev://share?u=${encodeURIComponent(a)}&u=${encodeURIComponent(b)}`;
  assert.deepStrictEqual(parsePackedShare(packed), [a, b]);
  assert.deepStrictEqual(parsePackedShare(`/share?u=${encodeURIComponent(a)}`), [a]);
  assert.strictEqual(parsePackedShare('magnet:?xt=urn:btih:abc'), null);

  // app/+native-intent.tsx does this: first source opens the add flow, the rest wait.
  const [first, ...rest] = parsePackedShare(packed);
  setShareQueue(rest);
  assert.strictEqual(first, a);
  assert.strictEqual(sharedWaiting(), 1);
  assert.strictEqual(takeNextShared(), b);
  assert.strictEqual(takeNextShared(), null);

  assert.strictEqual(bulkSummary('Paused', [true, true, true, true, false]), "Paused 4 · 1 couldn't");
  assert.strictEqual(bulkSummary('Paused', [true, true]), null);
  assert.strictEqual(bulkSummary('Deleted', [false, false]), "2 couldn't be deleted");
  assert.strictEqual(bulkSummary('Resumed', []), null);
  console.log('share + bulk summary tests passed');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
