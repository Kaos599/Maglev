// Ported from LavX/bazarr-provider-catalog (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/soustitreseu/provider.py
import { ProviderError } from '../../search/http.ts';
import { decodeEntities, stripTags } from '../../search/text.ts';
import { baseLanguage } from '../languages.ts';
import type { SubtitleCandidate, SubtitleContext, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { httpBytes, httpPageBytes, toPayload } from '../http.ts';
import { fold, joinBase, pathOf, resolveHref, titleMatches, tokens } from '../match.ts';

export const ID = 'soustitreseu';

export interface MediaRow {
  mediaType: 'film' | 'series';
  title: string;
  year?: number;
  aliases: string[];
  exact: boolean;
  url: string;
}

export interface ArchiveRow {
  url: string;
  filename: string;
  label: string;
  season?: number;
  episode?: number;
  /** ISO 639-1 codes the listing and the file name give. */
  languages: string[];
}

const NAME_EXT = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub', 'zip', 'rar', '7z']);
const TAG_LANG: Record<string, string[]> = { vo: ['en'], eng: ['en'], vf: ['fr'], fre: ['fr'], enfr: ['en', 'fr'] };
const TWO_LETTER: Record<string, string> = { en: 'en', fr: 'fr' };

/**
 * The languages a file name is tagged with. VO, VF, ENFR and the three-letter codes count in any case; a bare EN or FR
 * collides with French words ("Asterix.en.Bretagne"), so it counts only in capitals or as the last word before the extension.
 */
export function nameLanguages(name: string): string[] {
  const raw = (() => {
    try {
      return name.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    } catch {
      return name;
    }
  })();
  let toks = raw.split(/[^0-9A-Za-z]+/).filter(Boolean);
  if (toks.length && NAME_EXT.has(toks[toks.length - 1].toLowerCase())) toks = toks.slice(0, -1);
  const found = new Set<string>();
  for (const t of toks) for (const l of TAG_LANG[t.toLowerCase()] ?? []) found.add(l);
  if (found.size) return [...found];
  for (const t of toks) if (t === 'EN' || t === 'FR') found.add(TWO_LETTER[t.toLowerCase()]);
  const last = toks[toks.length - 1]?.toLowerCase();
  if (last && TWO_LETTER[last]) found.add(TWO_LETTER[last]);
  return [...found];
}

/** The result list of search.html: one block per film or series. */
export function parseSearch(body: string, pageUrl: string): MediaRow[] {
  if (!/<html|<body|<li/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const rows: MediaRow[] = [];
  const re = /<li\b[^>]*class=['"]([^'"]*\b(?:serie|film)\b[^'"]*)['"][^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const h3 = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(m[2]);
    const a = h3 ? /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i.exec(h3[1]) : null;
    if (!a) continue;
    const aliases = [...a[2].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((s) => stripTags(s[1]).replace(/^-\s*/, '')).filter(Boolean);
    let title = stripTags(a[2].replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, ''));
    let year: number | undefined;
    const y = /\((\d{4})\)\s*$/.exec(title);
    if (y) {
      year = parseInt(y[1], 10);
      title = title.replace(/\(\d{4}\)\s*$/, '').trim();
    }
    if (!title) continue;
    rows.push({
      mediaType: /\bserie\b/i.test(m[1]) ? 'series' : 'film',
      title,
      year,
      aliases,
      exact: /\bexact\b/i.test(m[1]),
      url: resolveHref(pageUrl, decodeEntities(a[1])),
    });
  }
  return rows;
}

function seasonEpisode(label: string): { season?: number; episode?: number } {
  const t = decodeEntities(label);
  const e = /(\d{1,2})\s*(?:x|×)\s*(\d{1,3})/i.exec(t);
  if (e) return { season: parseInt(e[1], 10), episode: parseInt(e[2], 10) };
  const s = /\bS(\d{1,2})\b/i.exec(t);
  return s ? { season: parseInt(s[1], 10) } : {};
}

/** The download links of a film or series page (also present, shortened, in search results). */
export function parseArchives(body: string, pageUrl: string): ArchiveRow[] {
  const rows: ArchiveRow[] = [];
  const re = /<a\b(?=[^>]*href=['"]([^'"]+)['"])(?=[^>]*class=['"][^'"]*\bsubList\b[^'"]*['"])[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const block = m[2];
    const span = (cls: string) => {
      const s = new RegExp(`<span\\b[^>]*class=['"]${cls}[^'"]*['"][^>]*>([\\s\\S]*?)</span>`, 'i').exec(block);
      return s ? stripTags(s[1]) : '';
    };
    const href = decodeEntities(m[1]);
    const filename = span('filenameSerie') || span('filenameFilm') || span('smallFilenameSerie') || span('smallFilenameFilm') || decodeURIComponentSafe(href.replace(/^.*\//, ''));
    if (!filename) continue;
    const label = span('episodenum');
    const langs = new Set(nameLanguages(filename));
    for (const img of block.matchAll(/<img\b[^>]*(?:alt|title)=['"]([a-z]{2})['"][^>]*>/gi)) {
      if (img[1].toLowerCase() === 'fr' || img[1].toLowerCase() === 'en') langs.add(img[1].toLowerCase());
    }
    rows.push({
      url: resolveHref(pageUrl, href),
      filename,
      label,
      ...seasonEpisode(label),
      languages: ['en', 'fr'].filter((l) => langs.has(l)),
    });
  }
  return rows;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Rows worth opening: the right kind, a title that has all the wanted words, and not a different year. */
export function rankRows(rows: MediaRow[], title: string, kind: 'film' | 'series', year?: number): MediaRow[] {
  const score = (r: MediaRow) => (r.exact ? 50 : 0) + (fold(r.title) === fold(title) ? 40 : 20) + (year && r.year === year ? 20 : 0);
  return rows
    .filter((r) => r.mediaType === kind && (titleMatches(title, r.title) || r.aliases.some((a) => titleMatches(title, a))) && !(year && r.year && r.year !== year))
    .sort((a, b) => score(b) - score(a));
}

/** Candidates of one page: one per language the archive holds on its own. Two-language archives are skipped: the zip can't be told apart by language. */
export function candidatesFor(archives: ArchiveRow[], row: MediaRow, q: Pick<SubtitleQuery, 'season' | 'episode' | 'languages'>): SubtitleCandidate[] {
  const wanted = new Set(q.languages.map(baseLanguage));
  const out: SubtitleCandidate[] = [];
  const seen = new Set<string>();
  for (const a of archives) {
    if (/\.(rar|7z)$/i.test(a.filename)) continue;
    if (row.mediaType === 'series') {
      if (q.season === undefined || a.season !== q.season) continue;
      if (a.episode !== undefined && a.episode !== q.episode) continue;
    }
    if (a.languages.length !== 1) continue;
    const language = a.languages[0];
    if (!wanted.has(language)) continue;
    const id = pathOf(a.url);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ providerId: ID, id, language, releaseName: a.filename.replace(/\.(zip|srt|ass|ssa|vtt|sub)$/i, ''), matchedBy: 'title' });
  }
  return out;
}

export function searchUrl(base: string, title: string): string {
  return `${joinBase(base, '/search.html')}?q=${encodeURIComponent(title)}`;
}

export const soustitreseu: SubtitleProvider = {
  id: ID,
  name: 'Sous-Titres.eu',
  homepage: 'https://www.sous-titres.eu',
  mirrors: ['https://www.sous-titres.eu'],
  languages: ['en', 'fr'],
  kinds: ['movie', 'episode'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q, ctx) {
    if (!q.languages.some((l) => ['en', 'fr'].includes(baseLanguage(l)))) return [];
    const episode = q.episodeConfidence === 'sure' && q.season !== undefined && q.episode !== undefined;
    if (!q.title.trim() || tokens(q.title).length === 0) return [];
    const url = searchUrl(ctx.baseUrl, q.title.trim());
    const rows = rankRows(parseSearch(await httpPageBytes(url, { signal: ctx.signal, accept: 'text/html' }), url), q.title, episode ? 'series' : 'film', episode ? undefined : q.year).slice(0, 3);
    for (const row of rows) {
      const body = await httpPageBytes(row.url, { signal: ctx.signal, accept: 'text/html', referer: url });
      const found = candidatesFor(parseArchives(body, row.url), row, q);
      if (found.length) return found;
    }
    return [];
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext) {
    const res = await httpBytes(joinBase(ctx.baseUrl, c.id), { signal: ctx.signal, referer: joinBase(ctx.baseUrl, '/') });
    return toPayload(res.bytes);
  },
};
