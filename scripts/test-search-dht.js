#!/usr/bin/env node
// Tests for the DHT / meta search providers ported from TorrentSearch: Btsow, TorrentKitty, FileMood, 0Magnet.
// No network: fetch is mocked from recorded fixtures. Needs Node 22.18+ (runs the .ts sources directly).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'search');
const fx = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');

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

const HEX40 = /^[0-9a-f]{40}$/;
const validResult = (r) => HEX40.test(r.infoHash) && r.magnet.startsWith('magnet:?xt=urn:btih:') && r.magnet.toLowerCase().includes(r.infoHash) && r.name;

async function main() {
  const agg = await import('../utils/search/aggregate.ts');
  const bw = await import('../utils/search/providers/btsow.ts');
  const tk = await import('../utils/search/providers/torrentkitty.ts');
  const fm = await import('../utils/search/providers/filemood.ts');
  const zm = await import('../utils/search/providers/zeromagnet.ts');

  const ctx = (over = {}) => ({ baseUrl: 'https://example.test', category: 'all', hideAdult: true, limit: 50, ...over });

  console.log('\n[1] Btsow');
  const bwRows = bw.parse(fx('btsow_search.json'), ctx());
  check('btsow: fixture parses to valid results', bwRows.length >= 5 && bwRows.every(validResult), `got ${bwRows.length}`);
  check('btsow: <em> markers and zero-width spaces removed', bwRows.every((r) => !/<\/?em>|[​-‍]/.test(r.name)) && /^ubuntu-24\.04\.2-desktop-amd64\.iso$/.test(bwRows[0].name), bwRows[0].name);
  check('btsow: hash lowercased, size, category other, detail url', bwRows[0].infoHash === '611f70899d4e1d6a9c39cfc925f103dfef630328' && bwRows[0].sizeBytes === 6343219200 && bwRows[0].category === 'other' && bwRows[0].detailUrl === `https://example.test/magnet/detail/${bwRows[0].infoHash}`, JSON.stringify(bwRows[0]));
  check('btsow: no counts invented', bwRows.every((r) => r.seeders === undefined && r.leechers === undefined));
  check('btsow: empty data -> empty list', bw.parse(fx('btsow_empty.json'), ctx()).length === 0);
  check('btsow: limit respected', bw.parse(fx('btsow_search.json'), ctx({ limit: 2 })).length === 2);
  let bwErr = null;
  try {
    bw.parse('<html>oops</html>', ctx());
  } catch (e) {
    bwErr = e.kind;
  }
  check('btsow: garbage body -> typed error', bwErr === 'blocked' || bwErr === 'parse', String(bwErr));

  // The search request is a POST with the Kotlin payload shape [{"search": q}, limit, 1].
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(fx('btsow_search.json'), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const bwSearch = await bw.btsow.search('ubuntu', 'other', 1, { baseUrl: 'https://btsow.test', signal: new AbortController().signal, hideAdult: true, limit: 30 });
  check('btsow: search POSTs the JSON payload to /bts/data/api/search', bwSearch.length >= 5 && seen[0].url === 'https://btsow.test/bts/data/api/search' && seen[0].init.method === 'POST' && seen[0].init.body === '[{"search":"ubuntu"},30,1]', JSON.stringify(seen[0]));

  console.log('\n[2] TorrentKitty');
  const tkRows = tk.parse(fx('torrentkitty_search.html'), ctx({ baseUrl: 'https://www.torrentkitty.tv' }));
  check('torrentkitty: fixture parses to valid results', tkRows.length >= 15 && tkRows.every(validResult), `got ${tkRows.length}`);
  check('torrentkitty: first row name, hash, date, detail url', tkRows[0].name === 'ubuntu-26.04-live-server-amd64.iso' && tkRows[0].infoHash === 'e1fc140a6391357fa1cf08ddb70274f9c05eb88b' && tkRows[0].publishedAt === Date.UTC(2026, 6, 20) && tkRows[0].detailUrl === 'https://www.torrentkitty.tv/information/E1FC140A6391357FA1CF08DDB70274F9C05EB88B', JSON.stringify(tkRows[0]));
  check('torrentkitty: size parsed from "223.04 kb"', tkRows[0].sizeBytes === 223040, String(tkRows[0].sizeBytes));
  check('torrentkitty: source magnet kept with its trackers', tkRows[0].magnet.includes('&tr=') && tkRows[0].magnet.startsWith('magnet:?xt=urn:btih:E1FC'));
  check('torrentkitty: header row not a result', !tkRows.some((r) => /Torrent Description/.test(r.name)));
  check('torrentkitty: "No result" page -> empty list', tk.parse(fx('torrentkitty_empty.html'), ctx()).length === 0);

  console.log('\n[3] FileMood');
  const fmRows = fm.parse(fx('filemood_search.html'), ctx());
  check('filemood: fixture parses to valid results', fmRows.length >= 15 && fmRows.every(validResult), `got ${fmRows.length}`);
  check('filemood: name without highlight markup, hash from the link', fmRows[0].name === 'ubuntu-26.04.1-desktop-amd64.iso', fmRows[0].name);
  check('filemood: info hash from detail link', fmRows[0].infoHash === '5b1e0d988fc7a0c9e99bd852071681a59974b39f', fmRows[0].infoHash);
  check('filemood: seeders/peers from "1918/70", size from "6.5 GB"', fmRows[0].seeders === 1918 && fmRows[0].leechers === 70 && fmRows[0].sizeBytes === 6.5e9, JSON.stringify(fmRows[0]));
  check('filemood: spacer rows and ads are not results', fmRows.every((r) => r.name.length > 3 && r.category === 'other'));
  check('filemood: empty result page -> empty list', fm.parse(fx('filemood_empty.html'), ctx()).length === 0);

  console.log('\n[4] 0Magnet (adult, magnet on the detail page)');
  const zmAdult = ctx({ hideAdult: false, category: 'adult' });
  const zmRows = zm.parse(fx('zeromagnet_search.html'), zmAdult);
  check('0magnet: fixture parses to rows', zmRows.length >= 5, `got ${zmRows.length}`);
  check('0magnet: rows have no magnet and a stand-in key, never a fake hash', zmRows.every((r) => r.magnet === '' && r.infoHash.startsWith('zeromagnet:') && !HEX40.test(r.infoHash)));
  check('0magnet: name, size, date, detail url, adult', zmRows[0].name === 'Sample adult title 01.mp4' && zmRows[0].sizeBytes === Math.round(2.09 * 1e9) && zmRows[0].publishedAt === Date.UTC(2026, 10, 5) && zmRows[0].detailUrl === 'https://example.test/!m66T' && zmRows[0].category === 'adult', JSON.stringify(zmRows[0]));
  check('0magnet: hidden when adult is off', zm.parse(fx('zeromagnet_search.html'), ctx({ hideAdult: true })).length === 0);
  check('0magnet: empty result page -> empty list', zm.parse(fx('zeromagnet_empty.html'), zmAdult).length === 0);
  const zmm = zm.parseMagnet(fx('zeromagnet_detail.html'));
  check('0magnet: magnet and hash read from the detail page', zmm.infoHash === '1e97419e52f0c94511e4178f13ebe1f260af8b88' && zmm.magnet.startsWith('magnet:?xt=urn:btih:1e97419e') && zmm.magnet.includes('&dn='), JSON.stringify(zmm));
  let zmErr = null;
  try {
    zm.parseMagnet('<html><body>nothing here</body></html>');
  } catch (e) {
    zmErr = e.kind;
  }
  check('0magnet: detail page without a magnet -> parse error', zmErr === 'parse', String(zmErr));
  const detailSeen = [];
  globalThis.fetch = async (url) => {
    detailSeen.push(String(url));
    return new Response(fx('zeromagnet_detail.html'), { status: 200, headers: { 'content-type': 'text/html' } });
  };
  const zmDone = await agg.resolveResult({ ...zmRows[0], sources: ['zeromagnet'] }, new AbortController().signal);
  check('0magnet: resolveResult fetches detailUrl and sets magnet + real hash', detailSeen.length === 1 && detailSeen[0] === zmRows[0].detailUrl && zmDone.infoHash === zmm.infoHash && zmDone.magnet === zmm.magnet);

  console.log('\n[5] registration and flags');
  const ids = ['btsow', 'torrentkitty', 'filemood', 'zeromagnet'];
  const provs = ids.map((id) => agg.PROVIDERS.find((p) => p.id === id));
  check('all four registered', provs.every(Boolean));
  check('all off by default', provs.every((p) => p.enabledByDefault === false));
  check('all flagged as unmoderated DHT (unsafeReason set)', provs.every((p) => typeof p.unsafeReason === 'string' && p.unsafeReason.length > 20));
  check('0magnet is the only nsfw one, with the adult category only', provs.filter((p) => p.nsfw).map((p) => p.id).join() === 'zeromagnet' && JSON.stringify(provs[3].categories) === '["adult"]');
  check('the others take "other" only', provs.slice(0, 3).every((p) => JSON.stringify(p.categories) === '["other"]'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
