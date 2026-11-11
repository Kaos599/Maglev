import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { maglevEngine } from 'maglev-engine';
import type { FeedAutomationConfig, FeedRule } from 'maglev-engine';
import { loadFeeds } from '../feeds';

/** Contract: docs/NATIVE_CONTRACT.md section 11.6. */
const KEY = 'maglev.feeds.automation.v1';

export type IntervalMins = 15 | 30 | 60;
export const INTERVALS: readonly IntervalMins[] = [15, 30, 60];

/** What the app persists. The feed list is added from loadFeeds() when pushing. */
export interface FeedAutomationPrefs {
  enabled: boolean;
  intervalMins: IntervalMins;
  rules: FeedRule[];
}

function normalizeRule(x: unknown): FeedRule | null {
  const r = x as Partial<FeedRule> | null;
  if (!r || typeof r.id !== 'string') return null;
  return {
    id: r.id,
    name: typeof r.name === 'string' ? r.name : '',
    feedIds: Array.isArray(r.feedIds) ? r.feedIds.filter((f): f is string => typeof f === 'string') : [],
    include: typeof r.include === 'string' ? r.include : '',
    exclude: typeof r.exclude === 'string' ? r.exclude : '',
    episodes: r.episodes === 'new_only' ? 'new_only' : 'all',
    startPaused: r.startPaused === true,
    enabled: r.enabled !== false,
  };
}

function normalize(raw: unknown): FeedAutomationPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    intervalMins: o.intervalMins === 15 || o.intervalMins === 60 ? o.intervalMins : 30,
    rules: Array.isArray(o.rules) ? o.rules.flatMap((r) => normalizeRule(r) ?? []) : [],
  };
}

let cache: FeedAutomationPrefs | null = null;
const listeners = new Set<() => void>();

export function getFeedAutomation(): FeedAutomationPrefs {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = Storage.getItemSync(KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    // Storage unavailable: defaults for this session.
  }
  cache = normalize(parsed);
  return cache;
}

/** The config Kotlin receives: prefs plus the current feed list. A rule whose chosen feeds are all gone is sent disabled, never as "all feeds". */
export function buildNativeConfig(p: FeedAutomationPrefs = getFeedAutomation()): FeedAutomationConfig {
  const feeds = loadFeeds().map((f) => ({ id: f.id, url: f.url, name: f.name }));
  const ids = new Set(feeds.map((f) => f.id));
  const rules = p.rules.map((r) => {
    if (r.feedIds.length === 0) return r;
    const kept = r.feedIds.filter((id) => ids.has(id));
    return kept.length === 0 ? { ...r, enabled: false } : { ...r, feedIds: kept };
  });
  return { enabled: p.enabled, intervalMins: p.intervalMins, feeds, rules };
}

/** Pushes to Kotlin. Call at app start, on every change here, and after the Feeds tab changes the feed list. */
export async function syncFeedAutomationToNative(): Promise<void> {
  try {
    await maglevEngine.setFeedAutomation(buildNativeConfig());
  } catch {
    // Native side unavailable: the next change or app start retries.
  }
}

export function updateFeedAutomation(
  change: Partial<FeedAutomationPrefs> | ((p: FeedAutomationPrefs) => Partial<FeedAutomationPrefs>),
): FeedAutomationPrefs {
  const prev = getFeedAutomation();
  const patch = typeof change === 'function' ? change(prev) : change;
  const next = normalize({ ...prev, ...patch });
  cache = next;
  try {
    Storage.setItemSync(KEY, JSON.stringify(next));
  } catch {
    // Kept in memory only.
  }
  listeners.forEach((l) => l());
  void syncFeedAutomationToNative();
  return next;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useFeedAutomation(): [FeedAutomationPrefs, typeof updateFeedAutomation] {
  const p = useSyncExternalStore(subscribe, getFeedAutomation, getFeedAutomation);
  return [p, updateFeedAutomation];
}

export function newFeedRule(): FeedRule {
  return {
    id: `frule_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    feedIds: [],
    include: '',
    exclude: '',
    episodes: 'new_only',
    startPaused: false,
    enabled: true,
  };
}

/** Short value for the Settings list. */
export function feedAutomationSummary(p: FeedAutomationPrefs): string {
  if (!p.enabled) return 'Off';
  const n = p.rules.length;
  return `Every ${p.intervalMins} min · ${n} ${n === 1 ? 'rule' : 'rules'}`;
}
