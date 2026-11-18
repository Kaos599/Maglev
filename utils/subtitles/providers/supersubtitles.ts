// Ported from LavX/bazarr-provider-catalog, providers/supersubtitles (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/supersubtitles/provider.py
// Hungarian and English subtitles from feliratok.eu. Group B page scraper.
// Changes from the reference: one HTML search per lookup (the site's own title search, movie tab or series tab) instead of
// the series-id JSON API, which the site's firewall refuses to this app's User-Agent; no IMDb page fetches.
import { decodeEntities, stripTags } from '../../search/text.ts';
import { ProviderError, httpText } from '../../search/http.ts';
import { normalizeLanguage } from '../languages.ts';
import type { SubtitleCandidate, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { formatFromName, httpBytes, toPayload } from '../http.ts';
import { matchKind, parseDate, titleMatchesAlias } from '../match.ts';

export const ID = 'supersubtitles';

const LANG_LABEL: Record<string, string> = { magyar: 'hu', angol: 'en' };
const SUPPORTED = new Set(['hu', 'en']);

export interface SuperRow {
  id: string;
  language: string;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  /** A whole season in one file. */
  pack: boolean;
  releases: string;
  fileName: string;
  uploadedAt?: number;
}

function param(href: string, name: string): string {
  const m = new RegExp(`[?&]${name}=([^&]*)`).exec(decodeEntities(href));
  if (!m) return '';
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' '));
  } catch {
    return m[1];
  }
}

/** "Show - 3x03 - Episode (rel, rel)", "Show (Season 5) (rel)", or "Film (1999) (rel)". */
export function parseTitle(text: string): Pick<SuperRow, 'title' | 'year' | 'season' | 'episode' | 'pack' | 'releases'> {
  const t = text.replace(/\s+/g, ' ').trim();
  let m = /^(.*?)\s+-\s+(\d{1,2})x(\d{1,3})(?:\s+-\s+.*?)?\s*(?:\(([^()]*)\))?$/.exec(t);
  if (m) return { title: m[1].trim(), season: +m[2], episode: +m[3], pack: false, releases: m[4] ?? '' };
  m = /^(.*?)\s*\(Season\s+(\d{1,2})\)\s*(?:\(([^()]*)\))?$/i.exec(t);
  if (m) return { title: m[1].trim(), season: +m[2], pack: true, releases: m[3] ?? '' };
  m = /^(.*?)\s*\(((?:19|20)\d{2})\)\s*(?:\((.*)\))?$/.exec(t);
  if (m) return { title: m[1].trim(), year: +m[2], pack: false, releases: m[3] ?? '' };
  return { title: t, pack: false, releases: '' };
}

/** Rows of a movie-tab or series-tab results page. */
export function parseRows(html: string): SuperRow[] {
  if (!/<html|<body|<table|<tr/i.test(html)) throw new ProviderError('parse', 'Unexpected response');
  const out: SuperRow[] = [];
  const seen = new Set<string>();
  for (const chunk of html.split(/<tr\s+id="vilagit"/i).slice(1)) {
    const link = /href="([^"]*action=letolt[^"]*)"/i.exec(chunk);
    if (!link) continue;
    const id = param(link[1], 'felirat');
    const language = LANG_LABEL[(/<small>([^<]*)<\/small>/i.exec(chunk)?.[1] ?? '').trim().toLowerCase()];
    const original = /<div class="eredeti">([\s\S]*?)<\/div>/i.exec(chunk)?.[1];
    if (!id || !language || !original || seen.has(id)) continue;
    seen.add(id);
    const parsed = parseTitle(stripTags(original));
    out.push({
      id,
      language,
      ...parsed,
      fileName: param(link[1], 'fnev'),
      uploadedAt: parseDate(chunk),
    });
  }
  return out;
}

/** The release name shown for a row: the uploaded file's name without its language and extension, else the listing text. */
export function releaseName(r: SuperRow): string {
  const stem = r.fileName.replace(/\.(srt|ass|ssa|vtt|sub|zip|rar|7z)$/i, '').replace(/[._ -](hu|hun|en|eng)$/i, '').trim();
  return stem || [r.title, r.year ? `(${r.year})` : '', r.releases ? `(${r.releases})` : ''].filter(Boolean).join(' ');
}

export function searchUrl(base: string, q: SubtitleQuery): string {
  const tab = q.season !== undefined && q.episodeConfidence !== 'none' ? 'sorozat' : 'film';
  return `${base.replace(/\/+$/, '')}/index.php?search=${encodeURIComponent(q.title.trim()).replace(/%20/g, '+')}&soriSorszam=&nyelv=&tab=${tab}`;
}

/** Candidates for a query from a results page: wanted languages, the same title, and this season or episode. */
export function toCandidates(rows: SuperRow[], q: SubtitleQuery): SubtitleCandidate[] {
  const wanted = new Set(q.languages.map((l) => normalizeLanguage(l)).filter((l): l is string => !!l));
  const episodic = q.season !== undefined && q.episodeConfidence !== 'none';
  const out: SubtitleCandidate[] = [];
  for (const r of rows) {
    if (!wanted.has(r.language) || /\.(rar|7z)$/i.test(r.fileName)) continue;
    if (!titleMatchesAlias(q.title, r.title)) continue;
    if (episodic) {
      if (r.season === undefined || r.season !== q.season) continue;
      if (!r.pack && r.episode !== q.episode) continue;
    } else if (q.year !== undefined && r.year !== undefined && r.year !== q.year) continue;
    const name = releaseName(r);
    out.push({
      providerId: ID,
      id: r.id,
      language: r.language,
      releaseName: name,
      format: formatFromName(r.fileName),
      matchedBy: matchKind(q, name),
      uploadedAt: r.uploadedAt,
    });
  }
  return out;
}

export function downloadUrl(base: string, id: string): string {
  return `${base.replace(/\/+$/, '')}/index.php?action=letolt&felirat=${encodeURIComponent(id)}`;
}

export const supersubtitles: SubtitleProvider = {
  id: ID,
  name: 'SuperSubtitles',
  homepage: 'https://feliratok.eu',
  mirrors: ['https://feliratok.eu'],
  languages: ['hu', 'en'],
  kinds: ['movie', 'episode'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q, ctx) {
    if (!q.languages.some((l) => SUPPORTED.has(normalizeLanguage(l) ?? ''))) return [];
    const text = await httpText(searchUrl(ctx.baseUrl, q), { signal: ctx.signal, accept: 'text/html' });
    return toCandidates(parseRows(text), q);
  },
  async download(c, ctx) {
    const { bytes } = await httpBytes(downloadUrl(ctx.baseUrl, c.id), { signal: ctx.signal, accept: '*/*', headers: { Referer: `${ctx.baseUrl.replace(/\/+$/, '')}/` } });
    return toPayload(bytes, { language: c.language, nameHint: c.format ? `x.${c.format}` : '', requireCues: true });
  },
};
