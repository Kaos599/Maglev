/**
 * Feed rule matching (docs/NATIVE_CONTRACT.md section 11.6).
 * Same semantics as Kotlin FeedRuleMatcher; scripts/fixtures/feeds/rule-vectors.json is the shared truth.
 */

export interface RuleMatchInput {
  include: string;
  exclude: string;
  episodes: 'all' | 'new_only';
}

export interface MatchResult {
  match: boolean;
  /** Episode key such as "s2e5", or null when the title has none. */
  episode: string | null;
  /** Show-aware key "the show|s1e2", or null when the title has no episode. */
  key: string | null;
}

const SXXEYY = /s(\d{1,3})\s?e(\d{1,4})/i;
const NXNN = /\b(\d{1,2})x(\d{2,4})\b/i;
const ABSOLUTE = /\s-\s(\d{1,4})(?:v\d+)?(?=[\s[(.]|$)/i;

/** Parses "s1e2" style keys: S01E02, 1x02, S01E01-E03 (first episode) and anime " - 12" / " - 12v2". */
export function parseEpisodeKey(title: string): string | null {
  let m = SXXEYY.exec(title);
  if (m) return `s${parseInt(m[1], 10)}e${parseInt(m[2], 10)}`;
  m = NXNN.exec(title);
  if (m) return `s${parseInt(m[1], 10)}e${parseInt(m[2], 10)}`;
  m = ABSOLUTE.exec(title);
  if (m) return `s1e${parseInt(m[1], 10)}`;
  return null;
}

const BRACKET_TAGS = /\[[^\]]*\]|\([^)]*\)/g;
const SPACED_TAGS = /\b(?:web ?dl|web ?rip|blu ?ray|h ?26[45]|x ?26[45])\b/g;
const YEAR = /^(?:19|20)\d\d$/;
const QUALITY_TAGS = new Set([
  '480p', '576p', '720p', '1080p', '1440p', '2160p', '4k', 'uhd', 'hd', 'web', 'webdl', 'webrip', 'bluray',
  'bdrip', 'brrip', 'hdrip', 'hdtv', 'dvdrip', 'remux', 'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid',
  'aac', 'ac3', '10bit', 'hdr', 'proper', 'repack',
]);

/**
 * Show name: the title text before the episode marker, lower case, ". _ -" as spaces, bracket groups, years (only when other words remain)
 * and quality/source tags dropped, spaces collapsed. Empty when there is no marker. Same rules as Kotlin FeedRuleMatcher.showName.
 */
export function showName(title: string): string {
  const starts = [SXXEYY, NXNN, ABSOLUTE].map((re) => re.exec(title)?.index).filter((i): i is number => i !== undefined);
  if (starts.length === 0) return '';
  const text = title
    .slice(0, Math.min(...starts))
    .replace(BRACKET_TAGS, ' ')
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(SPACED_TAGS, (m) => m.replace(' ', ''));
  const words = text.split(/\s+/).filter((w) => w !== '');
  const named = words.filter((w) => !QUALITY_TAGS.has(w));
  // A year is dropped only when other words remain ("1923 S01E01" is the show "1923").
  const noYear = named.filter((w) => !YEAR.test(w));
  const kept = noYear.length > 0 ? noYear : named;
  // Never reduce a titled release to nothing: fall back to the normalised words.
  return (kept.length > 0 ? kept : words).join(' ');
}

/** "<show>|s1e2" (show may be empty), or null when the title has no episode. */
export function episodeIdentity(title: string): string | null {
  const ep = parseEpisodeKey(title);
  return ep === null ? null : `${showName(title)}|${ep}`;
}

/** Returns the pattern when the text is wrapped in /…/, else null. */
function regexBody(spec: string): string | null {
  return spec.length >= 2 && spec.startsWith('/') && spec.endsWith('/') ? spec.slice(1, -1) : null;
}

/** True when the pattern syntax (/…/) is used but cannot compile. */
export function isInvalidPattern(spec: string): boolean {
  const body = regexBody(spec.trim());
  if (body === null) return false;
  if (body === '') return true;
  try {
    new RegExp(body, 'i');
    return false;
  } catch {
    return true;
  }
}

/** Words mode: every word (include) or any word (exclude) must appear. Pattern mode: it must match. Invalid patterns never match. */
function matchesSpec(spec: string, title: string, words: 'every' | 'some'): boolean {
  const s = spec.trim();
  if (!s) return words === 'every';
  const body = regexBody(s);
  if (body !== null) {
    if (body === '') return false;
    try {
      return new RegExp(body, 'i').test(title);
    } catch {
      return false;
    }
  }
  const lower = title.toLowerCase();
  const parts = s.toLowerCase().split(/\s+/);
  return words === 'every' ? parts.every((w) => lower.includes(w)) : parts.some((w) => lower.includes(w));
}

export function matchItem(rule: RuleMatchInput, title: string, seenEpisodes: readonly string[] = []): MatchResult {
  const episode = parseEpisodeKey(title);
  const included = matchesSpec(rule.include, title, 'every');
  const excluded = matchesSpec(rule.exclude, title, 'some');
  let match = included && !excluded;
  const key = episodeIdentity(title);
  if (match && rule.episodes === 'new_only' && episode !== null && key !== null) {
    // An old key without a show ("s1e2") belongs to an unknown show: it keeps suppressing that episode for
    // every show and is never removed.
    if (seenEpisodes.includes(key) || seenEpisodes.includes(episode)) match = false;
  }
  return { match, episode, key };
}
