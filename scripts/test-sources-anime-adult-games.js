#!/usr/bin/env node
// Tests for acgrip and u3c3 (anime, adult). No network: fixtures are real captures (see scripts/fixtures/search/*_SOURCES.txt).
// dodi was researched and deliberately not built (no magnets on the official site, only zovo.to shortlinks).

process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const FIX = path.join(__dirname, 'fixtures', 'search');
const fx = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const fxb = (n) => new Uint8Array(fs.readFileSync(path.join(FIX, n)));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const HEX40 = /^[0-9a-f]{40}$/;
const ctx = (over = {}) => ({ baseUrl: 'https://example.test', category: 'all', hideAdult: false, limit: 50, ...over });

async function rejects(fn, kind) {
  try { await fn(); return false; } catch (e) { return e && e.name === 'ProviderError' && e.kind === kind; }
}

async function main() {
  const ac = await import('../utils/search/providers/acgrip.ts');
  const u3 = await import('../utils/search/providers/u3c3.ts');

  console.log('[1] acgrip parse');
  const a = ac.parse(fx('acgrip_search.xml'), ctx());
  check('acgrip: rows parsed', a.length >= 5, `got ${a.length}`);
  check('acgrip: rows are deferred (no magnet, stand-in key, detail url)', a.every((r) => r.magnet === '' && /^acgrip:\d+$/.test(r.infoHash) && /^https:\/\/acg\.rip\/t\/\d+$/.test(r.detailUrl) && r.name));
  check('acgrip: first row name, size, date, category', a[0].name.startsWith('[ToonsHub]') && a[0].name.includes('One Piece') && a[0].sizeBytes === 1455723520 && a[0].publishedAt === Date.parse('Tue, 10 Nov 2026 09:21:19 -0800') && a[0].category === 'anime' && a[0].infoHash === 'acgrip:367408', JSON.stringify(a[0]));
  check('acgrip: title has no entities', a.every((r) => !r.name.includes('&amp;')));
  check('acgrip: limit', ac.parse(fx('acgrip_search.xml'), ctx({ limit: 2 })).length === 2);
  check('acgrip: empty feed -> []', ac.parse('<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>', ctx()).length === 0);
  check('acgrip: html body -> ProviderError(parse)', (() => { try { ac.parse('<html>nope</html>', ctx()); return false; } catch (e) { return e.name === 'ProviderError' && e.kind === 'parse'; } })());

  console.log('\n[2] acgrip .torrent -> info hash');
  check('sha1("abc")', ac.sha1Hex(new TextEncoder().encode('abc')) === 'a9993e364706816aba3e25717850c26c9cd0d89d');
  check('sha1 of 1000 x "a" (multi block)', ac.sha1Hex(new TextEncoder().encode('a'.repeat(1000))) === '291e9a6c66994949b57ba5e650361e98fc36b1ba');
  check('info hash of the real .torrent', ac.infoHashFromTorrent(fxb('acgrip_367408.torrent')) === '0636226361b50c81ef91ff57beb32f547dceaf78');
  check('not a torrent -> ProviderError(parse)', (() => { try { ac.infoHashFromTorrent(new TextEncoder().encode('<html>')); return false; } catch (e) { return e.name === 'ProviderError' && e.kind === 'parse'; } })());
  check('torrent without info dict -> ProviderError(parse)', (() => { try { ac.infoHashFromTorrent(new TextEncoder().encode('d3:fooi1ee')); return false; } catch (e) { return e.name === 'ProviderError' && e.kind === 'parse'; } })());

  console.log('\n[3] u3c3 parse');
  const u = u3.parse(fx('u3c3_search.html'), ctx());
  check('u3c3: rows parsed', u.length >= 10, `got ${u.length}`);
  check('u3c3: every row valid, adult, with magnet', u.every((r) => HEX40.test(r.infoHash) && r.magnet.startsWith('magnet:?xt=urn:btih:' + r.infoHash) && r.name && r.category === 'adult' && r.providerId === 'u3c3'));
  check('u3c3: pinned ad rows (999GB, year 2099) are dropped', u.every((r) => r.infoHash !== 'fa2ff11b032a79cc14a047d46565b479060946ea' && (r.sizeBytes ?? 0) < 900e9 && (r.publishedAt ?? 0) < Date.UTC(2090, 0, 1)));
  check('u3c3: size and date parsed', u[0].sizeBytes > 1e8 && u[0].publishedAt > Date.UTC(2026, 0, 1), JSON.stringify(u[0]).slice(0, 200));
  check('u3c3: detail url absolute', /^https:\/\/example\.test\/view\?id=[0-9a-f]+/.test(u[0].detailUrl), u[0].detailUrl);
  check('u3c3: unique hashes', new Set(u.map((r) => r.infoHash)).size === u.length);
  check('u3c3: hideAdult -> []', u3.parse(fx('u3c3_search.html'), ctx({ hideAdult: true })).length === 0);
  check('u3c3: limit', u3.parse(fx('u3c3_search.html'), ctx({ limit: 3 })).length === 3);
  check('u3c3: page without rows -> []', u3.parse('<html><body><table><tbody></tbody></table></body></html>', ctx()).length === 0);
  check('u3c3: non-html body -> ProviderError(parse)', (() => { try { u3.parse('{"x":1}', ctx()); return false; } catch (e) { return e.name === 'ProviderError' && e.kind === 'parse'; } })());
  check('u3c3: token read from the home page, commented-out one ignored', u3.parseToken(fx('u3c3_home_token.html')) === 'h4xxwbov');
  check('u3c3: no token -> ProviderError(parse)', (() => { try { u3.parseToken('<html></html>'); return false; } catch (e) { return e.name === 'ProviderError' && e.kind === 'parse'; } })());

  console.log('\n[4] flows (mocked fetch)');
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const u2 = new URL(url);
    seen.push(String(url));
    if (u2.hostname === 'acg.rip' && u2.pathname.endsWith('.torrent')) return new Response(fxb('acgrip_367408.torrent'), { status: 200 });
    if (u2.hostname === 'big.test') return new Response(new Uint8Array(4), { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } });
    if (u2.hostname === 'acg.test') {
      if (u2.pathname.endsWith('.torrent')) return new Response(fxb('acgrip_367408.torrent'), { status: 200 });
      return new Response(fx('acgrip_search.xml'), { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    }
    if (u2.hostname === 'u3.test') {
      if (u2.searchParams.has('search2')) return new Response(fx('u3c3_search.html'), { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(fx('u3c3_home_token.html'), { status: 200, headers: { 'content-type': 'text/html' } });
    }
    throw new TypeError('no route');
  };
  const sig = new AbortController().signal;
  const sctx = (base, over = {}) => ({ baseUrl: base, signal: sig, hideAdult: false, limit: 50, ...over });
  const rows = await ac.acgrip.search('one piece', 'anime', 1, sctx('https://acg.test'));
  check('acgrip.search: url has the term', rows.length > 0 && seen[0] === 'https://acg.test/.xml?term=one%20piece', seen[0]);
  const res = await ac.acgrip.resolveMagnet({ ...rows[0], detailUrl: 'https://acg.test/t/367408' }, sig);
  check('acgrip.resolveMagnet: fetches <detail>.torrent, returns real hash and magnet', res.infoHash === '0636226361b50c81ef91ff57beb32f547dceaf78' && res.magnet.startsWith('magnet:?xt=urn:btih:0636226361b50c81ef91ff57beb32f547dceaf78') && seen.at(-1) === 'https://acg.rip/t/367408.torrent', seen.at(-1));
  {
    const before = seen.length;
    await ac.acgrip.resolveMagnet({ ...rows[0], detailUrl: 'http://192.168.1.1/t/367408' }, sig).catch(() => {});
    check('acgrip.resolveMagnet: a feed host is never fetched; only the id is used, over https on acg.rip', seen.slice(before).every((u) => u === 'https://acg.rip/t/367408.torrent'), seen.slice(before).join(' '));
  }
  {
    const tf = await import('../utils/search/torrentFile.ts');
    check('fetchTorrentBytes: a declared oversize body is refused before it is read', await rejects(() => tf.fetchTorrentBytes('https://big.test/x.torrent', sig, 'ua'), 'parse'));
  }
  check('acgrip.resolveMagnet: no detail url -> parse error', await rejects(() => ac.acgrip.resolveMagnet({ ...rows[0], detailUrl: undefined }, sig), 'parse'));
  seen.length = 0;
  const ur = await u3.u3c3.search('asian', 'adult', 1, sctx('https://u3.test'));
  check('u3c3.search: home page first for the token, then the search with it', ur.length > 0 && seen.length === 2 && seen[1] === 'https://u3.test/?search2=h4xxwbov&search=asian', seen.join(' | '));
  seen.length = 0;
  await u3.u3c3.search('asian', 'adult', 2, sctx('https://u3.test'));
  check('u3c3.search: page 2 adds p=2', seen.at(-1) === 'https://u3.test/?p=2&search2=h4xxwbov&search=asian', seen.at(-1));
  seen.length = 0;
  check('u3c3.search: hideAdult -> [] with no request', (await u3.u3c3.search('asian', 'adult', 1, sctx('https://u3.test', { hideAdult: true }))).length === 0 && seen.length === 0);

  console.log('\n[5] registration flags');
  const A = ac.acgrip;
  check('acgrip: flags', A.id === 'acgrip' && A.enabledByDefault === false && A.nsfw === false && !A.unsafeReason && A.method === 'rss' && A.categories.length === 1 && A.categories[0] === 'anime' && typeof A.resolveMagnet === 'function' && A.mirrors[0] === 'https://acg.rip');
  const U = u3.u3c3;
  check('u3c3: flags', U.id === 'u3c3' && U.enabledByDefault === false && U.nsfw === true && U.categories.length === 1 && U.categories[0] === 'adult' && U.method === 'html' && U.mirrors.length >= 1 && U.canPage === true);
  check('abbr set and distinct', A.abbr && U.abbr && A.abbr !== U.abbr && A.name && U.name);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
