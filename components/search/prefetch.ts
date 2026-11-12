// Reads one search result's file list in the background, so "Add" -> choose files opens at once.
//
// The read is the same call the Add screen makes (resolveMetadata: librqbit list_only, which never
// adds the torrent or writes a file). Rules:
// - one read at a time; starting another cancels the previous one unless the Add screen took it;
// - results are kept by info hash for the session (a torrent's file list never changes);
// - a failed read is not cached and is not tried again for a while;
// - the Add screen takes a finished or running read with take(); a taken read is never cancelled here.
import type { EngineResult, Metadata } from 'maglev-engine';

export type MetadataResult = EngineResult<Metadata>;

export interface PrefetchEngine {
  resolveMetadata(source: string, timeoutMs: number): Promise<MetadataResult>;
  cancelResolve(infoHash: string): Promise<unknown>;
}

export interface PrefetchOptions {
  /** How long one background read may look for peers. Shorter than the Add screen's 60 s. */
  timeoutMs?: number;
  /** Finished reads kept for the session; the oldest go first. */
  maxEntries?: number;
  /** A hash whose read failed is not read again for this long. */
  retryAfterMs?: number;
  now?: () => number;
}

export const PREFETCH_TIMEOUT_MS = 30_000;

interface Entry {
  promise: Promise<MetadataResult>;
  result: MetadataResult | null;
  claimed: boolean;
}

export class MetadataPrefetcher {
  private readonly engine: PrefetchEngine;
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly retryAfterMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly failedAt = new Map<string, number>();
  private running: string | null = null;

  constructor(engine: PrefetchEngine, opts: PrefetchOptions = {}) {
    this.engine = engine;
    this.timeoutMs = opts.timeoutMs ?? PREFETCH_TIMEOUT_MS;
    this.maxEntries = opts.maxEntries ?? 20;
    this.retryAfterMs = opts.retryAfterMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** The hash being read right now and not yet taken by the Add screen, or null. */
  get runningHash(): string | null {
    return this.running;
  }

  has(infoHash: string): boolean {
    return this.entries.has(infoHash.toLowerCase());
  }

  /** A finished, successful read, or null. Does not mark it taken. */
  peek(infoHash: string): MetadataResult | null {
    const e = this.entries.get(infoHash.toLowerCase());
    return e?.result?.ok ? e.result : null;
  }

  /**
   * Starts a background read of a magnet. Returns false when nothing started: not a magnet, already
   * read or reading, or failed recently.
   */
  start(infoHash: string, magnet: string): boolean {
    const key = (infoHash || '').toLowerCase();
    if (!key || !/^magnet:/i.test(magnet || '')) return false;
    if (this.entries.has(key)) return false;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && this.now() - failed < this.retryAfterMs) return false;
    this.cancel();

    const entry: Entry = { promise: Promise.resolve(null as unknown as MetadataResult), result: null, claimed: false };
    entry.promise = this.engine.resolveMetadata(magnet, this.timeoutMs).then(
      (res) => {
        this.settle(key, entry, res);
        return res;
      },
      (err) => {
        this.settle(key, entry, null);
        throw err;
      },
    );
    // A read nobody takes must not surface as an unhandled rejection.
    entry.promise.catch(() => {});
    this.entries.set(key, entry);
    this.running = key;
    return true;
  }

  /** Cancels the running read unless the Add screen has taken it. Safe to call at any time. */
  cancel(): void {
    const key = this.running;
    if (!key) return;
    const e = this.entries.get(key);
    this.running = null;
    if (!e || e.claimed || e.result) return;
    this.entries.delete(key);
    this.engine.cancelResolve(key).catch(() => {});
  }

  /** Cancels only when `infoHash` is the running read (for example before adding that torrent directly). */
  cancelIf(infoHash: string): void {
    if (this.running && this.running === infoHash.toLowerCase()) this.cancel();
  }

  /**
   * For the Add screen: the read for this hash, finished or still running, or null when there is
   * none. A taken read is never cancelled by the search screen.
   */
  take(infoHash: string): Promise<MetadataResult> | null {
    const key = (infoHash || '').toLowerCase();
    const e = this.entries.get(key);
    if (!e) return null;
    e.claimed = true;
    if (this.running === key) this.running = null;
    if (e.result) return Promise.resolve(e.result);
    return e.promise;
  }

  private settle(key: string, entry: Entry, res: MetadataResult | null): void {
    if (this.running === key && this.entries.get(key) === entry) this.running = null;
    if (this.entries.get(key) !== entry) return; // cancelled and dropped already
    if (res && res.ok) {
      entry.result = res;
      this.failedAt.delete(key);
      this.trim();
      return;
    }
    // Failures (including a cancel) are not kept: the Add screen reads again itself.
    this.entries.delete(key);
    if (!res || res.code !== 'CANCELLED') this.failedAt.set(key, this.now());
  }

  private trim(): void {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, e] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (e.result && key !== this.running) this.entries.delete(key);
    }
  }
}

export interface NetworkFacts {
  /** Settings > Network > Wi-Fi only. */
  wifiOnly: boolean;
  torrents: ReadonlyArray<{ state: string; pausedBy?: string | null }>;
  downloads?: ReadonlyArray<{ state: string; pausedBy?: string | null }>;
}

/**
 * Whether a background read may use the network now. JS cannot see the link type, so:
 * - Wi-Fi only off: the user allows any network, so yes.
 * - Wi-Fi only on: only with proof the Wi-Fi rule is not blocking right now, meaning a transfer is
 *   moving and nothing is paused for Wi-Fi. Without proof (an empty list, all paused) the answer is no.
 */
export function prefetchAllowed(n: NetworkFacts): boolean {
  if (!n.wifiOnly) return true;
  const rows = [...n.torrents, ...(n.downloads ?? [])];
  if (rows.some((r) => r.pausedBy === 'wifi_only')) return false;
  return n.torrents.some((t) => t.state === 'DOWNLOADING' || t.state === 'SEEDING') || (n.downloads ?? []).some((d) => d.state === 'downloading');
}
