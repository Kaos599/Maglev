/**
 * File-list safety check for the assistant (docs/ASSISTANT_DESIGN.md §3.4, review round 1: R1-7).
 *
 * Pure: no React, no react-native, no engine. Input is the file list of a
 * torrent plus what the search result claimed. Output is a level and structured
 * findings. Findings carry codes and `name_untrusted` fields, never sentences
 * built from attacker text; `describeFinding` writes the plain English.
 *
 * The category is derived from the file kinds and the parsed name. The provider's
 * label is only a hint for the default runtime (anime episodes are 24 minutes).
 *
 * Green means "no warning signs". It never means safe.
 * The file list cannot prove that a RAR is encrypted; the password rule only
 * looks at file names.
 */
import { fileKind } from '../fileKind.ts';
import { formatBytes } from '../../constants/format.ts';
import { parseRelease } from './releaseName.ts';
import { sanitizeText } from './sanitize.ts';
import {
  DEFAULT_ANIME_EPISODE_RUNTIME_MIN, DEFAULT_EPISODE_RUNTIME_MIN, DEFAULT_FILM_RUNTIME_MIN,
  SMALL_FRACTION, TOO_SMALL_FRACTION, sizeBand,
} from './sizeBands.ts';
import type { BandCodec } from './sizeBands.ts';

export type SafetyLevel = 'green' | 'amber' | 'red';
/** The provider's label. Only a hint (runtime default); safety never trusts it. */
export type SafetyCategory = 'movie' | 'tv' | 'anime' | 'music' | 'other';
/** What the torrent really is, worked out from its files and name. */
export type EffectiveCategory = 'video' | 'music' | 'other';

export interface SafetyFile {
  path: string;
  sizeBytes: number;
}

export interface SafetyInput {
  /** The torrent name as the provider listed it. Used for resolution and codec claims. */
  name: string;
  /** Provider label. Ignored for safety decisions; 'anime' only selects the 24-minute episode runtime. */
  category?: SafetyCategory;
  files: readonly SafetyFile[];
  /** Size the search provider claimed for the whole torrent. */
  claimedSizeBytes?: number;
  /** Title the user searched for, and its year, if known. */
  queryTitle?: string;
  queryYear?: number;
  /** Runtime in minutes. Defaults: film 110, episode 45, anime episode 24. */
  runtimeMin?: number;
  /** Warnings from the release-name parser, e.g. 'cam_source'. Merged with the parser's own. */
  parserWarnings?: readonly string[];
}

export type FindingCode =
  | 'no_warning_signs'
  | 'empty_file_list'
  | 'hidden_program'
  | 'program_in_media'
  | 'android_app_in_media'
  | 'programs_unchecked'
  | 'install_note'
  | 'no_video'
  | 'archive_main'
  | 'password_note_with_link'
  | 'password_note'
  | 'cam_source'
  | 'size_mismatch'
  | 'title_mismatch'
  | 'year_mismatch'
  | 'different_video_sizes'
  | 'video_too_small'
  | 'video_small';

export interface SafetyFinding {
  code: FindingCode;
  level: SafetyLevel;
  /** A file or torrent name written by a stranger. Never put it into a sentence; use `describeFinding`. */
  name_untrusted?: string;
  /** Short text the app wrote itself (sizes, years). Never contains names. */
  detail?: string;
}

export interface SafetyResult {
  level: SafetyLevel;
  findings: SafetyFinding[];
  /** What the torrent was judged to be. */
  category: EffectiveCategory;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Programs and scripts. A video or music torrent never needs one (§3.4). */
const EXECUTABLE_EXT = new Set([
  'exe', 'scr', 'bat', 'cmd', 'lnk', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'reg', 'url', 'ps1', 'psm1',
  'msi', 'msp', 'jar', 'dll', 'com', 'pif', 'hta', 'cpl',
]);
/** Android packages: plain, split and bundle formats. All are programs, exactly like .apk. */
const ANDROID_PKG_EXT: ReadonlySet<string> = new Set(['apk', 'xapk', 'apks', 'apkm', 'aab', 'apex']);

/** Media or document extensions that a disguised program may hide behind. */
const CARRIER_EXT = [
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'mpg', 'mpeg', 'm4v', 'webm', 'flv', 'ts',
  'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma',
  'jpg', 'jpeg', 'png', 'gif', 'pdf', 'txt', 'srt', 'sub', 'nfo',
];
const DISGUISE_RE = new RegExp(
  `\\.(${CARRIER_EXT.join('|')})\\.(${[...EXECUTABLE_EXT, ...ANDROID_PKG_EXT].join('|')})$`,
  'i',
);

const SIZE_MISMATCH_FRACTION = 0.1;
const SAMPLE_FRACTION = 0.05;
const DIFFERENT_SIZE_FRACTION = 0.25;

/** Site-like names, e.g. "best-downloads.com". Used to spot a download-site lure. */
const DOMAIN_RE = /(^|[^a-z0-9])[a-z0-9-]+\.(com|net|org|io|ru|xyz|info|site|cc|ws)\b/i;

const LEVEL_ORDER: Record<SafetyLevel, number> = { green: 0, amber: 1, red: 2 };

/**
 * Normalises a file path before any extension check: NFKC, invisible and control characters removed,
 * and trailing dots and spaces trimmed from every segment (Windows ignores them, so `setup.exe ` runs).
 */
export function normalizePath(path: string): string {
  const s = path.normalize('NFKC').replace(/[\p{Default_Ignorable_Code_Point}\p{Cc}]/gu, '');
  return s
    .split(/[\\/]/)
    .map((seg) => seg.replace(/[.\s]+$/u, ''))
    .join('/');
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function extOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(basename(path));
  return m ? m[1].toLowerCase() : '';
}

function stemOf(path: string): string {
  return basename(path).replace(/\.[A-Za-z0-9]+$/, '');
}

/** Splits into lowercase words. Works for accented titles too. Apostrophes are dropped, not split on. */
function words(s: string): string[] {
  return s.toLowerCase().replace(/['’‘`]/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Resolution in pixels height, from a name ("1080p", "4K"). */
function resolutionOf(name: string): number | undefined {
  const m = /\b(2160|1080|720|480)p\b/i.exec(name);
  if (m) return Number(m[1]);
  if (/\b(4k|uhd)\b/i.test(name)) return 2160;
  return undefined;
}

/** Codec class for the size bands. Unknown codecs use HEVC bands: the lenient choice. */
function codecClassOf(name: string): BandCodec {
  if (/\bremux\b/i.test(name)) return 'remux';
  if (/\b(x264|h\.?264|avc)\b/i.test(name)) return 'avc';
  return 'hevc';
}

interface Normalised extends SafetyFile {
  /** Normalised path. */
  p: string;
  kind: ReturnType<typeof fileKind>;
}

/** Works out what the torrent really is. The provider's label plays no part. */
function deriveCategory(name: string, files: readonly Normalised[]): EffectiveCategory {
  const parsed = parseRelease(name);
  let video = 0;
  let audio = 0;
  let total = 0;
  for (const f of files) {
    total += Math.max(0, f.sizeBytes);
    if (f.kind === 'video') video += Math.max(0, f.sizeBytes);
    else if (f.kind === 'audio') audio += Math.max(0, f.sizeBytes);
  }
  const nameVideo = parsed.resolution !== undefined
    || parsed.season !== undefined
    || (parsed.episodes?.length ?? 0) > 0
    || parsed.source !== 'unknown'
    || parsed.codec !== 'unknown';
  // A bare channel layout such as "2.1" gives an 'unknown' audio codec; that is not evidence of music.
  const nameMusic = !nameVideo && parsed.audio.some((a) => a.codec !== 'unknown');
  const hasExec = files.some((f) => EXECUTABLE_EXT.has(extOf(f.p)) || ANDROID_PKG_EXT.has(extOf(f.p)));
  if (total > 0 && (video + audio) / total >= 0.5) return video >= audio ? 'video' : 'music';
  if (total === 0 && video + audio > 0) return video >= audio ? 'video' : 'music';
  if (nameVideo) return 'video';
  // A video next to no program at all (for example a film shipped as an archive plus a sample) is a video torrent.
  if (video > 0 && !hasExec) return 'video';
  if (nameMusic) return 'music';
  return 'other';
}

function defaultRuntimeMin(input: SafetyInput, parsed: ReturnType<typeof parseRelease>): number {
  if (input.category === 'anime') return DEFAULT_ANIME_EPISODE_RUNTIME_MIN;
  if (parsed.season !== undefined || (parsed.episodes?.length ?? 0) > 0 || input.category === 'tv') return DEFAULT_EPISODE_RUNTIME_MIN;
  return DEFAULT_FILM_RUNTIME_MIN;
}

function checkFiles(input: SafetyInput, files: readonly Normalised[], category: EffectiveCategory): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  const parsed = parseRelease(input.name);
  const total = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const videos = files.filter((f) => f.kind === 'video');
  const largestVideo = videos.reduce<Normalised | undefined>(
    (best, f) => (!best || f.sizeBytes > best.sizeBytes ? f : best),
    undefined,
  );
  const media = category === 'video' || category === 'music';
  let unchecked: Normalised | undefined;
  let uncheckedCount = 0;

  for (const f of files) {
    const b = basename(f.p);
    const ext = extOf(f.p);
    const isExec = EXECUTABLE_EXT.has(ext);

    if (DISGUISE_RE.test(b)) {
      findings.push({ code: 'hidden_program', level: 'red', name_untrusted: b });
    } else if (media && isExec) {
      findings.push({ code: 'program_in_media', level: 'red', name_untrusted: b });
    } else if (media && ANDROID_PKG_EXT.has(ext)) {
      findings.push({ code: 'android_app_in_media', level: 'red', name_untrusted: b });
    } else if (!media && isExec) {
      unchecked ??= f;
      uncheckedCount++;
    }

    if (media && f.kind === 'doc' && /\b(install|codec|downloader|player)\b/i.test(stemOf(f.p))) {
      findings.push({ code: 'install_note', level: 'red', name_untrusted: b });
    }
  }

  if (unchecked) {
    findings.push({
      code: 'programs_unchecked', level: 'amber', name_untrusted: basename(unchecked.p),
      detail: uncheckedCount > 1 ? `${uncheckedCount} programs or scripts` : undefined,
    });
  }

  if (category === 'video' && videos.length === 0) {
    findings.push({ code: 'no_video', level: 'red' });
  }

  const mainFile = files.reduce<Normalised | undefined>(
    (best, f) => (!best || f.sizeBytes > best.sizeBytes ? f : best),
    undefined,
  );
  if (category === 'video' && mainFile && mainFile.kind === 'archive') {
    findings.push({ code: 'archive_main', level: 'amber', name_untrusted: basename(mainFile.p) });
  }

  const hasRar = files.some((f) => /\.rar$|\.r\d{2}$/i.test(basename(f.p)));
  const passwordNote = files.find(
    (f) => f.kind === 'doc' && /(^|[^a-z])(password|pass|readme|how.to.open)([^a-z]|$)/i.test(stemOf(f.p)),
  );
  if (hasRar && passwordNote) {
    const linkFile = files.find((f) => /\.(url|html?)$/i.test(basename(f.p)));
    const domainFile = files.find((f) => DOMAIN_RE.test(basename(f.p)));
    const code = linkFile || domainFile ? 'password_note_with_link' : 'password_note';
    findings.push({ code, level: code === 'password_note' ? 'amber' : 'red', name_untrusted: basename(passwordNote.p) });
  }

  const warnings = new Set([...(input.parserWarnings ?? []), ...parsed.warnings]);
  if (warnings.has('cam_source')) {
    findings.push({ code: 'cam_source', level: 'amber' });
  }

  if (input.claimedSizeBytes && input.claimedSizeBytes > 0 && total > 0) {
    const diff = Math.abs(input.claimedSizeBytes - total);
    if (diff / Math.max(input.claimedSizeBytes, total) > SIZE_MISMATCH_FRACTION) {
      findings.push({
        code: 'size_mismatch', level: 'amber',
        detail: `${formatBytes(input.claimedSizeBytes)} listed, ${formatBytes(total)} in the files`,
      });
    }
  }

  if (videos.length === 1 && input.queryTitle) {
    const v = videos[0];
    const vList = words(stemOf(v.p));
    const vWords = new Set(vList);
    const want = words(input.queryTitle);
    // A file often glues or splits the title the other way ("prime time" against Primetime.mkv), so the title
    // written without spaces inside the file name, also without spaces, counts as a match.
    const glued = want.join('');
    const missing = !(glued.length > 0 && vList.join('').includes(glued)) && want.some((w) => !vWords.has(w));
    if (missing) {
      findings.push({ code: 'title_mismatch', level: 'amber', name_untrusted: basename(v.p) });
    }
    const yearIn = /\b(19|20)\d{2}\b/.exec(stemOf(v.p));
    if (yearIn && input.queryYear !== undefined && Math.abs(Number(yearIn[0]) - input.queryYear) > 1) {
      findings.push({ code: 'year_mismatch', level: 'amber', detail: `${yearIn[0]} and ${input.queryYear}` });
    }
  }

  const isFilm = parsed.season === undefined && (parsed.episodes?.length ?? 0) === 0 && input.category !== 'tv' && input.category !== 'anime';
  if (category === 'video' && isFilm && largestVideo && total > 0) {
    for (const v of videos) {
      if (v === largestVideo) continue;
      if (v.sizeBytes >= SAMPLE_FRACTION * total && v.sizeBytes <= DIFFERENT_SIZE_FRACTION * largestVideo.sizeBytes) {
        findings.push({
          code: 'different_video_sizes', level: 'amber', name_untrusted: basename(v.p),
          detail: `${formatBytes(v.sizeBytes)} and ${formatBytes(largestVideo.sizeBytes)}`,
        });
        break;
      }
    }
  }

  // A lone video next to a bigger non-video file (a sample beside an archive) is not the payload; skip it.
  const loneSample = videos.length <= 1 && mainFile !== undefined && mainFile.kind !== 'video';
  if (largestVideo && category === 'video' && !loneSample) {
    // The check runs from the per-file size. The name gives the resolution when it can; else the file's own
    // name; else the lowest band (480p), the lenient choice.
    const res = resolutionOf(input.name) ?? resolutionOf(basename(largestVideo.p)) ?? 480;
    const cls = codecClassOf(input.name);
    const band = sizeBand(res, cls);
    const runtime = input.runtimeMin ?? defaultRuntimeMin(input, parsed);
    if (band && runtime > 0) {
      const expectedLow = band.low * GB * (runtime / 60);
      const label = `${res}p ${cls === 'remux' ? 'REMUX' : cls === 'avc' ? 'H.264' : 'H.265'}`;
      const detail = `${formatBytes(largestVideo.sizeBytes)}; ${label} is usually at least ${formatBytes(expectedLow)}`;
      if (largestVideo.sizeBytes < TOO_SMALL_FRACTION * expectedLow) {
        findings.push({ code: 'video_too_small', level: 'red', name_untrusted: basename(largestVideo.p), detail });
      } else if (largestVideo.sizeBytes < SMALL_FRACTION * expectedLow) {
        findings.push({ code: 'video_small', level: 'amber', name_untrusted: basename(largestVideo.p), detail });
      }
    }
  }

  return findings;
}

function normalise(files: readonly SafetyFile[]): Normalised[] {
  return files.map((f) => {
    const p = normalizePath(f.path);
    return { path: f.path, sizeBytes: Number.isFinite(f.sizeBytes) ? f.sizeBytes : 0, p, kind: fileKind(p) };
  });
}

/**
 * Checks a torrent's file list and claims. Returns the highest level found and structured findings.
 * An empty file list is amber: nothing could be checked. Green carries one `no_warning_signs` finding.
 */
export function checkFileSafety(input: SafetyInput): SafetyResult {
  if (input.files.length === 0) {
    return { level: 'amber', findings: [{ code: 'empty_file_list', level: 'amber' }], category: 'other' };
  }
  const files = normalise(input.files);
  const category = deriveCategory(input.name, files);
  const findings = checkFiles(input, files, category);
  if (findings.length === 0) {
    return { level: 'green', findings: [{ code: 'no_warning_signs', level: 'green' }], category };
  }
  let level: SafetyLevel = 'green';
  for (const f of findings) if (LEVEL_ORDER[f.level] > LEVEL_ORDER[level]) level = f.level;
  return { level, findings, category };
}

export interface ShortlistSafetyRow {
  /** Caller's key for the row (the info hash). */
  id: string;
  name: string;
  category?: SafetyCategory;
  /** Absent when the file list has not been fetched. */
  files?: readonly SafetyFile[];
  claimedSizeBytes?: number;
  parserWarnings?: readonly string[];
}

/**
 * Runs the file-list check for every shortlist row that has a file list.
 * Rows without one map to null: unknown, never "green".
 */
export function safetyForShortlist(
  rows: readonly ShortlistSafetyRow[],
  ctx: { queryTitle?: string; queryYear?: number; runtimeMin?: number } = {},
): Map<string, SafetyResult | null> {
  const out = new Map<string, SafetyResult | null>();
  for (const r of rows) {
    out.set(
      r.id,
      r.files
        ? checkFileSafety({
          name: r.name, category: r.category, files: r.files, claimedSizeBytes: r.claimedSizeBytes,
          parserWarnings: r.parserWarnings, queryTitle: ctx.queryTitle, queryYear: ctx.queryYear, runtimeMin: ctx.runtimeMin,
        })
        : null,
    );
  }
  return out;
}

/** Fixed green wording. Never "safe", never first person. */
export const GREEN_TEXT = "No warning signs in the file list. That isn't a guarantee.";

/**
 * Plain English for one finding. The only place that turns a finding into a sentence, so the UI and the
 * model read the same words. Names are left out unless `includeNames` is set (UI only); when set they are
 * sanitised and quoted. Never first person.
 */
export function describeFinding(f: SafetyFinding, opts: { includeNames?: boolean } = {}): string {
  const n = opts.includeNames && f.name_untrusted ? `"${sanitizeText(f.name_untrusted, 80)}"` : undefined;
  const d = f.detail ?? '';
  switch (f.code) {
    case 'no_warning_signs': return GREEN_TEXT;
    case 'empty_file_list': return 'The file list is empty, so nothing could be checked.';
    case 'hidden_program':
      return `${n ?? 'A file'} hides a program behind a media file name. Double extensions like this are how fake files trick people.`;
    case 'program_in_media':
      return `${n ? `Contains ${n}, a` : 'Contains a'} program or script. Video and music torrents never need one.`;
    case 'android_app_in_media':
      return `${n ? `Contains ${n}, an` : 'Contains an'} Android app. Video and music torrents never need one.`;
    case 'programs_unchecked':
      return `Programs can't be checked. ${d ? `This torrent has ${d}` : n ? `This torrent has ${n}` : 'This torrent has a program'}, and nothing here can confirm what it does.`;
    case 'install_note':
      return `${n ?? 'A note'} tells you to install something (a codec, player or downloader). Real films don't need one.`;
    case 'no_video': return 'No video file in this torrent. There is nothing here to watch.';
    case 'archive_main':
      return `The main file is an archive${n ? ` (${n})` : ''}. Its contents can't be checked before you download it.`;
    case 'password_note_with_link':
      return `Has a RAR archive and a note${n ? ` named ${n}` : ''} about passwords, plus a link or download-site name. This is a common lure.`;
    case 'password_note':
      return `Has a RAR archive and a note${n ? ` named ${n}` : ''} about passwords. Password-protected archives are a common lure.`;
    case 'cam_source': return 'The name suggests a camera recording made inside a cinema. Picture and sound are poor.';
    case 'size_mismatch': return `The search listed a different size than the files add up to (${d}).`;
    case 'title_mismatch':
      return `The only video${n ? ` is named ${n}, which` : ''} doesn't match the title you searched for.`;
    case 'year_mismatch': return `The only video is from a different year than the title you searched for (${d}).`;
    case 'different_video_sizes':
      return `This film torrent has two very different video sizes${d ? ` (${d})` : ''}${n ? `, including ${n}` : ''}. That is unusual.`;
    case 'video_too_small':
      return `${n ?? 'The video'} is far smaller than a real copy should be${d ? ` (${d})` : ''}. It is probably not what the name says.`;
    case 'video_small':
      return `${n ?? 'The video'} is smaller than usual${d ? ` (${d})` : ''}, so expect lower quality.`;
    default: return 'Something about this file list looks off.';
  }
}
