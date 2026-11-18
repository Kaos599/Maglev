// Ported from LavX/bazarr-provider-catalog (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/nekur/provider.py
import { ProviderError } from '../../search/http.ts';
import { decodeEntities, stripTags } from '../../search/text.ts';
import { baseLanguage } from '../languages.ts';
import type { SubtitleCandidate, SubtitleContext, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { httpBytes, textOf, toPayload } from '../http.ts';
import { joinBase, pathOf, resolveHref, titleMatches } from '../match.ts';

export const ID = 'nekur';

export interface Row {
  title: string;
  year?: number;
  /** Site-root path of the download. */
  path: string;
  imdbId: string;
  notes: string;
}

/** Rows of the search answer that carry a `filmu-subtitri/download/` link. Rows without an IMDb link are skipped. */
export function parseSearch(body: string, baseUrl: string): Row[] {
  const rows: Row[] = [];
  for (const m of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    if (!m[1].includes('filmu-subtitri/download/')) continue;
    const cells = [...m[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => c[1]);
    if (cells.length < 6) continue;
    const a = /<a\b[^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i.exec(cells[0]);
    if (!a) continue;
    const titleText = stripTags(a[2]);
    const y = /\((\d{4})\)/.exec(titleText);
    const title = titleText.replace(/\(\d{4}\)/, '').trim();
    const imdb = /imdb\.com\/title\/(tt\d+)/i.exec(cells[3])?.[1];
    if (!title || !imdb) continue;
    rows.push({
      title,
      year: y ? parseInt(y[1], 10) : undefined,
      path: pathOf(resolveHref(`${baseUrl.replace(/\/+$/, '')}/`, decodeEntities(a[1]))),
      imdbId: imdb,
      notes: stripTags(cells[cells.length - 1]),
    });
  }
  return rows;
}

export function rowFits(r: Row, q: Pick<SubtitleQuery, 'title' | 'year'>): boolean {
  return titleMatches(q.title, r.title) && (!q.year || r.year === q.year);
}

export function toCandidate(r: Row): SubtitleCandidate {
  return {
    providerId: ID,
    id: r.path,
    language: 'lv',
    releaseName: r.notes || `${r.title}${r.year ? ` (${r.year})` : ''}`,
    matchedBy: 'title',
  };
}

export const nekur: SubtitleProvider = {
  id: ID,
  name: 'Subtitri Nekur',
  homepage: 'https://subtitri.nekur.net',
  mirrors: ['https://subtitri.nekur.net'],
  languages: ['lv'],
  kinds: ['movie'],
  matches: ['name'],
  group: 'B',
  enabledByDefault: false,
  async search(q, ctx) {
    if (!q.languages.some((l) => baseLanguage(l) === 'lv')) return [];
    if (q.episodeConfidence === 'sure' && q.season !== undefined) return [];
    const title = q.title.trim();
    if (!title) return [];
    // The site answers its search with HTTP 500 and the result table in the body.
    const res = await httpBytes(joinBase(ctx.baseUrl, '/modules/Subtitles.php'), {
      signal: ctx.signal,
      accept: 'text/html',
      method: 'POST',
      body: `ajax=1&sSearch=${encodeURIComponent(title)}`,
      contentType: 'application/x-www-form-urlencoded',
      referer: joinBase(ctx.baseUrl, '/'),
      okStatuses: [500],
    });
    const body = textOf(res.bytes);
    if (res.status === 500 && !body.includes('<tr')) throw new ProviderError('http', 'Not answering right now', 500);
    const seen = new Set<string>();
    const out: SubtitleCandidate[] = [];
    for (const r of parseSearch(body, ctx.baseUrl)) {
      if (!rowFits(r, q) || seen.has(r.path)) continue;
      seen.add(r.path);
      out.push(toCandidate(r));
    }
    return out;
  },
  async download(c: SubtitleCandidate, ctx: SubtitleContext) {
    const res = await httpBytes(joinBase(ctx.baseUrl, c.id), { signal: ctx.signal, referer: joinBase(ctx.baseUrl, '/') });
    return toPayload(res.bytes);
  },
};
