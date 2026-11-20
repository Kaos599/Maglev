/**
 * Subtitles for a season (docs/NATIVE_CONTRACT.md section 46). Pure: the candidates a run keeps when it ends in
 * needs-pick (46.4), the rule that says a stored candidate may be saved without asking (46.3), the episode rows of the
 * status sheet (46.1) and the bulk-save loop with its one retry (46.4). Nothing here touches the network, the engine or
 * the store: the callers pass those in.
 */
import { formatBytes } from '../../constants/format.ts';
import { languageRank } from './languages.ts';
import { episodePairs, isSeasonPack, sameTitleStrict, titleMatchesAlias } from './match.ts';
import { RELEASE_TAGS, parseName, parseTyped, stripName } from './parseName.ts';
import { PHASE_WORDS, episodeMain, episodeSaved } from './copy.ts';
import type { RankedSubtitle } from './rank.ts';
import type { FileRun, RequestEntry, RequestPhase } from './requests.ts';

// ---------------------------------------------------------------- stored candidates (46.4)

/**
 * What a needs-pick run keeps of a result: just enough to download it again and to judge it. Short keys keep kv small
 * (about 200 bytes each, two per run).
 */
export interface StoredCandidate {
  /** Provider id. */
  p: string;
  /** The candidate's id or download reference, as the source gave it. */
  id: string;
  /** Release name, cut to 120 characters. */
  rel: string;
  /** Language. */
  l: string;
  /** Title as `parseName` reads it from the release name. */
  t: string;
  /** Season and episode as parsed; absent when the release name states none. */
  s?: number;
  e?: number;
}

/** 46.4: at most this many candidates per run. */
const MAX_STORED = 2;
/** 46.4: bulk saves run at most this many at a time. */
const BULK_CONCURRENT = 2;
const REL_MAX = 120;

/** 46.4: the top result per language (at most 2), the languages the user picked first. Nothing else is kept. */
export function toStored(ranked: readonly RankedSubtitle[], languages: readonly string[], max = MAX_STORED): StoredCandidate[] {
  const inLanguages = ranked.filter((r) => Number.isFinite(languageRank(r.candidate.language, languages)));
  const others = ranked.filter((r) => !Number.isFinite(languageRank(r.candidate.language, languages)));
  const seen = new Set<string>();
  const out: StoredCandidate[] = [];
  for (const r of [...inLanguages, ...others]) {
    const c = r.candidate;
    if (seen.has(c.language)) continue;
    seen.add(c.language);
    const p = parseName(c.releaseName);
    const s: StoredCandidate = { p: c.providerId, id: c.id, rel: c.releaseName.slice(0, REL_MAX), l: c.language, t: p.title };
    if (p.season !== undefined) s.s = p.season;
    if (p.episode !== undefined) s.e = p.episode;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Reads stored candidates back from kv JSON; anything malformed is dropped. */
export function cleanStored(raw: unknown): StoredCandidate[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: StoredCandidate[] = [];
  for (const v of raw) {
    const o = v as Record<string, unknown> | null;
    if (!o || typeof o.p !== 'string' || typeof o.id !== 'string' || typeof o.rel !== 'string' || typeof o.l !== 'string' || typeof o.t !== 'string') continue;
    const c: StoredCandidate = { p: o.p, id: o.id, rel: o.rel, l: o.l, t: o.t };
    if (typeof o.s === 'number' && Number.isFinite(o.s)) c.s = o.s;
    if (typeof o.e === 'number' && Number.isFinite(o.e)) c.e = o.e;
    out.push(c);
    if (out.length >= MAX_STORED) break;
  }
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------- qualification (46.3)

export interface QualifyCtx {
  /** The show's title as the file names it. */
  show: string;
  season: number;
  episode: number;
  /** `effectiveLanguages`. */
  languages: readonly string[];
}

const MULTI_EPISODE = /s\d{1,2}[ ._-]?e\d{1,3}(?:[ ._-]?e\d{1,3}|[ ._-]?-[ ._-]?e?\d{1,3}|[ ._]*[+&][ ._]*e?\d{1,3})|\b\d{1,2}x\d{2,3}(?:-\d{2,3}|[ ._]?x\d{2,3})/i;

/** A release name that states more than one episode ("S02E01E02", "S02E01-E03", "S02E01 S02E02"). */
function isMultiEpisode(releaseName: string): boolean {
  return MULTI_EPISODE.test(releaseName) || episodePairs(releaseName).length > 1;
}

/**
 * 46.3: a stored candidate may be saved without asking only when all three hold:
 * - its title is the show's (strict title match, or an alias);
 * - its season and episode are the file's, and it is neither a season pack nor a multi-episode subtitle;
 * - its language is one of the user's.
 */
export function qualifies(c: StoredCandidate | undefined, x: QualifyCtx): boolean {
  if (!c) return false;
  if (!x.show || !c.t) return false;
  if (!titleMatchesAlias(x.show, c.t) && !sameTitleStrict(x.show, c.t)) return false;
  if (c.s !== x.season || c.e !== x.episode) return false;
  if (isMultiEpisode(c.rel) || isSeasonPack(c.rel, x.season)) return false;
  return Number.isFinite(languageRank(c.l, x.languages));
}

const baseOf = (path: string): string => path.replace(/^.*[\\/]/, '');

/** The show's name for a file: its own title, else the pack's title (without " · 23 episodes" or a season tag). */
function showTitle(fileName: string, askTitle: string): string {
  const own = parseName(fileName).title;
  if (own) return own;
  return parseTyped(askTitle.split(' · ')[0].replace(/[()]/g, '')).title;
}

/** The context to judge a file's candidates by, or null when the file name does not state a sure season and episode. */
export function runCtx(fileKey: string, askTitle: string, languages: readonly string[]): QualifyCtx | null {
  const p = parseName(baseOf(fileKey));
  if (p.episodeConfidence !== 'sure' || p.season === undefined || p.episode === undefined) return null;
  const show = showTitle(baseOf(fileKey), askTitle);
  return show ? { show, season: p.season, episode: p.episode, languages } : null;
}

export interface BestRun {
  /** The request's key (`t:<hash>`). */
  askKey: string;
  fileKey: string;
  /** The stored best candidate (the first one stored). */
  cand: StoredCandidate;
  ctx: QualifyCtx;
}

/** 46.3: the needs-pick episode runs whose best stored candidate qualifies. `k` is the length of this list. */
export function qualifyingRuns(entry: Pick<RequestEntry, 'files' | 'ask'> | undefined, languages: readonly string[]): BestRun[] {
  const files = entry?.files;
  if (!entry || !files || Object.keys(files).length < 2) return [];
  const out: BestRun[] = [];
  for (const [fileKey, r] of Object.entries(files)) {
    if (r.phase !== 'needs-pick' || !r.cands || r.cands.length === 0) continue;
    const ctx = runCtx(fileKey, entry.ask.title, languages);
    if (ctx && qualifies(r.cands[0], ctx)) out.push({ askKey: entry.ask.key, fileKey, cand: r.cands[0], ctx });
  }
  return out.sort((a, b) => a.ctx.season - b.ctx.season || a.ctx.episode - b.ctx.episode);
}

/** 46.5: the page row shows "Use best match" when its pack has at least one qualifying run, else "See all". */
export const pageRowAction = (k: number): 'use-best' | 'see-all' => (k >= 1 ? 'use-best' : 'see-all');

// ---------------------------------------------------------------- the episode rows (46.1)

export type EpisodeStart = 'results' | 'edit-name';

export interface EpisodeRow {
  askKey: string;
  /** The video's path inside the torrent: the key of its run. */
  fileKey: string;
  /** `S02E01 · Redemption`, or the file name without its extension when it can't be read. */
  main: string;
  /** `1.2 GB · Close match · pick`. */
  detail: string;
  phase: RequestPhase;
  /** The row is in the "needs you" group (sorted first). */
  needsYou: boolean;
  /** How the single sheet opens when the row is tapped; null when there is nothing to open yet. */
  start: EpisodeStart | null;
  /** Sort key: season and episode; null when unreadable. */
  order: [number, number] | null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const EP_TOKEN = /(?:^|[^a-z0-9])(?:s\d{1,2}[ ._-]?e\d{1,3}(?:(?:[ ._-]?e\d{1,3})|(?:-\d{1,3}))*|\d{1,2}x\d{2,3})(?![a-z0-9])/i;

/** The episode's own title from a file name ("Show.S02E01.Redemption.720p.mkv" gives "Redemption"), or "". */
function episodeTitle(fileName: string): string {
  const base = stripName(fileName).replace(/^\s*\[[^\]]*\]\s*/, '');
  const m = EP_TOKEN.exec(base);
  if (!m) return '';
  let rest = base.slice(m.index + m[0].length);
  const tag = RELEASE_TAGS.exec(rest);
  if (tag) rest = rest.slice(0, tag.index);
  rest = rest.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[\s-]+|[\s-]+$/g, '');
  // "-GROUP" right after the episode, with no tags, is the release group, not a title.
  return /^-[A-Za-z0-9]+$/.test(base.slice(m.index + m[0].length).trim()) ? '' : rest;
}

/** 46.1 main line. */
export function episodeLabel(fileKey: string): string {
  const name = baseOf(fileKey);
  const p = parseName(name);
  if (p.episodeConfidence === 'sure' && p.season !== undefined && p.episode !== undefined) return episodeMain(`S${pad2(p.season)}E${pad2(p.episode)}`, episodeTitle(name));
  return stripName(name);
}

const NEEDS_YOU: readonly RequestPhase[] = ['needs-pick', 'none', 'failed'];

/** 46.2: what opens, by phase. A run still waiting for its file has nothing to open. */
export function episodeStart(phase: RequestPhase): EpisodeStart | null {
  if (phase === 'none') return 'edit-name';
  if (phase === 'needs-pick' || phase === 'saved' || phase === 'has-already' || phase === 'skipped') return 'results';
  return null;
}

/** 46.1: the result in words. A saved episode names its language when it is known. */
export function episodeWord(phase: RequestPhase, language: string | null): string {
  return phase === 'saved' ? episodeSaved(language) : PHASE_WORDS[phase];
}

/** 46.1: a pack's request lists its video runs; one with a single run (or no file list yet) keeps its one row. */
export const isEpisodeRequest = (e: Pick<RequestEntry, 'files'> | undefined): boolean => !!e?.files && Object.keys(e.files).length >= 2;

/**
 * 46.1: one row per video file run. Rows that need you come first, then the rest in episode order; rows whose names
 * can't be read go last, by name. `langOf` gives the language of the subtitle saved next to a video, when known.
 */
export function episodeRows(entry: Pick<RequestEntry, 'files' | 'ask'>, langOf: (videoPath?: string) => string | null = () => null): EpisodeRow[] {
  const rows: EpisodeRow[] = Object.entries(entry.files ?? {}).map(([fileKey, r]) => {
    const p = parseName(baseOf(fileKey));
    const sure = p.episodeConfidence === 'sure' && p.season !== undefined && p.episode !== undefined;
    const word = episodeWord(r.phase, r.phase === 'saved' ? langOf(r.vp) : null);
    return {
      askKey: entry.ask.key,
      fileKey,
      main: episodeLabel(fileKey),
      detail: r.bytes && r.bytes > 0 ? `${formatBytes(r.bytes)} · ${word}` : word,
      phase: r.phase,
      needsYou: NEEDS_YOU.includes(r.phase),
      start: episodeStart(r.phase),
      order: sure ? [p.season as number, p.episode as number] : null,
    };
  });
  return sortRows(rows);
}

/** Needs-you rows first, then the rest; each group in episode order, unreadable names last. */
function sortRows(rows: EpisodeRow[]): EpisodeRow[] {
  const byEpisode = (a: EpisodeRow, b: EpisodeRow): number => {
    if (a.order && b.order) return a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.fileKey.localeCompare(b.fileKey);
    if (a.order) return -1;
    if (b.order) return 1;
    return a.fileKey.localeCompare(b.fileKey, undefined, { numeric: true });
  };
  return rows.slice().sort((a, b) => (a.needsYou === b.needsYou ? byEpisode(a, b) : a.needsYou ? -1 : 1));
}

/** The summary counts of a list of phases ("21 saved · 2 need you"). */
export function phaseCounts(phases: readonly (RequestPhase | undefined)[]): { saved: number; needsYou: number; waiting: number } {
  const c = { saved: 0, needsYou: 0, waiting: 0 };
  for (const p of phases) {
    if (p === 'saved') c.saved++;
    else if (p === 'needs-pick') c.needsYou++;
    else if (p === 'searching' || p === 'queued') c.waiting++;
  }
  return c;
}

// ---------------------------------------------------------------- bulk save (46.3, 46.4)

/** 'stay': not saved and not worth searching again (the name is taken, or there is nowhere to write). */
export type SaveResult = 'saved' | 'stay' | 'failed';

export interface BulkDeps {
  /** Downloads and saves one stored candidate for a run (choice 'normal'). */
  save(run: BestRun, cand: StoredCandidate): Promise<SaveResult>;
  /** Searches the run's episode again; its candidates best first, or null when the search could not run. */
  research(run: BestRun): Promise<StoredCandidate[] | null>;
  /** The run is still waiting for a pick and was not skipped, renamed or deleted since the bulk started. */
  valid(run: BestRun): boolean;
  /** A run was saved: the caller marks it (`markSaved`) and writes the card. */
  saved(run: BestRun): void;
  /** Called after each run ends, with how many have ended. */
  progress?(done: number, total: number): void;
}

export interface BulkOutcome {
  total: number;
  saved: number;
  /** Runs that stayed in needs-pick. */
  left: number;
  /** Runs that were searched again (each at most once). */
  retried: number;
}

/**
 * 46.3 and 46.4: saves each run's stored best candidate, at most `BULK_CONCURRENT` at a time. A download that fails
 * (an expired link, a source error) searches that one run again, once, and uses the new best candidate only if it
 * qualifies; otherwise the run stays in needs-pick. A taken name or a folder that can't be written is not retried.
 */
export async function runBulk(runs: readonly BestRun[], deps: BulkDeps, concurrency = BULK_CONCURRENT): Promise<BulkOutcome> {
  const out: BulkOutcome = { total: runs.length, saved: 0, left: 0, retried: 0 };
  let next = 0;
  let done = 0;
  const one = async (run: BestRun): Promise<void> => {
    let ok = false;
    try {
      if (deps.valid(run)) {
        let res = await deps.save(run, run.cand);
        if (res === 'failed' && deps.valid(run)) {
          out.retried++;
          const fresh = await deps.research(run);
          const best = fresh?.[0];
          if (best && qualifies(best, run.ctx) && deps.valid(run)) res = await deps.save(run, best);
        }
        if (res === 'saved' && deps.valid(run)) {
          deps.saved(run);
          ok = true;
        }
      }
    } catch {
      // a run that throws stays in needs-pick
    }
    if (ok) out.saved++;
    else out.left++;
    done++;
    deps.progress?.(done, runs.length);
  };
  const worker = async (): Promise<void> => {
    while (next < runs.length) {
      const run = runs[next++];
      await one(run);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, runs.length) }, worker));
  return out;
}

/** "Saving i of k": `done` runs have ended, so the one in progress is done + 1 (never above k). */
export const bulkIndex = (done: number, k: number): number => Math.min(done + 1, k);

/** The needs-pick episode runs of a pack that are left. */
export const needPickCount = (files: Record<string, FileRun> | undefined): number => Object.values(files ?? {}).filter((r) => r.phase === 'needs-pick').length;
