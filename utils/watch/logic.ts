// Watch for a title: pure logic. Contract: docs/contracts-0.19/watch.md.
// No React, no storage, no native calls, so scripts/test-watch.js can run it in Node.

import { formatBytes } from '../../constants/format.ts';
import { parseQuery, scoreResults } from '../assistant/scoring.ts';
import { parseRelease } from '../assistant/releaseName.ts';
import type { Category, MergedResult } from '../search/types.ts';

export const MAX_WATCHES = 20;
/** Keys remembered per watch. Enough for several pages of results across many runs. */
export const MAX_SEEN = 400;
export const INTERVALS = [1, 6, 24] as const;
export type IntervalHours = (typeof INTERVALS)[number];
export const DEFAULT_INTERVAL: IntervalHours = 6;
export const RESOLUTIONS = [480, 720, 1080, 2160] as const;
export type MinResolution = (typeof RESOLUTIONS)[number];

const HOUR_MS = 3_600_000;
/** WorkManager timing is inexact: a watch counts as due a little early so a run is not skipped a whole slot. */
const DUE_SLACK = 0.9;
const MIN_JOB_MINUTES = 15;
const DEFAULT_JOB_MINUTES = 360;
const QUERY_MAX = 120;
const CATEGORIES: readonly Category[] = ['all', 'movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other', 'adult'];

export interface Watch {
  id: string;
  query: string;
  category: Category;
  minResolution?: MinResolution;
  maxSizeGb?: number;
  mustContain: string[];
  intervalHours: IntervalHours;
  mobileData: boolean;
  paused: boolean;
  createdAt: number;
  /** Epoch ms, 0 = never. */
  lastCheckedAt: number;
  lastNewAt: number;
  lastNewName: string;
  /** Result keys already announced, or present when the watch first ran. Newest last. */
  seen: string[];
}

export interface WatchInput {
  query: string;
  category?: string;
  minResolution?: number;
  maxSizeGb?: number;
  mustContain?: string[];
  intervalHours?: number;
  mobileData?: boolean;
}

export interface NetworkState {
  connected: boolean;
  /** Not metered: Wi-Fi or Ethernet. */
  unmetered: boolean;
  /** The app-wide "Wi-Fi only" setting. */
  globalWifiOnly: boolean;
}

// ---------------------------------------------------------------- creation and repair

function cleanQuery(q: unknown): string {
  return typeof q === 'string' ? q.replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX) : '';
}

function pickInterval(v: unknown): IntervalHours {
  return (INTERVALS as readonly number[]).includes(v as number) ? (v as IntervalHours) : DEFAULT_INTERVAL;
}

function pickResolution(v: unknown): MinResolution | undefined {
  return (RESOLUTIONS as readonly number[]).includes(v as number) ? (v as MinResolution) : undefined;
}

function pickSize(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function pickCategory(v: unknown): Category {
  return (CATEGORIES as readonly string[]).includes(v as string) ? (v as Category) : 'all';
}

function words(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 8);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export function newWatch(input: WatchInput, now: number, rand: () => number = Math.random): Watch {
  return {
    id: `w_${now.toString(36)}${rand().toString(36).slice(2, 6)}`,
    query: cleanQuery(input.query),
    category: pickCategory(input.category),
    minResolution: pickResolution(input.minResolution),
    maxSizeGb: pickSize(input.maxSizeGb),
    mustContain: words(input.mustContain),
    intervalHours: pickInterval(input.intervalHours),
    mobileData: input.mobileData === true,
    paused: false,
    createdAt: now,
    lastCheckedAt: 0,
    lastNewAt: 0,
    lastNewName: '',
    seen: [],
  };
}

/** Repairs one stored row. Null when it is not a watch at all. */
export function normalizeWatch(raw: unknown): Watch | null {
  const o = raw as Partial<Record<keyof Watch, unknown>> | null;
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id) return null;
  const query = cleanQuery(o.query);
  if (!query) return null;
  return {
    id: o.id,
    query,
    category: pickCategory(o.category),
    minResolution: pickResolution(o.minResolution),
    maxSizeGb: pickSize(o.maxSizeGb),
    mustContain: words(o.mustContain),
    intervalHours: pickInterval(o.intervalHours),
    mobileData: o.mobileData === true,
    paused: o.paused === true,
    createdAt: num(o.createdAt),
    lastCheckedAt: num(o.lastCheckedAt),
    lastNewAt: num(o.lastNewAt),
    lastNewName: typeof o.lastNewName === 'string' ? o.lastNewName.slice(0, 200) : '',
    seen: Array.isArray(o.seen) ? o.seen.filter((s): s is string => typeof s === 'string').slice(-MAX_SEEN) : [],
  };
}

export function normalizeWatches(raw: unknown): Watch[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => normalizeWatch(r) ?? []).slice(0, MAX_WATCHES);
}

export function sameWatch(a: { query: string; category: string }, b: { query: string; category: string }): boolean {
  return normName(a.query) === normName(b.query) && a.category === b.category;
}

export type AddResult = { ok: true; list: Watch[]; watch: Watch } | { ok: false; error: string };

export const CAP_MESSAGE = `You can watch up to ${MAX_WATCHES} titles. Delete one first.`;
export const DUPLICATE_MESSAGE = 'You are already watching that.';

export function addWatch(list: readonly Watch[], input: WatchInput, now: number, rand?: () => number): AddResult {
  const w = newWatch(input, now, rand);
  if (!w.query) return { ok: false, error: 'Type what to watch for.' };
  if (list.some((x) => sameWatch(x, w))) return { ok: false, error: DUPLICATE_MESSAGE };
  if (list.length >= MAX_WATCHES) return { ok: false, error: CAP_MESSAGE };
  return { ok: true, list: [...list, w], watch: w };
}

// ---------------------------------------------------------------- keys and new-vs-seen

/** Lower-case letters and digits only, so "Prime.Time 2160p" and "prime time 2160P" are the same name. */
export function normName(name: string): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The keys a result is known by: its info hash (when it is a real one) and its normalized name. */
export function resultKeys(r: Pick<MergedResult, 'infoHash' | 'name'>): string[] {
  const keys: string[] = [];
  const h = (r.infoHash ?? '').toLowerCase();
  if (/^[0-9a-f]{40}$/.test(h)) keys.push(h);
  const n = normName(r.name);
  if (n) keys.push(`n:${n}`);
  return keys;
}

function resolutionOf(name: string): number | undefined {
  return parseRelease(name).resolution;
}

export function passesFilters(w: Watch, r: MergedResult): boolean {
  if (w.minResolution !== undefined) {
    const res = resolutionOf(r.name);
    if (res === undefined || res < w.minResolution) return false;
  }
  if (w.maxSizeGb !== undefined && r.sizeBytes !== undefined && r.sizeBytes > w.maxSizeGb * 1024 ** 3) return false;
  if (w.mustContain.length > 0) {
    const name = r.name.toLowerCase();
    if (!w.mustContain.every((word) => name.includes(word.toLowerCase()))) return false;
  }
  return true;
}

export interface Evaluation {
  /** First run of this watch: what matches is recorded, nothing is announced. */
  first: boolean;
  /** Everything that matched the title and filters. */
  matches: MergedResult[];
  /** Matches not seen before. Empty on the first run. */
  fresh: MergedResult[];
  /** The fresh match with the most sharing. */
  best?: MergedResult;
  nextSeen: string[];
}

/**
 * Decides what is new for one watch. Title matching reuses the assistant's scoring (scoring.ts), so "prime time"
 * matches "Primetime", a sequel or a cinema recording does not, then the watch's own filters apply.
 */
export function evaluateWatch(w: Watch, results: readonly MergedResult[], now: number): Evaluation {
  const parsed = parseQuery(w.query);
  const scored = scoreResults(results, {
    profile: 'phone',
    freeBytes: Number.MAX_SAFE_INTEGER / 4,
    pendingNeed: 0,
    stagingFactor: 1,
    warnUnsafe: false,
    providers: new Map(),
    query: { ...parsed, raw: w.query },
    category: w.category,
    now,
  });
  const matches = scored.ranked.map((r) => r.result).filter((r) => passesFilters(w, r));
  const first = w.lastCheckedAt === 0 && w.seen.length === 0;
  const known = new Set(w.seen);
  const fresh = first ? [] : matches.filter((r) => !resultKeys(r).some((k) => known.has(k)));
  const best = fresh.slice().sort((x, y) => (y.seeders ?? -1) - (x.seeders ?? -1))[0];
  const added = (first ? matches : fresh).flatMap(resultKeys);
  const nextSeen = [...w.seen, ...added.filter((k) => !known.has(k))].slice(-MAX_SEEN);
  return { first, matches, fresh, best, nextSeen };
}

// ---------------------------------------------------------------- scheduling

export function isDue(w: Watch, now: number): boolean {
  if (w.paused) return false;
  if (w.lastCheckedAt === 0) return true;
  return now - w.lastCheckedAt >= w.intervalHours * HOUR_MS * DUE_SLACK;
}

export function hasActive(list: readonly Watch[]): boolean {
  return list.some((w) => !w.paused);
}

/** The one background job runs this often: the shortest interval among active watches, never under 15 minutes. */
export function jobIntervalMinutes(list: readonly Watch[]): number {
  const active = list.filter((w) => !w.paused);
  if (active.length === 0) return DEFAULT_JOB_MINUTES;
  return Math.max(MIN_JOB_MINUTES, Math.min(...active.map((w) => w.intervalHours * 60)));
}

export function networkAllows(w: Watch, net: NetworkState): boolean {
  if (!net.connected) return false;
  if (net.unmetered) return true;
  return w.mobileData && !net.globalWifiOnly;
}

// ---------------------------------------------------------------- notification

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function watchNotificationText(w: Watch, r: MergedResult): { title: string; text: string } {
  const p = parseRelease(r.name);
  const name = (p.title ?? '').trim() || w.query;
  const title = `${name}${p.resolution ? ` ${p.resolution}p` : ''} is up`;
  const parts: string[] = [];
  if (r.sizeBytes !== undefined && r.sizeBytes > 0) parts.push(formatBytes(r.sizeBytes));
  if (r.seeders !== undefined && r.seeders >= 0) parts.push(`${r.seeders} sharing`);
  return { title, text: parts.length > 0 ? parts.join(' · ') : 'New result' };
}

export function openUrl(w: Pick<Watch, 'query' | 'category'>): string {
  return `maglev://search?q=${encodeURIComponent(w.query)}&c=${w.category}`;
}

/** The Add screen, which runs the usual space and safety checks. Nothing is added from the notification itself. */
export function downloadUrl(r: Pick<MergedResult, 'magnet'>): string | undefined {
  return /^magnet:\?/i.test(r.magnet ?? '') ? `maglev://add-torrent?source=${encodeURIComponent(r.magnet)}` : undefined;
}

/** Same as Kotlin: 7000 + (String.hashCode() and 0xFFFF). */
export function notificationId(watchId: string): number {
  let h = 0;
  for (let i = 0; i < watchId.length; i++) h = (Math.imul(31, h) + watchId.charCodeAt(i)) | 0;
  return 7000 + (h & 0xffff);
}

// ---------------------------------------------------------------- copy for the list

export function lastCheckedText(at: number, now: number): string {
  if (!at) return 'Not checked yet';
  const mins = Math.floor((now - at) / 60000);
  if (mins < 1) return 'Checked just now';
  if (mins < 60) return `Checked ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Checked ${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `Checked ${days} ${plural(days, 'day', 'days')} ago`;
}

export function filtersLine(w: Watch): string {
  const parts: string[] = [];
  if (w.minResolution !== undefined) parts.push(`${w.minResolution}p or better`);
  if (w.maxSizeGb !== undefined) parts.push(`up to ${w.maxSizeGb} GB`);
  if (w.mustContain.length > 0) parts.push(w.mustContain.join(', '));
  return parts.length > 0 ? parts.join(' · ') : 'Any quality';
}

export function intervalLabel(h: IntervalHours): string {
  return h === 1 ? 'Every hour' : h === 24 ? 'Every day' : `Every ${h} hours`;
}
