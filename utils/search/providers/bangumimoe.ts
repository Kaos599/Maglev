// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/BangumiMoe.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, parseJson, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { parseSize, toInt, toMs } from '../text.ts';

export const ID = 'bangumimoe';

/** `POST /api/v2/torrent/search` -> `{ torrents: [...] }`. Size is a string such as "52.02 GB". */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  const json = parseJson(body);
  if (!json || !Array.isArray(json.torrents)) throw new ProviderError('parse', 'Unexpected response');
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const out: SearchResult[] = [];
  for (const t of json.torrents) {
    const hash = normalizeInfoHash(t?.infoHash) ?? normalizeInfoHash(/btih:([0-9A-Za-z]+)/.exec(t?.magnet ?? '')?.[1]);
    const name = typeof t?.title === 'string' ? t.title : '';
    if (!hash || !name) continue;
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name, ['https://tr.bangumi.moe:9696/announce', 'http://nyaa.tracker.wf:7777/announce']),
      sizeBytes: parseSize(t.size),
      seeders: toInt(t.seeders),
      leechers: toInt(t.leechers),
      publishedAt: toMs(t.publish_time),
      category: 'anime',
      detailUrl: t._id ? `${base}/torrent/${t._id}` : undefined,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const bangumimoe: SearchProvider = {
  id: ID,
  name: 'Bangumi Moe',
  abbr: 'BM',
  homepage: 'https://bangumi.moe',
  mirrors: ['https://bangumi.moe'],
  categories: ['anime'],
  nsfw: false,
  enabledByDefault: false,
  method: 'json',
  canPage: false,
  async search(q, category, page, ctx) {
    if (page > 1) return [];
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/api/v2/torrent/search`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/json', method: 'POST', contentType: 'application/json', body: JSON.stringify({ query: q }) });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
