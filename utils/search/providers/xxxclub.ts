// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/XXXClub.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, infoHashFromMagnet, normalizeInfoHash } from '../magnet.ts';
import { parseDayMonthYear } from '../dates.ts';
import { decodeEntities, parseSize, stripTags, toInt } from '../text.ts';

export const ID = 'xxxclub';

/**
 * Scrape of the result list. TorrentSearch reads the magnet from the detail page. The list itself puts
 * the info hash in the `id` of the row's details link (`id="#i<40 hex>"`, checked against the detail
 * page magnet), so the magnet is built from it. A row without that id falls back to a deferred magnet
 * (`resolveMagnet`, stand-in key `xxxclub:<details path>`). Every row is adult content.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<div|<ul/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  if (ctx.hideAdult) return [];
  const out: SearchResult[] = [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const start = body.search(/<div class="(?:browsetableinside|divtableinside)"/i);
  if (start < 0) return out;
  for (const row of body.slice(start).split(/<li>/i).slice(1)) {
    const link = /<a\s+href="(\/torrents\/details\/([^"]+))"([^>]*)>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue; // header row
    const name = stripTags(link[4]);
    if (!name) continue;
    const idAttr = /id="#?i?([0-9A-Fa-f]{40})"/i.exec(link[3])?.[1];
    const hash = normalizeInfoHash(idAttr);
    const span = (cls: string) => new RegExp(`<span class="[^"]*\\b${cls}\\b[^"]*">([\\s\\S]*?)</span>`, 'i').exec(row)?.[1];
    out.push({
      providerId: ID,
      name,
      infoHash: hash ?? `${ID}:${link[2]}`,
      magnet: hash ? buildMagnet(hash, name) : '',
      sizeBytes: parseSize(stripTags(span('siz') ?? '')),
      seeders: toInt(stripTags(span('see') ?? '').replace(/,/g, '')),
      leechers: toInt(stripTags(span('lee') ?? '').replace(/,/g, '')),
      publishedAt: parseDayMonthYear(stripTags(span('adde') ?? '')),
      category: 'adult',
      detailUrl: base + decodeEntities(link[1]),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/** The magnet link on a detail page. */
export function parseMagnet(body: string): { magnet: string; infoHash: string } {
  const m = /href="(magnet:\?[^"]+)"/i.exec(body);
  const magnet = m ? decodeEntities(m[1]) : '';
  const hash = infoHashFromMagnet(magnet);
  if (!hash) throw new ProviderError('parse', 'No magnet link on the page');
  return { magnet, infoHash: hash };
}

export const xxxclub: SearchProvider = {
  id: ID,
  name: 'XXXClub',
  abbr: 'XC',
  homepage: 'https://xxxclub.to',
  mirrors: ['https://xxxclub.to'],
  categories: ['adult'],
  nsfw: true,
  enabledByDefault: false,
  method: 'html',
  // The site pages with an opaque cursor, not a page number.
  canPage: false,
  async search(q, category, _page, ctx) {
    if (ctx.hideAdult) return [];
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/torrents/search/all/${encodeURIComponent(q.trim())}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    if (!result.detailUrl || !/^https?:\/\//i.test(result.detailUrl)) throw new ProviderError('parse', 'No page to read the magnet from');
    return parseMagnet(await httpText(result.detailUrl, { signal, accept: 'text/html' }));
  },
};
