/**
 * Subtitle requests (docs/NATIVE_CONTRACT.md 44.1, 44.7). Pure rules plus the kv store `subtitles.requests`.
 * Search asks for subtitles through `askSubtitles`; the runner (components/subtitles/useSubtitleRequests.ts) works
 * the requests off and writes their phase back. Nothing here touches the network or the engine.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { kvGet, kvSet } from '../prefs/kv.ts';
import { languageRank } from './languages.ts';
import { addedAtSuffix } from './copy.ts';
import type { RankedSubtitle } from './rank.ts';
import type { SubtitleSourceStatus } from './search.ts';

// ---------------------------------------------------------------- the interface Search calls (44.1)

export interface SubtitleAsk {
  /** 't:<infoHash lowercase>' (torrent) or 'd:<downloadId>' (link). */
  key: string;
  /** Main line: parsed "Casino Royale (2006)" / "Severance S01 · 10 episodes". */
  title: string;
  /** Second line: "1080p · YTS · 2.1 GB", unknown parts left out. */
  detail: string;
  /** NATIVE_CONTRACT 42: the edited name. Absent means use the file name. */
  searchName?: string;
  /** Optional: epoch ms of the add. Tells identical rows apart in the multi-video sheet (44.9). */
  addedAt?: number;
}

export type RequestPhase = 'queued' | 'searching' | 'saved' | 'needs-pick' | 'none' | 'has-already' | 'offline' | 'limited' | 'skipped';

/** One video file's run inside a torrent request (a season pack has several). */
export interface FileRun {
  phase: RequestPhase;
  /** Searches that gave an answer. */
  tries: number;
}

export interface RequestEntry {
  ask: SubtitleAsk;
  auto: boolean;
  /** The phase of the whole request; for a torrent it is the roll-up of `files`. */
  phase: RequestPhase;
  tries: number;
  updatedAt: number;
  /** Torrents only, once the file list is known: one run per video file, by path. */
  files?: Record<string, FileRun>;
  /** Set with `needs-pick` when the only results were in a language the user didn't pick. */
  otherLang?: string;
}

/** 44.7: at most 100 entries, oldest dropped. */
export const MAX_REQUESTS = 100;
/** 44.7: a first search by name, then one more with the fingerprint. */
export const MAX_TRIES = 2;
/** 44.7: at most 2 searches at a time. */
export const MAX_CONCURRENT = 2;
/** Offline is tried again after this wait (and whenever the app comes back to the front). */
export const OFFLINE_RETRY_MS = 30_000;
/** A source that said limit is tried again after this wait. */
export const LIMITED_RETRY_MS = 5 * 60_000;
/** An item missing from the lists this long was removed for good (the undo window is 5 s, longer with TalkBack). */
export const REMOVAL_GRACE_MS = 30_000;

const KEY = 'subtitles.requests';

// ---------------------------------------------------------------- pure rules

/** Results to a phase (44.7 outcome table). `pick` is the row to save for `saved`. */
export interface Outcome {
  phase: 'saved' | 'needs-pick' | 'none';
  pick?: RankedSubtitle;
  /** Language of the results when only languages the user didn't pick have any. */
  otherLang?: string;
}

/**
 * 44.7: a `fits` result in the first language that has one is saved (the top-ranked one of that language). Only
 * `probably` / `maybe` results never save by themselves. Results only in other languages need a pick too.
 */
export function outcomeFromRanked(ranked: readonly RankedSubtitle[], languages: readonly string[]): Outcome {
  if (ranked.length === 0) return { phase: 'none' };
  const inLanguages = ranked.filter((r) => Number.isFinite(languageRank(r.candidate.language, languages)));
  // `ranked` is ordered by group, then by the user's language order: the first fits row is in the first language that has one.
  const fit = inLanguages.find((r) => r.group === 'fits');
  if (fit) return { phase: 'saved', pick: fit };
  if (inLanguages.length > 0) return { phase: 'needs-pick' };
  return { phase: 'needs-pick', otherLang: ranked[0].candidate.language };
}

/**
 * Nobody answered: limit when a source said so, otherwise offline (a network error or a timeout, tried again later).
 * Null when at least one source answered (then the results decide).
 */
export function outcomeFromSources(sources: readonly SubtitleSourceStatus[]): 'offline' | 'limited' | null {
  if (sources.length === 0) return null;
  if (sources.some((s) => s.state === 'done' || s.state === 'empty')) return null;
  if (sources.some((s) => s.state === 'searching')) return null;
  return sources.some((s) => s.state === 'limit') ? 'limited' : 'offline';
}

/** The phase of a whole pack from its files (44.7): `saved` only when all are saved, `needs-pick` if any needs one. */
export function rollUp(phases: readonly RequestPhase[]): RequestPhase {
  if (phases.length === 0) return 'queued';
  const has = (p: RequestPhase) => phases.includes(p);
  if (phases.every((p) => p === 'saved')) return 'saved';
  if (has('needs-pick')) return 'needs-pick';
  if (has('searching')) return 'searching';
  if (has('queued')) return 'queued';
  if (has('limited')) return 'limited';
  if (has('offline')) return 'offline';
  if (phases.every((p) => p === 'saved' || p === 'has-already')) return 'has-already';
  if (has('none')) return 'none';
  return phases.every((p) => p === 'skipped') ? 'skipped' : 'none';
}

export type RunKind = 'name' | 'fingerprint';

/** When an offline or limited run may go again. */
export function retryAt(run: Pick<FileRun, 'phase'>, updatedAt: number): number | null {
  if (run.phase === 'offline') return updatedAt + OFFLINE_RETRY_MS;
  if (run.phase === 'limited') return updatedAt + LIMITED_RETRY_MS;
  return null;
}

/**
 * Whether a video's run should start now, and how (44.7). A first search is by name as soon as bytes are on disk.
 * When the file has finished, a run that came from auto and ended `none` or `needs-pick` goes once more with the
 * fingerprint (`tries` stays at 2 or less). A typed name never gets a fingerprint (NATIVE_CONTRACT 42.4).
 */
export function planRun(
  run: FileRun,
  o: { started: boolean; complete: boolean; auto: boolean; typed: boolean; now: number; updatedAt: number },
): RunKind | null {
  if (!o.started) return null;
  switch (run.phase) {
    case 'queued':
      return 'name';
    case 'offline':
    case 'limited': {
      const at = retryAt(run, o.updatedAt);
      if (at === null || o.now < at) return null;
      return run.tries === 0 ? 'name' : o.complete && o.auto && !o.typed && run.tries < MAX_TRIES ? 'fingerprint' : null;
    }
    case 'none':
    case 'needs-pick':
      return o.complete && o.auto && !o.typed && run.tries >= 1 && run.tries < MAX_TRIES ? 'fingerprint' : null;
    default:
      return null;
  }
}

/** A run that needs nothing more from the engine's lists (so the runner can stop refreshing its file list). */
export function runSettled(run: FileRun, o: { auto: boolean; typed: boolean }): boolean {
  if (run.phase === 'saved' || run.phase === 'has-already' || run.phase === 'skipped') return true;
  if (run.phase === 'none' || run.phase === 'needs-pick') return !(o.auto && !o.typed && run.tries < MAX_TRIES);
  return false;
}

/** Item presence over time. After `graceMs` of being absent the request is deleted (44.7 removal). */
export function absence(absentSince: number | undefined, present: boolean, now: number, graceMs = REMOVAL_GRACE_MS): { state: 'present' | 'absent' | 'delete'; since?: number } {
  if (present) return { state: 'present' };
  const since = absentSince ?? now;
  return now - since >= graceMs ? { state: 'delete', since } : { state: 'absent', since };
}

/** Keeps the newest `max` entries (by `updatedAt`). Returns the same object when nothing is dropped. */
export function capRequests(all: Record<string, RequestEntry>, max = MAX_REQUESTS): Record<string, RequestEntry> {
  const keys = Object.keys(all);
  if (keys.length <= max) return all;
  const keep = new Set(keys.sort((a, b) => all[b].updatedAt - all[a].updatedAt).slice(0, max));
  const out: Record<string, RequestEntry> = {};
  for (const k of Object.keys(all)) if (keep.has(k)) out[k] = all[k];
  return out;
}

/** h:mm in the phone's local time, e.g. 9:05. */
export function clockHm(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 44.9: the title of each row, with " · added {h:mm}" appended to rows whose title and detail match another row's.
 * Without an `addedAt` nothing can be added.
 */
export function rowTitles(asks: readonly SubtitleAsk[]): string[] {
  const count = new Map<string, number>();
  for (const a of asks) count.set(`${a.title}\n${a.detail}`, (count.get(`${a.title}\n${a.detail}`) ?? 0) + 1);
  return asks.map((a) => ((count.get(`${a.title}\n${a.detail}`) ?? 0) > 1 && typeof a.addedAt === 'number' ? a.title + addedAtSuffix(clockHm(a.addedAt)) : a.title));
}

/** 44.12: a transfer is new when its `addedAt` (ms) is at or after the switch's on-time; with none, the time first seen. */
export function isNewSince(autoSince: number | null, addedAtMs: number | null | undefined, firstSeenMs: number): boolean {
  if (autoSince === null) return false;
  const t = typeof addedAtMs === 'number' && Number.isFinite(addedAtMs) && addedAtMs > 0 ? addedAtMs : firstSeenMs;
  return t >= autoSince;
}

/** `addedAt` may be seconds (torrents) or ms; anything below 1e11 is read as seconds. */
export const addedAtMs = (v: number | null | undefined): number | null => (typeof v === 'number' && v > 0 ? (v < 1e11 ? v * 1000 : v) : null);

const AUTO_SINCE_KEY = 'subtitles.autoSince';
export function getAutoSince(): number | null {
  const n = Number(kvGet(AUTO_SINCE_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
}
/** Settings: on sets the on-time (once), off clears it. */
export function syncAutoSince(on: boolean, now = Date.now()): void {
  if (!on) {
    if (getAutoSince() !== null) kvSet(AUTO_SINCE_KEY, '');
    return;
  }
  if (getAutoSince() === null) kvSet(AUTO_SINCE_KEY, String(now));
}

// ---------------------------------------------------------------- the store

let cache: Record<string, RequestEntry> | null = null;
let version = 0;
const listeners = new Set<() => void>();
/** Names typed in the multi-video sheet before the ask is made (44.9); askSubtitles picks them up. */
const typedNames = new Map<string, string>();

const PHASES: readonly string[] = ['queued', 'searching', 'saved', 'needs-pick', 'none', 'has-already', 'offline', 'limited', 'skipped'];

function cleanEntry(raw: unknown): RequestEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const a = o.ask as Record<string, unknown> | undefined;
  if (!a || typeof a.key !== 'string' || typeof a.title !== 'string' || typeof o.phase !== 'string' || !PHASES.includes(o.phase)) return null;
  const ask: SubtitleAsk = { key: a.key, title: a.title, detail: typeof a.detail === 'string' ? a.detail : '' };
  if (typeof a.searchName === 'string' && a.searchName) ask.searchName = a.searchName;
  if (typeof a.addedAt === 'number' && Number.isFinite(a.addedAt)) ask.addedAt = a.addedAt;
  // A killed app can't still be searching.
  const fix = (p: string): RequestPhase => (p === 'searching' ? 'queued' : (p as RequestPhase));
  const entry: RequestEntry = {
    ask,
    auto: o.auto === true,
    phase: fix(o.phase),
    tries: typeof o.tries === 'number' && Number.isFinite(o.tries) ? o.tries : 0,
    updatedAt: typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
  };
  if (typeof o.otherLang === 'string') entry.otherLang = o.otherLang;
  if (o.files && typeof o.files === 'object' && !Array.isArray(o.files)) {
    const files: Record<string, FileRun> = {};
    for (const [p, v] of Object.entries(o.files as Record<string, unknown>)) {
      const r = v as Record<string, unknown> | null;
      if (r && typeof r.phase === 'string' && PHASES.includes(r.phase)) files[p] = { phase: fix(r.phase), tries: typeof r.tries === 'number' ? r.tries : 0 };
    }
    entry.files = files;
  }
  return entry;
}

function load(): Record<string, RequestEntry> {
  if (cache) return cache;
  const out: Record<string, RequestEntry> = {};
  try {
    const raw = kvGet(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const e = cleanEntry(v);
        if (e) out[k] = e;
      }
    }
  } catch {
    // unreadable: start empty
  }
  cache = capRequests(out);
  return cache;
}

function commit(next: Record<string, RequestEntry>): void {
  cache = capRequests(next);
  try {
    kvSet(KEY, JSON.stringify(cache));
  } catch {
    // memory only
  }
  version++;
  listeners.forEach((l) => l());
}

export const getRequests = (): Record<string, RequestEntry> => load();
export const getRequestsVersion = (): number => version;
export function subscribeRequests(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** For tests: forget the in-memory copy and the stored one. */
export function resetRequestsForTests(): void {
  cache = {};
  typedNames.clear();
  try {
    kvSet(KEY, '{}');
  } catch {
    // memory only
  }
  version++;
}

/**
 * Asks for subtitles for these videos (44.1). A key already held is ignored (44.12), so the same video from two
 * paths is asked for once and a skipped key is never asked for again. A name typed for a held, unfinished key is kept.
 */
export function askSubtitles(asks: SubtitleAsk[], opts: { auto: boolean }): void {
  if (asks.length === 0) return;
  const now = Date.now();
  const cur = load();
  const next = { ...cur };
  for (const a of asks) {
    const typed = a.searchName ?? typedNames.get(a.key);
    typedNames.delete(a.key);
    const prev = next[a.key];
    if (prev) {
      if (typed && typed !== prev.ask.searchName && prev.phase !== 'skipped' && prev.phase !== 'saved' && prev.phase !== 'has-already') {
        next[a.key] = { ...prev, ask: { ...prev.ask, searchName: typed } };
      }
      continue;
    }
    const ask: SubtitleAsk = { ...a };
    if (typed) ask.searchName = typed;
    else delete ask.searchName;
    next[a.key] = { ask, auto: opts.auto, phase: 'queued', tries: 0, updatedAt: now };
  }
  if (Object.keys(next).length === Object.keys(cur).length && Object.keys(next).every((k) => next[k] === cur[k])) return;
  commit(next);
}

/** Removes the request quietly, and leaves a mark so Search still sees it was dealt with. The runner never runs it. */
export function skipSubtitles(key: string): void {
  const cur = load();
  const prev = cur[key];
  if (!prev) return;
  const files = prev.files ? Object.fromEntries(Object.keys(prev.files).map((p) => [p, { phase: 'skipped' as RequestPhase, tries: 0 }])) : undefined;
  commit({ ...cur, [key]: { ...prev, phase: 'skipped', files, updatedAt: Date.now() } });
}

/** Deletes a request and whatever it kept (removal, or no video in the torrent). */
export function deleteRequest(key: string): void {
  const cur = load();
  if (!(key in cur)) return;
  const next = { ...cur };
  delete next[key];
  commit(next);
}

/**
 * Multi-video sheet, choose mode: the name typed for a row. `askSubtitles` picks it up for that key. Null forgets it.
 */
export function setAskSearchName(key: string, name: string | null): void {
  if (name) typedNames.set(key, name);
  else typedNames.delete(key);
}

/** Status mode: search again for this request with another name (NATIVE_CONTRACT 42). Null goes back to the file name. */
export function renameRequest(key: string, searchName: string | null): void {
  const cur = load();
  const prev = cur[key];
  if (!prev) return;
  const ask: SubtitleAsk = { ...prev.ask };
  if (searchName) ask.searchName = searchName;
  else delete ask.searchName;
  const files = prev.files ? Object.fromEntries(Object.keys(prev.files).map((p) => [p, { phase: 'queued' as RequestPhase, tries: 0 }])) : undefined;
  commit({ ...cur, [key]: { ...prev, ask, phase: 'queued', tries: 0, files, otherLang: undefined, updatedAt: Date.now() } });
}

/**
 * The runner's write. `fileKey` null writes the request's own run (links); a path writes that file's run and rolls the
 * request up. Nothing is written, and nobody woken, when the phase and tries are already as given.
 */
export function setRun(key: string, fileKey: string | null, run: FileRun, extra?: { otherLang?: string | null }): void {
  const cur = load();
  const prev = cur[key];
  if (!prev) return;
  let entry: RequestEntry;
  if (fileKey === null) {
    entry = { ...prev, phase: run.phase, tries: run.tries };
  } else {
    const files = { ...(prev.files ?? {}), [fileKey]: run };
    entry = { ...prev, files, phase: rollUp(Object.values(files).map((f) => f.phase)), tries: Math.max(...Object.values(files).map((f) => f.tries)) };
  }
  if (extra && 'otherLang' in extra) {
    if (extra.otherLang) entry.otherLang = extra.otherLang;
    else delete entry.otherLang;
  }
  const same =
    entry.phase === prev.phase &&
    entry.tries === prev.tries &&
    entry.otherLang === prev.otherLang &&
    (fileKey === null || (prev.files?.[fileKey]?.phase === run.phase && prev.files?.[fileKey]?.tries === run.tries));
  if (same) return;
  entry.updatedAt = Date.now();
  commit({ ...cur, [key]: entry });
}

/** The runner learned a torrent's video files: one queued run per path (kept when already known), others dropped. */
export function setFileList(key: string, paths: readonly string[]): void {
  const cur = load();
  const prev = cur[key];
  if (!prev) return;
  const old = prev.files ?? {};
  const files: Record<string, FileRun> = {};
  for (const p of paths) files[p] = old[p] ?? { phase: prev.phase === 'skipped' ? 'skipped' : 'queued', tries: 0 };
  const sameKeys = Object.keys(old).length === paths.length && paths.every((p) => p in old);
  if (sameKeys) return;
  commit({ ...cur, [key]: { ...prev, files, phase: rollUp(Object.values(files).map((f) => f.phase)) } });
}

/** The phase of each key; keys without a request are left out. */
export function phasesFor(keys: readonly string[]): Record<string, RequestPhase | undefined> {
  const all = load();
  const out: Record<string, RequestPhase | undefined> = {};
  for (const k of keys) out[k] = all[k]?.phase;
  return out;
}

/** The phase of each key, live (44.1). */
export function useRequestPhases(keys: string[]): Record<string, RequestPhase | undefined> {
  const v = useSyncExternalStore(subscribeRequests, getRequestsVersion, getRequestsVersion);
  const joined = keys.join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => phasesFor(keys), [v, joined]);
}
