import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, joinUrl, parseJson, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { toInt } from '../text.ts';

export const ID = 'torrentscsv';

// Cursor pagination: the response carries `next`, which is passed back as `after`.
const cursors = new Map<string, number>();
const cursorKey = (q: string, base: string) => `${base}|${q}`;

export function parse(body: string, ctx: ParseContext): SearchResult[] {
  const json = parseJson(body);
  const rows = json?.torrents;
  if (!Array.isArray(rows)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const r of rows) {
    const hash = normalizeInfoHash(r?.infohash);
    const name = typeof r?.name === 'string' ? r.name : undefined;
    if (!hash || !name) continue;
    const created = toInt(r.created_unix);
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name),
      sizeBytes: toInt(r.size_bytes),
      seeders: toInt(r.seeders),
      leechers: toInt(r.leechers),
      publishedAt: created ? created * 1000 : undefined,
      category: 'other',
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const torrentscsv: SearchProvider = {
  id: ID,
  name: 'Torrents-CSV',
  abbr: 'TC',
  homepage: 'https://torrents-csv.com',
  mirrors: ['https://torrents-csv.com'],
  categories: ['other'],
  nsfw: false,
  enabledByDefault: true,
  method: 'json',
  canPage: true,
  async search(q, category, page, ctx) {
    let url = `${joinUrl(ctx.baseUrl, '/service/search')}?q=${encodeURIComponent(q)}&size=${ctx.limit}`;
    if (page > 1) {
      const after = cursors.get(cursorKey(q, ctx.baseUrl));
      if (after == null) return [];
      url += `&after=${after}`;
    }
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/json' });
    const json = parseJson(text);
    const next = toInt(json?.next);
    if (next != null) cursors.set(cursorKey(q, ctx.baseUrl), next);
    else cursors.delete(cursorKey(q, ctx.baseUrl));
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
