// Ported from LavX/bazarr-provider-catalog, providers/subtitrarinoi (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/subtitrarinoi/provider.py
// Romanian subtitles from subtitrari-noi.ro. Group B page scraper.
// Changes from the reference: title search only (no IMDb id), and no per-file zip member listing: a zip goes to the app's member choice.
import { decodeEntities, stripTags } from '../../search/text.ts';
import { ProviderError, httpText } from '../../search/http.ts';
import { normalizeLanguage } from '../languages.ts';
import type { SubtitleCandidate, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { httpBytes, toPayload } from '../http.ts';
import { bestRelease, parseDate, titleMatchesAlias } from '../match.ts';

export const ID = 'subtitrarinoi';

export interface NoiRow {
  /** The download link as the site prints it; the candidate id. */
  href: string;
  title: string;
  year?: number;
  comment: string;
  downloads: number;
  uploadedAt?: number;
}

function splitTitle(label: string): { title: string; year?: number } {
  const m = /^(.*?)\s*\((\d{4})\)\s*$/.exec(label);
  return m ? { title: m[1].trim(), year: +m[2] } : { title: label.trim() };
}

/** Result blocks of the search answer (an HTML fragment, UTF-8). */
export function parseRows(html: string): NoiRow[] {
  if (/Acces direct interzis/i.test(html)) throw new ProviderError('parse', 'Unexpected response');
  const starts = [...html.matchAll(/<div\b[^>]*id=['"]round['"][^>]*>/gi)].map((m) => m.index ?? 0);
  const out: NoiRow[] = [];
  const seen = new Set<string>();
  starts.forEach((start, i) => {
    const chunk = html.slice(start, starts[i + 1] ?? html.length);
    const link = /<div\b[^>]*id=['"]content-main['"][^>]*>[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(chunk);
    const dl = /<p\b[^>]*class=['"][^'"]*\bbuton\b[^'"]*['"][^>]*>[\s\S]*?<a\b[^>]*href=['"]([^'"]+)['"]/i.exec(chunk);
    if (!link || !dl) return;
    const href = decodeEntities(dl[1]);
    if (seen.has(href)) return;
    seen.add(href);
    const comment = stripTags(/<div\b[^>]*font-weight\s*:\s*bold[^>]*font-style\s*:\s*italic[^>]*>([\s\S]*?)<\/div>/i.exec(chunk)?.[1] ?? '').replace(/\(\s*NOU!\s*\)/gi, '');
    out.push({
      href,
      ...splitTitle(stripTags(link[1])),
      comment,
      downloads: Number(/Descarcari:\s*(\d+)/i.exec(stripTags(chunk))?.[1] ?? 0),
      uploadedAt: parseDate(/<p>\s*Data:\s*([\d.]+)/i.exec(chunk)?.[1] ?? ''),
    });
  });
  return out;
}

/** The seasons a comment covers: "Sezoanele 1-5 complete", "Sezonul 3", "S02E04". Empty when it names none. */
function seasonsOf(comment: string): number[] {
  const range = /\bsezoanele\s+(\d{1,2})\s*[-,]\s*(\d{1,2})\b/i.exec(comment);
  if (range) {
    const out: number[] = [];
    for (let s = +range[1]; s <= +range[2] && out.length < 40; s++) out.push(s);
    return out;
  }
  const one = /\b(?:sezonul|season)\s*0*(\d{1,2})\b/i.exec(comment) ?? /\bS0*(\d{1,2})\s*E\d/i.exec(comment);
  return one ? [+one[1]] : [];
}

/** A single episode a comment names ("Episodul 4", "S02E04"), or undefined for a pack. */
function episodeOf(comment: string): number | undefined {
  if (/\bepisoadele\b|\bcomplete?\b/i.test(comment)) return undefined;
  const m = /\bS\d{1,2}\s*E0*(\d{1,3})\b/i.exec(comment) ?? /\bepisodul\s*0*(\d{1,3})\b/i.exec(comment);
  return m ? +m[1] : undefined;
}

export function toCandidates(rows: NoiRow[], q: SubtitleQuery): SubtitleCandidate[] {
  if (!q.languages.some((l) => normalizeLanguage(l) === 'ro')) return [];
  const episodic = q.season !== undefined && q.episodeConfidence !== 'none';
  const out: SubtitleCandidate[] = [];
  for (const r of rows) {
    const bare = r.title.replace(/\s*-\s*Sezonul\s+\d+\s*$/i, '');
    if (!titleMatchesAlias(q.title, bare)) continue;
    if (episodic) {
      const seasons = seasonsOf(`${r.title} ${r.comment}`);
      if (!seasons.includes(q.season as number)) continue;
      const ep = episodeOf(r.comment);
      if (ep !== undefined && q.episode !== undefined && ep !== q.episode) continue;
    } else if (q.year !== undefined && r.year !== undefined && r.year !== q.year) continue;
    const rel = r.comment ? bestRelease(q, r.comment) : { name: `${r.title}${r.year ? ` (${r.year})` : ''}`, matchedBy: 'title' as const };
    out.push({
      providerId: ID,
      id: r.href,
      language: 'ro',
      releaseName: rel.name,
      matchedBy: rel.matchedBy,
      downloads: r.downloads,
      uploadedAt: r.uploadedAt,
    });
  }
  return out;
}

export function searchBody(title: string): string {
  const t = encodeURIComponent(title.trim()).replace(/%20/g, '+');
  return `search_q=1&tip=2&an=Toti+anii&gen=Toate&cautare=${t}&query_q=${t}`;
}

export function downloadUrl(base: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return `${base.replace(/\/+$/, '')}/${href.replace(/^\/+/, '').replace(/ /g, '%20')}`;
}

export const subtitrarinoi: SubtitleProvider = {
  id: ID,
  name: 'Subtitrari Noi',
  homepage: 'https://www.subtitrari-noi.ro',
  mirrors: ['https://www.subtitrari-noi.ro'],
  languages: ['ro'],
  kinds: ['movie', 'episode'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q, ctx) {
    if (!q.languages.some((l) => normalizeLanguage(l) === 'ro')) return [];
    const base = ctx.baseUrl.replace(/\/+$/, '');
    // The answer is a fragment for the site's own script; it refuses a request that doesn't say it is one.
    const text = await httpText(`${base}/paginare_filme.php`, {
      signal: ctx.signal,
      accept: 'text/html',
      method: 'POST',
      body: searchBody(q.title),
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
      headers: { 'X-Requested-With': 'XMLHttpRequest', Origin: base, Referer: `${base}/` },
    });
    return toCandidates(parseRows(text), q);
  },
  async download(c, ctx) {
    const base = ctx.baseUrl.replace(/\/+$/, '');
    const { bytes } = await httpBytes(downloadUrl(ctx.baseUrl, c.id), { signal: ctx.signal, accept: '*/*', headers: { Referer: `${base}/` } });
    return toPayload(bytes, { language: c.language, requireCues: true });
  },
};
