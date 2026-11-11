// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/FitGirlRepacks.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { decodeEntities, stripTags, toMs } from '../text.ts';
import { firstMagnet } from './nicheText.ts';

export const ID = 'fitgirl';

/**
 * Scrape of the search results (WordPress posts). Only `category-lossless-repack` posts are games;
 * update digests are skipped. The list has no magnet: rows carry `detailUrl` and an empty `magnet`,
 * and `resolveMagnet` reads the post when the user adds one. `infoHash` is a stand-in (`fitgirl:<post id>`).
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<article/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const art of body.split(/<article\b/i).slice(1)) {
    const open = /^([^>]*)>/.exec(art)?.[1] ?? '';
    if (!/\bcategory-lossless-repack\b/.test(open)) continue;
    const id = /\bid="post-(\d+)"/.exec(open)?.[1];
    const link = /<h1 class="entry-title"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(art);
    if (!link) continue;
    const name = stripTags(link[2]);
    if (!name) continue;
    const url = decodeEntities(link[1]);
    out.push({
      providerId: ID,
      name,
      infoHash: `${ID}:${id ?? url}`,
      magnet: '',
      publishedAt: toMs(/<time[^>]*datetime="([^"]+)"/i.exec(art)?.[1]),
      category: 'games',
      detailUrl: url,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const fitgirl: SearchProvider = {
  id: ID,
  name: 'FitGirl Repacks',
  abbr: 'FG',
  homepage: 'https://fitgirl-repacks.site',
  mirrors: ['https://fitgirl-repacks.site'],
  categories: ['games'],
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
    const found = firstMagnet(await httpText(result.detailUrl, { signal, accept: 'text/html' }));
    if (!found) throw new ProviderError('parse', 'No magnet link on the page');
    return found;
  },
};
