// Browse: what is new or popular in one kind of thing, with no title (the assistant's browse_torrents tool).
// The sources are listing endpoints that take no query: YTS list_movies, Knaben /v1 without a query, The Pirate
// Bay's precompiled top-100 lists and Nyaa's front-page RSS. Each answer goes through the provider's own parse(),
// so rows, names and magnets are built exactly like a search row.
//
// The rules that decide what is shown (period window, "new" means newly released, one copy per title, order)
// are pure functions below so they can be tested without a network.

import { eligibleProviders, mergeResults } from './aggregate.ts';
import type { ProviderPrefs } from './aggregate.ts';
import { pausedFor, recordFailure, recordSuccess } from './health.ts';
import { httpText, joinUrl, ProviderError } from './http.ts';
import { parse as parseKnaben } from './providers/knaben.ts';
import { parseNyaaRss } from './providers/nyaa.ts';
import { parse as parseTpb } from './providers/tpb.ts';
import { parse as parseYts } from './providers/yts.ts';
import type { Category, SearchProvider, SearchResult, SearchUpdate, SourceStatus } from './types.ts';
import { parseRelease } from '../assistant/releaseName.ts';

export type BrowseKind = 'movies' | 'tv' | 'anime' | 'books' | 'games' | 'music' | 'apps';
export type BrowseOrder = 'new' | 'popular';
export type BrowsePeriod = 'day' | 'week' | 'month' | 'year';

export const BROWSE_KINDS: readonly BrowseKind[] = ['movies', 'tv', 'anime', 'books', 'games', 'music', 'apps'];
export const BROWSE_ORDERS: readonly BrowseOrder[] = ['new', 'popular'];
export const BROWSE_PERIODS: readonly BrowsePeriod[] = ['day', 'week', 'month', 'year'];

/** Length of each period in days. A month is 31 and a year 366 so the edges are never cut short. */
export const PERIOD_DAYS: Readonly<Record<BrowsePeriod, number>> = { day: 1, week: 7, month: 31, year: 366 };

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- pure rules

/**
 * Whether a row uploaded at `publishedAt` belongs to the period. A row without a date is kept only for
 * "popular" (top lists often carry no date); "new" needs to know.
 */
export function inPeriod(publishedAt: number | undefined, period: BrowsePeriod, order: BrowseOrder, now: number): boolean {
  if (publishedAt === undefined || !Number.isFinite(publishedAt) || publishedAt <= 0) return order === 'popular';
  return now - publishedAt <= PERIOD_DAYS[period] * DAY_MS;
}

/**
 * "New" for films and shows means newly released, not an old film uploaded again: the year in the name must be
 * this year or last year. A TV episode counts as new without a year (an episode uploaded in the window is a new
 * airing, even of a long-running show). Other kinds have no release year rule: new means newly uploaded.
 */
export function isNewRelease(name: string, kind: BrowseKind, now: number): boolean {
  if (kind !== 'movies' && kind !== 'tv') return true;
  const p = parseRelease(name);
  if (kind === 'tv' && (p.episodes?.length ?? 0) > 0) return true;
  if (p.year === undefined) return false;
  return p.year >= new Date(now).getUTCFullYear() - 1;
}

/**
 * Whether the name has the shape of the kind. Sources mislabel: Knaben lists popular films under TV. A show names a
 * season or an episode; a film names neither. Other kinds take any name.
 */
export function fitsKind(name: string, kind: BrowseKind): boolean {
  if (kind !== 'movies' && kind !== 'tv') return true;
  const p = parseRelease(name);
  const episodic = p.season !== undefined || (p.episodes?.length ?? 0) > 0 || p.completeSeries === true;
  return kind === 'tv' ? episodic : !episodic;
}

export interface BrowseFilter {
  kind: BrowseKind;
  order: BrowseOrder;
  period: BrowsePeriod;
  now: number;
}

/** Keeps the rows that fit the period, the kind's name shape and, for "new", the release rule. `dropped` counts the rest. */
export function filterForBrowse<T extends { name: string; publishedAt?: number }>(rows: readonly T[], f: BrowseFilter): { kept: T[]; dropped: number } {
  const kept = rows.filter((r) =>
    inPeriod(r.publishedAt, f.period, f.order, f.now) && fitsKind(r.name, f.kind) && (f.order !== 'new' || isNewRelease(r.name, f.kind, f.now)));
  return { kept, dropped: rows.length - kept.length };
}

function normTitle(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]+/g, '')
    .toLowerCase()
    .replace(/['’‘`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * One key per work: the parsed title plus the year for films, plus season and episode for shows and anime.
 * Two copies of the same film (720p and 1080p, two groups, two sources) get the same key.
 */
export function workKey(name: string, kind: BrowseKind): string {
  const p = parseRelease(name);
  const title = normTitle(p.title ?? name) || normTitle(name);
  if (kind === 'tv' || kind === 'anime') {
    const eps = p.episodes && p.episodes.length > 0 ? p.episodes.join(',') : '';
    if (p.season !== undefined || eps) return `${title}|s${p.season ?? ''}|e${eps}`;
  }
  return `${title}|${p.year ?? ''}`;
}

/** Keeps the first row of each key. Pass the rows best first, so the best copy of each work stays. */
export function collapseWorks<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** "new": latest upload first. "popular": most sharing first. Unknown values go last; the other value breaks ties. */
export function orderBrowse<T>(rows: readonly T[], order: BrowseOrder, get: (row: T) => { publishedAt?: number; seeders?: number }): T[] {
  const v = (n: number | undefined): number => (n === undefined || !Number.isFinite(n) ? -Infinity : n);
  const byDate = (a: T, b: T): number => v(get(b).publishedAt) - v(get(a).publishedAt);
  const bySharing = (a: T, b: T): number => v(get(b).seeders) - v(get(a).seeders);
  const cmp = order === 'new' ? (a: T, b: T) => byDate(a, b) || bySharing(a, b) : (a: T, b: T) => bySharing(a, b) || byDate(a, b);
  return rows.slice().sort((a, b) => {
    const d = cmp(a, b);
    return Number.isNaN(d) ? 0 : d;
  });
}

// Words that name a kind, for a search query that is really a browse ("latest movies").
const KIND_WORDS: ReadonlyArray<[BrowseKind, RegExp]> = [
  ['anime', /\b(anime|animes)\b/],
  ['tv', /\b(tv|shows?|series|episodes?|television)\b/],
  ['movies', /\b(movies?|films?|cinema|documentar(y|ies))\b/],
  ['books', /\b(books?|ebooks?|audiobooks?|comics?)\b/],
  ['games', /\b(games?)\b/],
  ['music', /\b(music|songs?|albums?)\b/],
  ['apps', /\b(apps?|software|programs?|applications?)\b/],
];

/**
 * Turns a generic search ("latest movies", "popular shows this week") into browse arguments. The category wins
 * over the words; sort newest or seeders wins over "latest" or "popular" in the words. Null when no kind can be
 * read: the caller then runs a normal search.
 */
export function browseArgsFromQuery(text: string, category: string, sort: string): { kind: BrowseKind; order: BrowseOrder; period: BrowsePeriod } | null {
  const t = String(text ?? '').toLowerCase();
  let kind: BrowseKind | undefined = (BROWSE_KINDS as readonly string[]).includes(category) ? (category as BrowseKind) : undefined;
  if (!kind) kind = KIND_WORDS.find(([, re]) => re.test(t))?.[0];
  if (!kind) return null;
  const order: BrowseOrder = sort === 'newest' ? 'new' : sort === 'seeders' ? 'popular' : /\b(popular|trending|top|best|hot|most)\b/.test(t) ? 'popular' : 'new';
  const period: BrowsePeriod = /\b(today|tonight|day)\b/.test(t) ? 'day' : /\bmonth\b/.test(t) ? 'month' : /\byear\b/.test(t) ? 'year' : 'week';
  return { kind, order, period };
}

// ---------------------------------------------------------------- sources

interface BrowseContext {
  baseUrl: string;
  signal: AbortSignal;
}

interface BrowseSource {
  id: string;
  /** Kinds this source is asked for, and for which orders. */
  use: Partial<Record<BrowseKind, readonly BrowseOrder[]>>;
  fetch(kind: BrowseKind, order: BrowseOrder, period: BrowsePeriod, ctx: BrowseContext): Promise<SearchResult[]>;
}

const BOTH: readonly BrowseOrder[] = ['new', 'popular'];
const PARSE_LIMIT = 200;
const parseCtx = (baseUrl: string, category: Category) => ({ baseUrl, category, hideAdult: true, limit: PARSE_LIMIT });

// Knaben category ids (same as providers/knaben.ts).
const KNABEN_IDS: Record<BrowseKind, number> = { music: 1000000, tv: 2000000, movies: 3000000, apps: 4000000, anime: 6000000, games: 7000000, books: 9000000 };

// The Pirate Bay subcategories with a precompiled top-100 list.
const TPB_CODES: Partial<Record<BrowseKind, number[]>> = { movies: [201, 207], tv: [205, 208], music: [101], games: [401], books: [601], apps: [301] };

const yts: BrowseSource = {
  id: 'yts',
  use: { movies: BOTH },
  async fetch(_kind, _order, _period, ctx) {
    // Newest uploads for both orders: the mirror ignores sort_by=seeds (checked live), and "popular this week"
    // means the most shared of the recent uploads anyway. The runner sorts by sharing.
    const url = `${joinUrl(ctx.baseUrl, '/api/v2/list_movies.json')}?sort_by=date_added&limit=50&page=1`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/json' });
    return parseYts(text, parseCtx(ctx.baseUrl, 'movies'));
  },
};

const knaben: BrowseSource = {
  id: 'knaben',
  use: { movies: BOTH, tv: BOTH, anime: BOTH, books: BOTH, games: BOTH, music: BOTH, apps: BOTH },
  async fetch(kind, order, _period, ctx) {
    const body = { order_by: order === 'new' ? 'date' : 'seeders', order_direction: 'desc', categories: [KNABEN_IDS[kind]], size: 50, hide_xxx: true };
    const text = await httpText(joinUrl(ctx.baseUrl, '/v1'), {
      signal: ctx.signal, accept: 'application/json', method: 'POST', contentType: 'application/json', body: JSON.stringify(body),
    });
    return parseKnaben(text, parseCtx(ctx.baseUrl, kind));
  },
};

const tpb: BrowseSource = {
  id: 'tpb',
  use: { movies: ['popular'], tv: BOTH, books: BOTH, games: BOTH, music: BOTH, apps: BOTH },
  async fetch(kind, order, period, ctx) {
    // The 48-hour list for new uploads and for short periods; the all-time list (filtered by date later) otherwise.
    const recent = order === 'new' || period === 'day' || period === 'week';
    const codes = TPB_CODES[kind] ?? [];
    const lists = await Promise.all(codes.map(async (code) => {
      const url = joinUrl(ctx.baseUrl, `/precompiled/data_top100${recent ? '_48h' : ''}_${code}.json`);
      const text = await httpText(url, { signal: ctx.signal, accept: 'application/json' });
      return parseTpb(text, parseCtx(ctx.baseUrl, kind));
    }));
    return lists.flat();
  },
};

const nyaa: BrowseSource = {
  id: 'nyaa',
  use: { anime: BOTH },
  async fetch(_kind, _order, _period, ctx) {
    // English-translated anime, newest first. The feed ignores a sort, so popular is sorted by the runner.
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/?page=rss&f=0&c=1_2&q=`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/rss+xml, application/xml, text/xml' });
    return parseNyaaRss('nyaa', text, parseCtx(ctx.baseUrl, 'anime'));
  },
};

const SOURCES: readonly BrowseSource[] = [yts, knaben, tpb, nyaa];

/** Ids of the sources that can list `kind` in `order`, before the user's prefs are applied. */
export function browseSourceIds(kind: BrowseKind, order: BrowseOrder): string[] {
  return SOURCES.filter((s) => s.use[kind]?.includes(order)).map((s) => s.id);
}

// ---------------------------------------------------------------- running

export interface BrowseOptions extends ProviderPrefs {
  mirrorOverride?: Record<string, string>;
  /** Seconds to wait per source, as for search. Default 8. */
  waitSeconds?: number;
  /** Drop rows with 0 sharing (undefined is kept). Default true. */
  hideDead?: boolean;
  signal?: AbortSignal;
  onUpdate?: (update: SearchUpdate) => void;
  /** Unused by the fetch; accepted so callers can pass one options object. */
  now?: number;
}

async function runSource(
  src: BrowseSource,
  provider: SearchProvider,
  kind: BrowseKind,
  order: BrowseOrder,
  period: BrowsePeriod,
  opts: BrowseOptions,
): Promise<{ status: SourceStatus; results: SearchResult[] }> {
  const started = Date.now();
  const finish = (state: SourceStatus['state'], results: SearchResult[], message?: string) => ({
    status: { providerId: src.id, state, count: results.length, ms: Date.now() - started, message },
    results,
  });
  const left = pausedFor(src.id);
  if (left > 0) return finish('error', [], `Paused after repeated failures. Retrying in ${Math.ceil(left / 60000)} min.`);

  const waitMs = (opts.waitSeconds ?? 8) * 1000;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, waitMs);
  const onCancel = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onCancel, { once: true });
  }
  // Settles when the controller aborts, even if a fetch ignores the signal.
  let gateListener: (() => void) | undefined;
  const gate = new Promise<never>((_, reject) => {
    const fire = () => reject(timedOut ? new ProviderError('timeout', `No answer in ${Math.round((waitMs / 1000) * 10) / 10}s`) : new ProviderError('cancelled', 'Cancelled'));
    if (controller.signal.aborted) fire();
    else {
      gateListener = fire;
      controller.signal.addEventListener('abort', fire, { once: true });
    }
  });
  gate.catch(() => {});

  const override = opts.mirrorOverride?.[src.id];
  const bases = override ? [override] : provider.mirrors;
  const work = (async (): Promise<SearchResult[]> => {
    const attempts = Math.min(bases.length, 2);
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await src.fetch(kind, order, period, { baseUrl: bases[i], signal: controller.signal });
      } catch (e) {
        lastErr = e;
        if (controller.signal.aborted) throw e;
        const retry = e instanceof ProviderError ? e.retryable : false;
        if (!retry || i + 1 >= attempts) throw e;
      }
    }
    throw lastErr;
  })();
  work.catch(() => {});

  try {
    let rows = await Promise.race([work, gate]);
    rows = rows.filter((r) => r.category !== 'adult');
    if (opts.hideDead ?? true) rows = rows.filter((r) => r.seeders !== 0);
    recordSuccess(src.id);
    return finish(rows.length ? 'done' : 'empty', rows);
  } catch (e) {
    if (e instanceof ProviderError) {
      if (e.kind === 'cancelled') return finish('error', [], 'Cancelled');
      if (e.kind === 'challenge') return finish('blocked', [], 'Blocked by a bot check');
      recordFailure(src.id);
      if (e.kind === 'timeout') return finish('timeout', [], e.message);
      if (e.kind === 'blocked') return finish('blocked', [], e.message);
      return finish('error', [], e.message);
    }
    recordFailure(src.id);
    return finish('error', [], e instanceof Error ? e.message : 'Unexpected error');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCancel);
    if (gateListener) controller.signal.removeEventListener('abort', gateListener);
  }
}

/**
 * Lists what is new or popular in `kind` from every enabled source that can list it, in parallel, with the same
 * per-source timeout, mirror retry and health rules as search. Adult content is never listed. `onUpdate` fires at
 * the start, after each source settles, and once more with done: true. Rows are merged by info hash; the caller
 * applies the period, release and one-copy-per-title rules.
 */
export async function browseAll(kind: BrowseKind, order: BrowseOrder, period: BrowsePeriod, opts: BrowseOptions): Promise<SearchUpdate> {
  const wanted = new Set(browseSourceIds(kind, order));
  const providers = eligibleProviders(kind, { ...opts, adult: false }).filter((p) => wanted.has(p.id));
  const statuses = new Map<string, SourceStatus>();
  const rows = new Map<string, SearchResult[]>();
  for (const p of providers) statuses.set(p.id, { providerId: p.id, state: 'searching', count: 0, ms: 0 });

  const snapshot = (done: boolean): SearchUpdate => ({
    results: mergeResults(providers.flatMap((p) => rows.get(p.id) ?? []), opts.enabled),
    sources: providers.map((p) => ({ ...statuses.get(p.id)! })),
    done,
  });
  const emit = (u: SearchUpdate) => {
    try {
      opts.onUpdate?.(u);
    } catch {
      // A listener must not break the browse.
    }
  };
  if (providers.length === 0) {
    const u = snapshot(true);
    emit(u);
    return u;
  }
  emit(snapshot(false));
  await Promise.all(
    providers.map(async (p) => {
      const src = SOURCES.find((s) => s.id === p.id)!;
      const out = await runSource(src, p, kind, order, period, opts);
      statuses.set(p.id, out.status);
      rows.set(p.id, out.results);
      emit(snapshot(false));
    }),
  );
  const final = snapshot(true);
  emit(final);
  return final;
}
