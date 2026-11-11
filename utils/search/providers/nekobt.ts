// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/NekoBT.kt
// TorrentSearch scrapes the HTML and has a TODO for the JSON API. Maglev uses the JSON API.
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, parseJson, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { toInt } from '../text.ts';

export const ID = 'nekobt';

/** `/api/v1/torrents/search` -> `{ data: { results: [...] } }`. Sizes and counts arrive as strings. */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  const json = parseJson(body);
  const results = json?.data?.results;
  if (!Array.isArray(results)) throw new ProviderError('parse', 'Unexpected response');
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const out: SearchResult[] = [];
  for (const r of results) {
    if (!r || r.deleted || r.hidden || r.waiting_approve) continue;
    const hash = normalizeInfoHash(r.infohash);
    const name = typeof r.title === 'string' ? r.title : '';
    if (!hash || !name) continue;
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name, ['https://tracker.nekobt.to/api/tracker/public/announce', 'http://nyaa.tracker.wf:7777/announce']),
      sizeBytes: toInt(r.filesize),
      seeders: toInt(r.seeders),
      leechers: toInt(r.leechers),
      publishedAt: typeof r.uploaded_at === 'number' ? r.uploaded_at : undefined,
      category: 'anime',
      detailUrl: r.id ? `${base}/torrents/${r.id}` : undefined,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const nekobt: SearchProvider = {
  id: ID,
  name: 'NekoBT',
  abbr: 'NK',
  homepage: 'https://nekobt.to',
  mirrors: ['https://nekobt.to'],
  categories: ['anime'],
  nsfw: false,
  enabledByDefault: false,
  method: 'json',
  canPage: false,
  async search(q, category, page, ctx) {
    if (page > 1) return [];
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/api/v1/torrents/search?query=${encodeURIComponent(q)}&limit=${Math.min(ctx.limit, 50)}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/json' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
