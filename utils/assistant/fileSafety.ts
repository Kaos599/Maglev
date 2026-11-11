/**
 * File-list safety check for the assistant (docs/ASSISTANT_DESIGN.md §3.4).
 *
 * Pure: no React, no react-native, no engine. Input is the file list of a
 * torrent plus what the search result claimed. Output is a level and plain
 * English reasons.
 *
 * Green means "no red flags in the file list". It never means safe.
 * The file list cannot prove that a RAR is encrypted; the password rule only
 * looks at file names.
 */
import { fileKind } from '../fileKind.ts';
import { formatBytes } from '../../constants/format.ts';
import { DEFAULT_EPISODE_RUNTIME_MIN, DEFAULT_FILM_RUNTIME_MIN, TOO_SMALL_FRACTION, lowGbPerHour } from './sizeBands.ts';

export type SafetyLevel = 'green' | 'amber' | 'red';
export type SafetyCategory = 'movie' | 'tv' | 'anime' | 'music' | 'other';

export interface SafetyFile {
  path: string;
  sizeBytes: number;
}

export interface SafetyInput {
  /** The torrent name as the provider listed it. Used for resolution and codec claims. */
  name: string;
  category: SafetyCategory;
  files: readonly SafetyFile[];
  /** Size the search provider claimed for the whole torrent. */
  claimedSizeBytes?: number;
  /** Title the user searched for, and its year, if known. */
  queryTitle?: string;
  queryYear?: number;
  /** Runtime in minutes. Defaults: movie 110, tv and anime 45 (per episode). */
  runtimeMin?: number;
  /** Warnings from the release-name parser, e.g. 'cam_source'. */
  parserWarnings?: readonly string[];
}

export interface SafetyResult {
  level: SafetyLevel;
  reasons: string[];
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Programs and scripts. A video or music torrent never needs one (§3.4). */
const EXECUTABLE_EXT = new Set(['exe', 'scr', 'bat', 'cmd', 'lnk', 'js', 'vbs', 'ps1', 'msi', 'jar', 'dll', 'com', 'pif', 'hta']);
const APK_EXT = 'apk';

/** Media or document extensions that a disguised program may hide behind. */
const CARRIER_EXT = [
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'mpg', 'mpeg', 'm4v', 'webm', 'flv', 'ts',
  'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma',
  'jpg', 'jpeg', 'png', 'gif', 'pdf', 'txt', 'srt', 'sub', 'nfo',
];
const DISGUISE_RE = new RegExp(
  `\\.(${CARRIER_EXT.join('|')})\\.(${[...EXECUTABLE_EXT, APK_EXT].join('|')})$`,
  'i',
);

const EXEC_RED_CATEGORIES: ReadonlySet<SafetyCategory> = new Set(['movie', 'tv', 'anime', 'music']);
const VIDEO_CATEGORIES: ReadonlySet<SafetyCategory> = new Set(['movie', 'tv', 'anime']);

const SIZE_MISMATCH_FRACTION = 0.1;
const SAMPLE_FRACTION = 0.05;
const DIFFERENT_SIZE_FRACTION = 0.25;

/** Site-like names, e.g. "best-downloads.com". Used to spot a download-site lure. */
const DOMAIN_RE = /(^|[^a-z0-9])[a-z0-9-]+\.(com|net|org|io|ru|xyz|info|site|cc|ws)\b/i;

interface Finding {
  level: Exclude<SafetyLevel, 'green'>;
  reason: string;
}

const LEVEL_ORDER: Record<SafetyLevel, number> = { green: 0, amber: 1, red: 2 };

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function extOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(basename(path));
  return m ? m[1].toLowerCase() : '';
}

function stemOf(path: string): string {
  return basename(path).replace(/\.[A-Za-z0-9]+$/, '');
}

function isVideo(path: string): boolean {
  return fileKind(path) === 'video';
}

/** Splits into lowercase words. Works for accented titles too. */
function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Resolution in pixels height, from the name ("1080p", "4K"). */
function resolutionOf(name: string): number | undefined {
  const m = /\b(2160|1080|720|480)p\b/i.exec(name);
  if (m) return Number(m[1]);
  if (/\b(4k|uhd)\b/i.test(name)) return 2160;
  return undefined;
}

/** Codec class for the size bands. Unknown codecs use HEVC bands: the lenient choice. */
function codecClassOf(name: string): 'remux' | 'avc' | 'hevc' {
  if (/\bremux\b/i.test(name)) return 'remux';
  if (/\b(x264|h\.?264|avc)\b/i.test(name)) return 'avc';
  return 'hevc';
}

function defaultRuntimeMin(category: SafetyCategory): number {
  return category === 'movie' ? DEFAULT_FILM_RUNTIME_MIN : DEFAULT_EPISODE_RUNTIME_MIN;
}

function checkFiles(input: SafetyInput): Finding[] {
  const findings: Finding[] = [];
  const { category, files } = input;
  const total = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const videos = files.filter((f) => isVideo(f.path));
  const largestVideo = videos.reduce<SafetyFile | undefined>(
    (best, f) => (!best || f.sizeBytes > best.sizeBytes ? f : best),
    undefined,
  );

  for (const f of files) {
    const b = basename(f.path);
    const ext = extOf(f.path);

    if (DISGUISE_RE.test(b)) {
      findings.push({ level: 'red', reason: `"${b}" hides a program behind a media file name. Double extensions like this are how fake files trick people.` });
    }

    if (EXEC_RED_CATEGORIES.has(category) && EXECUTABLE_EXT.has(ext)) {
      findings.push({ level: 'red', reason: `Contains "${b}", a program or script. Video and music torrents never need one.` });
    }

    if (EXEC_RED_CATEGORIES.has(category) && ext === APK_EXT) {
      findings.push({ level: 'red', reason: `Contains "${b}", an Android app. Video and music torrents never need one.` });
    }

    if (fileKind(f.path) === 'doc' && /\b(install|codec|downloader|player)\b/i.test(stemOf(f.path))) {
      findings.push({ level: 'red', reason: `"${b}" tells you to install something (a codec, player or downloader). Real films don't need one.` });
    }
  }

  if (VIDEO_CATEGORIES.has(category) && videos.length === 0) {
    findings.push({ level: 'red', reason: 'No video file in this torrent. There is nothing here to watch.' });
  }

  const mainFile = files.reduce<SafetyFile | undefined>(
    (best, f) => (!best || f.sizeBytes > best.sizeBytes ? f : best),
    undefined,
  );
  if (VIDEO_CATEGORIES.has(category) && mainFile && fileKind(mainFile.path) === 'archive') {
    findings.push({ level: 'amber', reason: `The main file is an archive ("${basename(mainFile.path)}"). Its contents can't be checked before you download it.` });
  }

  const hasRar = files.some((f) => /\.rar$|\.r\d{2}$/i.test(basename(f.path)));
  const passwordNote = files.find(
    (f) => fileKind(f.path) === 'doc' && /(^|[^a-z])(password|pass|readme|how.to.open)([^a-z]|$)/i.test(stemOf(f.path)),
  );
  if (hasRar && passwordNote) {
    const linkFile = files.find((f) => /\.(url|html?)$/i.test(basename(f.path)));
    const domainFile = files.find((f) => DOMAIN_RE.test(basename(f.path)));
    const b = basename(passwordNote.path);
    if (linkFile || domainFile) {
      findings.push({ level: 'red', reason: `Has a RAR archive and a note named "${b}" about passwords, plus a link or download-site name. This is a common lure.` });
    } else {
      findings.push({ level: 'amber', reason: `Has a RAR archive and a note named "${b}" about passwords. Password-protected archives are a common lure.` });
    }
  }

  if (input.parserWarnings?.includes('cam_source')) {
    findings.push({ level: 'amber', reason: 'The name suggests a camera recording made inside a cinema. Picture and sound are poor.' });
  }

  if (input.claimedSizeBytes && input.claimedSizeBytes > 0 && total > 0) {
    const diff = Math.abs(input.claimedSizeBytes - total);
    if (diff / Math.max(input.claimedSizeBytes, total) > SIZE_MISMATCH_FRACTION) {
      findings.push({ level: 'amber', reason: `The search listed ${formatBytes(input.claimedSizeBytes)}, but the files add up to ${formatBytes(total)}.` });
    }
  }

  if (videos.length === 1 && input.queryTitle) {
    const v = videos[0];
    const vWords = new Set(words(stemOf(v.path)));
    const missing = words(input.queryTitle).some((w) => !vWords.has(w));
    if (missing) {
      findings.push({ level: 'amber', reason: `The name says one title, but the only video is named "${basename(v.path)}", which doesn't match it.` });
    }
    const yearIn = /\b(19|20)\d{2}\b/.exec(stemOf(v.path));
    if (yearIn && input.queryYear !== undefined && Math.abs(Number(yearIn[0]) - input.queryYear) > 1) {
      findings.push({ level: 'amber', reason: `The only video is from ${yearIn[0]}, but the title you searched for is from ${input.queryYear}.` });
    }
  }

  if (category === 'movie' && largestVideo && total > 0) {
    for (const v of videos) {
      if (v === largestVideo) continue;
      if (v.sizeBytes >= SAMPLE_FRACTION * total && v.sizeBytes <= DIFFERENT_SIZE_FRACTION * largestVideo.sizeBytes) {
        findings.push({ level: 'amber', reason: `"${basename(v.path)}" is ${formatBytes(v.sizeBytes)} and "${basename(largestVideo.path)}" is ${formatBytes(largestVideo.sizeBytes)}. A single film torrent with two very different video sizes is unusual.` });
        break;
      }
    }
  }

  if (largestVideo && VIDEO_CATEGORIES.has(category)) {
    const res = resolutionOf(input.name);
    if (res !== undefined) {
      const cls = codecClassOf(input.name);
      const low = lowGbPerHour(res, cls);
      const runtime = input.runtimeMin ?? defaultRuntimeMin(category);
      if (low !== undefined && runtime > 0) {
        const expectedLow = low * GB * (runtime / 60);
        const label = `${res}p ${cls === 'remux' ? 'Blu-ray remux' : cls === 'avc' ? 'H.264' : 'H.265'}`;
        if (res === 1080 && total < 100 * MB) {
          findings.push({ level: 'amber', reason: `The files add up to ${formatBytes(total)}, but the name claims 1080p. Real 1080p films are bigger than that.` });
        }
        if (largestVideo.sizeBytes < TOO_SMALL_FRACTION * expectedLow) {
          findings.push({ level: 'amber', reason: `"${basename(largestVideo.path)}" is only ${formatBytes(largestVideo.sizeBytes)}. A ${label} video of this length is usually at least ${formatBytes(expectedLow)}. It is probably not what the name says.` });
        }
      }
    }
  }

  return findings;
}

/**
 * Checks a torrent's file list and claims. Returns the highest level found and
 * every reason, in plain English. An empty file list is amber: nothing could be checked.
 */
export function checkFileSafety(input: SafetyInput): SafetyResult {
  if (input.files.length === 0) {
    return { level: 'amber', reasons: ['The file list is empty, so nothing could be checked.'] };
  }
  const findings = checkFiles(input);
  if (findings.length === 0) {
    return { level: 'green', reasons: ['I found nothing suspicious in the file list. That is not a guarantee.'] };
  }
  let level: SafetyLevel = 'green';
  for (const f of findings) if (LEVEL_ORDER[f.level] > LEVEL_ORDER[level]) level = f.level;
  return { level, reasons: findings.map((f) => f.reason) };
}
