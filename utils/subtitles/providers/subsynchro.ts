// Ported from LavX/bazarr-provider-catalog (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/subsynchro/provider.py
import { ProviderError } from '../../search/http.ts';
import { decodeEntities, stripTags } from '../../search/text.ts';
import { baseLanguage } from '../languages.ts';
import type { SubFormat, SubtitleCandidate, SubtitleContext, SubtitleProvider } from '../types.ts';
import { httpBytes, httpPageBytes, toPayload } from '../http.ts';
import { joinBase, pathOf, resolveHref, titleMatches, tokens } from '../match.ts';

export const ID = 'subsynchro';

export interface FilmLink {
  title: string;
  year?: number;
  url: string;
}

export interface ReleaseRow {
  releaseId: string;
  info: string;
  group: string;
  url: string;
  format: string;
  files: number;
}

export interface FileRow {
  fileId: string;
  filename: string;
  downloadUrl: string;
  format: string;
  downloads?: number;
}

const attr = (attrs: string, name: string): string => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return decodeEntities(m ? (m[1] ?? m[2] ?? '') : '');
};

/** Film title and year from the page heading: `<h1><strong>Inception</strong> ... 2010</a></h1>`. */
export function parseFilmHeader(body: string): { title: string; year?: number } {
  const m = /<h1\b[^>]*>\s*<strong>([\s\S]*?)<\/strong>[\s\S]*?(\d{4})/i.exec(body);
  return m ? { title: stripTags(m[1]), year: parseInt(m[2], 10) } : { title: '' };
}

/** A search that finds several films answers with a list; each film link looks like `1999/791-the-matrix.html`. */
export function parseFilmList(body: string, baseUrl: string): FilmLink[] {
  const out: FilmLink[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/<a\b[^>]*href="(\d{4}\/\d+-[^/"]+\.html)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = stripTags(m[2]);
    const url = resolveHref(`${baseUrl.replace(/\/+$/, '')}/`, m[1]);
    if (!title || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, year: parseInt(m[1].slice(0, 4), 10), url });
  }
  return out;
}

/** Release rows of a film page (`<tr id="release_6001" class="ligne fichier_1" ...>`); rows with no file are skipped. */
export function parseReleases(body: string, baseUrl: string): ReleaseRow[] {
  const rows: ReleaseRow[] = [];
  for (const m of body.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
    const id = attr(m[1], 'id');
    if (!id.startsWith('release_')) continue;
    const files = parseInt(/\bfichier_(\d+)\b/.exec(attr(m[1], 'class'))?.[1] ?? '0', 10);
    if (files <= 0) continue;
    let href = '';
    let info = '';
    for (const a of m[2].matchAll(/<a\b([^>]*)>/gi)) {
      const h = attr(a[1], 'href');
      const t = attr(a[1], 'title');
      if (h.endsWith('.html') && h.includes('/') && t) {
        href = h;
        info = t.trim();
        break;
      }
    }
    if (!href || !info) continue;
    rows.push({
      releaseId: id.slice('release_'.length),
      info,
      group: stripTags(/<strong\b[^>]*class=['"][^'"]*\bgroup_name\b[^'"]*['"][^>]*>([\s\S]*?)<\/strong>/i.exec(m[2])?.[1] ?? ''),
      url: resolveHref(`${baseUrl.replace(/\/+$/, '')}/`, href),
      format: attr(m[1], 'data-format'),
      files,
    });
  }
  return rows;
}

/** File articles of a release page (`<article id="fichier_5661">`). */
export function parseFiles(body: string, baseUrl: string): FileRow[] {
  const rows: FileRow[] = [];
  for (const m of body.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)) {
    const id = attr(m[1], 'id');
    if (!id.startsWith('fichier_')) continue;
    const h4 = /<h4\b[^>]*>([\s\S]*?)<\/h4>/i.exec(m[2]);
    const filename = h4 ? stripTags(h4[1]) : '';
    let down = '';
    for (const a of m[2].matchAll(/<a\b([^>]*)>/gi)) {
      if (/\btelecharger\b/.test(attr(a[1], 'class')) && attr(a[1], 'href')) {
        down = attr(a[1], 'href');
        break;
      }
    }
    if (!filename || !down) continue;
    const format = (/Format\s*:\s*([^<\r\n]+)/i.exec(m[2])?.[1] ?? '').trim().toLowerCase().replace(/^\./, '') || (/\.([a-z0-9]{2,4})$/i.exec(filename)?.[1].toLowerCase() ?? '');
    const dl = /T[ée]l[ée]chargement\s*:\s*([\s\S]*?)<\/li>/i.exec(m[2]);
    const n = dl ? parseInt(stripTags(dl[1]).replace(/\D+/g, ''), 10) : NaN;
    rows.push({
      fileId: id.slice('fichier_'.length),
      filename,
      downloadUrl: resolveHref(`${baseUrl.replace(/\/+$/, '')}/`, down),
      format,
      downloads: Number.isFinite(n) ? n : undefined,
    });
  }
  return rows;
}

const KNOWN: SubFormat[] = ['srt', 'ass', 'ssa', 'vtt'];

/** One candidate per file. RAR and 7z files are dropped (36.3). */
export function candidatesFromFiles(files: FileRow[], release: ReleaseRow): SubtitleCandidate[] {
  const out: SubtitleCandidate[] = [];
  for (const f of files) {
    if (f.format === 'rar' || f.format === '7z' || /\.(rar|7z)$/i.test(f.filename)) continue;
    const ext = /\.([a-z0-9]{2,4})$/i.exec(f.filename)?.[1].toLowerCase();
    const format = KNOWN.find((k) => k === f.format || k === ext);
    out.push({
      providerId: ID,
      id: pathOf(f.downloadUrl),
      language: 'fr',
      releaseName: release.info,
      matchedBy: 'title',
      ...(format ? { format } : {}),
      ...(f.downloads !== undefined ? { downloads: f.downloads } : {}),
    });
  }
  return out;
}

const overlap = (a: string, b: string): number => {
  const set = new Set(tokens(b).filter((t) => t.length > 2));
  return tokens(a).filter((t) => t.length > 2 && set.has(t)).length;
};

export const subsynchro: SubtitleProvider = {
  id: ID,
  name: 'SubSynchro',
  homepage: 'https://www.subsynchro.com',
  mirrors: ['https://www.subsynchro.com'],
  languages: ['fr'],
  kinds: ['movie'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q, ctx) {
    if (!q.languages.some((l) => baseLanguage(l) === 'fr')) return [];
    if (q.episodeConfidence === 'sure' && q.season !== undefined) return [];
    const title = q.title.trim();
    if (!title) return [];
    const searchPage = joinBase(ctx.baseUrl, '/tous-les-films.html');
    // One match redirects to the film; several come back as a list.
    const first = await httpPageBytes(searchPage, {
      signal: ctx.signal,
      accept: 'text/html',
      method: 'POST',
      body: `q=${encodeURIComponent(title)}`,
      contentType: 'application/x-www-form-urlencoded',
    });
    let pages: string[] = [first];
    if (parseReleases(first, ctx.baseUrl).length === 0) {
      const films = parseFilmList(first, ctx.baseUrl)
        .filter((f) => titleMatches(title, f.title) && !(q.year && f.year && f.year !== q.year))
        .slice(0, 3);
      pages = [];
      for (const f of films) pages.push(await httpPageBytes(f.url, { signal: ctx.signal, accept: 'text/html', referer: searchPage }));
    }
    for (const page of pages) {
      const head = parseFilmHeader(page);
      if (q.year && head.year && head.year !== q.year) continue;
      const releases = parseReleases(page, ctx.baseUrl)
        .sort((a, b) => overlap(q.fileName, b.info) - overlap(q.fileName, a.info))
        .slice(0, 6);
      const out: SubtitleCandidate[] = [];
      for (const r of releases) {
        const body = await httpPageBytes(r.url, { signal: ctx.signal, accept: 'text/html', referer: searchPage });
        out.push(...candidatesFromFiles(parseFiles(body, ctx.baseUrl), r));
      }
      if (out.length) return out;
    }
    return [];
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext) {
    const res = await httpBytes(joinBase(ctx.baseUrl, c.id), { signal: ctx.signal, referer: joinBase(ctx.baseUrl, '/') });
    if (/html/i.test(res.contentType)) throw new ProviderError('parse', 'The source sent a page, not a subtitle');
    return toPayload(res.bytes);
  },
};
