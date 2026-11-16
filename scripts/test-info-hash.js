#!/usr/bin/env node
// Feature 17: a bare info hash (40 hex or 32 base32) is accepted by parseSource as if it were
// magnet:?xt=urn:btih:<hash>. Hashes inside other text are not accepted.
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

const HEX = '0123456789abcdef0123456789abcdef01234567'; // 40 lowercase hex
const HEX_UPPER = HEX.toUpperCase();
// 32 base32 characters (RFC 4648 alphabet) encoding the same 20 bytes as HEX.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function hexToBase32(hex) {
  let bits = '';
  for (const c of hex) bits += parseInt(c, 16).toString(2).padStart(4, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
const BASE32 = hexToBase32(HEX);

async function main() {
  const M = await import('../modules/maglev-engine/src/magnet.ts');
  const { parseSource, parseMagnet, normalizeInfoHash } = M;

  console.log('bare info hash');
  check('base32 fixture is 32 chars', BASE32.length === 32, BASE32);

  const lower = parseSource(HEX);
  check('40 lowercase hex gives a magnet result', lower?.kind === 'magnet' && lower.infoHash === HEX);
  check('40 lowercase hex equals the magnet URI result', JSON.stringify(lower) === JSON.stringify(parseMagnet(`magnet:?xt=urn:btih:${HEX}`)));

  const upper = parseSource(HEX_UPPER);
  check('40 uppercase hex is lowercased', upper?.kind === 'magnet' && upper.infoHash === HEX);

  const b32 = parseSource(BASE32);
  check('32 base32 gives the hex info hash', b32?.kind === 'magnet' && b32.infoHash === HEX, String(b32?.infoHash));
  check('32 base32 equals the magnet URI result', JSON.stringify(b32) === JSON.stringify(parseMagnet(`magnet:?xt=urn:btih:${BASE32}`)));

  check('lowercase base32 is accepted', parseSource(BASE32.toLowerCase())?.infoHash === HEX);

  check('surrounding spaces are trimmed (hex)', parseSource(`   ${HEX}  `)?.infoHash === HEX);
  check('surrounding spaces are trimmed (base32)', parseSource(`\t${BASE32}\n`)?.infoHash === HEX);

  check('bare hash has no name, trackers or length', (() => {
    const r = parseSource(HEX);
    return r?.name === null && r?.trackers?.length === 0 && r?.exactLength === undefined;
  })());

  console.log('rejected input');
  check('39 hex chars is null', parseSource(HEX.slice(0, 39)) === null);
  check('41 hex chars is null', parseSource(HEX + 'a') === null);
  check('31 base32 chars is null', parseSource(BASE32.slice(0, 31)) === null);
  check('33 base32 chars is null', parseSource(BASE32 + 'A') === null);
  check('non-hex 40 chars is null', parseSource('z' + HEX.slice(1)) === null);
  check('base32 digit 0 is null', parseSource('0' + BASE32.slice(1)) === null);
  check('base32 digit 1 is null', parseSource('1' + BASE32.slice(1)) === null);
  check('hash inside a sentence is null', parseSource(`Get this ${HEX} now`) === null);
  check('hash with a trailing word is null', parseSource(`${HEX} torrent`) === null);
  check('hash inside a URL path is null', parseSource(`https://example.com/${HEX}`) === null);
  check('empty string is null', parseSource('   ') === null);

  console.log('existing parsing');
  const magnet = parseSource(`magnet:?xt=urn:btih:${HEX}&dn=Some+File&tr=udp%3A%2F%2Ft.example%3A80&xl=42`);
  check('magnet with name, tracker and length is unchanged', magnet?.kind === 'magnet' && magnet.name === 'Some File' && magnet.trackers.length === 1 && magnet.exactLength === 42);
  check('magnet with base32 btih still normalises', parseSource(`magnet:?xt=urn:btih:${BASE32}`)?.infoHash === HEX);
  check('magnet without btih is null', parseSource('magnet:?dn=nothing') === null);
  check('normalizeInfoHash still handles 40 hex', normalizeInfoHash(HEX_UPPER) === HEX);
  check('normalizeInfoHash still handles base32', normalizeInfoHash(BASE32) === HEX);
  check('https torrent URL unchanged', parseSource('https://example.com/a/file.torrent')?.kind === 'torrent');

  if (failed) {
    console.log(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall info-hash checks passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Add a link hands a bare hash to Add torrent (0.25 review follow-up).
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'add-download.tsx'), 'utf8');
  const ok = /infoHashToMagnet\(input\)/.test(src) && /pathname: '\/add-torrent', params: \{ source: hashMagnet \}/.test(src);
  console.log(ok ? '  ok   add-download routes a bare hash to Add torrent' : '  FAIL add-download routes a bare hash to Add torrent');
  if (!ok) process.exitCode = 1;
}
