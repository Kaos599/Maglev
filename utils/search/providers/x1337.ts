import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { infoHashFromMagnet } from '../magnet.ts';
import { decodeEntities, parseSize, stripTags, toInt } from '../text.ts';

export const ID = 'x1337';

// Maglev category -> 1337x category-search segment. Books live under "Other" on 1337x.
const SEGMENT: Partial<Record<Category, string>> = {
  movies: 'Movies',
  tv: 'TV',
  anime: 'Anime',
  music: 'Music',
  apps: 'Apps',
  games: 'Games',
  books: 'Other',
  other: 'Other',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * "Mar. 7th '17" -> epoch ms (UTC). Recent rows carry a time and no year ("10:41am Dec. 24th"):
 * the year is then the current one, or the previous one when that would land in the future.
 */
export function parseDate(s: string, now = Date.now()): number | undefined {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+'(\d{2}))?/.exec(s);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return undefined;
  const day = parseInt(m[2], 10);
  if (m[3]) return Date.UTC(2000 + parseInt(m[3], 10), month, day);
  const year = new Date(now).getUTCFullYear();
  const t = Date.UTC(year, month, day);
  return t > now + 86_400_000 ? Date.UTC(year - 1, month, day) : t;
}

/**
 * Fragile scrape of the result table. The list has no magnet and no info hash: each row carries a
 * `detailUrl` and an empty `magnet`; `resolveMagnet` reads the detail page when the user adds it.
 * `infoHash` is a stand-in key (`x1337:<torrent id>`) until then, so rows never merge with other sources.
 */
export function parse(body: string, ctx: ParseContext, now = Date.now()): SearchResult[] {
  if (!/<html|<body|<div|<table/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  for (const row of body.split(/<tr[\s>]/i).slice(1)) {
    const link = /<a href="(\/torrent\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue; // header row or a stray row
    const name = stripTags(link[3]);
    if (!name) continue;
    const icon = /<i class="flaticon-([a-z0-9-]+)"/i.exec(row)?.[1] ?? '';
    const category: Category | undefined = /xxx|adult/i.test(icon) ? 'adult' : ctx.category !== 'all' ? ctx.category : undefined;
    if (ctx.hideAdult && category === 'adult') continue;
    const cell = (cls: string) => new RegExp(`<td class="[^"]*\\b${cls}\\b[^"]*">([\\s\\S]*?)</td>`, 'i').exec(row)?.[1];
    const sizeCell = cell('size');
    out.push({
      providerId: ID,
      name,
      infoHash: `${ID}:${link[2]}`,
      magnet: '',
      sizeBytes: parseSize(sizeCell ? stripTags(sizeCell.replace(/<span[\s\S]*$/i, '')) : undefined),
      seeders: toInt(stripTags(cell('seeds') ?? '').replace(/,/g, '')),
      leechers: toInt(stripTags(cell('leeches') ?? '').replace(/,/g, '')),
      publishedAt: parseDate(stripTags(cell('coll-date') ?? ''), now),
      category,
      detailUrl: base + decodeEntities(link[1]),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/** The magnet link on a detail page. Its anchor classes are randomised, so match on the href only. */
export function parseMagnet(body: string): { magnet: string; infoHash: string } {
  const m = /href="(magnet:\?[^"]+)"/i.exec(body);
  const magnet = m ? decodeEntities(m[1]) : '';
  const hash = infoHashFromMagnet(magnet);
  if (!hash) throw new ProviderError('parse', 'No magnet link on the page');
  return { magnet, infoHash: hash };
}

export function searchUrl(base: string, q: string, category: Category, page: number): string {
  const b = base.replace(/\/+$/, '');
  const term = encodeURIComponent(q.trim());
  const seg = SEGMENT[category];
  return seg ? `${b}/category-search/${term}/${seg}/${page}/` : `${b}/search/${term}/${page}/`;
}

export const x1337: SearchProvider = {
  id: ID,
  name: '1337x',
  abbr: '13',
  homepage: 'https://1337x.to',
  mirrors: ['https://1337x.to', 'https://1337x.st', 'https://x1337x.ws'],
  categories: ['movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other'],
  nsfw: false,
  unsafeReason: 'Some uploads are fake or carry malware. Check the comments and the file list before opening anything.',
  enabledByDefault: false,
  method: 'html',
  canPage: true,
  cloudflare: { solverUrl: 'https://1337x.to/' },
  async search(q, category, page, ctx) {
    const text = await httpText(searchUrl(ctx.baseUrl, q, category, page), { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    if (!result.detailUrl || !/^https?:\/\//i.test(result.detailUrl)) throw new ProviderError('parse', 'No page to read the magnet from');
    return parseMagnet(await httpText(result.detailUrl, { signal, accept: 'text/html' }));
  },
};
