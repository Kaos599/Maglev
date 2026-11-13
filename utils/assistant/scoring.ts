/**
 * Quality scoring and shortlist for the assistant (docs/ASSISTANT_DESIGN.md §3, review round 1).
 *
 * Pure: no React, no react-native, no engine, no clock unless the caller omits
 * `ctx.now`. Free space and pending need come in as arguments. The model never
 * ranks anything; this code does, and the model only words the result.
 *
 * Rows are keyed by info hash. This module assigns no handles; the runner issues
 * r1, r2, ... through HandleRegistry (R1-10).
 *
 * Section numbers in comments point at docs/ASSISTANT_DESIGN.md.
 */
import { formatBytes } from '../../constants/format.ts';
import { admit } from '../admission.ts';
import type { AdmissionResult } from '../admission.ts';
import { riskySources } from '../search/safety.ts';
import type { Category, MergedResult } from '../search/types.ts';
import type { PlaybackSupport } from '../../modules/maglev-engine/src/MaglevEngine.types';
import type { SafetyLevel, SafetyResult } from './fileSafety.ts';
import { playbackVerdict } from './playback.ts';
import { detectLanguages, hasAudioLanguage, languageLabel, parseRelease } from './releaseName.ts';
import type { LanguageInfo, LanguageWant, ParsedRelease, SourceKind } from './releaseName.ts';
import {
  DEFAULT_ANIME_EPISODE_RUNTIME_MIN, DEFAULT_EPISODE_RUNTIME_MIN, DEFAULT_FILM_RUNTIME_MIN, SMALL_FRACTION, TOO_SMALL_FRACTION, sizeBand,
} from './sizeBands.ts';
import type { BandCodec } from './sizeBands.ts';

const GB = 1024 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- types

export type Profile = 'phone' | 'tv' | 'archive';

/** §3.1. Fields marked "extra" are additions the design leaves open. */
export interface ScoreContext {
  profile: Profile;
  runtimeMin?: number;
  freeBytes: number;
  pendingNeed: number;
  stagingFactor: 1 | 2;
  maxBytes?: number;
  /** The phone's real codec probe. Absent or null means unknown, and unknown never scores as playable. */
  playback?: PlaybackSupport | null;
  warnUnsafe: boolean;
  providers: ReadonlyMap<string, { name: string; unsafeReason?: string }>;
  /**
   * `raw` is the user's query text before parsing ("ubuntu 24.04"). Non-video releases are matched on it, so a
   * version number the query parser read as part of a title still counts.
   */
  query: { title: string; year?: number; season?: number; episode?: number; raw?: string };
  /** Extra. The category searched. apps, games, books, music and other are matched on the raw name, not as films. */
  category?: Category;
  /** Extra. §3.2: CAM/TS/TC/SCR show only if the user says "earliest possible". */
  allowEarlySources?: boolean;
  /** Extra. §3.3 playability "+1 multiAudio when the user asked for a language the name lists". */
  wantsMultiAudio?: boolean;
  /**
   * Extra. The audio language the user asked for, from normalizeLanguage ("hindi", "multi" for dual audio, or a plain
   * word Maglev doesn't list). Rows whose name gives it rank first; the rest stay in the list, lower, with a reason.
   */
  audioLanguage?: LanguageWant;
  /** Extra. Subtitles the user asked for: "any", or a language. Rows whose name gives them rank first. */
  subtitles?: 'any' | LanguageWant;
  /** Extra. Episode count per season pack, keyed by info hash. Needed for pack sanity and `partial_fits`. */
  packEpisodeCounts?: ReadonlyMap<string, number>;
  /** Extra. File-list safety keyed by info hash (see `safetyForShortlist`). A red row is never shortlisted. */
  safety?: ReadonlyMap<string, SafetyResult | null>;
  /** Extra. Epoch ms. Defaults to Date.now(); pass it for deterministic tests. */
  now?: number;
}

export type Tier = 'recommended' | 'ok' | 'avoid';
export type Label = 'best-fit' | 'smaller' | 'best-quality';
export type ExcludeReason = 'cam_source' | 'wrong_title' | 'adult' | 'broken_size';

export interface Ranked {
  /** The info hash. Handles (r1, r2, ...) come from HandleRegistry in the runner, never from here. */
  id: string;
  score: number;
  tier: Tier;
  /** First of `labels`, kept for the §3.5 shape. */
  label?: Label;
  labels: Label[];
  reasons: string[];
  flags: string[];
  /** null only when the size is unknown (`size_unknown`): there is nothing to admit. */
  admission: { result: AdmissionResult; leftAfter: number } | null;
  /** Extras for callers: the source row, the parsed name and the score parts. */
  result: MergedResult;
  parsed: ParsedRelease;
  breakdown: { quality: number; playability: number; health: number; sanity: number; fit: number; penalties: number };
  /** File-list safety, when the runner has checked this row. */
  safety?: SafetyResult | null;
  /** Season pack that does not fit whole: how many episodes would. */
  partialEpisodes?: number;
  /** Set only when the user asked for an audio language or subtitles: how well the name matches. */
  preference?: { audio?: 'yes' | 'maybe' | 'no'; subtitles?: 'yes' | 'maybe' | 'no' };
}

export interface Excluded {
  /** The info hash. */
  id: string;
  result: MergedResult;
  reason: ExcludeReason;
  detail: string;
}

export interface ScoreOutput {
  /** Every non-excluded result, best first. */
  ranked: Ranked[];
  /** At most three, labelled by code (§3.5). */
  shortlist: Ranked[];
  excluded: Excluded[];
  /** Notes about the whole list. Shown once, not on every row. */
  notes: string[];
}

/** Said once per list, not on every row (R1-15). */
export const SEEDER_NOTE = 'Sharing counts come from the sites and can be out of date.';

// ---------------------------------------------------------------- tables

/** §3.3 Quality: source points as [phone/tv, archive]. */
const SOURCE_POINTS: Record<SourceKind, [number, number]> = {
  bluray: [24, 24], // §3.3 source table "bluray encode | 24 | 24"
  webdl: [24, 22], // "webdl | 24 | 22"
  remux: [16, 24], // "remux | 16 | 24"
  webrip: [19, 17], // "webrip | 19 | 17"
  web: [17, 15], // "web (unspecified) | 17 | 15"
  hdtv: [13, 11], // "hdtv | 13 | 11"
  hdrip: [10, 8], // "hdrip | 10 | 8"
  dvdrip: [7, 7], // "dvdrip | 7 | 7"
  unknown: [8, 8], // "unknown | 8 | 8"
  // Early sources are open in §3. They only appear when the user asked for them; they rank below dvdrip.
  cam: [2, 2],
  ts: [3, 3],
  tc: [4, 4],
  scr: [5, 5],
};

/** Glossary-consistent labels. 'unknown' is omitted from headlines (R1-15). */
const SOURCE_LABEL: Record<SourceKind, string | undefined> = {
  bluray: 'BluRay', webdl: 'WEB-DL', remux: 'REMUX', webrip: 'WEBRip', web: 'WEB', hdtv: 'HDTV',
  hdrip: 'HDRip', dvdrip: 'DVDRip', cam: 'CAM', ts: 'TS', tc: 'TC', scr: 'SCR', unknown: undefined,
};

/**
 * A video whose content size is below these is not what its name says (a placeholder, a text file, or a source that
 * reported the .torrent file's own size). Any video category: under 1 MB. Movies and TV episodes: under 50 MB.
 * Unknown sizes never count.
 */
const BROKEN_ANY_VIDEO_BYTES = 1024 * 1024;
const BROKEN_MOVIE_TV_BYTES = 50 * 1024 * 1024;

/** True when the size is known and far too small for a video of this kind. */
function brokenSize(r: MergedResult, parsed: ParsedRelease): boolean {
  if (r.sizeBytes === undefined || !(r.sizeBytes > 0)) return false;
  const cat = r.category;
  const videoCat = cat === 'movies' || cat === 'tv' || cat === 'anime';
  // A row with no clear category counts as video only when its name says so (a resolution or a video source).
  const nameSaysVideo = parsed.resolution !== undefined || (parsed.source !== 'unknown');
  const isVideo = videoCat || ((cat === undefined || cat === 'all' || cat === 'other') && nameSaysVideo);
  if (!isVideo) return false;
  if (r.sizeBytes < BROKEN_ANY_VIDEO_BYTES) return true;
  return cat !== 'anime' && r.sizeBytes < BROKEN_MOVIE_TV_BYTES;
}

const EARLY_SOURCES: ReadonlySet<SourceKind> = new Set(['cam', 'ts', 'tc', 'scr']);

/** Tier thresholds. Open in §3; chosen here. */
const RECOMMENDED_MIN_SCORE = 70;
const AVOID_BELOW_SCORE = 40;
/** §3.3 Penalties: "risky source -15". */
const RISKY_PENALTY = 15;
/** §3.5: "smaller: ... size is at most 60 % of best-fit". */
const SMALLER_FRACTION = 0.6;
/** A copy this much smaller than the group's median size is an outlier (likely a fake). */
const OUTLIER_FRACTION = 0.5;

// ---------------------------------------------------------------- title matching

const ARTICLES = new Set(['the', 'a', 'an']);
/** Extra words that mark a different film or season: "Dune" must not match "Dune Part Two". */
const SEQUEL_WORDS = new Set([
  'part', 'chapter', 'volume', 'vol', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix',
]);

export interface ParsedQuery {
  title: string;
  year?: number;
  season?: number;
  episode?: number;
}

/**
 * Splits the model's free-text query into a title and the facts the release parser can read from it:
 * a year, a season and an episode ("Harbor Light S01E02", "Schindler's List 1993"). Reuses `parseRelease`.
 * The model must not add a year the user didn't give; that is a prompt rule, not enforced here.
 */
export function parseQuery(text: string): ParsedQuery {
  const raw = typeof text === 'string' ? text.trim() : '';
  const p = parseRelease(raw);
  const title = (p.title ?? '').trim() || raw;
  const out: ParsedQuery = { title };
  if (p.year !== undefined) out.year = p.year;
  if (p.season !== undefined) out.season = p.season;
  if (p.episodes && p.episodes.length > 0) out.episode = p.episodes[0];
  return out;
}

/** Facts the caller passed win; the rest are read out of the title text. */
function resolveQuery(q: ScoreContext['query']): ScoreContext['query'] {
  const parsed = parseQuery(q.title);
  return {
    title: parsed.title,
    year: q.year ?? parsed.year,
    season: q.season ?? parsed.season,
    episode: q.episode ?? parsed.episode,
  };
}

/** Scripts written without spaces between words: a title in them is one long token, so it is matched by substring. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function titleTokens(s: string): string[] {
  const tokens = s
    .normalize('NFKC')
    // Fold Latin accents only (combining marks U+0300-036F); marks that belong to other scripts stay.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]+/g, '')
    .normalize('NFKC')
    .toLowerCase()
    // Apostrophes are dropped, not split on: "Schindler's" becomes "schindlers".
    .replace(/['’‘`´]/g, '')
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => t.length > 0 && !ARTICLES.has(t));
  // "Ocean.s.Eleven" has lost its apostrophe to a dot: glue a lone s or t back on.
  const out: string[] = [];
  for (const t of tokens) {
    if ((t === 's' || t === 't') && out.length > 0) out[out.length - 1] += t;
    else out.push(t);
  }
  return out;
}

function bigrams(s: string): string[] {
  const cs = Array.from(s);
  if (cs.length < 2) return [s];
  const out: string[] = [];
  for (let i = 0; i < cs.length - 1; i++) out.push(cs[i] + cs[i + 1]);
  return out;
}

/** Whether a wanted token shows up in the release's title tokens. Unspaced scripts match by substring or character pairs. */
function hasToken(want: string, have: Set<string>, haveText: string): boolean {
  if (have.has(want)) return true;
  if (!UNSPACED.test(want)) return false;
  if (haveText.includes(want)) return true;
  // A one-character difference in a long title ("進撃の巨人" vs "進撃の巨神") still counts as the same title.
  const pairs = bigrams(want);
  if (pairs.length < 4) return false;
  return pairs.filter((b) => haveText.includes(b)).length / pairs.length >= 0.75;
}

/**
 * The wanted title words that the name does not show. A release often glues or splits a word the user typed the
 * other way ("prime time" against "Primetime", "primetime" against "Prime.Time"), so two adjacent words that join
 * into one the other side has count as matched, and so do the two sides joined whole.
 */
function missingTokens(want: readonly string[], have: readonly string[]): string[] {
  const set = new Set(have);
  const haveText = have.join('');
  if (want.join('') === haveText) return [];
  const joined = new Set<string>();
  for (let i = 0; i + 1 < have.length; i++) {
    joined.add(have[i] + have[i + 1]);
    if (i + 2 < have.length) joined.add(have[i] + have[i + 1] + have[i + 2]);
  }
  const covered = new Set<number>();
  for (let i = 0; i + 1 < want.length; i++) {
    if (set.has(want[i] + want[i + 1])) {
      covered.add(i);
      covered.add(i + 1);
    }
  }
  return want.filter((t, i) => !covered.has(i) && !hasToken(t, set, haveText) && !joined.has(t));
}

/** Seasons a name covers: the range of a multi-season pack, else the single season (empty when it names none). */
function coveredSeasons(parsed: ParsedRelease): number[] {
  if (parsed.seasons && parsed.seasons.length > 1) return parsed.seasons;
  return parsed.season !== undefined ? [parsed.season] : [];
}

/** "seasons 1\u20135" for a run, "seasons 1, 3 and 4" otherwise. */
function seasonSpan(seasons: readonly number[]): string {
  const first = seasons[0];
  const last = seasons[seasons.length - 1];
  if (seasons.length === last - first + 1) return `seasons ${first}\u2013${last}`;
  return `seasons ${seasons.slice(0, -1).join(', ')} and ${last}`;
}

/** A pack that holds more than the one season the user asked for. */
function isBigPack(parsed: ParsedRelease, q: ScoreContext['query']): boolean {
  if (q.season === undefined || q.episode !== undefined) return false;
  if (parsed.seasons && parsed.seasons.length > 1) return parsed.seasons.includes(q.season);
  return parsed.completeSeries === true && parsed.season === undefined;
}

/**
 * Words that ask for a kind of thing rather than name a title ("latest movies", "new tv shows this week").
 * A query made only of these (and a year) is a browse query: every release of the kind is a match.
 */
const GENERIC_WORDS = new Set([
  'movies', 'movie', 'films', 'film', 'shows', 'show', 'series', 'tv', 'anime', 'books', 'book', 'ebooks', 'audiobooks',
  'comics', 'games', 'game', 'music', 'songs', 'albums', 'apps', 'app', 'software', 'programs', 'documentaries',
  'documentary', 'cartoons', 'episodes', 'other', 'releases', 'release',
  'latest', 'new', 'newest', 'recent', 'popular', 'trending', 'best', 'top', 'good', 'this', 'week', 'month', 'year',
  'today', 'now',
]);

/** True when every word of the query is generic or a 4-digit year (there is no title to match). */
export function isBrowseQuery(text: string): boolean {
  const tokens = titleTokens(text);
  return tokens.length > 0 && tokens.every((t) => GENERIC_WORDS.has(t) || /^(19|20)\d\d$/.test(t));
}

const LEAD_FILLER = new Set(['find', 'get', 'download', 'please', 'best', 'good']);
const KIND_FILLER = new Set(['movie', 'movies', 'film', 'films']);
const TAIL_FILLER = new Set(['torrent', 'torrents', 'download', 'downloads', 'hd', 'free', 'best']);

/**
 * Takes the words that ask for a kind of result, not a title, off the ends of a model's query: "best prime time
 * movie torrents" becomes "prime time". Only the ends are touched and a title's own words stay ("Scary Movie",
 * "Top Gun", "Free Guy"). Movie and film words go only when two or more words remain. Never returns an empty query.
 */
export function cleanSearchQuery(text: string): string {
  let words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  const low = (w: string | undefined): string => (w ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  for (let again = true; again && words.length > 1; ) {
    again = false;
    const first = low(words[0]);
    const second = low(words[1]);
    const last = low(words[words.length - 1]);
    let cut = 0;
    if (first === 'the' && (second === 'best' || second === 'good')) cut = 2;
    else if ((first === 'find' || first === 'get' || first === 'show') && second === 'me') cut = 2;
    else if (LEAD_FILLER.has(first)) cut = 1;
    else if (first === 'top' && /^\d+$/.test(second)) cut = 1;
    else if (KIND_FILLER.has(first) && words.length - 1 >= 2) cut = 1;
    if (cut > 0 && words.length - cut >= 1) {
      words = words.slice(cut);
      again = true;
      continue;
    }
    if ((TAIL_FILLER.has(last) || (KIND_FILLER.has(last) && words.length - 1 >= 2)) && words.length > 1) {
      words = words.slice(0, -1);
      again = true;
    }
  }
  return words.join(' ');
}

/** Categories whose releases are named like software, books or albums, not like films. */
const NON_VIDEO_CATEGORIES: ReadonlySet<string> = new Set(['apps', 'games', 'books', 'music', 'other']);

/** Whether the name reads like a film or an episode: a year, a season, an episode, a resolution or a video source. */
function parsesAsVideo(parsed: ParsedRelease): boolean {
  return parsed.year !== undefined || parsed.season !== undefined || (parsed.episodes?.length ?? 0) > 0
    || parsed.resolution !== undefined || parsed.source !== 'unknown';
}

/** A row is matched as a non-video release when its category or the searched one says so, or its name is not a film's. */
function isNonVideo(r: MergedResult, parsed: ParsedRelease, searched: Category | undefined): boolean {
  if (r.category === 'movies' || r.category === 'tv' || r.category === 'anime') return false;
  if (searched !== undefined && NON_VIDEO_CATEGORIES.has(searched)) return true;
  if (r.category === 'apps' || r.category === 'games' || r.category === 'books' || r.category === 'music') return true;
  return !parsesAsVideo(parsed);
}

/**
 * Non-video match: the query's words against the words of the raw name, split on . _ - and spaces, so
 * "ubuntu 24.04" matches "ubuntu-24.04.1-desktop-amd64.iso". Extra numbers are versions here, not sequels.
 */
function wrongRawName(name: string, q: ScoreContext['query']): TitleVerdict {
  const want = titleTokens(q.raw ?? q.title);
  if (want.length === 0) return { reason: null, partial: false };
  const have = titleTokens(name);
  const missing = missingTokens(want, have);
  // A version number the user typed must be there: "ubuntu 22.04" is not "ubuntu 24.04".
  if (missing.length > 1 || (missing.length === 1 && want.length < 2) || missing.some((t) => /^\d+$/.test(t))) {
    return { reason: `The name does not match "${q.raw ?? q.title}".`, partial: false };
  }
  return { reason: null, partial: missing.length === 1 };
}

interface TitleVerdict { reason: string | null; partial: boolean }

/**
 * Returns a plain-English reason when the result is the wrong title, else null. §3.2 row 2, R1-9.
 * `browse`: the query names no title (see `isBrowseQuery`), so only the year, season and episode are checked.
 */
function wrongTitle(parsed: ParsedRelease, q: ScoreContext['query'], browse = false): TitleVerdict {
  let partial = false;
  const want = browse ? [] : titleTokens(q.title);
  if (want.length > 0) {
    const have = titleTokens(parsed.title ?? '');
    if (have.length === 0) return { reason: 'The name does not show a title.', partial };
    const missing = missingTokens(want, have);
    // Exclude when more than one word is missing. One missing word is a partial match only in a title of 3+ words
    // (an existing contract): in a two-word one it is the other film ("Prime Suspect" is not "Prime Time").
    if (missing.length > 1 || (missing.length === 1 && want.length < 3)) {
      return { reason: `The title does not match "${q.title}".`, partial };
    }
    if (missing.length === 1) partial = true;
    // A sequel or part number the user did not ask for means a different film.
    const wantSet = new Set(want);
    const extra = have.find((t) => !wantSet.has(t) && (/^\d+$/.test(t) || SEQUEL_WORDS.has(t)));
    if (extra !== undefined) return { reason: `This looks like a different film or part than "${q.title}".`, partial };
  }
  // §3.2: "the year differs by more than 1".
  if (q.year !== undefined && parsed.year !== undefined && Math.abs(parsed.year - q.year) > 1) {
    return { reason: `It is from ${parsed.year}, but you asked for ${q.year}.`, partial };
  }
  if (q.season !== undefined && parsed.season !== undefined) {
    const covered = coveredSeasons(parsed);
    if (!covered.includes(q.season)) {
      return {
        reason: covered.length > 1
          ? `It covers ${seasonSpan(covered)}, but you asked for season ${q.season}.`
          : `It is season ${parsed.season}, but you asked for season ${q.season}.`,
        partial,
      };
    }
  }
  if (q.episode !== undefined && parsed.episodes && parsed.episodes.length > 0 && !parsed.episodes.includes(q.episode)) {
    return { reason: `It is not episode ${q.episode}.`, partial };
  }
  return { reason: null, partial };
}

// ---------------------------------------------------------------- score parts

function bandCodecOf(parsed: ParsedRelease): BandCodec {
  if (parsed.source === 'remux') return 'remux';
  switch (parsed.codec) {
    case 'avc':
    case 'xvid':
    case 'mpeg2':
    case 'vc1':
      return 'avc';
    default:
      // hevc, av1, vp9, and unknown: the lenient choice, same as fileSafety (§3.3 "hevc/av1" rows).
      return 'hevc';
  }
}

/** §3.3 resolution points. Unknown resolution gets 3 (open in §3). */
function resolutionPoints(res: ParsedRelease['resolution'], profile: Profile): number {
  switch (res) {
    case 480: case 576: return 2; // §3.3 "480 -> 2"
    case 720: return 6; // "720 -> 6"
    case 1080: return 10; // "1080 -> 10"
    case 2160: case 4320: return profile === 'phone' ? 10 : 12; // "2160 -> 10 on phone and 12 on tv/archive"
    default: return 3;
  }
}

/** What the codec scores when the phone decodes it well. §3.3 "avc 10-bit 8", "avc 8-bit 20", "hevc 18", "av1 16". */
function codecPotential(parsed: ParsedRelease): number {
  switch (parsed.codec) {
    case 'avc': return parsed.bitDepth === 10 ? 8 : 20;
    case 'hevc': return 18;
    case 'av1': return 16;
    default: return 10; // "xvid / mpeg2 / vc1 10". vp9 and unknown codecs get the same (open in §3).
  }
}

/**
 * §3.3 playability through `playbackVerdict`, so the codec probe decides (R1 item 7):
 * smooth keeps the codec's points, "may stutter" is capped at 10, "needs another player" at 4,
 * and unknown scores 60 % of them. Unknown is never treated as playable.
 */
function playabilityOf(parsed: ParsedRelease, ctx: ScoreContext, flags: string[]): number {
  const advice = playbackVerdict(parsed, ctx.playback);
  const potential = codecPotential(parsed);
  let pts: number;
  switch (advice.verdict) {
    case 'smooth': pts = potential; break;
    case 'may_stutter': pts = Math.min(potential, 10); break;
    case 'needs_other_player': pts = Math.min(potential, 4); break;
    default:
      pts = Math.round(potential * 0.6);
      flags.push('playback_unknown');
  }
  if (parsed.hdr.includes('dv') && parsed.dvFallback !== true) {
    flags.push('dv_no_fallback');
    // "Subtract 8: dv without confirmed fallback and probe says no DV" (the verdict already caps a confirmed no-fallback case).
    if (ctx.playback?.dolbyVision === 'none' && advice.verdict !== 'needs_other_player') pts -= 8;
  }
  const audio = parsed.audio;
  if (ctx.profile === 'phone' && audio.length > 0 && audio.every((a) => a.codec === 'truehd' || a.codec === 'dtshd')) {
    pts -= 3; // "Subtract 3: lossless audio only on phone"
    flags.push('lossless_audio_only');
  }
  if (parsed.hardcodedSubs) {
    pts -= 2; // "Subtract 2: hardcoded subs"
    flags.push('hardcoded_subs');
  }
  if (parsed.multiAudio && (ctx.wantsMultiAudio || ctx.audioLanguage !== undefined)) pts += 1; // "Add 1 (cap 20): multiAudio ..."
  return Math.max(0, Math.min(20, pts));
}

function healthOf(r: MergedResult, now: number): number {
  const s = r.seeders;
  let pts: number;
  if (s === undefined) pts = 8; // §3.3 health "undefined 8"
  else if (s <= 0) pts = 0; // "0 -> 0"
  else if (s < 5) pts = 4; // "1-4 -> 4"
  else if (s < 20) pts = 10; // "5-19 -> 10"
  else if (s < 100) pts = 15; // "20-99 -> 15"
  else pts = 20; // "100+ -> 20"
  // "Subtract 3 when publishedAt is older than 2 years and seeders < 5."
  if (s !== undefined && s < 5 && r.publishedAt !== undefined && now - r.publishedAt > 2 * 365 * DAY_MS) pts -= 3;
  return Math.max(0, pts);
}

function isEpisodic(parsed: ParsedRelease, q: ScoreContext['query']): boolean {
  return q.season !== undefined || q.episode !== undefined || parsed.season !== undefined || (parsed.episodes?.length ?? 0) > 0;
}

/** Total runtime the size is spread over, or undefined when it cannot be known (pack with no episode count). */
function totalRuntimeMin(r: MergedResult, parsed: ParsedRelease, ctx: ScoreContext, q: ScoreContext['query']): number | undefined {
  // R1-13: an anime episode runs 24 minutes, other episodes 45, films 110.
  const episodic = isEpisodic(parsed, q) || r.category === 'anime';
  const episodeMin = r.category === 'anime' ? DEFAULT_ANIME_EPISODE_RUNTIME_MIN : DEFAULT_EPISODE_RUNTIME_MIN;
  const per = ctx.runtimeMin ?? (episodic ? episodeMin : DEFAULT_FILM_RUNTIME_MIN);
  if (parsed.seasonPack) {
    const n = ctx.packEpisodeCounts?.get(r.infoHash);
    return n !== undefined && n > 0 ? n * per : undefined; // §3.3: "skip when the episode count is unknown"
  }
  if ((parsed.episodes?.length ?? 0) > 1) return parsed.episodes!.length * per;
  return per;
}

interface SizeScore { sanity: number; bitrate: number }

function sizeScore(r: MergedResult, parsed: ParsedRelease, runtimeMin: number | undefined, flags: string[]): SizeScore {
  if (r.sizeBytes === undefined || r.sizeBytes <= 0) return { sanity: 5, bitrate: 0 }; // §3.2 "sanity 5 of 10"
  const band = sizeBand(parsed.resolution, bandCodecOf(parsed));
  // No band or no runtime: the check cannot run, so give the neutral 5 and no bitrate points.
  if (!band || !runtimeMin) return { sanity: 5, bitrate: 0 };
  const perHour = r.sizeBytes / GB / (runtimeMin / 60);
  if (perHour < band.low * TOO_SMALL_FRACTION) {
    flags.push('too_small_for_claim'); // R1-13: below 0.25x the floor: probably not what the name says
    return { sanity: 0, bitrate: 0 };
  }
  if (perHour < band.low * SMALL_FRACTION) {
    flags.push('small_for_quality'); // R1-13: only below 0.5x the floor is "smaller than usual"
    return { sanity: 5, bitrate: 0 };
  }
  if (perHour < band.low) return { sanity: 8, bitrate: 0 }; // a slim encode, no warning
  if (perHour > band.high) {
    flags.push('bigger_than_needed'); // "Above high: 6 and flag bigger_than_needed"
    return { sanity: 6, bitrate: 0 };
  }
  // In band: sanity 10; bitrate position 6 in the upper half, 3 in the lower half.
  return { sanity: 10, bitrate: perHour >= (band.low + band.high) / 2 ? 6 : 3 };
}

// ---------------------------------------------------------------- reasons

function codecLabel(parsed: ParsedRelease): string | undefined {
  if (parsed.encoder) return parsed.encoder;
  switch (parsed.codec) {
    case 'avc': return 'H.264';
    case 'hevc': return 'H.265';
    case 'av1': return 'AV1';
    case 'xvid': return 'XviD';
    case 'vp9': return 'VP9';
    case 'mpeg2': return 'MPEG-2';
    case 'vc1': return 'VC-1';
    default: return undefined;
  }
}

/** §3.5 template: "{SOURCE} {RES}p {CODEC}{ 10-bit}, {SIZE}, {N} sharing, {FIT}". Unknown parts are left out. */
function headline(r: MergedResult, parsed: ParsedRelease, adm: Ranked['admission']): string {
  const parts: string[] = [];
  const source = SOURCE_LABEL[parsed.source];
  if (source) parts.push(source);
  if (parsed.resolution) parts.push(`${parsed.resolution}p`);
  const codec = codecLabel(parsed);
  if (codec) parts.push(codec);
  let head = parts.join(' ');
  if (parsed.bitDepth === 10 && head) head += ' 10-bit';
  const size = r.sizeBytes !== undefined && r.sizeBytes > 0 ? formatBytes(r.sizeBytes) : 'size unknown';
  const sharing = r.seeders === undefined ? 'no sharing count' : `${r.seeders} sharing`;
  let fit: string;
  if (!adm) fit = 'fit unknown';
  else if (adm.result === 'Fits') fit = `fits with ${formatBytes(adm.leftAfter)} to spare`;
  else if (adm.result === 'Tight') fit = `fits, leaves ${formatBytes(adm.leftAfter)} free`;
  else fit = `doesn't fit by ${formatBytes(-adm.leftAfter)}`;
  return [head, size, sharing, fit].filter((x) => x.length > 0).join(', ');
}

function extraReasons(
  flags: readonly string[], parsed: ParsedRelease, r: MergedResult, ctx: ScoreContext, partial: number | undefined,
): string[] {
  const out: string[] = [];
  const res = parsed.resolution ? `${parsed.resolution}p ` : '';
  for (const f of flags) {
    switch (f) {
      case 'risky_source': {
        const names = riskySources(r, ctx.providers, ctx.warnUnsafe);
        const list = names && names.length > 0 ? names.join(' and ') : 'some sites';
        out.push(`Maglev flags ${list} as unsafe, and only ${names && names.length > 1 ? 'those sites list' : `${list} lists`} this one.`);
        break;
      }
      case 'size_unknown': out.push('The site gave no size, so the fit and the size check could not run.'); break;
      case 'too_small_for_claim': out.push(`The file is far smaller than a real ${res}copy should be. It is probably not what the name says.`); break;
      case 'small_for_quality': out.push(`Smaller than usual for ${res}video, so expect lower quality.`); break;
      case 'bigger_than_needed': out.push(`Bigger than usual for ${res}video. A smaller copy would likely look the same on a phone.`); break;
      case 'dv_no_fallback': out.push('Dolby Vision only. On phones without it, colours can look green or purple.'); break;
      case 'lossless_audio_only': out.push("The sound track is disc-quality and adds gigabytes a phone can't use."); break;
      case 'hardcoded_subs': out.push('Subtitles are burned into the picture.'); break;
      case 'over_size_cap': out.push(`Bigger than your limit of ${formatBytes(ctx.maxBytes ?? 0)}.`); break;
      case 'partial_fits': out.push(`The whole pack does not fit, but ${partial} episode${partial === 1 ? '' : 's'} would.`); break;
      case 'multi_season_pack': {
        const span = parsed.seasons && parsed.seasons.length > 1 ? seasonSpan(parsed.seasons) : 'complete series';
        out.push(`Pack: ${span} (bigger download)`);
        break;
      }
      case 'title_partial': out.push('The title is close, but one word you searched for is missing from the name.'); break;
      case 'no_sharing': out.push('Nobody is sharing it right now, so it would not download.'); break;
      case 'unsafe_files': out.push('The file list has a serious warning sign.'); break;
      default: break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- language and subtitle preference

type Match = 'yes' | 'maybe' | 'no';
interface Preference { audio?: Match; subtitles?: Match; good: string[]; bad: string[]; rank: number }

const MATCH_POINTS: Record<Match, number> = { yes: 2, maybe: 1, no: 0 };

/**
 * How a name meets the language and subtitle the user asked for. `rank` orders rows (audio before subtitles);
 * nothing is dropped. Reasons are plain and only say what the name shows.
 */
function preferenceOf(name: string, ctx: ScoreContext): Preference | null {
  const audioWant = ctx.audioLanguage;
  const subWant = ctx.subtitles;
  if (audioWant === undefined && subWant === undefined) return null;
  const info: LanguageInfo = detectLanguages(name);
  const pref: Preference = { good: [], bad: [], rank: 0 };
  if (audioWant !== undefined) {
    const label = languageLabel(audioWant);
    if (audioWant === 'multi') {
      pref.audio = info.multiAudio ? 'yes' : 'no';
      if (info.multiAudio) pref.good.push(info.audio.length > 1 ? `Has ${info.audio.map(languageLabel).join(' and ')} audio` : 'Has more than one audio track');
      else pref.bad.push('No sign of more than one audio track in the name');
    } else if (hasAudioLanguage(info, audioWant)) {
      pref.audio = 'yes';
      pref.good.push(`Has ${label} audio`);
    } else if (info.multiAudio && info.audio.length < 2) {
      pref.audio = 'maybe';
      pref.good.push(`Has more than one audio track, but the name doesn't say if ${label} is one`);
    } else {
      pref.audio = 'no';
      pref.bad.push(`No sign of ${label} audio in the name`);
    }
  }
  if (subWant !== undefined) {
    if (subWant === 'any' || subWant === 'multi') {
      pref.subtitles = info.subtitles ? 'yes' : 'no';
      if (info.subtitles) pref.good.push(info.subtitleLanguages.length > 0 ? `Has ${info.subtitleLanguages.map(languageLabel).join(' and ')} subtitles` : 'Has subtitles');
      else pref.bad.push('No sign of subtitles in the name');
    } else {
      const label = languageLabel(subWant);
      if ((info.subtitleLanguages as string[]).includes(subWant)) {
        pref.subtitles = 'yes';
        pref.good.push(`Has ${label} subtitles`);
      } else if (info.subtitles) {
        pref.subtitles = 'maybe';
        pref.good.push(info.multiSubs ? `Has subtitles in several languages; ${label} is likely but not named` : `Has subtitles, but the name doesn't say ${label}`);
      } else {
        pref.subtitles = 'no';
        pref.bad.push(`No sign of ${label} subtitles in the name`);
      }
    }
  }
  pref.rank = (pref.audio ? MATCH_POINTS[pref.audio] * 3 : 0) + (pref.subtitles ? MATCH_POINTS[pref.subtitles] : 0);
  return pref;
}

// ---------------------------------------------------------------- scoring one result

interface Scored { ranked: Ranked; sizeKnown: boolean; eligible: boolean; prefRank: number }

function scoreOne(
  r: MergedResult, parsed: ParsedRelease, ctx: ScoreContext, q: ScoreContext['query'], now: number, titlePartial: boolean,
): Scored {
  const flags: string[] = [];
  if (titlePartial) flags.push('title_partial');
  if (isBigPack(parsed, q)) flags.push('multi_season_pack');
  const sizeKnown = r.sizeBytes !== undefined && r.sizeBytes > 0;
  const runtimeMin = totalRuntimeMin(r, parsed, ctx, q);

  // Quality (0-40). Resolution 12 on tv/archive can push the sum past 40; cap it there.
  const size = sizeScore(r, parsed, runtimeMin, flags);
  const srcPts = SOURCE_POINTS[parsed.source][ctx.profile === 'archive' ? 1 : 0];
  const quality = Math.min(40, srcPts + resolutionPoints(parsed.resolution, ctx.profile) + size.bitrate);

  const playability = playabilityOf(parsed, ctx, flags);
  const health = healthOf(r, now);
  const dead = r.seeders !== undefined && r.seeders <= 0;
  if (dead) flags.push('no_sharing');

  let admission: Ranked['admission'] = null;
  let budget = 0;
  let fit = 5; // size unknown: nothing to admit, so the neutral middle (open in §3)
  if (sizeKnown) {
    const out = admit({
      freeBytes: ctx.freeBytes, pendingNeed: ctx.pendingNeed, stagingFactor: ctx.stagingFactor, selectionBytes: r.sizeBytes!,
    });
    admission = { result: out.result, leftAfter: out.leftAfter };
    budget = out.budget;
    fit = out.result === 'Fits' ? 10 : out.result === 'Tight' ? 5 : 0; // §3.3 fit
  } else {
    flags.push('size_unknown');
  }

  const risky = riskySources(r, ctx.providers, ctx.warnUnsafe) !== null;
  let penalties = 0;
  if (risky) {
    penalties += RISKY_PENALTY;
    flags.push('risky_source');
  }

  const safety = ctx.safety?.get(r.infoHash);
  const unsafeFiles = safety?.level === 'red';
  if (unsafeFiles) flags.push('unsafe_files');

  const overCap = sizeKnown && ctx.maxBytes !== undefined && r.sizeBytes! > ctx.maxBytes;
  if (overCap) flags.push('over_size_cap');

  // §3.2 row 3: a pack that does not fit whole may still fit in part.
  let partialEpisodes: number | undefined;
  if (admission?.result === 'DoesntFit' && parsed.seasonPack) {
    const count = ctx.packEpisodeCounts?.get(r.infoHash);
    if (count !== undefined && count > 1) {
      const per = r.sizeBytes! / count;
      let n = budget > 0 ? Math.min(count - 1, Math.floor(budget / (per * ctx.stagingFactor))) : 0;
      // Re-run admit() so the claim is verified, not computed on the side.
      while (n > 0 && admit({
        freeBytes: ctx.freeBytes, pendingNeed: ctx.pendingNeed, stagingFactor: ctx.stagingFactor, selectionBytes: Math.round(per * n),
      }).result === 'DoesntFit') n--;
      if (n > 0) {
        partialEpisodes = n;
        flags.push('partial_fits');
      }
    }
  }

  const score = Math.max(0, Math.min(100, Math.round(quality + playability + health + size.sanity + fit - penalties)));

  let tier: Tier;
  if (
    admission?.result === 'DoesntFit' || overCap || dead || unsafeFiles
    || flags.includes('too_small_for_claim') || score < AVOID_BELOW_SCORE
  ) {
    tier = 'avoid';
  } else if (
    score >= RECOMMENDED_MIN_SCORE && sizeKnown && !risky && admission !== null && !titlePartial
  ) {
    tier = 'recommended';
  } else {
    tier = 'ok';
  }

  // What the user asked for leads after the headline; a miss goes last so warnings stay in the first three.
  const pref = preferenceOf(r.name, ctx);
  const reasons = [headline(r, parsed, admission), ...(pref?.good ?? []), ...extraReasons(flags, parsed, r, ctx, partialEpisodes), ...(pref?.bad ?? [])];
  const ranked: Ranked = {
    id: r.infoHash, score, tier, labels: [], reasons, flags, admission, result: r, parsed,
    breakdown: { quality, playability, health, sanity: size.sanity, fit, penalties },
    ...(safety !== undefined ? { safety } : {}),
    ...(partialEpisodes !== undefined ? { partialEpisodes } : {}),
    ...(pref ? { preference: { ...(pref.audio ? { audio: pref.audio } : {}), ...(pref.subtitles ? { subtitles: pref.subtitles } : {}) } } : {}),
  };
  return {
    ranked, sizeKnown, prefRank: pref?.rank ?? 0,
    eligible: sizeKnown && tier !== 'avoid' && admission !== null && admission.result !== 'DoesntFit',
  };
}

// ---------------------------------------------------------------- shortlist

/** Same release, whoever uploaded it. Rows inside a group differ by info hash and are ranked together. */
function groupKey(p: ParsedRelease): string {
  return [
    (p.title ?? '').toLowerCase(), p.year ?? '', p.season ?? '', (p.seasons ?? []).join('-'), p.completeSeries ? 'c' : '', (p.episodes ?? []).join(','),
    p.resolution ?? '', p.source, p.encoder ?? p.codec,
  ].join('|');
}

function median(xs: number[]): number {
  const a = xs.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Prefer results that are not risky; fall back to all of them when every one is risky. */
function preferSafe(list: Scored[]): Scored[] {
  const safe = list.filter((s) => !s.ranked.flags.includes('risky_source'));
  return safe.length > 0 ? safe : list;
}

function pickShortlist(sorted: Scored[]): Ranked[] {
  // Only rows that could be offered take part. A copy that cannot be offered (no size, dead, unsafe, too big)
  // never hides one that can. Dead and unsafe rows are already tier "avoid" and so not eligible.
  const eligible = sorted.filter((s) => s.eligible);

  // §3.5: one row per release. The group is ranked as a whole (best score first), but a copy far smaller
  // than its siblings is a likely fake and only wins when nothing else is left in the group.
  const groups = new Map<string, Scored[]>();
  for (const s of eligible) {
    const k = groupKey(s.ranked.parsed);
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  const unique: Scored[] = [];
  for (const g of groups.values()) {
    let pool = g;
    if (g.length >= 3) {
      const med = median(g.map((s) => s.ranked.result.sizeBytes!));
      const normal = g.filter((s) => s.ranked.result.sizeBytes! >= OUTLIER_FRACTION * med);
      if (normal.length > 0) pool = normal;
    }
    unique.push(pool[0]); // `sorted` order is best first
  }
  unique.sort((a, b) => sorted.indexOf(a) - sorted.indexOf(b));

  const give = (s: Scored | undefined, label: Label): Ranked | undefined => {
    if (s && !s.ranked.labels.includes(label)) s.ranked.labels.push(label);
    return s?.ranked;
  };

  const fits = preferSafe(unique.filter((s) => s.ranked.admission!.result === 'Fits'));
  const bestFit = fits[0]; // highest score among Fits
  give(bestFit, 'best-fit');

  if (bestFit) {
    const cap = SMALLER_FRACTION * bestFit.ranked.result.sizeBytes!;
    const small = preferSafe(unique.filter((s) => s !== bestFit && s.ranked.result.sizeBytes! <= cap));
    give(small[0], 'smaller');
  }

  // best-quality: highest quality component among Fits or Tight (both are in `unique`).
  const byQuality = preferSafe(unique).slice().sort(
    (a, b) => b.prefRank - a.prefRank || b.ranked.breakdown.quality - a.ranked.breakdown.quality || b.ranked.score - a.ranked.score,
  );
  if (byQuality[0] !== bestFit) give(byQuality[0], 'best-quality');

  const order: Label[] = ['best-fit', 'smaller', 'best-quality'];
  const out: Ranked[] = [];
  for (const label of order) {
    const hit = unique.find((s) => s.ranked.labels.includes(label));
    if (hit && !out.includes(hit.ranked)) out.push(hit.ranked);
  }
  for (const r of out) r.label = order.find((l) => r.labels.includes(l));
  return out;
}

// ---------------------------------------------------------------- proposing

export interface ProposeCheck {
  ok: boolean;
  /** Plain English, set when `ok` is false. */
  reason?: string;
}

/**
 * Whether the assistant may propose adding this row (R1-8). Red is enforced: a row whose file-list safety
 * is red, or whose size says it is not what the name claims, is refused. Accepts a Ranked row or any object
 * carrying the stored `safety` result (or just its `level`).
 */
export function canPropose(
  result: { safety?: { level: SafetyLevel } | null; level?: SafetyLevel; flags?: readonly string[] } | null | undefined,
): ProposeCheck {
  const level = result?.safety?.level ?? result?.level;
  if (level === 'red' || result?.flags?.includes('unsafe_files')) {
    return { ok: false, reason: "The file list has a serious warning sign, so Maglev won't add it." };
  }
  if (result?.flags?.includes('too_small_for_claim')) {
    return { ok: false, reason: "The file is far smaller than the name claims, so Maglev won't add it." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- entry point

/**
 * Applies the hard rules, scores what is left, and picks the shortlist.
 * `ranked` holds every kept result, best first, with "avoid" rows last.
 * Rows are keyed by info hash (`id`); the runner turns them into handles.
 * The same info hash given twice is one row.
 */
export function scoreResults(results: readonly MergedResult[], ctx: ScoreContext): ScoreOutput {
  const now = ctx.now ?? Date.now();
  const q = resolveQuery(ctx.query);
  const browse = isBrowseQuery(ctx.query.raw ?? ctx.query.title);
  const excluded: Excluded[] = [];
  const scored: Scored[] = [];
  const seen = new Set<string>();

  for (const r of results) {
    const hash = r.infoHash;
    if (seen.has(hash)) continue;
    seen.add(hash);
    const parsed = parseRelease(r.name);
    // §3.2 and decision D2: adult content is never recommended, and never goes into a shortlist.
    if (r.category === 'adult') {
      excluded.push({ id: hash, result: r, reason: 'adult', detail: 'Adult content is never suggested.' });
      continue;
    }
    // Browse queries skip the title match; non-video releases are matched on their raw name (no year or
    // sequel rules); films and episodes keep the full title, year, season and episode check.
    const wrong = isNonVideo(r, parsed, ctx.category)
      ? (browse ? { reason: null, partial: false } : wrongRawName(r.name, q))
      : wrongTitle(parsed, q, browse);
    if (wrong.reason !== null) {
      excluded.push({ id: hash, result: r, reason: 'wrong_title', detail: wrong.reason });
      continue;
    }
    if (EARLY_SOURCES.has(parsed.source) && !ctx.allowEarlySources) {
      excluded.push({
        id: hash, result: r, reason: 'cam_source',
        detail: 'Recorded in a cinema or from an early source. The picture and sound are poor.',
      });
      continue;
    }
    if (brokenSize(r, parsed)) {
      excluded.push({
        id: hash, result: r, reason: 'broken_size',
        detail: 'The size is far too small for a video, so it is probably a fake or broken upload.',
      });
      continue;
    }
    scored.push(scoreOne(r, parsed, ctx, q, now, wrong.partial));
  }

  const rank = (s: Scored) => (s.ranked.tier === 'avoid' ? 1 : 0);
  // A pack that only contains the season asked for never outranks an exact single-season match.
  const pack = (s: Scored) => (s.ranked.flags.includes('multi_season_pack') ? 1 : 0);
  const sorted = scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      rank(a.s) - rank(b.s)
      || pack(a.s) - pack(b.s)
      // A language or subtitles the user asked for beats quality; rows without it stay, lower.
      || b.s.prefRank - a.s.prefRank
      || b.s.ranked.score - a.s.ranked.score
      || (b.s.ranked.result.seeders ?? -1) - (a.s.ranked.result.seeders ?? -1)
      || a.i - b.i)
    .map((x) => x.s);

  // §3.2 last row: a risky source never ranks first while a clean, usable result exists.
  if (sorted.length > 0 && sorted[0].ranked.flags.includes('risky_source')) {
    const j = sorted.findIndex((s) => !s.ranked.flags.includes('risky_source') && s.ranked.tier !== 'avoid');
    if (j > 0) sorted.unshift(sorted.splice(j, 1)[0]);
  }

  const shortlist = pickShortlist(sorted);
  const notes = sorted.some((s) => s.ranked.result.seeders !== undefined) ? [SEEDER_NOTE] : [];
  return { ranked: sorted.map((s) => s.ranked), shortlist, excluded, notes };
}
