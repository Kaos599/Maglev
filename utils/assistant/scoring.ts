/**
 * Quality scoring and shortlist for the assistant (docs/ASSISTANT_DESIGN.md §3).
 *
 * Pure: no React, no react-native, no engine, no clock unless the caller omits
 * `ctx.now`. Free space and pending need come in as arguments. The model never
 * ranks anything; this code does, and the model only words the result.
 *
 * Section numbers in comments point at docs/ASSISTANT_DESIGN.md.
 */
import { formatBytes } from '../../constants/format.ts';
import { admit } from '../admission.ts';
import type { AdmissionResult } from '../admission.ts';
import { riskySources } from '../search/safety.ts';
import type { MergedResult } from '../search/types.ts';
import { parseRelease } from './releaseName.ts';
import type { ParsedRelease, SourceKind } from './releaseName.ts';
import { DEFAULT_EPISODE_RUNTIME_MIN, DEFAULT_FILM_RUNTIME_MIN, TOO_SMALL_FRACTION, sizeBand } from './sizeBands.ts';
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
  playback?: { hevc: boolean; hevc10: boolean; av1: 'hardware' | 'software'; dv: boolean };
  warnUnsafe: boolean;
  providers: ReadonlyMap<string, { name: string; unsafeReason?: string }>;
  query: { title: string; year?: number; season?: number; episode?: number };
  /** Extra. §3.2: CAM/TS/TC/SCR show only if the user says "earliest possible". */
  allowEarlySources?: boolean;
  /** Extra. §3.3 playability "+1 multiAudio when the user asked for a language the name lists". */
  wantsMultiAudio?: boolean;
  /** Extra. Episode count per season pack, keyed by info hash. Needed for pack sanity and `partial_fits`. */
  packEpisodeCounts?: ReadonlyMap<string, number>;
  /** Extra. Epoch ms. Defaults to Date.now(); pass it for deterministic tests. */
  now?: number;
}

export type Tier = 'recommended' | 'ok' | 'avoid';
export type Label = 'best-fit' | 'smaller' | 'best-quality';
export type ExcludeReason = 'cam_source' | 'wrong_title' | 'adult';

export interface Ranked {
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
  /** Season pack that does not fit whole: how many episodes would. */
  partialEpisodes?: number;
}

export interface Excluded {
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
}

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

const SOURCE_LABEL: Record<SourceKind, string> = {
  bluray: 'BluRay', webdl: 'WEB-DL', remux: 'Remux', webrip: 'WEBRip', web: 'WEB', hdtv: 'HDTV',
  hdrip: 'HDRip', dvdrip: 'DVDRip', cam: 'CAM', ts: 'TS', tc: 'TC', scr: 'SCR', unknown: 'Unknown',
};

const EARLY_SOURCES: ReadonlySet<SourceKind> = new Set(['cam', 'ts', 'tc', 'scr']);

/** Tier thresholds. Open in §3; chosen here. */
const RECOMMENDED_MIN_SCORE = 70;
const AVOID_BELOW_SCORE = 40;
/** §3.3 Penalties: "risky source -15". */
const RISKY_PENALTY = 15;
/** §3.5: "smaller: ... size is at most 60 % of best-fit". */
const SMALLER_FRACTION = 0.6;

// ---------------------------------------------------------------- title matching

const ARTICLES = new Set(['the', 'a', 'an']);
/** Extra words that mark a different film or season: "Dune" must not match "Dune Part Two". */
const SEQUEL_WORDS = new Set([
  'part', 'chapter', 'volume', 'vol', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ii', 'iii', 'iv', 'vi', 'vii', 'viii', 'ix',
]);

function titleTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !ARTICLES.has(t));
}

/** Returns a plain-English reason when the result is the wrong title, else null. §3.2 row 2. */
function wrongTitle(parsed: ParsedRelease, q: ScoreContext['query']): string | null {
  const want = titleTokens(q.title);
  if (want.length > 0) {
    const have = titleTokens(parsed.title ?? '');
    if (have.length === 0) return 'The name does not show a title.';
    const set = new Set(have);
    // §3.2: every query title token must be present in the result title.
    const missing = want.find((t) => !set.has(t));
    if (missing !== undefined) return `The title does not match "${q.title}".`;
    // A sequel or part number the user did not ask for means a different film.
    const wantSet = new Set(want);
    const extra = have.find((t) => !wantSet.has(t) && (/^\d+$/.test(t) || SEQUEL_WORDS.has(t)));
    if (extra !== undefined) return `This looks like a different film or part than "${q.title}".`;
  }
  // §3.2: "the year differs by more than 1".
  if (q.year !== undefined && parsed.year !== undefined && Math.abs(parsed.year - q.year) > 1) {
    return `It is from ${parsed.year}, but you asked for ${q.year}.`;
  }
  if (q.season !== undefined && parsed.season !== undefined && parsed.season !== q.season) {
    return `It is season ${parsed.season}, but you asked for season ${q.season}.`;
  }
  if (q.episode !== undefined && parsed.episodes && parsed.episodes.length > 0 && !parsed.episodes.includes(q.episode)) {
    return `It is not episode ${q.episode}.`;
  }
  return null;
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

function playabilityOf(parsed: ParsedRelease, ctx: ScoreContext, flags: string[]): number {
  const pb = ctx.playback;
  let pts: number;
  switch (parsed.codec) {
    case 'avc':
      pts = parsed.bitDepth === 10 ? 8 : 20; // §3.3 "avc 10-bit (Hi10P) 8", "avc 8-bit 20"
      break;
    case 'hevc': {
      const noHw = pb !== undefined && (!pb.hevc || (parsed.bitDepth === 10 && !pb.hevc10));
      pts = noHw ? 10 : 18; // "hevc, probe says no hardware HEVC 10", "hevc ... hardware (or unknown) 18"
      break;
    }
    case 'av1':
      pts = pb?.av1 === 'hardware' ? 16 : 9; // "av1 with hardware decode 16", "software-only or unknown 9"
      break;
    default:
      pts = 10; // "xvid / mpeg2 / vc1 10". vp9 and unknown codecs get the same (open in §3).
  }
  if (parsed.hdr.includes('dv') && parsed.dvFallback !== true) {
    flags.push('dv_no_fallback');
    if (pb !== undefined && !pb.dv) pts -= 8; // "Subtract 8: dv without confirmed fallback and probe says no DV"
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
  if (parsed.multiAudio && ctx.wantsMultiAudio) pts += 1; // "Add 1 (cap 20): multiAudio ..."
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
function totalRuntimeMin(r: MergedResult, parsed: ParsedRelease, ctx: ScoreContext): number | undefined {
  const per = ctx.runtimeMin ?? (isEpisodic(parsed, ctx.query) ? DEFAULT_EPISODE_RUNTIME_MIN : DEFAULT_FILM_RUNTIME_MIN);
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
    flags.push('too_small_for_claim'); // §3.3 "Below 0.6x low: 0 and flag too_small_for_claim"
    return { sanity: 0, bitrate: 0 };
  }
  if (perHour < band.low) {
    flags.push('small_for_quality'); // "Below low but at least 0.6x low: 5 and flag small_for_quality"
    return { sanity: 5, bitrate: 0 };
  }
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
    case 'mpeg2': return 'MPEG2';
    case 'vc1': return 'VC1';
    default: return undefined;
  }
}

/** §3.5 template: "{SOURCE} {RES}p {CODEC}{ 10-bit}, {SIZE}, {SEEDERS} seeders, {FIT}". */
function headline(r: MergedResult, parsed: ParsedRelease, adm: Ranked['admission']): string {
  const parts = [SOURCE_LABEL[parsed.source]];
  if (parsed.resolution) parts.push(`${parsed.resolution}p`);
  const codec = codecLabel(parsed);
  if (codec) parts.push(codec);
  let head = parts.join(' ');
  if (parsed.bitDepth === 10) head += ' 10-bit';
  const size = r.sizeBytes !== undefined && r.sizeBytes > 0 ? formatBytes(r.sizeBytes) : 'size unknown';
  const seeders = r.seeders === undefined ? 'no seeder count' : `${r.seeders} ${r.seeders === 1 ? 'seeder' : 'seeders'}`;
  let fit: string;
  if (!adm) fit = 'fit unknown';
  else if (adm.result === 'Fits') fit = `fits with ${formatBytes(adm.leftAfter)} to spare`;
  else if (adm.result === 'Tight') fit = `fits, leaves ${formatBytes(adm.leftAfter)} free`;
  else fit = `doesn't fit by ${formatBytes(-adm.leftAfter)}`;
  return `${head}, ${size}, ${seeders}, ${fit}`;
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
        out.push(`Only ${names ? names.join(' and ') : 'flagged sites'} list${names && names.length === 1 ? 's' : ''} it, and the app flags that source as unsafe.`);
        break;
      }
      case 'size_unknown': out.push('The site gave no size, so the fit and the size check could not run.'); break;
      case 'too_small_for_claim': out.push(`The file is far smaller than a real ${res}copy should be. It is probably not what the name says.`); break;
      case 'small_for_quality': out.push(`Smaller than usual for ${res}video, so expect lower quality.`); break;
      case 'bigger_than_needed': out.push(`Bigger than usual for ${res}video. A smaller copy would look the same.`); break;
      case 'dv_no_fallback': out.push('Dolby Vision with no standard HDR fallback listed. Colours can look wrong on screens that lack it.'); break;
      case 'lossless_audio_only': out.push('Only lossless audio, which adds gigabytes a phone cannot use.'); break;
      case 'hardcoded_subs': out.push('Subtitles are burned into the picture.'); break;
      case 'over_size_cap': out.push(`Bigger than your limit of ${formatBytes(ctx.maxBytes ?? 0)}.`); break;
      case 'partial_fits': out.push(`The whole pack does not fit, but ${partial} episode${partial === 1 ? '' : 's'} would.`); break;
      default: break;
    }
  }
  if (r.seeders !== undefined) out.push('Seeder counts are reported by the site and can be out of date.');
  return out;
}

// ---------------------------------------------------------------- scoring one result

interface Scored { ranked: Ranked; sizeKnown: boolean; eligible: boolean }

function scoreOne(r: MergedResult, id: string, parsed: ParsedRelease, ctx: ScoreContext, now: number): Scored {
  const flags: string[] = [];
  const sizeKnown = r.sizeBytes !== undefined && r.sizeBytes > 0;
  const runtimeMin = totalRuntimeMin(r, parsed, ctx);

  // Quality (0-40). Resolution 12 on tv/archive can push the sum past 40; cap it there.
  const size = sizeScore(r, parsed, runtimeMin, flags);
  const srcPts = SOURCE_POINTS[parsed.source][ctx.profile === 'archive' ? 1 : 0];
  const quality = Math.min(40, srcPts + resolutionPoints(parsed.resolution, ctx.profile) + size.bitrate);

  const playability = playabilityOf(parsed, ctx, flags);
  const health = healthOf(r, now);

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
  if (admission?.result === 'DoesntFit' || overCap || flags.includes('too_small_for_claim') || score < AVOID_BELOW_SCORE) {
    tier = 'avoid';
  } else if (
    score >= RECOMMENDED_MIN_SCORE && sizeKnown && !risky && admission !== null
  ) {
    tier = 'recommended';
  } else {
    tier = 'ok';
  }

  const reasons = [headline(r, parsed, admission), ...extraReasons(flags, parsed, r, ctx, partialEpisodes)];
  const ranked: Ranked = {
    id, score, tier, labels: [], reasons, flags, admission, result: r, parsed,
    breakdown: { quality, playability, health, sanity: size.sanity, fit, penalties },
    ...(partialEpisodes !== undefined ? { partialEpisodes } : {}),
  };
  return { ranked, sizeKnown, eligible: sizeKnown && tier !== 'avoid' && admission !== null && admission.result !== 'DoesntFit' };
}

// ---------------------------------------------------------------- shortlist

function dedupeKey(p: ParsedRelease): string {
  return [
    (p.title ?? '').toLowerCase(), p.year ?? '', p.season ?? '', (p.episodes ?? []).join(','),
    p.resolution ?? '', p.source, p.encoder ?? p.codec,
  ].join('|');
}

/** Prefer results that are not risky; fall back to all of them when every one is risky. */
function preferSafe(list: Scored[]): Scored[] {
  const safe = list.filter((s) => !s.ranked.flags.includes('risky_source'));
  return safe.length > 0 ? safe : list;
}

function pickShortlist(sorted: Scored[]): Ranked[] {
  // §3.5: deduplicate by (title, year, resolution, source, encoder); sorted order keeps the best copy.
  const seen = new Set<string>();
  const unique = sorted.filter((s) => {
    const k = dedupeKey(s.ranked.parsed);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const eligible = unique.filter((s) => s.eligible);
  const give = (s: Scored | undefined, label: Label): Ranked | undefined => {
    if (s && !s.ranked.labels.includes(label)) s.ranked.labels.push(label);
    return s?.ranked;
  };

  const fits = preferSafe(eligible.filter((s) => s.ranked.admission!.result === 'Fits'));
  const bestFit = fits[0]; // highest score among Fits
  give(bestFit, 'best-fit');

  if (bestFit) {
    const cap = SMALLER_FRACTION * bestFit.ranked.result.sizeBytes!;
    const small = preferSafe(eligible.filter((s) => s !== bestFit && s.ranked.result.sizeBytes! <= cap));
    give(small[0], 'smaller');
  }

  // best-quality: highest quality component among Fits or Tight (both are in `eligible`).
  const byQuality = preferSafe(eligible).slice().sort(
    (a, b) => b.ranked.breakdown.quality - a.ranked.breakdown.quality || b.ranked.score - a.ranked.score,
  );
  if (byQuality[0] !== bestFit) give(byQuality[0], 'best-quality');

  const order: Label[] = ['best-fit', 'smaller', 'best-quality'];
  const out: Ranked[] = [];
  for (const label of order) {
    const hit = eligible.find((s) => s.ranked.labels.includes(label));
    if (hit && !out.includes(hit.ranked)) out.push(hit.ranked);
  }
  for (const r of out) r.label = order.find((l) => r.labels.includes(l));
  return out;
}

// ---------------------------------------------------------------- entry point

/**
 * Applies the hard rules, scores what is left, and picks the shortlist.
 * `ranked` holds every kept result, best first, with "avoid" rows last.
 * Ids are `r1`, `r2`, ... by input position, so they stay stable for the session.
 */
export function scoreResults(results: readonly MergedResult[], ctx: ScoreContext): ScoreOutput {
  const now = ctx.now ?? Date.now();
  const excluded: Excluded[] = [];
  const scored: Scored[] = [];

  results.forEach((r, i) => {
    const id = `r${i + 1}`;
    const parsed = parseRelease(r.name);
    // §3.2 and decision D2: adult content is never recommended, and never goes into a shortlist.
    if (r.category === 'adult') {
      excluded.push({ id, result: r, reason: 'adult', detail: 'Adult content is never suggested.' });
      return;
    }
    const wrong = wrongTitle(parsed, ctx.query);
    if (wrong !== null) {
      excluded.push({ id, result: r, reason: 'wrong_title', detail: wrong });
      return;
    }
    if (EARLY_SOURCES.has(parsed.source) && !ctx.allowEarlySources) {
      excluded.push({
        id, result: r, reason: 'cam_source',
        detail: 'Recorded in a cinema or from an early source. The picture and sound are poor.',
      });
      return;
    }
    scored.push(scoreOne(r, id, parsed, ctx, now));
  });

  const rank = (s: Scored) => (s.ranked.tier === 'avoid' ? 1 : 0);
  const sorted = scored
    .map((s, i) => ({ s, i }))
    .sort((a, b) =>
      rank(a.s) - rank(b.s)
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
  return { ranked: sorted.map((s) => s.ranked), shortlist, excluded };
}
