// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/BlueRoms.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { decodeEntities, parseSize, stripTags } from '../text.ts';
import { firstMagnet, absUrl } from './nicheText.ts';

export const ID = 'blueroms';

/**
 * Scrape of the result cards (retro console games). Each card links to a download page, which holds the
 * magnet: rows carry `detailUrl` = that download page and an empty `magnet`; `resolveMagnet` reads it.
 * `infoHash` is a stand-in (`blueroms:<download id>`).
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<div/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const card of body.split(/<div class="card"/i).slice(1)) {
    const dl = /<div class="card-footer"[^>]*>\s*<a href="([^"]+)"/i.exec(card)?.[1];
    const title = /<h4 class="card-title"[^>]*>\s*<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(card);
    if (!dl || !title) continue;
    const game = stripTags(title[2]);
    if (!game) continue;
    const platform = /<strong>\s*Platform:\s*<\/strong>\s*<a[^>]*>([\s\S]*?)<\/a>/i.exec(card)?.[1];
    const size = /<strong>\s*Size:\s*<\/strong>\s*([^<]+)/i.exec(card)?.[1];
    const downloadUrl = absUrl(ctx.baseUrl, decodeEntities(dl));
    out.push({
      providerId: ID,
      name: platform ? `${game} - ${stripTags(platform)}` : game,
      infoHash: `${ID}:${downloadUrl.replace(/\/+$/, '').split('/').pop()}`,
      magnet: '',
      sizeBytes: parseSize(size?.trim().replace(/GiB$/i, ' GiB').replace(/MiB$/i, ' MiB').replace(/KiB$/i, ' KiB')),
      category: 'games',
      detailUrl: downloadUrl,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/**
 * The download page. Today's layout hides the magnet Base64-encoded in `button#magnet-button[data-link]`
 * (as TorrentSearch reads it); the older layout (Wayback 2022 capture) has a plain magnet link.
 */
export function parseMagnet(body: string): { magnet: string; infoHash: string } {
  const data = /<button[^>]*id="magnet-button"[^>]*>/i.exec(body)?.[0];
  const link = data ? /data-link="([^"]+)"/i.exec(data)?.[1] : undefined;
  if (link) {
    try {
      const magnet = atob(link);
      const found = firstMagnet(`href="${magnet}"`);
      if (found) return found;
    } catch {
      // fall through to the plain link
    }
  }
  const found = firstMagnet(body);
  if (!found) throw new ProviderError('parse', 'No magnet link on the page');
  return found;
}

export const blueroms: SearchProvider = {
  id: ID,
  name: 'BlueRoms',
  abbr: 'BR',
  homepage: 'https://www.blueroms.ws',
  mirrors: ['https://www.blueroms.ws'],
  categories: ['games'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  cloudflare: { solverUrl: 'https://www.blueroms.ws/' },
  async search(q, category, page, ctx) {
    if (page > 1) return [];
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/search?g=0&p=0&q=${encodeURIComponent(q.trim())}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    if (!result.detailUrl || !/^https?:\/\//i.test(result.detailUrl)) throw new ProviderError('parse', 'No page to read the magnet from');
    return parseMagnet(await httpText(result.detailUrl, { signal, accept: 'text/html' }));
  },
};
