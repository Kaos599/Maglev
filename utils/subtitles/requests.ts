/**
 * Subtitle requests. Pure rules plus the kv store `subtitles.requests`.
 * Search asks for subtitles through `askSubtitles`; the runner (components/subtitles/useSubtitleRequests.ts) works
 * the requests off and writes their phase back. Nothing here touches the network or the engine.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { kvGet, kvSet } from '../prefs/kv.ts';
import { languageRank } from './languages.ts';
import { ordinalSuffix } from './copy.ts';
import { fileKind } from '../fileKind.ts';
import type { RankedSubtitle } from './rank.ts';
import type { SubtitleSourceStatus } from './search.ts';
import { cleanStored, type StoredCandidate } from './season.ts';

// ---------------------------------------------------------------- the interface Search calls

export interface SubtitleAsk {
  /** 't:<infoHash lowercase>' (torrent) or 'd:<downloadId>' (link). */
  key: string;
  /** Main line: parsed "Casino Royale (2006)" / "Severance S01 · 10 episodes". */
  title: string;
  /** Second line: "1080p · YTS · 2.1 GB", unknown parts left out. */
  detail: string;
  /** The edited name. Absent means use the file name. */
  searchName?: string;
  /** Optional: epoch ms of the add. Not used to tell rows apart any more; kept for old data. */
  addedAt?: number;
}

export type RequestPhase =
  | 'queued'
  | 'searching'
  | 'saved'
  | 'needs-pick'
  | 'none'
  | 'has-already'
  | 'offline'
  | 'limited'
  | 'skipped'
  | 'failed'
  | 'unavailable';

/** One video file's run inside a torrent request (a season pack has several). */
export interface FileRun {
  phase: RequestPhase;
  /** Searches that gave an answer. */
  tries: number;
  /** When this run last changed, so one episode's change never delays another's retry. */
  at?: number;
  /** Attempts in which no source answered (not counting offline). */
  fails?: number;
  /** A queued or limited run may go again at this time (epoch ms). */
  retryAt?: number;
  /** Maglev saved a subtitle for this video (the sheet or a run), so a taken name means saved. */
  saved?: boolean;
  /** The video's path, so deleting the request can clear its stored state. */
  vp?: string;
  /** The video's size, for the episode row's second line. */
  bytes?: number;
  /** A pack's run that ended in needs-pick keeps its top candidate per language (at most 2). Dropped with the phase. */
  cands?: StoredCandidate[];
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
  /** Bumped when the name changes; a run that finishes with an older epoch is dropped. */
  epoch?: number;
  /** The runner itself asked (automatic mode), so turning automatic mode off stops it. */
  byRunner?: boolean;
  /** A link's own run (it has no file list): the same fields a `FileRun` carries. */
  fails?: number;
  retryAt?: number;
  saved?: boolean;
  vp?: string;
}

/** At most 100 entries, oldest dropped. */
const MAX_REQUESTS = 100;
/** A first search by name, then one more with the fingerprint. */
export const MAX_TRIES = 2;
/** At most 2 searches at a time. */
export const MAX_CONCURRENT = 2;
/** A source that said limit is tried again after this wait. */
export const LIMITED_RETRY_MS = 5 * 60_000;
/** Attempts in which no source answered; the third one ends as `failed`. */
const MAX_FAILS = 3;
/** The wait after the 1st and the 2nd failed attempt (2 min, then 10 min; the 3rd ends it). */
const FAIL_RETRY_MS: readonly number[] = [2 * 60_000, 10 * 60_000, 30 * 60_000];
/** A failed getDetail waits 5 s, doubling, up to 60 s. */
const DETAIL_BACKOFF_START_MS = 5_000;
const DETAIL_BACKOFF_MAX_MS = 60_000;
/** At most this many getDetail calls at once. */
export const MAX_DETAIL_INFLIGHT = 3;
/** The torrent's file list is read again at most this often while a video still needs something. */
const DETAIL_EVERY_MS = 5_000;
/** An item missing from the lists this long was removed for good (the undo window is 5 s, longer with TalkBack). */
export const REMOVAL_GRACE_MS = 30_000;

const KEY = 'subtitles.requests';

// ---------------------------------------------------------------- pure rules

/** Results to a phase. `pick` is the row to save for `saved`. */
export interface Outcome {
  phase: 'saved' | 'needs-pick' | 'none';
  pick?: RankedSubtitle;
  /** Language of the results when only languages the user didn't pick have any. */
  otherLang?: string;
}

/**
 * A `fits` result in the first language that has one is saved (the top-ranked one of that language). Only
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
 * Nobody answered: `limited` when a source said so; `offline` only when the phone itself has no internet;
 * any other failure (a timeout, an error, a challenge) is `failed`, which counts an attempt. Null when at least one
 * source answered (then the results decide).
 */
export function outcomeFromSources(sources: readonly SubtitleSourceStatus[], online = true): 'offline' | 'limited' | 'failed' | null {
  if (sources.length === 0) return null;
  if (sources.some((s) => s.state === 'done' || s.state === 'empty')) return null;
  if (sources.some((s) => s.state === 'searching')) return null;
  if (!online) return 'offline';
  return sources.some((s) => s.state === 'limit') ? 'limited' : 'failed';
}

/** What a run becomes after no source answered. `offline` never counts an attempt and waits for the network. */
export function afterFailure(kind: 'offline' | 'limited' | 'failed', prev: FileRun, now: number): FileRun {
  const keep = { tries: prev.tries, saved: prev.saved, vp: prev.vp, at: now };
  if (kind === 'offline') return { ...keep, phase: 'offline', fails: prev.fails ?? 0 };
  const fails = (prev.fails ?? 0) + 1;
  if (fails >= MAX_FAILS) return { ...keep, phase: 'failed', fails };
  if (kind === 'limited') return { ...keep, phase: 'limited', fails, retryAt: now + LIMITED_RETRY_MS };
  return { ...keep, phase: 'queued', fails, retryAt: now + FAIL_RETRY_MS[Math.min(fails - 1, FAIL_RETRY_MS.length - 1)] };
}

/** The phase of a whole pack from its files: `saved` only when all are saved, `needs-pick` if any needs one. */
export function rollUp(phases: readonly RequestPhase[]): RequestPhase {
  if (phases.length === 0) return 'queued';
  const has = (p: RequestPhase) => phases.includes(p);
  if (phases.every((p) => p === 'saved')) return 'saved';
  if (has('needs-pick')) return 'needs-pick';
  if (has('searching')) return 'searching';
  if (has('queued')) return 'queued';
  if (has('limited')) return 'limited';
  if (has('offline')) return 'offline';
  if (has('failed')) return 'failed';
  if (phases.every((p) => p === 'saved' || p === 'has-already')) return 'has-already';
  if (has('none')) return 'none';
  if (phases.every((p) => p === 'unavailable')) return 'unavailable';
  return phases.every((p) => p === 'skipped') ? 'skipped' : 'none';
}

/** The card icon of a pack, from the roll-up of its episode runs. `clear` removes the stored state. */
export function packCardState(phases: readonly RequestPhase[]): 'getting' | 'saved' | 'needs-look' | 'none' | 'clear' {
  const r = rollUp(phases);
  if (r === 'saved') return 'saved';
  if (r === 'needs-pick') return 'needs-look';
  if (r === 'searching' || r === 'queued') return 'getting';
  if (r === 'has-already' || r === 'skipped') return 'clear';
  return 'none';
}

export type RunKind = 'name' | 'fingerprint';

/** When a queued or limited run may go again. Offline runs have no time: they wait for the network. */
export function retryAt(run: Pick<FileRun, 'phase' | 'retryAt'>): number | null {
  if ((run.phase === 'queued' || run.phase === 'limited') && typeof run.retryAt === 'number') return run.retryAt;
  return null;
}

/**
 * Whether a video's run should start now, and how. A first search is by name as soon as bytes are on
 * disk. When the file has finished, a run that ended `none` or `needs-pick` goes once more with the fingerprint, for
 * manual asks as well as automatic ones (`tries` stays at 2 or less). A typed name never gets a fingerprint.
 * An offline run goes when the network is back. `auto` is no longer a condition.
 */
export function planRun(
  run: FileRun,
  o: { started: boolean; complete: boolean; typed: boolean; now: number; online?: boolean; auto?: boolean; updatedAt?: number },
): RunKind | null {
  if (!o.started) return null;
  const again = (): RunKind => (run.tries === 0 ? 'name' : o.complete && !o.typed && run.tries < MAX_TRIES ? 'fingerprint' : 'name');
  switch (run.phase) {
    case 'queued':
    case 'limited': {
      const at = retryAt(run);
      if (at !== null && o.now < at) return null;
      return again();
    }
    case 'offline':
      return o.online === false ? null : again();
    case 'none':
    case 'needs-pick':
      return o.complete && !o.typed && run.tries >= 1 && run.tries < MAX_TRIES ? 'fingerprint' : null;
    default:
      return null;
  }
}

/** A run that needs nothing more from the engine's lists (so the runner can stop refreshing its file list). */
export function runSettled(run: FileRun, o: { typed: boolean; auto?: boolean }): boolean {
  if (run.phase === 'saved' || run.phase === 'has-already' || run.phase === 'skipped' || run.phase === 'failed' || run.phase === 'unavailable') return true;
  if (run.phase === 'none' || run.phase === 'needs-pick') return o.typed || run.tries >= MAX_TRIES;
  return false;
}

/** The request's own run: a link's whole request, or (for a torrent) its roll-up. */
export const ownRun = (e: RequestEntry): FileRun => ({ phase: e.phase, tries: e.tries, fails: e.fails, retryAt: e.retryAt, saved: e.saved, vp: e.vp });

/** A request whose runs are all settled needs no file list at all. */
export function requestSettled(e: RequestEntry): boolean {
  const typed = !!e.ask.searchName;
  const runs = e.files ? Object.values(e.files) : null;
  if (runs && runs.length > 0) return runs.every((r) => runSettled(r, { typed }));
  return runSettled(ownRun(e), { typed });
}

/** The wait after `fails` failed getDetail calls: 5 s, doubling, up to 60 s. */
export const detailBackoffMs = (fails: number): number => (fails <= 0 ? 0 : Math.min(DETAIL_BACKOFF_MAX_MS, DETAIL_BACKOFF_START_MS * 2 ** (fails - 1)));

/** When a torrent's file list may be fetched next. 0 means now. */
export function nextDetailAt(o: { lastOkAt?: number; fail?: { fails: number; at: number } }): number {
  if (o.fail && o.fail.fails > 0) return o.fail.at + detailBackoffMs(o.fail.fails);
  return o.lastOkAt !== undefined ? o.lastOkAt + DETAIL_EVERY_MS : 0;
}

/** Whether the runner reads a torrent's file list now. */
export function detailDue(o: { needed: boolean; changed: boolean; now: number; at: number; busy: number }): boolean {
  return o.needed && o.changed && o.busy < MAX_DETAIL_INFLIGHT && o.now >= o.at;
}

/**
 * Item presence over time. After `graceMs` of being absent the request is deleted. While the lists have
 * not loaded live from the engine (`live` false) nothing is absent: the cache is not proof.
 */
export function absence(absentSince: number | undefined, present: boolean, now: number, graceMs = REMOVAL_GRACE_MS, live = true): { state: 'present' | 'absent' | 'delete'; since?: number } {
  if (present || !live) return { state: 'present' };
  const since = absentSince ?? now;
  return now - since >= graceMs ? { state: 'delete', since } : { state: 'absent', since };
}

/** Phases that need nothing more, for the cap. */
export const isSettledPhase = (p: RequestPhase): boolean => p !== 'queued' && p !== 'searching' && p !== 'offline' && p !== 'limited';

/**
 * Keeps at most `max` entries. It never evicts a request whose transfer is still in the lists (`present`),
 * nor one that is not settled; it drops settled requests of absent transfers, oldest first. With no `present` (lists
 * not known yet) nothing is dropped. Returns the same object when nothing is dropped.
 */
export function capRequests(all: Record<string, RequestEntry>, max = MAX_REQUESTS, present: ReadonlySet<string> | null = null): Record<string, RequestEntry> {
  const keys = Object.keys(all);
  if (keys.length <= max || present === null) return all;
  const evictable = keys.filter((k) => !present.has(k) && isSettledPhase(all[k].phase)).sort((a, b) => all[a].updatedAt - all[b].updatedAt);
  const drop = new Set(evictable.slice(0, keys.length - max));
  if (drop.size === 0) return all;
  const out: Record<string, RequestEntry> = {};
  for (const k of keys) if (!drop.has(k)) out[k] = all[k];
  return out;
}

/**
 * The title of each row, with " · 2nd", " · 3rd" and so on added to rows whose title and detail match an
 * earlier row's, in add order. The first of a kind keeps its plain title.
 */
export function rowTitles(asks: readonly SubtitleAsk[]): string[] {
  const seen = new Map<string, number>();
  return asks.map((a) => {
    const id = `${a.title}\n${a.detail}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n > 1 ? a.title + ordinalSuffix(n) : a.title;
  });
}

/** A pack row (several episodes) has no pencil and no single typed name. */
export function isPackAsk(ask: Pick<SubtitleAsk, 'title'>, files?: Record<string, FileRun>): boolean {
  if (files && Object.keys(files).length >= 2) return true;
  return / · \d+ episodes$/.test(ask.title) || /\bS\d{1,2}$/i.test(ask.title);
}

// ---------------------------------------------------------------- what counts as new

/** A transfer is new in automatic mode when its key is not in the baseline taken when the switch turned on. */
export function isNewTransfer(key: string, baseline: ReadonlySet<string> | null): boolean {
  return baseline !== null && !baseline.has(key);
}

const BASELINE_KEY = 'subtitles.autoBaseline';
export function getAutoBaseline(): Set<string> | null {
  try {
    const raw = kvGet(BASELINE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : null;
  } catch {
    return null;
  }
}
/**
 * The switch follows the baseline. Off clears it. On takes it from the ids present in both engine lists; when the
 * lists have not loaded live (`present` null) it waits for the first live load. An existing baseline is kept.
 */
export function syncAutoBaseline(on: boolean, present: readonly string[] | null): 'off' | 'kept' | 'pending' | 'taken' {
  if (!on) {
    if (getAutoBaseline() !== null) kvSet(BASELINE_KEY, '');
    return 'off';
  }
  if (getAutoBaseline() !== null) return 'kept';
  if (present === null) return 'pending';
  kvSet(BASELINE_KEY, JSON.stringify([...new Set(present)]));
  return 'taken';
}

/** A link's name decides video only once it has an extension; before that it is unknown, not "no". */
export function linkNameKind(name: string): 'video' | 'not-video' | 'unknown' {
  if (!/\.[A-Za-z0-9]{1,6}$/.test(name)) return 'unknown';
  return fileKind(name) === 'video' ? 'video' : 'not-video';
}

// ---------------------------------------------------------------- abort registry

/**
 * One map of running searches, shared by this module and the runner: request key and file to the controller, and
 * the video it works on (so the sheet can stop the run for one video of a pack).
 */
const aborters = new Map<string, { ctl: AbortController; videoPath?: string }>();
const runKeyOf = (key: string, fileKey: string | null): string => `${key}\n${fileKey ?? ''}`;
export function registerRun(key: string, fileKey: string | null, ctl: AbortController, videoPath?: string): void {
  aborters.set(runKeyOf(key, fileKey), { ctl, videoPath });
}
export function unregisterRun(key: string, fileKey: string | null, ctl?: AbortController): void {
  const rk = runKeyOf(key, fileKey);
  if (!ctl || aborters.get(rk)?.ctl === ctl) aborters.delete(rk);
}
export const isRunning = (key: string, fileKey: string | null): boolean => aborters.has(runKeyOf(key, fileKey));
export const runningCount = (): number => aborters.size;
/** Aborts every running search or save of this request. */
export function abortKey(key: string): void {
  for (const [rk, r] of aborters) if (rk.startsWith(`${key}\n`)) r.ctl.abort();
}
/** Aborts every running search whose request key matches. */
export function abortWhere(pred: (key: string) => boolean): void {
  for (const [rk, r] of aborters) if (pred(rk.slice(0, rk.indexOf('\n')))) r.ctl.abort();
}
function resetAbortersForTests(): void {
  aborters.forEach((r) => r.ctl.abort());
  aborters.clear();
  holds.clear();
  writers.clear();
}

// ---------------------------------------------------------------- the sheet takes a video over

/**
 * While the one-video sheet is open, it owns the video: the runner starts no search and no save for it, so the two
 * never write a subtitle for the same video. Writing is tracked apart from holding because the phone's write can't
 * be stopped: a write still under way when the sheet opens (the runner's) or closes (the sheet's) finishes, and the
 * next writer waits for it.
 */
const holds = new Map<string, number>();
const writers = new Map<string, number>();
const writeWaiters = new Map<string, (() => void)[]>();
const videoKeyOf = (key: string, videoPath: string): string => `${key.startsWith('t:') ? key.toLowerCase() : key}\n${videoPath}`;

/** Nudges whoever reads the requests (the runner) without changing them, so a released video is looked at again. */
function nudge(): void {
  version++;
  listeners.forEach((l) => l());
}

/** The sheet opens for this video: any automatic search for it is cancelled. Returns the release, safe to call twice. */
export function holdVideo(key: string, videoPath: string): () => void {
  const vk = videoKeyOf(key, videoPath);
  holds.set(vk, (holds.get(vk) ?? 0) + 1);
  for (const [rk, r] of aborters) if (videoKeyOf(rk.slice(0, rk.indexOf('\n')), r.videoPath ?? '') === vk) r.ctl.abort();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (holds.get(vk) ?? 1) - 1;
    if (n > 0) holds.set(vk, n);
    else holds.delete(vk);
    nudge();
  };
}
export const isHeld = (key: string, videoPath: string): boolean => holds.has(videoKeyOf(key, videoPath));

/** A subtitle write for this video starts. Returns its end, safe to call twice. */
export function beginWrite(key: string, videoPath: string): () => void {
  const vk = videoKeyOf(key, videoPath);
  writers.set(vk, (writers.get(vk) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const n = (writers.get(vk) ?? 1) - 1;
    if (n > 0) {
      writers.set(vk, n);
      return;
    }
    writers.delete(vk);
    const waiting = writeWaiters.get(vk) ?? [];
    writeWaiters.delete(vk);
    waiting.forEach((w) => w());
    nudge();
  };
}
export const isWriting = (key: string, videoPath: string): boolean => writers.has(videoKeyOf(key, videoPath));

/** Resolves once no write for this video is under way. */
export function writesDone(key: string, videoPath: string): Promise<void> {
  const vk = videoKeyOf(key, videoPath);
  if (!writers.has(vk)) return Promise.resolve();
  return new Promise((resolve) => writeWaiters.set(vk, [...(writeWaiters.get(vk) ?? []), resolve]));
}

// ---------------------------------------------------------------- epoch and state writes

/** A finishing run whose epoch is old, or whose request is gone, is dropped. */
export function epochOk(entry: Pick<RequestEntry, 'epoch'> | undefined, epoch: number): boolean {
  return !!entry && (entry.epoch ?? 0) === epoch;
}

/** A card or state write is allowed only for a request that still exists with the same epoch. A skipped one takes only `saved` (the file is on disk). */
export function canWriteState(entry: Pick<RequestEntry, 'epoch' | 'phase'> | undefined, epoch: number, state: string): boolean {
  if (!epochOk(entry, epoch)) return false;
  return entry!.phase !== 'skipped' || state === 'saved';
}

/** A taken name or an existing sidecar means `saved` when Maglev saved one for this video, else `has-already`. */
export const resolveExisting = (prev: Pick<FileRun, 'saved'>): 'saved' | 'has-already' => (prev.saved ? 'saved' : 'has-already');

/** A video gone from disk keeps an earlier `needs-pick` instead of turning into `none`. */
export const afterMissing = (prev: RequestPhase): 'needs-pick' | 'none' => (prev === 'needs-pick' ? 'needs-pick' : 'none');

/** A re-added torrent whose video files have no bytes on disk lost its files, so its old request starts again. */
export function videosGone(files: readonly { path: string; length: number; progressBytes: number; included?: boolean }[]): boolean {
  const videos = files.filter((f) => f.included !== false && f.length > 0 && fileKind(f.path) === 'video');
  return videos.length > 0 && videos.every((f) => f.progressBytes === 0);
}

/** The sidecar is never written while the torrent is being moved. */
export const canWriteNow = (torrentState: string | undefined): boolean => torrentState !== 'MOVING';

/** Whether the runner works on this request now. The runner's own automatic requests stop with the switch. */
export function shouldRun(e: Pick<RequestEntry, 'byRunner'>, o: { enabled: boolean; providers: number; autoOn: boolean }): boolean {
  if (!o.enabled || o.providers < 1) return false;
  return !e.byRunner || o.autoOn;
}

/** The video paths whose stored state a deleted request clears (every episode, and the remembered one). */
export function statePathsToClear(e: Pick<RequestEntry, 'files' | 'vp'> | undefined, remembered?: string | null): string[] {
  const out = new Set<string>();
  for (const r of Object.values(e?.files ?? {})) if (r.vp) out.add(r.vp);
  if (e?.vp) out.add(e.vp);
  if (remembered) out.add(remembered);
  return [...out];
}

const requeue = (r: Pick<FileRun, 'saved' | 'vp' | 'bytes'>): FileRun => ({ phase: 'queued', tries: 0, saved: r.saved, vp: r.vp, ...(r.bytes ? { bytes: r.bytes } : {}) });

/** A removed hash re-added within the grace starts again: runs go back to `queued`; `skipped` and what Maglev saved are kept. */
export function resetEntryForReturn(e: RequestEntry): RequestEntry {
  if (e.phase === 'skipped') return e;
  const { fails: _f, retryAt: _r, ...rest } = e;
  void _f;
  void _r;
  if (e.files) {
    const files = Object.fromEntries(Object.entries(e.files).map(([p, r]) => [p, r.phase === 'skipped' ? r : requeue(r)]));
    return { ...rest, files, phase: rollUp(Object.values(files).map((f) => f.phase)), tries: 0, otherLang: undefined };
  }
  return { ...rest, phase: 'queued', tries: 0, otherLang: undefined };
}

// ---------------------------------------------------------------- the store

let cache: Record<string, RequestEntry> | null = null;
let version = 0;
let presentKeys: ReadonlySet<string> | null = null;
const listeners = new Set<() => void>();
/** Names typed in the multi-video sheet before the ask is made; askSubtitles picks them up. */
const typedNames = new Map<string, string>();

const PHASES: readonly string[] = ['queued', 'searching', 'saved', 'needs-pick', 'none', 'has-already', 'offline', 'limited', 'skipped', 'failed', 'unavailable'];

/** Optional run fields, read from stored JSON. */
function extras(r: Record<string, unknown>): Pick<FileRun, 'at' | 'fails' | 'retryAt' | 'saved' | 'vp' | 'bytes' | 'cands'> {
  const out: Pick<FileRun, 'at' | 'fails' | 'retryAt' | 'saved' | 'vp' | 'bytes' | 'cands'> = {};
  if (typeof r.bytes === 'number' && Number.isFinite(r.bytes) && r.bytes > 0) out.bytes = r.bytes;
  const cands = cleanStored(r.cands);
  if (cands) out.cands = cands;
  if (typeof r.at === 'number' && Number.isFinite(r.at)) out.at = r.at;
  if (typeof r.fails === 'number' && Number.isFinite(r.fails)) out.fails = r.fails;
  if (typeof r.retryAt === 'number' && Number.isFinite(r.retryAt)) out.retryAt = r.retryAt;
  if (r.saved === true) out.saved = true;
  if (typeof r.vp === 'string') out.vp = r.vp;
  return out;
}

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
    ...extras(o),
  };
  if (typeof o.otherLang === 'string') entry.otherLang = o.otherLang;
  if (typeof o.epoch === 'number' && Number.isFinite(o.epoch)) entry.epoch = o.epoch;
  if (o.byRunner === true) entry.byRunner = true;
  if (o.files && typeof o.files === 'object' && !Array.isArray(o.files)) {
    const files: Record<string, FileRun> = {};
    for (const [p, v] of Object.entries(o.files as Record<string, unknown>)) {
      const r = v as Record<string, unknown> | null;
      if (r && typeof r.phase === 'string' && PHASES.includes(r.phase)) files[p] = { phase: fix(r.phase), tries: typeof r.tries === 'number' ? r.tries : 0, ...extras(r) };
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
  cache = out;
  return cache;
}

function commit(next: Record<string, RequestEntry>): void {
  cache = capRequests(next, MAX_REQUESTS, presentKeys);
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

/** The runner tells the store which transfers are in the engine's lists. Null until they loaded live. */
export function setPresentKeys(keys: ReadonlySet<string> | null): void {
  presentKeys = keys;
}

/** For tests: forget the in-memory copy and the stored one. */
export function resetRequestsForTests(): void {
  resetAbortersForTests();
  cache = {};
  typedNames.clear();
  presentKeys = null;
  try {
    kvSet(KEY, '{}');
  } catch {
    // memory only
  }
  version++;
}

/**
 * Asks for subtitles for these videos. A key already held is ignored, so the same video from two
 * paths is asked for once and a skipped key is never asked for again. A name typed for a held, unfinished key is kept.
 * A held key's empty `title` or `detail` is filled in from the richer ask, and a runner's thinner ask gives
 * way to the tray's.
 */
export function askSubtitles(asks: SubtitleAsk[], opts: { auto: boolean; byRunner?: boolean }): void {
  if (asks.length === 0) return;
  const now = Date.now();
  const cur = load();
  const next = { ...cur };
  for (const a of asks) {
    const typed = a.searchName ?? typedNames.get(a.key);
    typedNames.delete(a.key);
    const prev = next[a.key];
    if (prev) {
      let entry = prev;
      if (typed && typed !== prev.ask.searchName && prev.phase !== 'skipped' && prev.phase !== 'saved' && prev.phase !== 'has-already') {
        entry = { ...entry, ask: { ...entry.ask, searchName: typed } };
      }
      const richer = !opts.byRunner && entry.byRunner;
      const title = (!entry.ask.title || richer) && a.title ? a.title : entry.ask.title;
      const detail = entry.ask.detail || a.detail;
      if (title !== entry.ask.title || detail !== entry.ask.detail) entry = { ...entry, ask: { ...entry.ask, title, detail } };
      if (richer) {
        const { byRunner: _b, ...rest } = entry;
        void _b;
        entry = rest;
      }
      if (entry !== prev) next[a.key] = entry;
      continue;
    }
    const ask: SubtitleAsk = { ...a };
    if (typed) ask.searchName = typed;
    else delete ask.searchName;
    next[a.key] = { ask, auto: opts.auto, phase: 'queued', tries: 0, updatedAt: now, ...(opts.byRunner ? { byRunner: true } : {}) };
  }
  if (Object.keys(next).length === Object.keys(cur).length && Object.keys(next).every((k) => next[k] === cur[k])) return;
  commit(next);
}

/**
 * Skip: marks the request `skipped`, aborts any running search or save for it, and leaves any subtitle
 * already written on disk. The runner never runs it again.
 */
export function skipSubtitles(key: string): void {
  const cur = load();
  const prev = cur[key];
  abortKey(key);
  if (!prev) return;
  const files = prev.files ? Object.fromEntries(Object.entries(prev.files).map(([p, r]) => [p, { ...r, phase: 'skipped' as RequestPhase }])) : undefined;
  commit({ ...cur, [key]: { ...prev, phase: 'skipped', files, updatedAt: Date.now() } });
}

/** "not this one". Writes a `skipped` mark for keys that hold nothing yet, so automatic mode leaves them alone. */
export function markNotThisOne(asks: readonly SubtitleAsk[]): void {
  const cur = load();
  const next = { ...cur };
  const now = Date.now();
  for (const a of asks) if (!next[a.key]) next[a.key] = { ask: { ...a }, auto: false, phase: 'skipped', tries: 0, updatedAt: now };
  if (Object.keys(next).length !== Object.keys(cur).length) commit(next);
}

/** Deletes a request and whatever it kept (removal, or no video in the torrent). */
export function deleteRequest(key: string): void {
  const cur = load();
  abortKey(key);
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
/** Names typed in a sheet that was closed without asking are forgotten. */
export function clearAskSearchNames(keys: readonly string[]): void {
  for (const k of keys) typedNames.delete(k);
}
/**
 * Status mode: search again for this request with another name. Null goes back to the file name.
 * Aborts the running search and bumps the epoch, so a run that finishes late is dropped.
 */
export function renameRequest(key: string, searchName: string | null): void {
  const cur = load();
  const prev = cur[key];
  if (!prev) return;
  abortKey(key);
  const ask: SubtitleAsk = { ...prev.ask };
  if (searchName) ask.searchName = searchName;
  else delete ask.searchName;
  const files = prev.files ? Object.fromEntries(Object.entries(prev.files).map(([p, r]) => [p, requeue(r)])) : undefined;
  const { fails: _f, retryAt: _r, ...rest } = prev;
  void _f;
  void _r;
  commit({ ...cur, [key]: { ...rest, ask, phase: 'queued', tries: 0, files, otherLang: undefined, epoch: (prev.epoch ?? 0) + 1, updatedAt: Date.now() } });
}

/** "Try again" on a `failed` request. */
export function retryRequest(key: string): void {
  const cur = load();
  const prev = cur[key];
  if (!prev) return;
  const redo = (r: FileRun): FileRun => (r.phase === 'failed' ? requeue(r) : r);
  if (prev.files) {
    const files = Object.fromEntries(Object.entries(prev.files).map(([p, r]) => [p, redo(r)]));
    commit({ ...cur, [key]: { ...prev, files, phase: rollUp(Object.values(files).map((f) => f.phase)), updatedAt: Date.now() } });
    return;
  }
  if (prev.phase !== 'failed') return;
  const { fails: _f, retryAt: _r, ...rest } = prev;
  void _f;
  void _r;
  commit({ ...cur, [key]: { ...rest, phase: 'queued', tries: 0, updatedAt: Date.now() } });
}

/** What the sheet hands back when it closes without a save: what its own search found. */
export interface HandBack {
  phase: 'needs-pick' | 'none' | 'queued';
  otherLang?: string;
  /** The sheet searched a finished file with its fingerprint, so the runner has nothing more to try. */
  fingerprinted: boolean;
}

/**
 * The sheet that took this video over closed without a save. A run it took over (queued or searching) becomes what
 * the sheet found, so the row never stays on "Getting subtitles…" with nothing running. Rows found: waiting for
 * a pick. Every source answered with nothing: none. Closed before anything came: queued, and the runner tries again.
 * Returns the phase written, or null when the run had already moved on (saved, skipped, or never asked).
 */
export function handBack(key: string, videoPath: string, fileKey: string | null, result: HandBack): RequestPhase | null {
  const cur = load();
  const k = key.startsWith('t:') ? key.toLowerCase() : key;
  const prev = cur[k];
  if (!prev) return null;
  let fk: string | null = null;
  if (prev.files && Object.keys(prev.files).length > 0) {
    const paths = Object.keys(prev.files);
    fk = fileKey && prev.files[fileKey] ? fileKey : (paths.find((p) => prev.files![p].vp === videoPath) ?? (paths.length === 1 ? paths[0] : null));
    if (!fk) return null;
  }
  const run = fk ? prev.files![fk] : ownRun(prev);
  if (run.phase !== 'queued' && run.phase !== 'searching') return null;
  const tries = result.phase === 'queued' ? run.tries : result.fingerprinted ? MAX_TRIES : Math.max(run.tries, 1);
  const next: FileRun = { phase: result.phase, tries, vp: videoPath, ...(run.saved ? { saved: true } : {}), ...(run.bytes ? { bytes: run.bytes } : {}) };
  setRun(k, fk, next, { otherLang: result.phase === 'needs-pick' ? (result.otherLang ?? null) : null, epoch: prev.epoch ?? 0 });
  return result.phase;
}

/** Back after a removal within the grace. */
export function resetRequest(key: string): void {
  const cur = load();
  const prev = cur[key];
  if (!prev) return;
  const next = resetEntryForReturn(prev);
  if (next === prev) return;
  commit({ ...cur, [key]: { ...next, updatedAt: Date.now() } });
}

/**
 * The sheet saved a subtitle for this video. The request becomes `saved` (for a pack, that episode's run),
 * and the run remembers that Maglev saved one, so a taken name later is `saved`, not `has-already`.
 */
export function markSaved(key: string, fileKey?: string | null): void {
  const cur = load();
  const prev = cur[key];
  if (!prev) return;
  let entry: RequestEntry;
  if (prev.files && Object.keys(prev.files).length > 0) {
    const paths = Object.keys(prev.files);
    const fk = fileKey && prev.files[fileKey] ? fileKey : paths.length === 1 ? paths[0] : null;
    const f = fk ? prev.files[fk] : undefined;
    if (!fk || !f) return;
    const { cands: _c, ...rest } = f;
    void _c;
    const files = { ...prev.files, [fk]: { ...rest, phase: 'saved' as RequestPhase, saved: true, at: Date.now() } };
    entry = { ...prev, files, phase: rollUp(Object.values(files).map((x) => x.phase)) };
  } else {
    entry = { ...prev, phase: 'saved', saved: true, tries: Math.max(prev.tries, 1) };
  }
  delete entry.otherLang;
  entry.updatedAt = Date.now();
  commit({ ...cur, [key]: entry });
}

const sameRun = (a: FileRun, b: FileRun): boolean => a.phase === b.phase && a.tries === b.tries && a.fails === b.fails && a.retryAt === b.retryAt && a.saved === b.saved && a.vp === b.vp && JSON.stringify(a.cands) === JSON.stringify(b.cands);

/**
 * The runner's write. `fileKey` null writes the request's own run (links); a path writes that file's run and rolls the
 * request up. Nothing is written, and nobody woken, when the run is already as given.
 * A skipped request or run is never overwritten, and a write with an old `epoch` or for a deleted request is
 * dropped. Each file run keeps its own `at`.
 */
export function setRun(key: string, fileKey: string | null, run: FileRun, extra?: { otherLang?: string | null; epoch?: number }): void {
  const cur = load();
  const prev = cur[key];
  if (!prev) return;
  if (extra?.epoch !== undefined && !epochOk(prev, extra.epoch)) return;
  if (prev.phase === 'skipped' && run.phase !== 'skipped') return;
  if (fileKey !== null && prev.files?.[fileKey]?.phase === 'skipped' && run.phase !== 'skipped') return;
  const now = Date.now();
  let entry: RequestEntry;
  let before: FileRun;
  if (fileKey === null) {
    before = ownRun(prev);
    const { fails: _f, retryAt: _r, saved: _s, vp: _v, ...rest } = prev;
    void _f;
    void _r;
    void _s;
    void _v;
    entry = { ...rest, phase: run.phase, tries: run.tries };
    if (run.fails !== undefined) entry.fails = run.fails;
    if (run.retryAt !== undefined) entry.retryAt = run.retryAt;
    if (run.saved) entry.saved = true;
    if (run.vp) entry.vp = run.vp;
  } else {
    before = prev.files?.[fileKey] ?? { phase: 'queued', tries: -1 };
    // The size is kept across the runner's writes; the candidates belong to this run only.
    const bytes = run.bytes ?? prev.files?.[fileKey]?.bytes;
    const files = { ...(prev.files ?? {}), [fileKey]: { ...run, ...(bytes ? { bytes } : {}), at: now } };
    entry = { ...prev, files, phase: rollUp(Object.values(files).map((f) => f.phase)), tries: Math.max(...Object.values(files).map((f) => f.tries)) };
  }
  if (extra && 'otherLang' in extra) {
    if (extra.otherLang) entry.otherLang = extra.otherLang;
    else delete entry.otherLang;
  }
  if (sameRun(before, run) && entry.phase === prev.phase && entry.tries === prev.tries && entry.otherLang === prev.otherLang) return;
  entry.updatedAt = now;
  commit({ ...cur, [key]: entry });
}

/** The runner learned a torrent's video files: one queued run per path (kept when already known), others dropped. */
export function setFileList(key: string, paths: readonly string[], sizes?: Readonly<Record<string, number>>): void {
  const cur = load();
  const prev = cur[key];
  if (!prev) return;
  const old = prev.files ?? {};
  const files: Record<string, FileRun> = {};
  let sizesChanged = false;
  for (const p of paths) {
    const run = old[p] ?? { phase: prev.phase === 'skipped' ? 'skipped' : 'queued', tries: 0 };
    const n = sizes?.[p];
    // The size shows on the episode row's second line.
    if (n && n > 0 && run.bytes !== n) {
      files[p] = { ...run, bytes: n };
      sizesChanged = true;
    } else files[p] = run;
  }
  const sameKeys = Object.keys(old).length === paths.length && paths.every((p) => p in old);
  if (sameKeys && !sizesChanged) return;
  commit({ ...cur, [key]: { ...prev, files, phase: rollUp(Object.values(files).map((f) => f.phase)) } });
}

/** The phase of each key; keys without a request are left out. */
export function phasesFor(keys: readonly string[]): Record<string, RequestPhase | undefined> {
  const all = load();
  const out: Record<string, RequestPhase | undefined> = {};
  for (const k of keys) out[k] = all[k]?.phase;
  return out;
}

/** The phase of each key, live. */
export function useRequestPhases(keys: string[]): Record<string, RequestPhase | undefined> {
  const v = useSyncExternalStore(subscribeRequests, getRequestsVersion, getRequestsVersion);
  const joined = keys.join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => phasesFor(keys), [v, joined]);
}
