// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/XXXTracker.kt
import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, infoHashFromMagnet } from '../magnet.ts';
import { parseDayMonthYear } from '../dates.ts';
import { decodeEntities, parseSize, stripTags, toInt } from '../text.ts';

export const ID = 'xxxtracker';

// The site prints Russian month abbreviations ("24 Апр 24").
const RU_MONTHS: Record<string, string> = {
  янв: 'Jan', фев: 'Feb', мар: 'Mar', апр: 'Apr', май: 'May', июн: 'Jun', июл: 'Jul', авг: 'Aug', сен: 'Sep', окт: 'Oct', ноя: 'Nov', дек: 'Dec',
};

/** "24 Апр 24" -> epoch ms (UTC). */
export function parseDate(s: string): number | undefined {
  const m = /^\s*(\d{1,2})\s+(\S+)\s+(\d{2,4})\s*$/.exec(s);
  if (!m) return undefined;
  const month = RU_MONTHS[m[2].toLowerCase().slice(0, 3)];
  return month ? parseDayMonthYear(`${m[1]} ${month} ${m[3]}`) : undefined;
}

/**
 * Fragile scrape of the result table: date, then a cell with the magnet link, the .torrent link and the
 * detail link, then size, then seeders and leechers. Every row is adult content.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<div|<table/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  if (ctx.hideAdult) return [];
  const out: SearchResult[] = [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  for (const row of body.split(/<tr[\s>]/i).slice(1)) {
    const mag = /href="(magnet:\?[^"]+)"/i.exec(row);
    const hash = infoHashFromMagnet(mag ? decodeEntities(mag[1]) : undefined);
    const link = /<a href="(\/torrent\/\d+\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!mag || !hash || !link) continue; // header row or a stray row
    const name = stripTags(link[2]);
    if (!name) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    // cells: date, name block, size, peers
    const magnet = decodeEntities(mag[1]);
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: magnet.startsWith('magnet:?') ? magnet : buildMagnet(hash, name),
      sizeBytes: parseSize(cells[2]),
      seeders: toInt(stripTags(/<span class="green">([\s\S]*?)<\/span>/i.exec(row)?.[1] ?? '')),
      leechers: toInt(stripTags(/<span class="red">([\s\S]*?)<\/span>/i.exec(row)?.[1] ?? '')),
      publishedAt: parseDate(cells[0] ?? ''),
      category: 'adult',
      detailUrl: base + decodeEntities(link[1]),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const xxxtracker: SearchProvider = {
  id: ID,
  name: 'XXXTracker',
  abbr: 'XT',
  homepage: 'https://xxxtor.com',
  mirrors: ['https://xxxtor.com'],
  categories: ['adult'],
  nsfw: true,
  enabledByDefault: false,
  method: 'html',
  canPage: true,
  cloudflare: { solverUrl: 'https://xxxtor.com/' },
  async search(q, category, page, ctx) {
    if (ctx.hideAdult) return [];
    // The site's pages are 0-based.
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/b.php?search=${encodeURIComponent(q.trim())}${page > 1 ? `&page=${page - 1}` : ''}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
