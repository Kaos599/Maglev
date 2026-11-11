// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/TokyoToshokan.kt
import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, infoHashFromMagnet } from '../magnet.ts';
import { decodeEntities, parseSize, stripTags, toInt } from '../text.ts';

export const ID = 'tokyotoshokan';

// Maglev category -> Tokyo Toshokan `type`. 'all' searches everything.
const TYPES: Partial<Record<Category, string>> = { anime: '1', music: '2', books: '3', other: '5', tv: '7' };

/** Site category sprite ("sprite_cat-anime") -> Maglev category. */
function categoryFromSprite(sprite: string | undefined): Category {
  switch (sprite) {
    case 'anime':
    case 'batch':
    case 'noneng':
    case 'raw':
      return 'anime';
    case 'music':
      return 'music';
    case 'manga':
      return 'books';
    case 'drama':
      return 'tv';
    case 'hanime':
    case 'hmanga':
    case 'hgame':
    case 'jav':
      return 'adult';
    default:
      return 'other';
  }
}

/** "2025-01-16 23:19 UTC" -> epoch ms. */
function parseDate(s: string | undefined): number | undefined {
  const m = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : undefined;
}

/**
 * Scrape of the listing table. Each torrent is two `<tr class="category_N">` rows: the first holds the
 * magnet and name (`desc-top`), the second the size, date and S/L/C counts (`desc-bot`).
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<table|<div/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const out: SearchResult[] = [];
  const rows = body.split(/<tr class="category_/i).slice(1);
  for (let i = 0; i < rows.length; i++) {
    const top = rows[i];
    if (!/class="desc-top"/.test(top)) continue;
    const bot = /class="desc-bot"/.test(rows[i + 1] ?? '') ? rows[i + 1] : '';
    const mag = /href="(magnet:[^"]+)"/i.exec(top);
    const magnet = mag ? decodeEntities(mag[1]) : '';
    const hash = infoHashFromMagnet(magnet);
    const nameMatch = /<a [^>]*href="(?!magnet:)[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(top.slice(top.indexOf('class="desc-top"')));
    const name = nameMatch ? stripTags(nameMatch[1]) : '';
    if (!hash || !name) continue;
    const category = categoryFromSprite(/sprite_cat-([a-z]+)/.exec(top)?.[1]);
    if (ctx.hideAdult && category === 'adult') continue;
    const details = /href="(details\.php\?id=\d+)"/.exec(top)?.[1];
    const stats = /S: <span[^>]*>(\d+)<\/span> L: <span[^>]*>(\d+)<\/span>/.exec(bot);
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name, ['http://nyaa.tracker.wf:7777/announce']),
      sizeBytes: parseSize(/Size: ([\d.,]+\s*[A-Za-z]+)/.exec(bot)?.[1]),
      seeders: toInt(stats?.[1]),
      leechers: toInt(stats?.[2]),
      publishedAt: parseDate(/Date: ([^<]+)/.exec(bot)?.[1]),
      category,
      detailUrl: details ? `${base}/${details}` : undefined,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export const tokyotoshokan: SearchProvider = {
  id: ID,
  name: 'Tokyo Toshokan',
  abbr: 'TT',
  homepage: 'https://www.tokyotosho.info',
  mirrors: ['https://www.tokyotosho.info'],
  categories: ['anime', 'music', 'books', 'tv', 'other'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  cloudflare: { solverUrl: 'https://www.tokyotosho.info' },
  async search(q, category, page, ctx) {
    if (page > 1) return [];
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/search.php?terms=${encodeURIComponent(q)}&type=${TYPES[category] ?? '0'}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
