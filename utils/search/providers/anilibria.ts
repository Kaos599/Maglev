// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/AniLibria.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, parseJson, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { toInt, toMs } from '../text.ts';

export const ID = 'anilibria';

/** Releases looked up per search, each needing one more request (TorrentSearch uses 15). */
const MAX_RELEASES = 10;

export interface Release {
  id: number;
  alias?: string;
  name: string;
}

/** `GET /api/v1/app/search/releases?query=` -> array of releases. */
export function parseReleases(body: string): Release[] {
  const json = parseJson(body);
  if (!Array.isArray(json)) throw new ProviderError('parse', 'Unexpected response');
  const out: Release[] = [];
  for (const r of json) {
    if (typeof r?.id !== 'number') continue;
    out.push({ id: r.id, alias: typeof r.alias === 'string' ? r.alias : undefined, name: r.name?.english || r.name?.main || '' });
  }
  return out;
}

/** `GET /api/v1/anime/torrents/release/{id}` -> array of torrents (one per quality). */
export function parse(body: string, ctx: ParseContext, release?: Release): SearchResult[] {
  const json = parseJson(body);
  if (!Array.isArray(json)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const t of json) {
    const hash = normalizeInfoHash(t?.hash);
    const name = (typeof t?.label === 'string' && t.label) || t?.release?.name?.english || release?.name || '';
    if (!hash || !name) continue;
    const alias = t?.release?.alias ?? release?.alias;
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name, ['http://tr.libria.fun:2710/announce']),
      sizeBytes: toInt(t.size),
      seeders: toInt(t.seeders),
      leechers: toInt(t.leechers),
      publishedAt: toMs(t.created_at),
      category: 'anime',
      detailUrl: alias ? `https://anilibria.top/anime/releases/release/${alias}` : undefined,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const anilibria: SearchProvider = {
  id: ID,
  name: 'AniLibria',
  abbr: 'AL',
  homepage: 'https://anilibria.top',
  mirrors: ['https://anilibria.top'],
  categories: ['anime'],
  nsfw: false,
  enabledByDefault: false,
  method: 'json',
  canPage: false,
  async search(q, category, page, ctx) {
    if (page > 1) return [];
    const base = ctx.baseUrl.replace(/\/+$/, '');
    const pc: ParseContext = { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit };
    const releases = parseReleases(await httpText(`${base}/api/v1/app/search/releases?query=${encodeURIComponent(q)}`, { signal: ctx.signal, accept: 'application/json' })).slice(0, MAX_RELEASES);
    const lists = await Promise.all(
      releases.map(async (r) => {
        try {
          return parse(await httpText(`${base}/api/v1/anime/torrents/release/${r.id}`, { signal: ctx.signal, accept: 'application/json' }), pc, r);
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          return [];
        }
      }),
    );
    return lists.flat().slice(0, ctx.limit);
  },
};
