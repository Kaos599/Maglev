// Ported from LavX/bazarr-provider-catalog, providers/titrari (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/titrari/provider.py
// Romanian and English (and a few other languages) subtitles from titrari.ro. Group B page scraper.
// Changes from the reference: the site's plain title search (page=cautare) instead of the advanced search, no IMDb ids,
// and about half of the files on this site are RAR, which Maglev can't open: those fail at download with the
// "file type isn't supported" message, because the listing doesn't say which kind a file is.
import { stripTags } from '../../search/text.ts';
import { ProviderError, httpText } from '../../search/http.ts';
import { normalizeLanguage } from '../languages.ts';
import type { SubtitleCandidate, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { httpBytes, toPayload } from '../http.ts';
import { bestRelease, parseDate, titleMatchesAlias } from '../match.ts';

export const ID = 'titrari';

// The site's language id (the flag file and the search menu) to a Maglev code.
const SITE_LANG: Record<string, string> = { '1': 'ro', '2': 'en', '3': 'es', '4': 'de', '5': 'it', '6': 'pt', '7': 'fr', '18': 'cs', '19': 'ru', '20': 'hu' };
const SITE_ID: Record<string, string> = Object.fromEntries(Object.entries(SITE_LANG).map(([k, v]) => [v, k]));

export interface TitrariRow {
  id: string;
  language: string;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  /** The uploader's comment: usually the release names. */
  comment: string;
  downloads: number;
  uploadedAt?: number;
}

function parseTitle(full: string): { title: string; year?: number; season?: number } {
  let t = full.replace(/\s+/g, ' ').trim();
  const years = [...t.matchAll(/\((\d{4})\)/g)];
  const year = years.length ? +years[years.length - 1][1] : undefined;
  t = t.replace(/\s*\(\d{4}\)\s*/g, ' ').trim();
  const m = /^(.*?)\s*[-:]?\s*\b(?:Sezonul|Season)\s+(\d{1,2})\b.*$/i.exec(t);
  if (m && m[1].trim()) return { title: m[1].trim(), year, season: +m[2] };
  return { title: t, year };
}

/** Season and episode a comment names: "S02E12", "Sezonul 2 Episodul 12". */
function fromComment(c: string): { season?: number; episode?: number } {
  let m = /\bS(\d{1,2})\s*[._ -]?E(\d{1,3})\b/i.exec(c);
  if (m) return { season: +m[1], episode: +m[2] };
  m = /\bSezonul\s+(\d{1,2})\s+Episodul\s+(\d{1,3})\b/i.exec(c);
  if (m) return { season: +m[1], episode: +m[2] };
  m = /\bSezonul\s+(\d{1,2})\b/i.exec(c);
  return m ? { season: +m[1] } : {};
}

/** Result blocks of a search page (the page is UTF-8). */
export function parseRows(html: string): TitrariRow[] {
  if (!/<html|<body|<table/i.test(html)) throw new ProviderError('parse', 'Unexpected response');
  const out: TitrariRow[] = [];
  const seen = new Set<string>();
  for (const part of html.split(/(?=<tr><td\s+rowspan\s*=\s*['"]?4['"]?\s+class\s*=\s*['"]?row1)/i)) {
    const block = part.split('<tr><td class="row1, test"')[0];
    const id = /href\s*=\s*['"]?get\.php\?id=(\d+)/i.exec(block)?.[1];
    const h1 = /<h1>\s*<a\b[^>]*>([\s\S]*?)<\/a>\s*<\/h1>/i.exec(block)?.[1];
    const flag = /flags\/(\d+)\.gif/i.exec(block)?.[1];
    const language = flag ? SITE_LANG[flag] : undefined;
    if (!id || !h1 || !language || seen.has(id)) continue;
    seen.add(id);
    const t = parseTitle(stripTags(h1));
    const comment = stripTags(/<td\s+class\s*=\s*['"]?comment['"]?\s+width\s*=\s*['"]?100%['"]?>([\s\S]*?)<\/td>/i.exec(block)?.[1] ?? '');
    const c = fromComment(comment);
    out.push({
      id,
      language,
      title: t.title,
      year: t.year,
      season: t.season ?? c.season,
      episode: c.episode,
      comment,
      downloads: Number(/Descarcari:\s*(\d+)/i.exec(stripTags(block))?.[1] ?? 0),
      uploadedAt: parseDate(/Data:\s*(\d{4}-\d{2}-\d{2})/i.exec(stripTags(block))?.[1] ?? ''),
    });
  }
  return out;
}

/** The episode numbers a pack comment covers ("Episoadele 1-8"), or null when it names no range. */
function packRange(comment: string): [number, number] | null {
  const m = /\b(?:episoadele|episodes?|ep\.?)\s*0*(\d{1,3})\s*-\s*0*(\d{1,3})\b/i.exec(comment);
  return m ? [+m[1], +m[2]] : null;
}

export function toCandidates(rows: TitrariRow[], q: SubtitleQuery): SubtitleCandidate[] {
  const episodic = q.season !== undefined && q.episodeConfidence !== 'none';
  const out: SubtitleCandidate[] = [];
  for (const r of rows) {
    if (!titleMatchesAlias(q.title, r.title)) continue;
    if (episodic) {
      if (r.season === undefined || r.season !== q.season) continue;
      if (r.episode !== undefined && q.episode !== undefined && r.episode !== q.episode) continue;
      const range = r.episode === undefined ? packRange(r.comment) : null;
      if (range && q.episode !== undefined && (q.episode < range[0] || q.episode > range[1])) continue;
    } else {
      if (r.season !== undefined) continue;
      if (q.year !== undefined && r.year !== undefined && r.year !== q.year) continue;
    }
    const rel = r.comment ? bestRelease(q, r.comment) : { name: `${r.title}${r.year ? ` (${r.year})` : ''}`, matchedBy: 'title' as const };
    out.push({
      providerId: ID,
      id: r.id,
      language: r.language,
      releaseName: rel.name,
      matchedBy: rel.matchedBy,
      downloads: r.downloads,
      uploadedAt: r.uploadedAt,
    });
  }
  return out;
}

/** The site language ids to ask for: the wanted languages the site has, at most three, in order. */
export function wantedSiteIds(q: SubtitleQuery): string[] {
  const ids: string[] = [];
  for (const l of q.languages) {
    const id = SITE_ID[normalizeLanguage(l) ?? ''];
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length === 3) break;
  }
  return ids;
}

export function searchUrl(base: string, title: string, siteLang: string): string {
  return `${base.replace(/\/+$/, '')}/index.php?page=cautare&z1=0&z2=${encodeURIComponent(title.trim()).replace(/%20/g, '+')}&z3=${siteLang}&z4=1`;
}

export function downloadUrl(base: string, id: string): string {
  return `${base.replace(/\/+$/, '')}/get.php?id=${encodeURIComponent(id)}`;
}

export const titrari: SubtitleProvider = {
  id: ID,
  name: 'Titrari.ro',
  homepage: 'https://www.titrari.ro',
  mirrors: ['https://www.titrari.ro'],
  languages: ['ro', 'en', 'es', 'de', 'it', 'pt', 'fr', 'cs', 'ru', 'hu'],
  kinds: ['movie', 'episode'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q, ctx) {
    const out: SubtitleCandidate[] = [];
    for (const lang of wantedSiteIds(q)) {
      const text = await httpText(searchUrl(ctx.baseUrl, q.title, lang), { signal: ctx.signal, accept: 'text/html' });
      out.push(...toCandidates(parseRows(text), q).filter((c) => c.language === SITE_LANG[lang]));
    }
    return out;
  },
  async download(c, ctx) {
    // get.php sends a visitor with no Referer back to the film's page instead of the file.
    const { bytes } = await httpBytes(downloadUrl(ctx.baseUrl, c.id), { signal: ctx.signal, accept: '*/*', headers: { Referer: `${ctx.baseUrl.replace(/\/+$/, '')}/` } });
    return toPayload(bytes, { language: c.language, requireCues: true });
  },
};
