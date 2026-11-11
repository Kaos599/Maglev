import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, joinUrl, parseJson, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { toInt } from '../text.ts';

export const ID = 'yts';

export function parse(body: string, ctx: ParseContext): SearchResult[] {
  const json = parseJson(body);
  if (json?.status && json.status !== 'ok') throw new ProviderError('http', String(json.status_message ?? 'YTS error'));
  const movies = json?.data?.movies;
  if (movies == null) {
    if (json?.data) return []; // movie_count 0: the field is absent
    throw new ProviderError('parse', 'Unexpected response');
  }
  if (!Array.isArray(movies)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const m of movies) {
    const title = m?.title_long ?? m?.title;
    if (typeof title !== 'string' || !Array.isArray(m.torrents)) continue;
    const qualityCount: Record<string, number> = {};
    for (const t of m.torrents) qualityCount[t?.quality] = (qualityCount[t?.quality] ?? 0) + 1;
    for (const t of m.torrents) {
      const hash = normalizeInfoHash(t?.hash);
      if (!hash) continue;
      // "Title (Year) 1080p"; the source type is added only when two rows share a quality.
      const type = typeof t.type === 'string' && qualityCount[t.quality] > 1 ? ` ${t.type}` : '';
      const name = `${title} ${t.quality ?? ''}${type}`.trim();
      const uploaded = toInt(t.date_uploaded_unix);
      out.push({
        providerId: ID,
        name,
        infoHash: hash,
        magnet: buildMagnet(hash, name, ['udp://glotorrents.pw:6969/announce']),
        sizeBytes: toInt(t.size_bytes),
        seeders: toInt(t.seeds),
        leechers: toInt(t.peers),
        publishedAt: uploaded ? uploaded * 1000 : undefined,
        category: 'movies',
        detailUrl: typeof m.url === 'string' ? m.url : undefined,
      });
      if (out.length >= ctx.limit) return out;
    }
  }
  return out;
}

export const yts: SearchProvider = {
  id: ID,
  name: 'YTS',
  abbr: 'YT',
  homepage: 'https://yts.bz',
  mirrors: ['https://movies-api.accel.li'],
  categories: ['movies'],
  nsfw: false,
  enabledByDefault: true,
  method: 'json',
  canPage: true,
  async search(q, category, page, ctx) {
    const url =
      `${joinUrl(ctx.baseUrl, '/api/v2/list_movies.json')}?query_term=${encodeURIComponent(q)}` +
      `&limit=${Math.min(ctx.limit, 50)}&page=${page}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/json' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
