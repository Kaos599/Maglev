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
  if (match && rule.episodes === 'new_only' && episode !== null && seenEpisodes.includes(episode)) match = false;
  return { match, episode };
}
