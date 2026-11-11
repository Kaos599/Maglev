// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/AudioBookBay.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { decodeEntities, stripTags } from '../text.ts';
import { absUrl, parseBinarySize, parseEnDate } from './nicheText.ts';

export const ID = 'audiobookbay';

/**
 * Scrape of the `div.post` blocks. The list has no hash: rows carry `detailUrl` and an empty `magnet`;
 * `resolveMagnet` reads the "Info Hash" on the post page. `infoHash` is a stand-in (`audiobookbay:<slug>`).
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<div/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const post of body.split(/<div class="post">/i).slice(1)) {
    const link = /<div class="postTitle"><h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(post);
    if (!link) continue;
    const name = stripTags(link[2]);
    if (!name) continue;
    const url = absUrl(ctx.baseUrl, decodeEntities(link[1]));
    const info = stripTags(/<div class="postContent">([\s\S]*?)<div class=['"]postMeta['"]/i.exec(post)?.[1] ?? '');
    const size = /File Size:\s*([\d.,]+\s*[KMGT]?B)s?\b/i.exec(info)?.[1];
    const posted = /Posted:\s*(\d{1,2}\s+[A-Za-z]{3}[a-z]*\s+\d{4})/i.exec(info)?.[1];
    out.push({
      providerId: ID,
      name,
      infoHash: `${ID}:${url.replace(/\/+$/, '').split('/').pop()}`,
      magnet: '',
      sizeBytes: parseBinarySize(size),
      publishedAt: parseEnDate(posted),
      category: 'books',
      detailUrl: url,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/** The post page lists "Info Hash:" in a table; the magnet is built from it with the default trackers. */
export function parseDetail(body: string, name: string): { magnet: string; infoHash: string } {
  const raw = /<td>\s*Info Hash:\s*<\/td>\s*<td>\s*([0-9A-Za-z]+)\s*<\/td>/i.exec(body)?.[1];
  const hash = normalizeInfoHash(raw);
  if (!hash) throw new ProviderError('parse', 'No info hash on the page');
  return { magnet: buildMagnet(hash, name), infoHash: hash };
}

export const audiobookbay: SearchProvider = {
  id: ID,
  name: 'AudioBookBay',
  abbr: 'AB',
  homepage: 'https://audiobookbay.lu',
  mirrors: ['https://audiobookbay.lu'],
  categories: ['books'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: true,
  async search(q, category, page, ctx) {
    const b = ctx.baseUrl.replace(/\/+$/, '');
    const url = `${b}${page > 1 ? `/page/${page}` : ''}/?s=${encodeURIComponent(q.trim())}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    if (!result.detailUrl || !/^https?:\/\//i.test(result.detailUrl)) throw new ProviderError('parse', 'No page to read the magnet from');
    return parseDetail(await httpText(result.detailUrl, { signal, accept: 'text/html' }), result.name);
  },
};
