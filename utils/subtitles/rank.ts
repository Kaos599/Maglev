/**
 * Grouping and order of subtitle results (docs/NATIVE_CONTRACT.md section 36.5). Pure.
 */
import { languageRank } from './languages.ts';
import { parseRelease } from './parseName.ts';
import type { SubtitleCandidate, SubtitleQuery } from './types.ts';

export type SubtitleGroup = 'fits' | 'probably' | 'maybe';

const GROUP_ORDER: readonly SubtitleGroup[] = ['fits', 'probably', 'maybe'];
/** Group tags shown on the rows. */
export const GROUP_LABEL: Record<SubtitleGroup, string> = {
  fits: 'Fits this file',
  probably: 'Probably fits',
  maybe: 'May be out of sync',
};

export interface RankedSubtitle {
  candidate: SubtitleCandidate;
  group: SubtitleGroup;
}

export interface RankOptions {
  /** The video's file name. */
  fileName: string;
  episodeConfidence: SubtitleQuery['episodeConfidence'];
  /** Language order from 36.2. */
  languages: readonly string[];
  hearingImpaired: 'both' | 'prefer' | 'avoid';
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * True when the subtitle's release name is the same release as the video: same group and source, and the same
 * resolution when both say one. A release name that gives no group or no source can't be told apart, so it isn't.
 */
export function releasesMatch(fileName: string, releaseName: string): boolean {
  const v = parseRelease(fileName);
  const r = parseRelease(releaseName);
  if (!v.group || !v.source || !r.group || !r.source) return false;
  if (v.group !== r.group || v.source !== r.source) return false;
  if (v.resolution && r.resolution && v.resolution !== r.resolution) return false;
  return true;
}

/** The group of one candidate. */
function groupOf(c: SubtitleCandidate, o: Pick<RankOptions, 'fileName' | 'episodeConfidence'>): SubtitleGroup {
  if (c.matchedBy === 'hash') return 'fits';
  // Without a sure episode a matching release name proves nothing about which episode the subtitle is for.
  if (o.episodeConfidence !== 'sure') return 'maybe';
  return releasesMatch(o.fileName, c.releaseName) ? 'probably' : 'maybe';
}

function dedupeKey(c: SubtitleCandidate): string {
  return [c.providerId, squash(c.releaseName), c.language, c.hearingImpaired ? 'hi' : ''].join('|');
}

/** Of two copies of the same release: a hash match wins, then more downloads, then the one seen first. */
function better(a: SubtitleCandidate, b: SubtitleCandidate): boolean {
  const ha = a.matchedBy === 'hash' ? 1 : 0;
  const hb = b.matchedBy === 'hash' ? 1 : 0;
  if (ha !== hb) return hb > ha;
  return (b.downloads ?? -1) > (a.downloads ?? -1);
}

/**
 * Drops duplicates (same provider and release name, once per language; a hearing-impaired copy is its own entry
 * so the user's preference can still choose), groups, and sorts: group, language order, hearing-impaired
 * preference, downloads (most first). Equal rows keep the order the sources gave them.
 */
export function rankCandidates(cands: readonly SubtitleCandidate[], o: RankOptions): RankedSubtitle[] {
  const kept = new Map<string, { c: SubtitleCandidate; at: number }>();
  cands.forEach((c, at) => {
    const k = dedupeKey(c);
    const prev = kept.get(k);
    if (!prev) kept.set(k, { c, at });
    else if (better(prev.c, c)) kept.set(k, { c, at: prev.at });
  });
  const rows = Array.from(kept.values()).map(({ c, at }) => ({
    candidate: c,
    group: groupOf(c, o),
    lang: languageRank(c.language, o.languages),
    hi: o.hearingImpaired === 'both' ? 0 : o.hearingImpaired === 'prefer' ? (c.hearingImpaired ? 0 : 1) : c.hearingImpaired ? 1 : 0,
    at,
  }));
  rows.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      (a.lang === b.lang ? 0 : a.lang < b.lang ? -1 : 1) ||
      a.hi - b.hi ||
      (b.candidate.downloads ?? -1) - (a.candidate.downloads ?? -1) ||
      a.at - b.at,
  );
  return rows.map((r) => ({ candidate: r.candidate, group: r.group }));
}

/**
 * The row pre-selected in the sheet: the first one, only when it is in "Fits this file". Otherwise null, and
 * Download stays disabled until the user picks.
 */
export function defaultSelection(ranked: readonly RankedSubtitle[]): number | null {
  return ranked.length > 0 && ranked[0].group === 'fits' ? 0 : null;
}

/** Rows for one language tab (the candidate's language is exactly this one). */
export function forLanguage(ranked: readonly RankedSubtitle[], language: string): RankedSubtitle[] {
  return ranked.filter((r) => r.candidate.language === language);
}
