#!/usr/bin/env node
// Tests for the Project Gutenberg and LibriVox providers (direct-file results, SEARCH_CONTRACT section 9).
// No network: fixtures are recorded responses, see scripts/fixtures/search/{gutenberg,librivox}_SOURCES.txt.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).

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
const throwsParse = (fn) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e && e.name === 'ProviderError' && e.kind === 'parse';
  }
};
const ctx = (category = 'all', over = {}) => ({ baseUrl: 'https://www.gutenberg.org', category, hideAdult: true, limit: 50, ...over });
const direct = (r, id) =>
  r.providerId === id && r.magnet === '' && r.infoHash.startsWith(`${id}:`) && /^https:\/\/[^\s]+$/.test(r.directUrl) && r.category === 'books';

async function main() {
  const pg = await import('../utils/search/providers/gutenberg.ts');
  const lv = await import('../utils/search/providers/librivox.ts');

  console.log('gutenberg');
  const g = pg.parse(fx('gutenberg_search.xml'), ctx());
  check('parses the book rows', g.length >= 4, `n=${g.length}`);
  check('every row is a direct result', g.every((r) => direct(r, 'gutenberg')));
  const austen = g.find((r) => r.infoHash === 'gutenberg:1342');
  check('Pride and Prejudice is there with its author', !!austen && austen.name === 'Pride and Prejudice - Jane Austen', austen && austen.name);
  check('directUrl is the EPUB3 with images', austen && austen.directUrl === 'https://www.gutenberg.org/ebooks/1342.epub3.images');
  check('detailUrl is the book page', austen && austen.detailUrl === 'https://www.gutenberg.org/ebooks/1342');
  check('no fabricated size or seeders', g.every((r) => r.sizeBytes === undefined && r.seeders === undefined));
  check('ids are unique', new Set(g.map((r) => r.infoHash)).size === g.length);
  check('empty result', pg.parse(fx('gutenberg_empty.xml'), ctx()).length === 0);
  check('limit', pg.parse(fx('gutenberg_search.xml'), ctx('all', { limit: 2 })).length === 2);
  check('hideAdult does not matter', pg.parse(fx('gutenberg_search.xml'), ctx('all', { hideAdult: false })).length === g.length);
  check('malformed body -> parse error', throwsParse(() => pg.parse('<html>nope</html>', ctx())));
  check('empty body -> parse error', throwsParse(() => pg.parse('', ctx())));
  const gp = pg.gutenberg;
  check('registration flags', gp.id === 'gutenberg' && gp.enabledByDefault === true && gp.nsfw === false && gp.unsafeReason === undefined);
  check('books only', gp.categories.length === 1 && gp.categories[0] === 'books');
  check('mirrors are https', gp.mirrors.every((m) => m.startsWith('https://')));
  const ac = new AbortController();
  check('search outside books makes no request', (await gp.search('pride', 'movies', 1, { baseUrl: 'http://127.0.0.1:1', signal: ac.signal, hideAdult: true, limit: 5 })).length === 0);
  check('blank query makes no request', (await gp.search('  ', 'books', 1, { baseUrl: 'http://127.0.0.1:1', signal: ac.signal, hideAdult: true, limit: 5 })).length === 0);

  console.log('librivox');
  const lctx = (category = 'all', over = {}) => ({ baseUrl: 'https://librivox.org', category, hideAdult: true, limit: 50, ...over });
  const t = lv.parse(fx('librivox_title.json'), lctx());
  check('books without a zip are skipped', t.length === 1, `n=${t.length}`);
  check('direct result', t.every((r) => direct(r, 'librivox')));
  check('name has title, author and audiobook', t[0].name === 'Pride and Prejudice - Jane Austen (audiobook)', t[0].name);
  check('directUrl is the archive.org zip, spaces encoded', t[0].directUrl.startsWith('https://archive.org/compress/pride_and_prejudice_librivox/') && !/\s/.test(t[0].directUrl), t[0].directUrl);
  check('detailUrl is the LibriVox page', t[0].detailUrl === 'https://librivox.org/pride-and-prejudice-by-jane-austen/');
  const a = lv.parse(fx('librivox_author.json'), lctx());
  check('author search parses', a.length === 3 && a.every((r) => direct(r, 'librivox')));
  check('empty 404 body is zero results', lv.parse(fx('librivox_empty.json'), lctx()).length === 0);
  check('limit', lv.parse(fx('librivox_author.json'), lctx('all', { limit: 1 })).length === 1);
  check('non-https zip is dropped', lv.parse(JSON.stringify({ books: [{ id: '1', title: 'x', url_zip_file: 'http://a/b.zip' }] }), lctx()).length === 0);
  check('malformed body -> parse error', throwsParse(() => lv.parse('not json', lctx())));
  check('wrong shape -> parse error', throwsParse(() => lv.parse('{"x":1}', lctx())));
  const lp = lv.librivox;
  check('registration flags', lp.id === 'librivox' && lp.enabledByDefault === true && lp.nsfw === false && lp.unsafeReason === undefined);
  check('books only', lp.categories.length === 1 && lp.categories[0] === 'books');
  check('search outside books makes no request', (await lp.search('emma', 'tv', 1, { baseUrl: 'http://127.0.0.1:1', signal: ac.signal, hideAdult: true, limit: 5 })).length === 0);

  // A 404 from the API is zero results, not an error; other failures still throw.
  const realFetch = globalThis.fetch;
  const reply = (status, body) => async () => new Response(body, { status, headers: { 'content-type': 'application/json' } });
  try {
    globalThis.fetch = reply(404, fx('librivox_empty.json'));
    const none = await lp.search('zzzqqqxx', 'books', 1, { baseUrl: 'https://librivox.org', signal: ac.signal, hideAdult: true, limit: 5 });
    check('HTTP 404 -> zero results', Array.isArray(none) && none.length === 0);
    globalThis.fetch = reply(500, 'oops');
    let kind = null;
    try {
      await lp.search('emma', 'books', 1, { baseUrl: 'https://librivox.org', signal: ac.signal, hideAdult: true, limit: 5 });
    } catch (e) {
      kind = e.kind;
    }
    check('HTTP 500 still throws', kind === 'http', String(kind));
    let n = 0;
    globalThis.fetch = async (url) => {
      n++;
      return new Response(fx(String(url).includes('author=') ? 'librivox_author.json' : 'librivox_title.json'), { status: 200 });
    };
    const both = await lp.search('pride and austen', 'books', 1, { baseUrl: 'https://librivox.org', signal: ac.signal, hideAdult: true, limit: 50 });
    check('title and author calls are merged without duplicates', n === 2 && both.length === 3 && new Set(both.map((r) => r.infoHash)).size === 3, `n=${n} len=${both.length}`);
  } finally {
    globalThis.fetch = realFetch;
  }

  {
    // A direct file over http (a mirror override) must stop with a message, never fall into the torrent path.
    const tab = fs.readFileSync(path.join(__dirname, '..', 'app', '(tabs)', 'search.tsx'), 'utf8');
    check('Search refuses an http direct file instead of adding it as a torrent', /if \(r\.directUrl && !r\.magnet\) \{[\s\S]{0,200}show\([\s\S]{0,120}return;/.test(tab));
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
