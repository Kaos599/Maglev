// Fan-out search across providers with per-provider timeout, mirrors, health, merge and sort.
// Contract: docs/SEARCH_CONTRACT.md sections 1 and 4.

import { PROVIDERS } from './providers/index.ts';
import { createTorznabProvider } from './providers/torznab.ts';
import { ProviderError } from './http.ts';
import { pausedFor, recordFailure, recordSuccess } from './health.ts';
import { CATEGORY_ORDER } from './types.ts';
import { decodeEntities } from './text.ts';
import type { Category, MergedResult, SearchProvider, SearchResult, SearchUpdate, SortKey, SourceStatus } from './types.ts';

export { PROVIDERS, createTorznabProvider };
export type { TorznabConfig } from './providers/torznab.ts';
export * from './types.ts';

export interface ProviderPrefs {
  /** Provider ids in priority order (the On list). */
  enabled: string[];
  /** Per-provider category restriction; missing = all of the provider's categories. */
  useFor?: Record<string, Category[]>;
  adult?: boolean;
  /** User-added providers (for example from createTorznabProvider). */
  extraProviders?: SearchProvider[];
}

export interface SearchOptions extends ProviderPrefs {
  mirrorOverride?: Record<string, string>;
  /** Seconds to wait per provider: 5, 8 or 15. Default 8. Fractions allowed. */
  waitSeconds?: number;
  /** Results per provider: 25, 50 or 100. Default 50. */
  limit?: number;
  /** Drop results with 0 seeders (undefined is kept). Default true. */
  hideDead?: boolean;
  sort?: SortKey;
  page?: number;
  signal?: AbortSignal;
  onUpdate?: (update: SearchUpdate) => void;
}

function lookup(id: string, extra?: SearchProvider[]): SearchProvider | undefined {
  return PROVIDERS.find((p) => p.id === id) ?? extra?.find((p) => p.id === id);
}

/**
 * Gives a result its real magnet and info hash before it is added. Rows that already have a magnet pass through.
 * Throws a ProviderError (for example 'challenge' when the site wants its check again).
 */
export async function resolveResult<T extends SearchResult>(r: T, signal: AbortSignal, extra?: SearchProvider[]): Promise<T> {
  if (r.magnet) return r;
  const p = lookup(r.providerId, extra);
  if (!p?.resolveMagnet) throw new ProviderError('parse', 'No magnet link for this result');
  const { magnet, infoHash } = await p.resolveMagnet(r, signal);
  return { ...r, magnet, infoHash };
}

export function effectiveCategories(p: SearchProvider, prefs: Pick<ProviderPrefs, 'useFor' | 'adult'>): Category[] {
  const pick = prefs.useFor?.[p.id];
  let cats = pick ? p.categories.filter((c) => pick.includes(c)) : p.categories.slice();
  if (!prefs.adult) cats = cats.filter((c) => c !== 'adult');
  return cats;
}

/** Enabled providers that should receive a query in `category`, in priority order. */
export function eligibleProviders(category: Category, prefs: ProviderPrefs): SearchProvider[] {
  const out: SearchProvider[] = [];
  const seen = new Set<string>();
  for (const id of prefs.enabled) {
    if (seen.has(id)) continue;
    seen.add(id);
    const p = lookup(id, prefs.extraProviders);
    if (!p) continue;
    if (p.nsfw && !prefs.adult) continue;
    if (category === 'adult' && !prefs.adult) continue;
    const eff = effectiveCategories(p, prefs);
    if (category === 'all' ? eff.length > 0 : eff.includes(category)) out.push(p);
  }
  return out;
}

/** Chips for the Search screen: All plus every category some enabled provider supports. */
export function availableCategories(prefs: ProviderPrefs): Category[] {
  const out: Category[] = ['all'];
  for (const c of CATEGORY_ORDER) {
    if (c === 'all') continue;
    if (c === 'adult' && !prefs.adult) continue;
    if (eligibleProviders(c, prefs).length > 0) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- merge and sort

const rank = (n: number | undefined) => (n === undefined ? -Infinity : n);

export function mergeResults(rows: SearchResult[], priority: string[]): MergedResult[] {
  const prio = (id: string) => {
    const i = priority.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const groups = new Map<string, SearchResult[]>();
  for (const raw of rows) {
    // JSON providers (e.g. Internet Archive) return HTML-escaped titles too.
    const r = raw.name.includes('&') ? { ...raw, name: decodeEntities(raw.name) } : raw;
    const g = groups.get(r.infoHash);
    if (g) g.push(r);
    else groups.set(r.infoHash, [r]);
  }
  const out: MergedResult[] = [];
  for (const g of groups.values()) {
    const ordered = g.slice().sort((a, b) => rank(b.seeders) - rank(a.seeders) || prio(a.providerId) - prio(b.providerId));
    const best = ordered[0];
    const sources = Array.from(new Set(g.slice().sort((a, b) => prio(a.providerId) - prio(b.providerId)).map((r) => r.providerId)));
    const seeds = g.map((r) => r.seeders).filter((n): n is number => n !== undefined);
    const leech = g.map((r) => r.leechers).filter((n): n is number => n !== undefined);
    const dates = g.map((r) => r.publishedAt).filter((n): n is number => n !== undefined);
    out.push({
      ...best,
      seeders: seeds.length ? Math.max(...seeds) : undefined,
      leechers: leech.length ? Math.max(...leech) : undefined,
      publishedAt: dates.length ? Math.min(...dates) : undefined,
      sizeBytes: best.sizeBytes ?? g.find((r) => r.sizeBytes !== undefined)?.sizeBytes,
      sources,
    });
  }
  return out;
}

/** Adds one provider's late rows (for example after a solved check) to an existing merged list. */
export function mergeInto(existing: MergedResult[], rows: SearchResult[], priority: string[]): MergedResult[] {
  const prio = (id: string) => {
    const i = priority.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const byHash = new Map(existing.map((m) => [m.infoHash, m]));
  for (const r of rows) {
    const m = byHash.get(r.infoHash);
    if (!m) {
      byHash.set(r.infoHash, { ...r, sources: [r.providerId] });
      continue;
    }
    const pick = (a?: number, b?: number, f: (x: number, y: number) => number = Math.max) => (a === undefined ? b : b === undefined ? a : f(a, b));
    const sources = Array.from(new Set([...m.sources, r.providerId])).sort((a, b) => prio(a) - prio(b));
    const better = rank(r.seeders) > rank(m.seeders);
    byHash.set(r.infoHash, {
      ...(better ? r : m),
      seeders: pick(m.seeders, r.seeders),
      leechers: pick(m.leechers, r.leechers),
      publishedAt: pick(m.publishedAt, r.publishedAt, Math.min),
      sizeBytes: m.sizeBytes ?? r.sizeBytes,
      sources,
    });
  }
  return Array.from(byHash.values());
}

export function sortResults(list: MergedResult[], sort: SortKey = 'seeders'): MergedResult[] {
  const bySeeders = (a: MergedResult, b: MergedResult) => rank(b.seeders) - rank(a.seeders);
  const cmp: Record<SortKey, (a: MergedResult, b: MergedResult) => number> = {
    seeders: bySeeders,
    newest: (a, b) => rank(b.publishedAt) - rank(a.publishedAt) || bySeeders(a, b),
    size: (a, b) => rank(b.sizeBytes) - rank(a.sizeBytes) || bySeeders(a, b),
    name: (a, b) => a.name.localeCompare(b.name) || bySeeders(a, b),
  };
  return list.slice().sort(cmp[sort] ?? bySeeders);
}

// ---------------------------------------------------------------- running one provider

interface RunArgs {
  provider: SearchProvider;
  q: string;
  category: Category;
  page: number;
  limit: number;
  hideAdult: boolean;
  hideDead: boolean;
  waitMs: number;
  mirrorOverride?: string;
  cancel?: AbortSignal;
}

interface RunOutcome {
  status: SourceStatus;
  results: SearchResult[];
}

async function runProvider(a: RunArgs): Promise<RunOutcome> {
  const { provider: p } = a;
  const started = Date.now();
  const finish = (state: SourceStatus['state'], results: SearchResult[], message?: string): RunOutcome => ({
    status: { providerId: p.id, state, count: results.length, ms: Date.now() - started, message },
    results,
  });

  const left = pausedFor(p.id);
  if (left > 0) return finish('error', [], `Paused after repeated failures. Retrying in ${Math.ceil(left / 60000)} min.`);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, a.waitMs);
  const onCancel = () => controller.abort();
  if (a.cancel) {
    if (a.cancel.aborted) controller.abort();
    else a.cancel.addEventListener('abort', onCancel, { once: true });
  }

  // Settles when the controller aborts, even if the provider ignores the signal.
  let gateListener: (() => void) | undefined;
  const gate = new Promise<never>((_, reject) => {
    const fire = () =>
      reject(timedOut ? new ProviderError('timeout', `No answer in ${Math.round((a.waitMs / 1000) * 10) / 10}s`) : new ProviderError('cancelled', 'Cancelled'));
    if (controller.signal.aborted) fire();
    else {
      gateListener = fire;
      controller.signal.addEventListener('abort', fire, { once: true });
    }
  });
  gate.catch(() => {});

  const bases = a.mirrorOverride ? [a.mirrorOverride] : p.mirrors;

  const work = (async (): Promise<SearchResult[]> => {
    const attempts = Math.min(bases.length, 2); // one retry on the next mirror
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await p.search(a.q, a.category, a.page, {
          baseUrl: bases[i],
          signal: controller.signal,
          hideAdult: a.hideAdult,
          limit: a.limit,
        });
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
    if (a.hideAdult) rows = rows.filter((r) => r.category !== 'adult');
    if (a.hideDead) rows = rows.filter((r) => r.seeders !== 0);
    recordSuccess(p.id);
    return finish(rows.length ? 'done' : 'empty', rows);
  } catch (e) {
    if (e instanceof ProviderError) {
      if (e.kind === 'cancelled') return finish('error', [], 'Cancelled');
      // A check page is not a failure of the source: no health penalty. Without a solver URL it stays 'blocked'.
      if (e.kind === 'challenge') {
        return p.cloudflare ? finish('challenge', [], 'Needs a quick check') : finish('blocked', [], 'Blocked by a bot check');
      }
      recordFailure(p.id);
      if (e.kind === 'timeout') return finish('timeout', [], e.message);
      if (e.kind === 'blocked') return finish('blocked', [], e.message);
      return finish('error', [], e.message);
    }
    recordFailure(p.id);
    return finish('error', [], e instanceof Error ? e.message : 'Unexpected error');
  } finally {
    clearTimeout(timer);
    a.cancel?.removeEventListener('abort', onCancel);
    if (gateListener) controller.signal.removeEventListener('abort', gateListener);
  }
}

// ---------------------------------------------------------------- public API

/**
 * Runs the query on every eligible provider in parallel. `onUpdate` fires at start, after each
 * provider settles, and once more with done: true. The returned promise resolves to that final update.
 */
export async function searchAll(q: string, category: Category, opts: SearchOptions): Promise<SearchUpdate> {
  const providers = eligibleProviders(category, opts);
  const limit = opts.limit ?? 50;
  const waitMs = (opts.waitSeconds ?? 8) * 1000;
  const hideAdult = !opts.adult;
  const hideDead = opts.hideDead ?? true;
  const page = opts.page ?? 1;

  const statuses = new Map<string, SourceStatus>();
  const rows = new Map<string, SearchResult[]>();
  for (const p of providers) statuses.set(p.id, { providerId: p.id, state: 'searching', count: 0, ms: 0 });

  const snapshot = (done: boolean): SearchUpdate => ({
    results: sortResults(mergeResults(providers.flatMap((p) => rows.get(p.id) ?? []), opts.enabled), opts.sort),
    sources: providers.map((p) => ({ ...statuses.get(p.id)! })),
    done,
  });
  const emit = (u: SearchUpdate) => {
    try {
      opts.onUpdate?.(u);
    } catch {
      // A listener must not break the search.
    }
  };

  const trimmed = q.trim();
  if (!trimmed || providers.length === 0) {
    const u = snapshot(true);
    emit(u);
    return u;
  }

  emit(snapshot(false));
  await Promise.all(
    providers.map(async (p) => {
      const out = await runProvider({
        provider: p,
        q: trimmed,
        category,
        page,
        limit,
        hideAdult,
        hideDead,
        waitMs,
        mirrorOverride: opts.mirrorOverride?.[p.id] || undefined,
        cancel: opts.signal,
      });
      statuses.set(p.id, out.status);
      rows.set(p.id, out.results);
      emit(snapshot(false));
    }),
  );
  const final = snapshot(true);
  emit(final);
  return final;
}

export interface RerunOptions extends ProviderPrefs {
  mirrorOverride?: Record<string, string>;
  waitSeconds?: number;
  limit?: number;
  hideDead?: boolean;
  page?: number;
  signal?: AbortSignal;
}

/**
 * Re-runs one provider after the user solved its Cloudflare check. Exactly one attempt: if the host answers
 * with a challenge again it stays 'challenge' (the HTTP layer drops the clearance) and nothing loops.
 */
export async function rerunProvider(
  id: string,
  q: string,
  category: Category,
  opts: RerunOptions,
): Promise<{ status: SourceStatus; results: SearchResult[] } | null> {
  const p = lookup(id, opts.extraProviders);
  if (!p || !q.trim()) return null;
  return runProvider({
    provider: p,
    q: q.trim(),
    category,
    page: opts.page ?? 1,
    limit: opts.limit ?? 50,
    hideAdult: !opts.adult,
    hideDead: opts.hideDead ?? true,
    waitMs: (opts.waitSeconds ?? 8) * 1000,
    mirrorOverride: opts.mirrorOverride?.[p.id] || undefined,
    cancel: opts.signal,
  });
}

export interface TestOptions {
  extraProviders?: SearchProvider[];
  mirrorOverride?: Record<string, string>;
  waitSeconds?: number;
  signal?: AbortSignal;
}

/** One live probe for the provider sheet's Test now button. */
export async function testProvider(
  id: string,
  opts: TestOptions = {},
): Promise<{ ok: boolean; ms: number; count: number; message: string }> {
  const p = lookup(id, opts.extraProviders);
  if (!p) return { ok: false, ms: 0, count: 0, message: 'Unknown source' };
  const category: Category = p.categories.every((c) => c === 'adult') ? 'adult' : 'all';
  const out = await runProvider({
    provider: p,
    q: 'ubuntu',
    category,
    page: 1,
    limit: 10,
    hideAdult: category !== 'adult',
    hideDead: false,
    waitMs: (opts.waitSeconds ?? 8) * 1000,
    mirrorOverride: opts.mirrorOverride?.[p.id] || undefined,
    cancel: opts.signal,
  });
  const { state, count, ms, message } = out.status;
  if (state === 'done') return { ok: true, ms, count, message: `Working. ${count} result${count === 1 ? '' : 's'}.` };
  if (state === 'empty') return { ok: true, ms, count: 0, message: 'Reachable. No results for the test search.' };
  return { ok: false, ms, count: 0, message: message ?? 'Failed' };
}
