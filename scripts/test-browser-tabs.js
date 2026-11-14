#!/usr/bin/env node
// Browser tabs and pop-ups (NATIVE_CONTRACT 24.10): pure state machines T1, T2, T4, T5, tab persistence over node:sqlite, prefs.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const stubs = {
  'expo-sqlite/kv-store': `export default { getItemSync: () => null, setItemSync: () => {} };`,
  react: `export const useSyncExternalStore = () => 0;`,
};
require('node:module').registerHooks({
  resolve(spec, ctx, next) {
    if (stubs[spec]) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[spec]), shortCircuit: true, format: 'module' };
    try { return next(spec, ctx); } catch (e) {
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

async function main() {
  const T = await import('../utils/browser/tabs.ts');
  const P = await import('../utils/browser/popups.ts');
  const { createHistoryStore } = await import('../utils/history/store.ts');
  const { defaultBrowserPrefs, normalizeBrowserPrefs } = await import('../utils/prefs/browser.ts');

  let n = 0;
  const env = (now = 1000) => ({ now, newId: () => `id${++n}` });
  const ids = (s) => s.tabs.map((t) => t.id);
  const liveIds = (s) => T.liveTabs(s).map((t) => t.id).sort();

  console.log('T1 lifecycle');
  check('constants', T.MAX_LIVE === 3 && T.MAX_TABS === 50);
  let s = T.createTabsState(env(1));
  check('starts with one blank live active tab', s.tabs.length === 1 && s.tabs[0].url === '' && s.tabs[0].state === 'live' && s.activeId === s.tabs[0].id);
  const a = s.activeId;
  let r = T.openTab(s, { url: 'https://a.test/' }, env(2));
  check('foreground open is live and active', r.result === 'ok' && r.state.activeId === r.id && T.getTab(r.state, r.id).state === 'live');
  s = r.state;
  const b = r.id;
  r = T.openTab(s, { url: 'https://c.test/' }, env(3)); s = r.state; const c = r.id;
  check('three live at MAX_LIVE', liveIds(s).length === 3);
  r = T.openTab(s, { url: 'https://d.test/' }, env(4)); s = r.state; const d = r.id;
  check('fourth tab puts the least recently active to sleep', T.getTab(s, a).state === 'asleep' && liveIds(s).length === 3 && s.activeId === d);
  s = T.selectTab(s, b, env(5));
  check('select makes the tab active', s.activeId === b && T.getTab(s, b).lastActive === 5);
  s = T.selectTab(s, a, env(6));
  check('waking a sleeping tab evicts the LRU live one (c, active order d>c? c=3 is oldest)', T.getTab(s, a).state === 'live' && T.getTab(s, c).state === 'asleep' && liveIds(s).length === 3, ids(s).map((i) => T.getTab(s, i).state).join());
  check('asleep tab keeps url and title', T.getTab(s, c).url === 'https://c.test/');
  check('selecting an unknown id changes nothing', T.selectTab(s, 'nope', env()) === s);
  check('active tab never sleeps', T.getTab(s, s.activeId).state === 'live');

  r = T.openTab(s, { url: 'https://bg.test/', background: true, opener: a }, env(7));
  check('background open: asleep, no switch, opener kept', r.state.activeId === s.activeId && T.getTab(r.state, r.id).state === 'asleep' && T.getTab(r.state, r.id).opener === a);

  // cap
  let big = T.createTabsState(env());
  for (let i = 1; i < T.MAX_TABS; i++) big = T.openTab(big, { url: `https://x${i}.test/` }, env(10 + i)).state;
  check('50 tabs reachable', big.tabs.length === 50);
  check('never more than MAX_LIVE live with 50 tabs', T.liveTabs(big).length === 3);
  const capped = T.openTab(big, { url: 'https://over.test/' }, env());
  check('cap returns "cap" and opens nothing', capped.result === 'cap' && capped.id === null && capped.state === big);
  check('cap also stops background tabs', T.openTab(big, { background: true }, env()).result === 'cap');

  console.log('T2 switcher actions');
  s = T.createTabsState(env(1)); const first = s.activeId;
  s = T.openTab(s, { url: 'https://one.test/' }, env(2)).state;
  const second = s.activeId;
  check('switcher order is newest first', eq(T.switcherOrder(s).map((t) => t.id), [second, first]));
  let cr = T.closeTab(s, second, env(3));
  check('closing the active tab switches to another', cr.state.tabs.length === 1 && cr.state.activeId === first);
  s = cr.state;
  cr = T.closeTab(s, first, env(4));
  check('closing the last tab leaves one blank tab', cr.state.tabs.length === 1 && cr.state.tabs[0].url === '' && cr.state.activeId !== first);
  check('undo payload carries the closed tab as closing', cr.undo.closed[0].tab.state === 'closing' && cr.undo.blankId === cr.state.activeId);
  let u = T.undoClose(cr.state, cr.undo, env(5));
  check('undo of the last close removes the blank tab and restores it', u.tabs.length === 1 && u.tabs[0].id === first && u.activeId === first && u.tabs[0].state === 'live');
  check('closing an unknown id gives no undo', T.closeTab(u, 'nope', env()).undo === null);

  // close a background tab keeps active
  s = T.createTabsState(env(1)); const t1 = s.activeId;
  s = T.openTab(s, { url: 'https://two.test/' }, env(2)).state; const t2 = s.activeId;
  s = T.openTab(s, { url: 'https://three.test/' }, env(3)).state; const t3 = s.activeId;
  cr = T.closeTab(s, t1, env(4));
  check('closing a background tab keeps the active one', cr.state.activeId === t3 && !ids(cr.state).includes(t1));
  u = T.undoClose(cr.state, cr.undo, env(5));
  check('undo puts the tab back at its place, asleep when it is not active', eq(ids(u), [t1, t2, t3]) && u.activeId === t3 && T.getTab(u, t1).state !== 'closing');
  // close active, undo
  cr = T.closeTab(s, t3, env(6));
  check('closing the active tab picks the most recently active', cr.state.activeId === t2);
  u = T.undoClose(cr.state, cr.undo, env(7));
  check('undo brings the active tab back as active', u.activeId === t3 && eq(ids(u), [t1, t2, t3]));

  // close all
  const all = T.closeAll(s, env(8));
  check('close all leaves one blank tab', all.state.tabs.length === 1 && all.state.tabs[0].url === '');
  check('close all undo payload holds every tab', all.undo.closed.length === 3);
  u = T.undoClose(all.state, all.undo, env(9));
  check('undo close all restores every tab in order, previous active active again', eq(ids(u), [t1, t2, t3]) && u.activeId === t3);
  check('after undo no more than MAX_LIVE live', T.liveTabs(u).length <= 3);
  let all50 = T.closeAll(big, env());
  u = T.undoClose(all50.state, all50.undo, env());
  check('close all and undo with 50 tabs', u.tabs.length === 50 && T.liveTabs(u).length <= 3);

  // closing a tab with opener falls back to opener
  s = T.createTabsState(env(1)); const o = s.activeId;
  s = T.openTab(s, { url: 'https://o1.test/' }, env(2)).state; const mid = s.activeId;
  r = T.openTab(s, { url: 'https://child.test/', opener: o }, env(3)); s = r.state;
  cr = T.closeTab(s, r.id, env(4));
  check('closing the active child returns to its opener', cr.state.activeId === o);

  // updateTab
  s = T.updateTab(s, mid, { title: 'Hello' });
  check('updateTab changes only given fields', T.getTab(s, mid).title === 'Hello' && T.getTab(s, mid).url === 'https://o1.test/');

  console.log('Back and opener');
  s = T.createTabsState(env(1)); const root = s.activeId;
  r = T.openTab(s, { url: 'https://child.test/', opener: root }, env(2)); s = r.state; const kid = r.id;
  check('back goes back while the page can', T.backTarget(s, kid, true) === 'goBack');
  check('back closes and switches to the opener', eq(T.backTarget(s, kid, false), { closeAndSwitchTo: root }));
  check('no opener: leave', T.backTarget(s, root, false) === 'leave');
  cr = T.closeTab(s, root, env(3));
  check('opener that was closed: leave', T.backTarget(cr.state, kid, false) === 'leave');
  check('unknown tab: leave', T.backTarget(s, 'nope', false) === 'leave');

  console.log('Restore and rows');
  s = T.createTabsState(env(1));
  s = T.openTab(s, { url: 'https://r1.test/', title: 'R1' }, env(2)).state;
  s = T.openTab(s, { url: 'data:text/html,x', title: 'Odd' }, env(3)).state;
  const saved = T.toRows(s);
  check('rows carry position, opener, lastActive', saved.rows.length === 3 && saved.rows[2].position === 2 && saved.rows[0].opener === null);
  check('non-http(s) saves as empty url', saved.rows[2].url === '' && saved.rows[0].url === '' && saved.rows[1].url === 'https://r1.test/');
  const back = T.restoreTabs(saved.rows, s.tabs[1].id, env(100));
  check('restore: all asleep except the active, which is woken', back.activeId === s.tabs[1].id && T.liveTabs(back).length === 1 && T.getTab(back, back.activeId).state === 'live');
  check('restore keeps order', eq(ids(back), ids(s)));
  const none = T.restoreTabs([], null, env(100));
  check('restore with no rows gives one blank tab', none.tabs.length === 1 && none.tabs[0].url === '' && none.tabs[0].state === 'live');
  const odd = T.restoreTabs([{ id: 'x', url: '', title: '', position: 0, opener: 'ghost', lastActive: 5 }], 'missing', env(100));
  check('restore: unknown active falls back, dangling opener cleared', odd.activeId === 'x' && odd.tabs[0].opener === null);

  console.log('Registrable part');
  check('a.b.example.com', P.registrablePart('a.b.example.com') === 'example.com');
  check('example.com', P.registrablePart('example.com') === 'example.com');
  check('x.co.uk', P.registrablePart('x.co.uk') === 'x.co.uk');
  check('news.bbc.co.uk', P.registrablePart('news.bbc.co.uk') === 'bbc.co.uk');
  check('www and case ignored', P.registrablePart('WWW.Shop.Example.com') === 'example.com');
  check('single label and IP stay whole', P.registrablePart('localhost') === 'localhost' && P.registrablePart('10.0.0.1') === '10.0.0.1');
  check('sameSite a.b.example.com vs example.com', P.sameSite('a.b.example.com', 'example.com'));
  check('x.co.uk vs y.co.uk differ', !P.sameSite('x.co.uk', 'y.co.uk'));
  check('bbc.co.uk vs news.bbc.co.uk same', P.sameSite('bbc.co.uk', 'news.bbc.co.uk'));
  check('www.ard.de vs ard.de same', P.sameSite('www.ard.de', 'ard.de'));
  check('news.abc.de is abc.de', P.registrablePart('news.abc.de') === 'abc.de');
  check('shop.foo.com.au is foo.com.au', P.registrablePart('shop.foo.com.au') === 'foo.com.au');
  check('sameSite takes addresses', P.sameSite('https://a.example.com/x', 'http://example.com:8080/'));
  check('hostAllowed suffix', P.hostAllowed('m.example.com', ['example.com']) && P.hostAllowed('example.com', ['www.example.com']));
  check('hostAllowed needs a label boundary', !P.hostAllowed('badexample.com', ['example.com']) && !P.hostAllowed('example.com', []));

  console.log('T4 new-window policy');
  const dn = (policy, allowed, gesture, kind) => P.decideNewWindow({ policy, allowed, gesture, kind });
  check('tapped window opens a tab under every policy', ['ask', 'block', 'allow'].every((p) => dn(p, false, true, 'window') === 'newTab'));
  check('untapped window: ask', dn('ask', false, false, 'window') === 'ask');
  check('untapped window: block', dn('block', false, false, 'window') === 'blocked');
  check('untapped window: allow', dn('allow', false, false, 'window') === 'newTab');
  check('untapped window: allowed host beats ask and block', dn('ask', true, false, 'window') === 'newTab' && dn('block', true, false, 'window') === 'newTab');
  check('redirect: ask / block / allow / allowed', dn('ask', false, false, 'redirect') === 'ask' && dn('block', false, false, 'redirect') === 'blocked' && dn('allow', false, false, 'redirect') === 'newTab' && dn('ask', true, false, 'redirect') === 'newTab');
  check('tapped app: ask / block / allow / allowed', dn('ask', false, true, 'app') === 'ask' && dn('block', false, true, 'app') === 'blocked' && dn('allow', false, true, 'app') === 'openApp' && dn('ask', true, true, 'app') === 'openApp');
  check('untapped app is blocked always', ['ask', 'block', 'allow'].every((p) => dn(p, true, false, 'app') === 'blocked'));

  console.log('T5 pop-up prompt');
  const rq = (url, kind = 'window', sourceUrl = 'https://www.Source.com/page') => ({ url, kind, sourceUrl });
  let ps = P.emptyPopups();
  ps = P.request(ps, 'A', rq('https://ad1.test/'));
  check('first request becomes the card', P.promptFor(ps, 'A').first.url === 'https://ad1.test/' && P.moreBlocked(ps, 'A') === 0);
  ps = P.request(ps, 'A', rq('https://ad2.test/')); ps = P.request(ps, 'A', rq('https://ad3.test/'));
  check('more requests count and the first stays', P.moreBlocked(ps, 'A') === 2 && P.promptFor(ps, 'A').first.url === 'https://ad1.test/');
  ps = P.request(ps, 'B', rq('https://other.test/'));
  check('prompts are per tab', P.promptFor(ps, 'B').first.url === 'https://other.test/' && P.promptFor(ps, 'B').more === 0);
  check('no card for no tab', P.promptFor(ps, null) === null && P.promptFor(ps, 'Z') === null);
  let res = P.open(ps, 'A');
  check('open acts on the first only; the later ones count as blocked', res.request.url === 'https://ad1.test/' && P.promptFor(res.state, 'A') === null && P.blockedOnPage(res.state, 'A') === 2);
  check('open leaves other tabs alone', P.promptFor(res.state, 'B') !== null);
  let st = P.block(ps, 'A');
  check('block counts the first and the later ones', P.blockedOnPage(st, 'A') === 3 && P.promptFor(st, 'A') === null);
  const al = P.allowForSite(ps, 'A', ['old.com']);
  check('allow for site adds the normalized source host, then opens', eq(al.allowHosts, ['old.com', 'source.com']) && al.host === 'source.com' && al.request.url === 'https://ad1.test/' && P.promptFor(al.state, 'A') === null);
  check('allow for site does not duplicate', eq(P.allowForSite(ps, 'A', ['source.com']).allowHosts, ['source.com']));
  check('resolving with no card does nothing', P.open(P.emptyPopups(), 'A').request === null && P.block(P.emptyPopups(), 'A').blocked.A === undefined);
  let dr = P.drop(ps, 'A', 'navigated');
  check('navigated drops the card and counts it', dr.dropped === 3 && P.promptFor(dr.state, 'A') === null && P.blockedOnPage(dr.state, 'A') === 0);
  ps = P.noteBlocked(P.noteBlocked(P.emptyPopups(), 'A'), 'A');
  check('onPopupBlocked counts per page', P.blockedOnPage(ps, 'A') === 2);
  dr = P.drop(ps, 'A', 'navigated');
  check('new page resets the per-page counter', P.blockedOnPage(dr.state, 'A') === 0 && dr.dropped === 0);
  dr = P.drop(P.request(ps, 'A', rq('https://x.test/')), 'A', 'closed');
  check('closed tab is forgotten', dr.dropped === 1 && P.promptFor(dr.state, 'A') === null && !('A' in dr.state.blocked));
  // inactive tab queue: one kept plus a count, shown on switch
  let q = P.emptyPopups();
  q = P.request(q, 'bg', rq('https://q1.test/')); q = P.request(q, 'bg', rq('https://q2.test/')); q = P.request(q, 'bg', rq('https://q3.test/'));
  check('inactive tab keeps 1 plus a count; shown when it becomes active', P.promptFor(q, 'fg') === null && P.promptFor(q, 'bg').first.url === 'https://q1.test/' && P.moreBlocked(q, 'bg') === 2);

  console.log('Persistence (node:sqlite)');
  const prefs = { saveHistory: true, suggestFromHistory: true, clearHistoryOnClose: false };
  let db = nodeDb();
  let store = createHistoryStore(db, () => prefs);
  await store.init(1);
  const tbl = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
  check('tabs and meta tables are created', tbl.includes('tabs') && tbl.includes('meta') && tbl.includes('pages'));
  const empty = await store.loadTabs();
  check('empty load', empty.tabs.length === 0 && empty.activeId === null);
  let rs = T.createTabsState(env(1));
  rs = T.openTab(rs, { url: 'https://p1.test/', title: 'P1', opener: rs.activeId }, env(2)).state;
  rs = T.openTab(rs, { url: 'https://p2.test/', title: 'P2' }, env(3)).state;
  const rows = T.toRows(rs);
  check('save returns true', (await store.saveTabs(rows.rows, rows.activeId)) === true);
  let loaded = await store.loadTabs();
  check('round trip rows', eq(loaded.tabs, rows.rows) && loaded.activeId === rows.activeId, JSON.stringify(loaded));
  const fewer = T.closeTab(rs, rs.tabs[1].id, env(4)).state;
  const frows = T.toRows(fewer);
  await store.saveTabs(frows.rows, frows.activeId);
  loaded = await store.loadTabs();
  check('saving again replaces: closed tabs are gone, positions follow', loaded.tabs.length === 2 && eq(loaded.tabs, frows.rows));
  const restored = T.restoreTabs(loaded.tabs, loaded.activeId, env(50));
  check('restore from the store: all asleep but the active', T.liveTabs(restored).length === 1 && restored.activeId === frows.activeId);
  await store.saveTabs([], null);
  loaded = await store.loadTabs();
  check('saving no tabs empties', loaded.tabs.length === 0 && loaded.activeId === null);

  db.raw.exec('DROP TABLE tabs');
  loaded = await store.loadTabs();
  check('missing tabs table loads as empty, never throws', loaded.tabs.length === 0 && loaded.activeId === null);
  check('saving to a broken database returns false, never throws', (await store.saveTabs(rows.rows, rows.activeId)) === false);
  check('and stays a no-op afterwards', (await store.saveTabs(rows.rows, rows.activeId)) === false);
  const dead = { exec: async () => { throw new Error('x'); }, run: async () => { throw new Error('x'); }, all: async () => { throw new Error('x'); } };
  const deadStore = createHistoryStore(dead, () => prefs);
  const dl = await deadStore.loadTabs();
  check('unopenable database loads as empty', dl.tabs.length === 0 && dl.activeId === null);

  // older database without tabs: init creates them
  db = nodeDb();
  db.raw.exec("CREATE TABLE pages (url TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', host TEXT NOT NULL, first_visited INTEGER NOT NULL, last_visited INTEGER NOT NULL, visits INTEGER NOT NULL DEFAULT 1)");
  store = createHistoryStore(db, () => prefs);
  await store.init(1);
  check('init upgrades an older database', db.raw.prepare("SELECT name FROM sqlite_master WHERE name='tabs'").all().length === 1);

  // clear on close wipes tabs and the active id
  db = nodeDb();
  const p2 = { ...prefs };
  store = createHistoryStore(db, () => p2);
  await store.init(1);
  await store.saveTabs(rows.rows, rows.activeId);
  await store.recordVisit({ url: 'https://h.test/', title: 'H' }, 5);
  const store2 = createHistoryStore(db, () => ({ ...p2, clearHistoryOnClose: true }));
  await store2.init(10);
  loaded = await store2.loadTabs();
  check('cold-start wipe clears tabs and active tab', loaded.tabs.length === 0 && loaded.activeId === null);
  check('and pages', (await store2.list()).length === 0);
  await store.saveTabs(rows.rows, rows.activeId);
  const store3 = createHistoryStore(db, () => p2);
  await store3.init(20);
  check('without the setting tabs survive a cold start', (await store3.loadTabs()).tabs.length === rows.rows.length);
  db.raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('other', 'keep')").run();
  await createHistoryStore(db, () => ({ ...p2, clearHistoryOnClose: true })).init(30);
  check('wipe leaves other meta keys', db.raw.prepare("SELECT value FROM meta WHERE key='other'").all().length === 1);

  console.log('Undo after use (section 30)');
  {
    let u = T.createTabsState(env(1));
    u = T.openTab(u, { url: 'https://u1.test/' }, env(2)).state;
    const closed = T.closeAll(u, env(3));
    const blankId = closed.undo.blankId;
    const typed = T.updateTab(closed.state, blankId, { url: 'https://typed.test/' });
    const back = T.undoClose(typed, closed.undo, env(4));
    check('undo keeps a blank tab the user has since used', T.getTab(back, blankId) && T.getTab(back, blankId).url === 'https://typed.test/' && back.tabs.length === 3);
    const back2 = T.undoClose(closed.state, closed.undo, env(5));
    check('undo still drops the blank tab while it is blank', !T.getTab(back2, blankId) && back2.tabs.length === 2);
  }

  console.log('Tab store (section 30)');
  {
    const { createTabStore } = await import('../utils/browser/tabStore.ts');
    const mk = (opts = {}) => {
      const log = { saved: [], deleted: 0, loads: 0 };
      let saveHistory = opts.saveHistory ?? true;
      let wipe = 0;
      const prefLs = new Set();
      const store = createTabStore();
      store.bind({
        load: async () => { log.loads++; return opts.saved ?? { tabs: [], activeId: null }; },
        scheduleSave: (rows, activeId) => log.saved.push({ rows, activeId }),
        flush: async () => {},
        deleteSaved: async () => { log.deleted++; },
        saveHistory: () => saveHistory,
        subscribePrefs: (fn) => { prefLs.add(fn); return () => prefLs.delete(fn); },
        wipeCount: async () => wipe,
      });
      return { store, log, setSave: (v) => { saveHistory = v; prefLs.forEach((f) => f()); }, setWipe: (v) => { wipe = v; } };
    };
    const m = mk();
    await m.store.ensureRestored();
    await m.store.ensureRestored();
    check('restores once per process', m.log.loads === 1 && m.store.getState().tabs.length === 1);
    let seenA = 0; let seenB = 0;
    const offA = m.store.subscribe(() => seenA++);
    m.store.subscribe(() => seenB++);
    const opened = m.store.open({ url: 'https://shared.test/' });
    check('two subscribers both see a change and read the same state', seenA === 1 && seenB === 1 && m.store.getState().activeId === opened.id && m.store.getState().tabs.length === 2);
    offA();
    m.store.select(m.store.getState().tabs[0].id);
    check('an unsubscribed listener stops hearing', seenA === 1 && seenB === 2);
    check('every change is scheduled for saving', m.log.saved.length === 2 && m.log.saved[0].rows.length === 2);
    const u = m.store.closeAll();
    m.store.undo(u);
    check('close all and undo go through the store', m.store.getState().tabs.length === 2);

    // Save history off: nothing written, rows deleted when it turns off
    const off = mk({ saveHistory: false, saved: { tabs: [{ id: 'old', url: 'https://old.test/', title: '', position: 0, opener: null, lastActive: 1 }], activeId: 'old' } });
    await off.store.ensureRestored();
    check('Save history off: saved tabs are not read', off.log.loads === 0 && off.store.getState().tabs.length === 1 && off.store.getState().tabs[0].url === '');
    off.store.open({ url: 'https://mem.test/' });
    off.store.select(off.store.getState().tabs[0].id);
    check('Save history off: no writes at all', off.log.saved.length === 0 && off.log.deleted === 0);
    const on = mk();
    await on.store.ensureRestored();
    on.store.open({ url: 'https://x.test/' });
    const before = on.log.saved.length;
    on.setSave(false);
    check('turning Save history off deletes the saved rows', on.log.deleted === 1);
    on.store.open({ url: 'https://y.test/' });
    check('and later changes are not written', on.log.saved.length === before && on.store.getState().tabs.length === 3);
    on.setSave(true);
    check('turning it on again saves the current tabs', on.log.saved.length === before + 1 && on.log.saved[before].rows.length === 3);
    on.setSave(true);
    check('a pref change that leaves it unchanged does nothing', on.log.deleted === 1 && on.log.saved.length === before + 1);

    // wipe counter
    const w = mk();
    await w.store.ensureRestored();
    await w.store.checkWipe();
    w.store.open({ url: 'https://keep.test/' });
    await w.store.checkWipe();
    check('same wipe count keeps the tabs', w.store.getState().tabs.length === 2);
    w.setWipe(1);
    await w.store.checkWipe();
    check('a new wipe count drops the in-memory tabs to one blank tab', w.store.getState().tabs.length === 1 && w.store.getState().tabs[0].url === '');
    w.store.open({ url: 'https://again.test/' });
    await w.store.checkWipe();
    check('and the count is remembered', w.store.getState().tabs.length === 2);
  }

  console.log('Tab rows deletion (section 30)');
  {
    const dbx = nodeDb();
    const pr = { saveHistory: true, suggestFromHistory: true, clearHistoryOnClose: false };
    const st = createHistoryStore(dbx, () => pr);
    await st.init(1);
    const r0 = T.toRows(T.openTab(T.createTabsState(env(1)), { url: 'https://p.test/' }, env(2)).state);
    await st.saveTabs(r0.rows, r0.activeId);
    await st.deleteTabs();
    const l = await st.loadTabs();
    check('deleteTabs removes rows and the active id', l.tabs.length === 0 && l.activeId === null);
    pr.saveHistory = false;
    check('saveTabs writes nothing while Save history is off', (await st.saveTabs(r0.rows, r0.activeId)) === false && (await st.loadTabs()).tabs.length === 0);
  }

  console.log('Prefs');
  const dp = defaultBrowserPrefs();
  check('defaults', dp.popupPolicy === 'ask' && eq(dp.popupAllowHosts, []));
  check('normalize empty', normalizeBrowserPrefs(null).popupPolicy === 'ask' && eq(normalizeBrowserPrefs({}).popupAllowHosts, []));
  check('valid policies kept', ['ask', 'block', 'allow'].every((p) => normalizeBrowserPrefs({ popupPolicy: p }).popupPolicy === p));
  check('unknown policy becomes ask', normalizeBrowserPrefs({ popupPolicy: 'yes' }).popupPolicy === 'ask' && normalizeBrowserPrefs({ popupPolicy: 3 }).popupPolicy === 'ask');
  check('allow hosts trimmed, lower-cased, deduped, junk dropped', eq(normalizeBrowserPrefs({ popupAllowHosts: [' A.com ', 'a.COM', '', 5, 'b.org'] }).popupAllowHosts, ['a.com', 'b.org']));
  check('non-array allow hosts becomes []', eq(normalizeBrowserPrefs({ popupAllowHosts: 'a.com' }).popupAllowHosts, []));

  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\nAll browser tab checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
