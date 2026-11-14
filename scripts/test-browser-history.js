#!/usr/bin/env node
// Browser history (NATIVE_CONTRACT 24.9): store logic over node:sqlite, prefs, index wiring, and static checks on the Kotlin.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const root = path.join(__dirname, '..');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Native-only packages are stubbed so the modules load in Node.
const kv = new Map();
const wipeCalls = [];
globalThis.__kv = kv;
globalThis.__wipeCalls = wipeCalls;
globalThis.__openDb = null; // set per test: () => node:sqlite DatabaseSync
const stubs = {
  'expo-sqlite/kv-store': `export default { getItemSync: (k) => globalThis.__kv.has(k) ? globalThis.__kv.get(k) : null, setItemSync: (k, v) => { globalThis.__kv.set(k, v); } };`,
  'expo-sqlite': `export async function openDatabaseAsync(name) {
    const d = globalThis.__openDb();
    return {
      name,
      execAsync: async (sql) => { d.exec(sql); },
      runAsync: async (sql, params = []) => { const r = d.prepare(sql).run(...params); return { changes: Number(r.changes) }; },
      getAllAsync: async (sql, params = []) => d.prepare(sql).all(...params),
    };
  }`,
  'maglev-engine': `export const setHistoryWipeOnClose = async (v) => { globalThis.__wipeCalls.push(v); };`,
  react: `export const useSyncExternalStore = () => 0;`,
};
require('node:module').registerHooks({
  resolve(spec, ctx, next) {
    if (stubs[spec]) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[spec]), shortCircuit: true, format: 'module' };
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') && !/\.\w+(\?.*)?$/.test(spec)) return next(spec + '.ts', ctx);
      throw e;
    }
  },
});

function nodeDb() {
  const d = new DatabaseSync(':memory:');
  return {
    raw: d,
    exec: async (sql) => { d.exec(sql); },
    run: async (sql, params = []) => ({ changes: Number(d.prepare(sql).run(...params).changes) }),
    all: async (sql, params = []) => d.prepare(sql).all(...params).map((r) => ({ ...r })),
  };
}

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const T0 = new Date(2026, 10, 14, 15, 30, 0).getTime(); // 14 Nov 2026, 15:30 local

async function main() {
  const { createHistoryStore } = await import('../utils/history/store.ts');
  const { defaultBrowserPrefs, normalizeBrowserPrefs } = await import('../utils/prefs/browser.ts');

  async function fresh(prefs = {}) {
    const db = nodeDb();
    const p = { saveHistory: true, suggestFromHistory: true, clearHistoryOnClose: false, ...prefs };
    const store = createHistoryStore(db, () => p);
    await store.init(T0);
    return { db, store, p };
  }
  const count = async (db) => (await db.all('SELECT COUNT(*) AS n FROM pages'))[0].n;

  console.log('prefs');
  const d = defaultBrowserPrefs();
  check('saveHistory defaults on', d.saveHistory === true);
  check('suggestFromHistory defaults on', d.suggestFromHistory === true);
  check('clearHistoryOnClose defaults off', d.clearHistoryOnClose === false);
  const n0 = normalizeBrowserPrefs({});
  check('normalize of {} gives the defaults', n0.saveHistory && n0.suggestFromHistory && !n0.clearHistoryOnClose);
  const n1 = normalizeBrowserPrefs({ saveHistory: false, suggestFromHistory: false, clearHistoryOnClose: true });
  check('normalize keeps the three values', !n1.saveHistory && !n1.suggestFromHistory && n1.clearHistoryOnClose);
  const n2 = normalizeBrowserPrefs({ saveHistory: 'no', suggestFromHistory: 0, clearHistoryOnClose: 'yes' });
  check('normalize ignores junk', n2.saveHistory === true && n2.suggestFromHistory === true && n2.clearHistoryOnClose === false);
  check('normalize of null is safe', normalizeBrowserPrefs(null).saveHistory === true);
  check('old saved prefs without the fields get the defaults', normalizeBrowserPrefs({ adBlock: false }).saveHistory === true);

  console.log('schema');
  {
    const { db } = await fresh();
    const cols = (await db.all('PRAGMA table_info(pages)')).map((c) => c.name).join(',');
    check('pages has the spec columns', cols === 'url,title,host,first_visited,last_visited,visits', cols);
    const idx = (await db.all("SELECT name FROM sqlite_master WHERE type='index'")).map((r) => r.name);
    check('both indexes exist', idx.includes('pages_last') && idx.includes('pages_host'));
  }

  console.log('recording rules');
  {
    const { db, store, p } = await fresh();
    check('first visit is saved', (await store.recordVisit({ url: 'https://www.Example.com/a?x=1#frag', title: 'A' }, T0)) === 'saved');
    let rows = await db.all('SELECT * FROM pages');
    check('fragment removed from the stored url', rows[0].url === 'https://www.Example.com/a?x=1');
    check('host is lower case without www', rows[0].host === 'example.com');
    check('visits starts at 1 with both times set', rows[0].visits === 1 && rows[0].first_visited === T0 && rows[0].last_visited === T0);

    check('same address again updates the title only', (await store.recordVisit({ url: 'https://www.Example.com/a?x=1', title: 'A2' }, T0 + 1000)) === 'title');
    rows = await db.all('SELECT * FROM pages');
    check('title updated, visits and time unchanged', rows[0].title === 'A2' && rows[0].visits === 1 && rows[0].last_visited === T0);
    check('fragment-only change is the same page', (await store.recordVisit({ url: 'https://www.Example.com/a?x=1#other', title: 'A2' }, T0 + 2000)) === 'title');
    check('an empty title does not erase the title', (await store.recordVisit({ url: 'https://www.Example.com/a?x=1', title: '' }, T0 + 3000)) === 'title' && (await db.all('SELECT title FROM pages'))[0].title === 'A2');

    check('a different page is saved', (await store.recordVisit({ url: 'https://other.org/', title: 'O' }, T0 + 4000)) === 'saved');
    check('going back to the first page is a new visit', (await store.recordVisit({ url: 'https://www.Example.com/a?x=1', title: 'A3' }, T0 + 5000)) === 'saved');
    rows = await db.all("SELECT * FROM pages WHERE host='example.com'");
    check('visits counted, time moved, first visit kept, one row', rows.length === 1 && rows[0].visits === 2 && rows[0].last_visited === T0 + 5000 && rows[0].first_visited === T0 && rows[0].title === 'A3');
    check('a page with no title is saved with an empty title', (await store.recordVisit({ url: 'http://notitle.net/x', title: '' }, T0 + 6000)) === 'saved' && (await db.all("SELECT title FROM pages WHERE host='notitle.net'"))[0].title === '');
    await store.recordVisit({ url: 'http://notitle.net/x', title: 'Late title' }, T0 + 6100);
    check('a title that arrives after the load fills the empty one', (await db.all("SELECT title, visits FROM pages WHERE host='notitle.net'"))[0].title === 'Late title');

    for (const bad of ['about:blank', 'data:text/html,hi', 'blob:https://a.com/1', 'file:///sdcard/a.html', '', 'javascript:alert(1)', 'ftp://a.com/', 'content://x/y', 'intent://x', 'magnet:?xt=urn:btih:abc', 'https://', 'not a url']) {
      check(`skips ${JSON.stringify(bad)}`, (await store.recordVisit({ url: bad, title: 't' }, T0 + 7000)) === 'skipped');
    }
    const before = await count(db);
    p.saveHistory = false;
    check('skips when saveHistory is off', (await store.recordVisit({ url: 'https://new.example/', title: 'n' }, T0 + 8000)) === 'skipped' && (await count(db)) === before);
    p.saveHistory = true;
    check('records again when it is back on', (await store.recordVisit({ url: 'https://new.example/', title: 'n' }, T0 + 9000)) === 'saved');
    check('uppercase scheme and a port still work', (await store.recordVisit({ url: 'HTTPS://User@Host.Example:8080/p', title: 'p' }, T0 + 9500)) === 'saved' && (await db.all("SELECT host FROM pages WHERE url LIKE '%8080%'"))[0].host === 'host.example');
  }

  console.log('listeners');
  {
    const { store } = await fresh();
    let calls = 0;
    const off = store.subscribe(() => { calls++; });
    const v0 = store.version();
    await store.recordVisit({ url: 'https://a.com/', title: 'a' }, T0);
    check('told after a save', calls === 1 && store.version() > v0);
    await store.recordVisit({ url: 'https://a.com/', title: 'a2' }, T0 + 1);
    check('told after a title update', calls === 2);
    await store.recordVisit({ url: 'about:blank', title: '' }, T0 + 2);
    check('not told after a skip', calls === 2);
    await store.removePages(['https://a.com/']);
    check('told after remove', calls === 3);
    await store.restorePages([]);
    await store.recordVisit({ url: 'https://c.com/', title: 'c' }, T0 + 4);
    const c0 = calls;
    await store.clearRange('all', T0);
    check('told after clear', calls === c0 + 1);
    check('told after clear', calls >= 4);
    off();
    const c = calls;
    await store.recordVisit({ url: 'https://b.com/', title: 'b' }, T0 + 3);
    check('unsubscribe stops it', calls === c);
  }

  console.log('listHistory');
  {
    const { store } = await fresh();
    for (let i = 0; i < 250; i++) await store.recordVisit({ url: `https://site${i % 7}.com/p${i}`, title: i % 2 ? `Odd ${i}` : `Even ${i}` }, T0 + i * 1000);
    const first = await store.list({});
    check('default limit is 100', first.length === 100);
    check('newest first', first[0].lastVisited > first[99].lastVisited && first[0].url.endsWith('/p249'));
    const second = await store.list({ before: first[99] });
    check('before pages backwards without overlap', second.length === 100 && second[0].lastVisited < first[99].lastVisited);
    const third = await store.list({ before: second[99] });
    check('last page has the rest', third.length === 50);
    const byNumber = await store.list({ before: first[99].lastVisited, limit: 5 });
    check('before accepts a time and limit applies', byNumber.length === 5 && byNumber[0].lastVisited < first[99].lastVisited);
    const q = await store.list({ query: 'odd 24' });
    check('query matches the title, case-insensitive', q.length > 0 && q.every((e) => /odd 24/i.test(e.title)));
    const qu = await store.list({ query: 'site3.com/p3' });
    check('query matches the address', qu.length > 0 && qu.every((e) => e.url.includes('site3.com/p3')));
    check('percent in a query is literal', (await store.list({ query: '%' })).length === 0);
    check('underscore in a query is literal', (await store.list({ query: '_' })).length === 0);
    check('entries have the typed shape', typeof first[0].firstVisited === 'number' && typeof first[0].visits === 'number' && typeof first[0].host === 'string');
  }

  console.log('suggestions');
  {
    const { store, p } = await fresh();
    const v = (url, title, n, t) => (async () => { for (let i = 0; i < n; i++) { await store.recordVisit({ url: 'https://zz-sep.test/', title: '' }, t); await store.recordVisit({ url, title }, t + i); } })();
    await v('https://news.example.com/world', 'World news', 3, T0);
    await v('https://example.org/', 'Example', 1, T0 + HOUR);
    await v('https://blog.other.net/example-post', 'An example post', 5, T0 + 2 * HOUR);
    await v('https://www.example.net/a', 'Net', 5, T0 + 3 * HOUR);
    await v('https://www.example.net/b', 'Net b', 5, T0 + 4 * HOUR);
    await v('https://exampleshop.io/', 'Shop', 2, T0 + 5 * HOUR);
    const s = await store.suggest('Example ');
    check('trimmed and lower-cased', s.length > 0);
    check('host-starts-with first, then visits desc, then newest', s.map((e) => e.url).join('|') === [
      'https://www.example.net/b', 'https://www.example.net/a', 'https://exampleshop.io/', 'https://example.org/',
      'https://blog.other.net/example-post', 'https://news.example.com/world',
    ].join('|'), s.map((e) => e.url).join('|'));
    check('empty text gives nothing', (await store.suggest('')).length === 0 && (await store.suggest('   ')).length === 0);
    check('scheme text is not matched', (await store.suggest('https')).length === 0);
    check('www. is not matched as part of the address', (await store.suggest('www.')).length === 0);
    check('title matches count', (await store.suggest('world news')).length === 1);
    for (let i = 0; i < 12; i++) await store.recordVisit({ url: `https://cap${i}.dev/`, title: 'cap' }, T0 + 10 * HOUR + i);
    check('capped at 6', (await store.suggest('cap')).length === 6);
    check('limit parameter works', (await store.suggest('cap', 3)).length === 3);
    check('a partial address still finds it', (await store.suggest('example.or')).some((e) => e.url === 'https://example.org/'));
    check('the exact address typed is excluded', (await store.suggest('example.org')).length === 0 && (await store.suggest('https://www.example.org/')).length === 0 && (await store.suggest('example.org/')).length === 0);
    p.suggestFromHistory = false;
    check('nothing when suggestFromHistory is off', (await store.suggest('example')).length === 0);
  }

  console.log('removing and restoring');
  {
    const { db, store } = await fresh();
    await store.recordVisit({ url: 'https://a.com/1', title: 'A1' }, T0);
    await store.recordVisit({ url: 'https://a.com/2', title: 'A2' }, T0 + 1000);
    await store.recordVisit({ url: 'https://www.a.com/1', title: 'A1 www' }, T0 + 2000);
    await store.recordVisit({ url: 'https://a.com/2', title: 'A2' }, T0 + 3000);
    await store.recordVisit({ url: 'https://b.com/', title: 'B' }, T0 + 4000);
    const snapshot = await db.all('SELECT * FROM pages ORDER BY url');
    const gone = await store.removePages(['https://a.com/1', 'https://nothere.com/']);
    check('removePages returns the removed rows only', gone.length === 1 && gone[0].url === 'https://a.com/1' && gone[0].title === 'A1');
    check('and removes them', (await count(db)) === snapshot.length - 1);
    await store.restorePages(gone);
    check('restorePages round-trips exactly (page)', JSON.stringify(await db.all('SELECT * FROM pages ORDER BY url')) === JSON.stringify(snapshot));
    const hostRows = await store.removeHost('WWW.A.com');
    check('removeHost removes every address of the host, www or not', hostRows.length === 3 && (await count(db)) === 1);
    check('removeHost returns full rows (visits kept)', hostRows.some((r) => r.url === 'https://a.com/2' && r.visits === 2));
    await store.restorePages(hostRows);
    check('removeHost round-trips exactly', JSON.stringify(await db.all('SELECT * FROM pages ORDER BY url')) === JSON.stringify(snapshot));
    await store.restorePages(hostRows);
    check('restoring twice does not duplicate', (await count(db)) === snapshot.length);
    const big = [];
    for (let i = 0; i < 1200; i++) big.push(`https://bulk.com/${i}`);
    for (const u of big) await db.run('INSERT INTO pages VALUES (?,?,?,?,?,?)', [u, '', 'bulk.com', T0, T0, 1]);
    check('removePages handles more urls than one statement takes', (await store.removePages(big)).length === 1200);
  }

  console.log('clearing ranges');
  {
    const midnight = new Date(2026, 10, 14, 0, 0, 0, 0).getTime();
    const seed = async () => {
      const f = await fresh();
      const at = { h: T0 - 30 * MIN, edgeH: T0 - HOUR, justOverH: T0 - HOUR - 1, today: midnight + 1, beforeMid: midnight - 1, week: T0 - 6 * DAY, overWeek: T0 - 8 * DAY };
      let i = 0;
      for (const [k, t] of Object.entries(at)) { await f.store.recordVisit({ url: `https://${k}.com/`, title: k }, t); i++; }
      return f;
    };
    const left = async (db) => (await db.all('SELECT title FROM pages ORDER BY title')).map((r) => r.title).join(',');
    let f = await seed();
    check('hour: removes the last 60 minutes (inclusive of the edge)', (await f.store.clearRange('hour', T0)) === 2 && (await left(f.db)) === 'beforeMid,justOverH,overWeek,today,week'.split(',').sort().join(','), await left(f.db));
    f = await seed();
    check('today: removes since local midnight', (await f.store.clearRange('today', T0)) === 4 && (await left(f.db)) === 'beforeMid,overWeek,week'.split(',').sort().join(','), await left(f.db));
    f = await seed();
    check('week: removes the last 7 days', (await f.store.clearRange('week', T0)) === 6 && (await left(f.db)) === 'overWeek', await left(f.db));
    f = await seed();
    check('all: removes everything and returns the count', (await f.store.clearRange('all', T0)) === 7 && (await count(f.db)) === 0);
    f = await seed();
    await f.store.recordVisit({ url: 'https://today.com/', title: 'today' }, T0 + 10);
    check('range uses the last visit, not the first', (await f.store.clearRange('hour', T0 + 20)) >= 1 && !(await left(f.db)).includes('today'));
  }

  console.log('retention');
  {
    const { db, store } = await fresh();
    const ins = db.raw.prepare('INSERT INTO pages VALUES (?,?,?,?,?,?)');
    db.raw.exec('BEGIN');
    for (let i = 0; i < 100; i++) ins.run(`https://old.com/${i}`, '', 'old.com', T0 - 91 * DAY, T0 - 91 * DAY - i, 1);
    ins.run('https://edge.com/', '', 'edge.com', T0 - 90 * DAY, T0 - 90 * DAY, 1);
    ins.run('https://justold.com/', '', 'justold.com', T0 - 90 * DAY - 1, T0 - 90 * DAY - 1, 1);
    for (let i = 0; i < 10_050; i++) ins.run(`https://many.com/${i}`, '', 'many.com', T0 - i * 1000, T0 - i * 1000 - 1, 1);
    db.raw.exec('COMMIT');
    let calls = 0;
    store.subscribe(() => { calls++; });
    await store.prune(T0);
    check('rows older than 90 days go', (await db.all("SELECT 1 FROM pages WHERE host='old.com' OR host='justold.com'")).length === 0);
    check('only the newest 10,000 rows stay', (await count(db)) === 10_000, String(await count(db)));
    const oldest = (await db.all('SELECT MIN(last_visited) AS m FROM pages'))[0].m;
    const keptNewest = (await db.all("SELECT 1 FROM pages WHERE url='https://many.com/0'")).length === 1;
    check('the newest rows are the ones kept', keptNewest && oldest > T0 - 10_100 * 1000);
    check('pruning tells the listeners', calls === 1);
    await store.prune(T0);
    check('pruning again changes nothing and stays quiet', (await count(db)) === 10_000 && calls === 1);
  }
  {
    // Pruning also runs after every 50th save.
    const { db, store } = await fresh();
    db.raw.prepare('INSERT INTO pages VALUES (?,?,?,?,?,?)').run('https://ancient.com/', '', 'ancient.com', T0 - 200 * DAY, T0 - 200 * DAY, 1);
    for (let i = 0; i < 49; i++) await store.recordVisit({ url: `https://s.com/${i}`, title: '' }, T0 + i);
    check('not pruned before the 50th save', (await db.all("SELECT 1 FROM pages WHERE host='ancient.com'")).length === 1);
    await store.recordVisit({ url: 'https://s.com/49', title: '' }, T0 + 49);
    check('pruned on the 50th save', (await db.all("SELECT 1 FROM pages WHERE host='ancient.com'")).length === 0);
    await db.run("INSERT INTO pages VALUES ('https://ancient2.com/', '', 'ancient2.com', ?, ?, 1)", [T0 - 200 * DAY, T0 - 200 * DAY]);
    for (let i = 0; i < 5; i++) await store.recordVisit({ url: 'https://s.com/49', title: 'same page ' + i }, T0 + 50 + i);
    check('title updates do not count as saves', (await db.all("SELECT 1 FROM pages WHERE host='ancient2.com'")).length === 1);
  }

  console.log('init and clear on close');
  {
    const db = nodeDb();
    const p = { saveHistory: true, suggestFromHistory: true, clearHistoryOnClose: false };
    const s1 = createHistoryStore(db, () => p);
    await s1.init(T0);
    await s1.recordVisit({ url: 'https://keep.com/', title: 'k' }, T0);
    const s2 = createHistoryStore(db, () => p);
    await s2.init(T0 + 1000);
    check('cold start with the setting off keeps history', (await count(db)) === 1);
    p.clearHistoryOnClose = true;
    const s3 = createHistoryStore(db, () => p);
    await s3.init(T0 + 2000);
    check('cold start with the setting on empties the table', (await count(db)) === 0);
    await s3.recordVisit({ url: 'https://new.com/', title: 'n' }, T0 + 3000);
    await s3.init(T0 + 4000);
    check('init is idempotent: a second call does not wipe again', (await count(db)) === 1);
    check('a store never read before init rejects nothing and lists after init', (await s3.list({})).length === 1);
  }

  console.log('index (public API wiring)');
  {
    kv.clear();
    wipeCalls.length = 0;
    let raw = null;
    globalThis.__openDb = () => (raw = new DatabaseSync(':memory:'));
    const idx = await import('../utils/history/index.ts');
    const prefsMod = await import('../utils/prefs/browser.ts');
    for (const name of ['initHistory', 'recordVisit', 'listHistory', 'suggestHistory', 'removePages', 'removeHost', 'restorePages', 'clearHistoryRange', 'subscribeHistory', 'useHistoryVersion']) {
      check(`exports ${name}`, typeof idx[name] === 'function');
    }
    await idx.initHistory(T0);
    check('initHistory tells native the wipe flag (off)', wipeCalls.length === 1 && wipeCalls[0] === false);
    check('record goes through', (await idx.recordVisit({ url: 'https://a.com/', title: 'a' }, T0)) === 'saved' && (await idx.listHistory({})).length === 1);
    prefsMod.updateBrowserPrefs({ clearHistoryOnClose: true });
    check('turning the setting on calls native again', wipeCalls.length === 2 && wipeCalls[1] === true);
    prefsMod.updateBrowserPrefs({ desktopMode: true });
    check('unrelated pref changes do not call native', wipeCalls.length === 2);
    prefsMod.updateBrowserPrefs({ clearHistoryOnClose: false });
    check('turning it off calls native', wipeCalls.length === 3 && wipeCalls[2] === false);
    await idx.initHistory(T0 + 1);
    check('initHistory twice does not subscribe twice', (prefsMod.updateBrowserPrefs({ clearHistoryOnClose: true }), wipeCalls.filter((x) => x === true).length === 2));
    prefsMod.updateBrowserPrefs({ clearHistoryOnClose: false });
    check('removePages and clearHistoryRange work through the index', (await idx.removePages(['https://a.com/'])).length === 1 && (await idx.clearHistoryRange('all', T0)) === 0);
  }
  {
    // Cold start with the setting on empties the table (module state is fresh per query string).
    kv.clear();
    wipeCalls.length = 0;
    (await import('../utils/prefs/browser.ts')).updateBrowserPrefs({ clearHistoryOnClose: true });
    wipeCalls.length = 0;
    const shared = new DatabaseSync(':memory:');
    shared.exec('CREATE TABLE pages (url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT \'\', host TEXT NOT NULL, first_visited INTEGER NOT NULL, last_visited INTEGER NOT NULL, visits INTEGER NOT NULL DEFAULT 1)');
    shared.prepare('INSERT INTO pages VALUES (?,?,?,?,?,?)').run('https://x.com/', 'x', 'x.com', T0, T0, 1);
    globalThis.__openDb = () => shared;
    const idx = await import('../utils/history/index.ts?cold');
    await idx.initHistory(T0 + 5);
    check('initHistory wipes when clearHistoryOnClose is on', shared.prepare('SELECT COUNT(*) AS n FROM pages').get().n === 0);
    check('and sends the flag as on', wipeCalls.length > 0 && wipeCalls.every((x) => x === true));
  }
  {
    // Database cannot open: every call degrades as the spec says.
    kv.clear();
    wipeCalls.length = 0;
    globalThis.__openDb = () => { throw new Error('disk full'); };
    const idx = await import('../utils/history/index.ts?broken');
    await idx.initHistory(T0);
    check('initHistory does not throw when the database cannot open', true);
    check('recording is a no-op', (await idx.recordVisit({ url: 'https://a.com/', title: 'a' }, T0)) === 'skipped');
    check('suggestions are empty', (await idx.suggestHistory('a')).length === 0);
    let threw = false;
    try { await idx.listHistory({}); } catch { threw = true; }
    check('listing fails so the screen can show Retry', threw);
    check('the wipe flag still reaches native', wipeCalls.length >= 1);
    globalThis.__openDb = () => new DatabaseSync(':memory:');
    await idx.initHistory(T0 + 1);
    check('Retry works once the database opens', Array.isArray(await idx.listHistory({})));
  }

  console.log('Kotlin and bridge (static)');
  const kt = 'modules/maglev-engine/android/src/main/java/com/maglev/engine/';
  const wipe = read(kt + 'browser/HistoryWipe.kt');
  const svc = read(kt + 'service/MaglevTorrentService.kt');
  const mod = read(kt + 'MaglevEngineModule.kt');
  const data = read(kt + 'browser/BrowserData.kt');
  const view = read(kt + 'browser/MaglevBrowserView.kt');
  const wrapper = read('modules/maglev-engine/src/MaglevBrowser.tsx');
  check('HistoryWipe deletes from pages', /DELETE FROM pages/.test(wipe));
  check('HistoryWipe opens read-write without creating', /OPEN_READWRITE/.test(wipe) && !/CREATE_IF_NECESSARY/.test(wipe));
  check('HistoryWipe uses the expo-sqlite folder and file name', /"SQLite"/.test(wipe) && /maglev-history\.db/.test(wipe));
  check('HistoryWipe keeps the flag in maglev.history / wipeOnClose', /maglev\.history/.test(wipe) && /wipeOnClose/.test(wipe));
  check('HistoryWipe exposes wipeIfArmed(context)', /fun wipeIfArmed\(context: Context\)/.test(wipe));
  check('HistoryWipe ignores errors', /catch \(_: Throwable\)|catch \(_: Exception\)/.test(wipe));
  check('service onTaskRemoved calls wipeIfArmed', /override fun onTaskRemoved[\s\S]*?HistoryWipe\.wipeIfArmed/.test(svc));
  check('service still calls super.onTaskRemoved', /super\.onTaskRemoved/.test(svc));
  check('module registers setHistoryWipeOnClose', /AsyncFunction\("setHistoryWipeOnClose"\)/.test(mod));
  check('module wipes when the activity is finishing', /OnActivityDestroys[\s\S]{0,200}isFinishing[\s\S]{0,200}HistoryWipe/.test(mod));
  check('clearBrowserData takes options', /AsyncFunction\("clearBrowserData"\)\s*\{\s*options:/.test(mod));
  check('view clearData takes options', /AsyncFunction\("clearData"\)\s*\{\s*view: MaglevBrowserView,\s*options/.test(mod));
  check('BrowserData.clear takes cookies and cache flags', /cookies: Boolean/.test(data) && /cache: Boolean/.test(data));
  check('BrowserData no longer clears history', !/clearHistory\(/.test(data));
  check('the view can clear its back/forward list', /fun clearHistoryList\(|fun clearNavigationHistory\(/.test(view) && /clearHistory\(\)/.test(view));
  check('TS wrapper exports setHistoryWipeOnClose', /export (async )?(const|function) setHistoryWipeOnClose/.test(wrapper));
  check('TS clearBrowserData takes cookies and cache', /clearBrowserData = \([^)]*cookies[^)]*cache/.test(wrapper) || /clearBrowserData = async \([^)]*cookies[^)]*cache/.test(wrapper));
  check('TS view clearData takes cookies and cache', /BrowserClearOptions = \{ cookies: boolean; cache: boolean \}/.test(wrapper) && /clearData\(options: BrowserClearOptions\)/.test(wrapper));

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
