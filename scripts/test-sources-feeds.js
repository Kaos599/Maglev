#!/usr/bin/env node
// Tests for ShowRSS, DistroWatch and the TPB trusted-uploader filter. No network: fixtures are real captures
// (see scripts/fixtures/search/*_SOURCES.txt). Needs Node 22.18+.

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

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
const ctx = (category = 'all', over = {}) => ({ baseUrl: 'https://example.test', category, hideAdult: true, limit: 500, ...over });
const throwsParse = (fn) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e.name === 'ProviderError' && e.kind === 'parse';
  }
};

async function main() {
  // The prefs module imports expo storage; stub it as the other tests do.
  Module.registerHooks({
    resolve(spec, c, next) {
      if (spec === 'expo-sqlite/kv-store' || spec === 'expo-secure-store') return { url: `stub:${spec}`, shortCircuit: true, format: 'commonjs' };
      return next(spec, c);
    },
    load(url, c, next) {
      if (url.startsWith('stub:')) {
        return { format: 'commonjs', shortCircuit: true, source: 'module.exports = { default: { getItemSync: () => null, setItemSync() {} }, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} };' };
      }
      return next(url, c);
    },
  });
  const sr = await import('../utils/search/providers/showrss.ts');
  const dw = await import('../utils/search/providers/distrowatch.ts');
  const tpb = await import('../utils/search/providers/tpb.ts');
  const prefs = await import('../utils/prefs/search.ts');

  console.log('\n[1] showrss');
  const feed = fx('showrss_all.xml');
  const rows = sr.parse(feed, ctx());
  check('parses 100 items', rows.length === 100, String(rows.length));
  check('hash, magnet and name valid', rows.every((r) => HEX40.test(r.infoHash) && r.magnet.startsWith('magnet:?xt=urn:btih:') && r.magnet.toLowerCase().includes(r.infoHash) && r.name));
  check('category tv, dated', rows.every((r) => r.category === 'tv' && r.publishedAt > 0));
  check('limit', sr.parse(feed, ctx('all', { limit: 7 })).length === 7);
  check('empty feed -> []', sr.parse('<rss version="2.0"><channel></channel></rss>', ctx()).length === 0);
  check('malformed -> parse error', throwsParse(() => sr.parse('<html>oops</html>', ctx())));
  const parsedFeed = sr.parseFeed(feed);
  const first = parsedFeed[0];
  const word = (first.haystack.match(/[A-Za-z]{4,}/g) || [])[0];
  const hits = sr.filterFeed(parsedFeed, word.toUpperCase(), 50);
  check('filter finds a title word, case-insensitive', hits.length >= 1 && hits.some((r) => r.infoHash === first.infoHash), word);
  check('filter ignores punctuation and accents', sr.filterFeed(parsedFeed, '90 day fiance: the-other way', 50).length >= 1);
  check('filter requires every token', sr.filterFeed(parsedFeed, `${word} zzzzqqqq`, 50).length === 0);
  check('empty query matches nothing', sr.filterFeed(parsedFeed, '  !! ', 50).length === 0);
  check('filter respects limit', sr.filterFeed(parsedFeed, '1080p', 3).length <= 3);
  check('results carry no match haystack', !('haystack' in hits[0]));

  console.log('\n[2] showrss cache');
  let fetches = 0;
  const realFetch = global.fetch;
  global.fetch = async () => {
    fetches++;
    return new Response(feed, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  };
  const sig = new AbortController().signal;
  const sctx = { baseUrl: 'https://example.test', signal: sig, hideAdult: true, limit: 50 };
  sr.resetCache();
  const r1 = await sr.showrss.search(word, 'all', 1, sctx);
  await sr.showrss.search('1080p', 'tv', 1, sctx);
  check('second search does not refetch', fetches === 1 && r1.length >= 1, String(fetches));
  check('wrong category -> [] without fetching', (await sr.showrss.search(word, 'movies', 1, sctx)).length === 0 && fetches === 1);
  check('page 2 -> []', (await sr.showrss.search(word, 'all', 2, sctx)).length === 0);
  sr.resetCache();
  await sr.showrss.search(word, 'all', 1, sctx);
  check('refetches after the cache is cleared', fetches === 2);
  const realNow = Date.now;
  Date.now = () => realNow() + sr.CACHE_MS + 1000;
  await sr.showrss.search(word, 'all', 1, sctx);
  Date.now = realNow;
  check('refetches after the cache expires', fetches === 3);
  global.fetch = realFetch;

  console.log('\n[3] showrss flags');
  const p = sr.showrss;
  check('off by default, tv, rss, no nsfw', p.enabledByDefault === false && p.nsfw === false && p.method === 'rss' && p.categories.join() === 'tv' && p.id === 'showrss');

  console.log('\n[4] distrowatch');
  const list = fx('distrowatch_list.html');
  const drows = dw.parse(list, ctx());
  check('parses 196 torrents', drows.length === 196, String(drows.length));
  check('rows have stand-in hash, no magnet, name, date, detail page', drows.every((r) => r.magnet === '' && r.infoHash.startsWith('distrowatch:') && r.name && r.publishedAt > 0 && r.detailUrl?.startsWith('https://example.test/')));
  check('name has no .torrent suffix', drows.every((r) => !/\.torrent$/i.test(r.name)));
  check('category apps', drows.every((r) => r.category === 'apps'));
  check('limit', dw.parse(list, ctx('all', { limit: 5 })).length === 5);
  check('malformed -> parse error', throwsParse(() => dw.parse('<html>oops</html>', ctx())));
  check('empty table -> parse error (page layout changed)', throwsParse(() => dw.parse('<table></table>', ctx())));
  const lrows = dw.parseList(list);
  check('filter by project name', dw.filterList(lrows, 'FEDORA', 50).length >= 1 && dw.filterList(lrows, 'netbsd', 50).every((r) => /netbsd/i.test(r.name)));
  check('filter requires every token', dw.filterList(lrows, 'netbsd zzzzqqqq', 50).length === 0);
  check('filter limit', dw.filterList(lrows, 'iso', 4).length === 4);

  console.log('\n[5] distrowatch .torrent resolve');
  const bytes = fs.readFileSync(path.join(FIX, 'distrowatch_NetBSD.torrent'));
  const infoStart = bytes.indexOf('4:info') + 6;
  const expected = crypto.createHash('sha1').update(bytes.subarray(infoStart, bytes.length - 1)).digest('hex');
  const t = dw.readTorrent(new Uint8Array(bytes));
  check('info hash equals SHA-1 of the info dictionary', t.infoHash === expected, t.infoHash);
  check('announce read', t.announce === 'http://tracker.NetBSD.org:6969/announce');
  check('garbage -> parse error', throwsParse(() => dw.readTorrent(new Uint8Array([1, 2, 3]))));
  check('truncated -> parse error', throwsParse(() => dw.readTorrent(new Uint8Array(bytes.subarray(0, 200)))));
  for (const len of [0, 1, 55, 56, 63, 64, 65, 1000]) {
    const b = crypto.randomBytes(len);
    const tor = Buffer.concat([Buffer.from('d4:infod4:name'), Buffer.from(`${len}:`), b, Buffer.from('ee')]);
    const want = crypto.createHash('sha1').update(tor.subarray(7, tor.length - 1)).digest('hex');
    check(`sha1 correct for ${len}-byte payload`, dw.readTorrent(new Uint8Array(tor)).infoHash === want);
  }
  global.fetch = async (url) => new Response(bytes, { status: 200 });
  const target = drows.find((r) => /NetBSD/i.test(r.name));
  const res = await dw.distrowatch.resolveMagnet(target, sig);
  check('resolveMagnet gives real hash and magnet', res.infoHash === expected && res.magnet.includes(expected) && res.magnet.includes('tracker.NetBSD.org'));
  let bad = false;
  try {
    await dw.distrowatch.resolveMagnet({ ...target, infoHash: 'abc' }, sig);
  } catch (e) {
    bad = e.kind === 'parse';
  }
  check('resolveMagnet refuses a non-DistroWatch row', bad);
  global.fetch = async () => new Response('nope', { status: 404 });
  let http = false;
  try {
    await dw.distrowatch.resolveMagnet(target, sig);
  } catch (e) {
    http = e.kind === 'http';
  }
  check('resolveMagnet reports an http error', http);
  global.fetch = realFetch;
  const d = dw.distrowatch;
  check('flags: off by default, apps, html, not nsfw', d.enabledByDefault === false && d.nsfw === false && d.method === 'html' && d.categories.join() === 'apps' && typeof d.resolveMagnet === 'function');

  console.log('\n[6] tpb trusted uploaders');
  check('isTrustedUploader: trusted statuses', ['vip', 'trusted', 'helper', 'moderator', 'supermod', 'admin', 'VIP'].every(tpb.isTrustedUploader));
  check('isTrustedUploader: member, missing, junk are not', ['member', 'Member', '', undefined, null, 5].every((s) => !tpb.isTrustedUploader(s)));
  check('isTrustedUploader: a status the site adds later is not trusted', ['banned', 'suspended', 'newbie', 'vipp'].every((s) => !tpb.isTrustedUploader(s)));
  const body = fx('tpb_status_search.json');
  const all = tpb.parse(body, ctx());
  check('no trustedOnly keeps every row', all.length === 12, String(all.length));
  const trusted = tpb.parse(body, ctx('all', { trustedOnly: true }));
  check('trustedOnly drops member and status-less rows', trusted.length === 8, String(trusted.length));
  check('trustedOnly false keeps every row', tpb.parse(body, ctx('all', { trustedOnly: false })).length === 12);
  check('real feed (all vip/trusted) unchanged by trustedOnly', tpb.parse(fx('tpb.json'), ctx('all', { trustedOnly: true })).length === tpb.parse(fx('tpb.json'), ctx()).length);
  check('limit applies after the trusted filter', tpb.parse(body, ctx('all', { trustedOnly: true, limit: 3 })).length === 3);
  check('search passes ctx.trustedOnly to parse', /trustedOnly: ctx\.trustedOnly/.test(fs.readFileSync(path.join(__dirname, '..', 'utils/search/providers/tpb.ts'), 'utf8')));

  console.log('\n[7] pref');
  const norm = prefs.normalizeSearchPrefs;
  check('trustedUploadersOnly defaults to true', norm({}, []).trustedUploadersOnly === true && norm(null, []).trustedUploadersOnly === true);
  check('false round-trips', norm({ trustedUploadersOnly: false }, []).trustedUploadersOnly === false);
  check('junk normalizes to true', norm({ trustedUploadersOnly: 'no' }, []).trustedUploadersOnly === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
