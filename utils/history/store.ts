/**
 * Browser history logic (docs/NATIVE_CONTRACT.md section 24.9), over an injected database so tests can use node:sqlite.
 * No React and no native imports here.
 */

export interface HistoryDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: (string | number)[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: (string | number)[]): Promise<T[]>;
}

export type HistoryEntry = {
  url: string;
  title: string;
  host: string;
  firstVisited: number;
  lastVisited: number;
  visits: number;
};

export type HistoryRange = 'hour' | 'today' | 'week' | 'all';
export type RecordResult = 'saved' | 'title' | 'skipped';

/** The slice of BrowserPrefs the store reads. */
export type HistoryPrefs = { saveHistory: boolean; suggestFromHistory: boolean; clearHistoryOnClose: boolean };

export const RETENTION_DAYS = 90;
export const MAX_ROWS = 10_000;
export const PRUNE_EVERY_SAVES = 50;

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Stay well under SQLite's variable limit. */
const CHUNK = 400;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pages (
    url TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    host TEXT NOT NULL,
    first_visited INTEGER NOT NULL,
    last_visited INTEGER NOT NULL,
    visits INTEGER NOT NULL DEFAULT 1
  )`,
  'CREATE INDEX IF NOT EXISTS pages_last ON pages(last_visited DESC)',
  'CREATE INDEX IF NOT EXISTS pages_host ON pages(host)',
];

type Row = { url: string; title: string; host: string; first_visited: number; last_visited: number; visits: number };

const toEntry = (r: Row): HistoryEntry => ({
  url: String(r.url),
  title: String(r.title ?? ''),
  host: String(r.host),
  firstVisited: Number(r.first_visited),
  lastVisited: Number(r.last_visited),
  visits: Number(r.visits),
});

/** Lower-case host without port, user info and a leading "www.". */
export function hostOf(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '');
}

/** The address without its fragment, and its host, or null when it isn't an http(s) address. */
export function parsePage(raw: string): { url: string; host: string } | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const m = /^https?:\/\/([^/?#\s]*)/i.exec(trimmed);
  if (!m) return null;
  let authority = m[1];
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  const host = hostOf(authority.replace(/:\d*$/, '').replace(/^\[|\]$/g, ''));
  if (!host) return null;
  const hash = trimmed.indexOf('#');
  return { url: hash >= 0 ? trimmed.slice(0, hash) : trimmed, host };
}

/** Address as people type it: no scheme, no "www.", no fragment, no trailing slash. Lower case. */
function bare(s: string): string {
  const noHash = s.indexOf('#') >= 0 ? s.slice(0, s.indexOf('#')) : s;
  return noHash.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '');
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function startOf(range: Exclude<HistoryRange, 'all'>, now: number): number {
  if (range === 'hour') return now - HOUR;
  if (range === 'week') return now - 7 * DAY;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function createHistoryStore(db: HistoryDb, prefs: () => HistoryPrefs) {
  const listeners = new Set<() => void>();
  let version = 0;
  let lastRecorded: string | null = null;
  let saves = 0;
  let initPromise: Promise<void> | null = null;

  const notify = () => {
    version++;
    listeners.forEach((l) => l());
  };

  async function prune(now: number = Date.now()): Promise<number> {
    const old = await db.run('DELETE FROM pages WHERE last_visited < ?', [now - RETENTION_DAYS * DAY]);
    const extra = await db.run(
      'DELETE FROM pages WHERE url NOT IN (SELECT url FROM pages ORDER BY last_visited DESC, url DESC LIMIT ?)',
      [MAX_ROWS],
    );
    const n = old.changes + extra.changes;
    if (n > 0) notify();
    return n;
  }

  function init(now: number = Date.now()): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        for (const sql of SCHEMA) await db.exec(sql);
        if (prefs().clearHistoryOnClose) {
          await db.run('DELETE FROM pages');
          notify();
        }
        await prune(now);
      })();
      initPromise.catch(() => {
        initPromise = null;
      });
    }
    return initPromise;
  }

  async function recordVisit(input: { url: string; title: string }, now: number = Date.now()): Promise<RecordResult> {
    if (!prefs().saveHistory) return 'skipped';
    const page = parsePage(input.url);
    if (!page) return 'skipped';
    await init(now);
    const title = (input.title ?? '').trim();
    if (page.url === lastRecorded) {
      if (title) {
        const r = await db.run('UPDATE pages SET title = ? WHERE url = ? AND title <> ?', [title, page.url, title]);
        if (r.changes > 0) notify();
      }
      return 'title';
    }
    await db.run(
      `INSERT INTO pages (url, title, host, first_visited, last_visited, visits) VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(url) DO UPDATE SET
         last_visited = excluded.last_visited,
         visits = visits + 1,
         title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END,
         host = excluded.host`,
      [page.url, title, page.host, now, now],
    );
    lastRecorded = page.url;
    notify();
    saves++;
    if (saves % PRUNE_EVERY_SAVES === 0) await prune(now);
    return 'saved';
  }

  /** `before` pages backwards: a last-visit time, or the last entry of the previous page (exact, ties included). */
  async function list(opts: { query?: string; limit?: number; before?: number | HistoryEntry } = {}): Promise<HistoryEntry[]> {
    await init();
    const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 100), 1000));
    const where: string[] = [];
    const params: (string | number)[] = [];
    const q = (opts.query ?? '').trim().toLowerCase();
    if (q) {
      where.push("(lower(url) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\')");
      params.push(like(q), like(q));
    }
    const b = opts.before;
    if (typeof b === 'number') {
      where.push('last_visited < ?');
      params.push(b);
    } else if (b) {
      where.push('(last_visited < ? OR (last_visited = ? AND url < ?))');
      params.push(b.lastVisited, b.lastVisited, b.url);
    }
    const rows = await db.all<Row>(
      `SELECT * FROM pages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY last_visited DESC, url DESC LIMIT ?`,
      [...params, limit],
    );
    return rows.map(toEntry);
  }

  async function suggest(text: string, limit = 6): Promise<HistoryEntry[]> {
    if (!prefs().suggestFromHistory) return [];
    const typed = bare(text.trim());
    if (typed.length < 1) return [];
    await init();
    const rows = (
      await db.all<Row>(
        "SELECT * FROM pages WHERE lower(url) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\'",
        [like(typed), like(typed)],
      )
    ).map(toEntry);
    const exact = typed.replace(/\/$/, '');
    const hits = rows.filter((e) => {
      const addr = bare(e.url);
      if (addr.replace(/\/$/, '') === exact) return false;
      return addr.includes(typed) || e.title.toLowerCase().includes(typed);
    });
    const starts = (e: HistoryEntry) => (e.host.startsWith(typed) ? 0 : 1);
    hits.sort((a, b) => starts(a) - starts(b) || b.visits - a.visits || b.lastVisited - a.lastVisited);
    return hits.slice(0, Math.max(0, limit));
  }

  async function removeWhere(sql: string, params: (string | number)[]): Promise<HistoryEntry[]> {
    const rows = (await db.all<Row>(`SELECT * FROM pages WHERE ${sql}`, params)).map(toEntry);
    if (rows.length) {
      await db.run(`DELETE FROM pages WHERE ${sql}`, params);
      notify();
    }
    return rows;
  }

  async function removePages(urls: string[]): Promise<HistoryEntry[]> {
    await init();
    const removed: HistoryEntry[] = [];
    const unique = [...new Set(urls)];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const part = unique.slice(i, i + CHUNK);
      removed.push(...(await removeWhere(`url IN (${part.map(() => '?').join(',')})`, part)));
    }
    return removed;
  }

  async function removeHost(host: string): Promise<HistoryEntry[]> {
    await init();
    return removeWhere('host = ?', [hostOf(host)]);
  }

  async function restorePages(rows: HistoryEntry[]): Promise<void> {
    await init();
    for (const r of rows) {
      await db.run('INSERT OR REPLACE INTO pages (url, title, host, first_visited, last_visited, visits) VALUES (?, ?, ?, ?, ?, ?)', [
        r.url,
        r.title,
        r.host,
        r.firstVisited,
        r.lastVisited,
        r.visits,
      ]);
    }
    if (rows.length) notify();
  }

  async function clearRange(range: HistoryRange, now: number = Date.now()): Promise<number> {
    await init(now);
    const r = range === 'all' ? await db.run('DELETE FROM pages') : await db.run('DELETE FROM pages WHERE last_visited >= ?', [startOf(range, now)]);
    if (r.changes > 0) notify();
    return r.changes;
  }

  return {
    init,
    prune,
    recordVisit,
    list,
    suggest,
    removePages,
    removeHost,
    restorePages,
    clearRange,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    version: () => version,
  };
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;
