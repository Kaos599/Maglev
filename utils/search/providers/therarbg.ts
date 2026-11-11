// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/TheRarBg.kt
import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { infoHashFromMagnet } from '../magnet.ts';
import { parseIsoLike } from '../dates.ts';
import { decodeEntities, parseSize, stripTags, toInt } from '../text.ts';

export const ID = 'therarbg';

// Maglev category -> TheRarBg category name in the search path.
const SEGMENT: Partial<Record<Category, string>> = {
  movies: 'Movies',
  tv: 'Tv',
  anime: 'Anime',
  music: 'Music',
  apps: 'Apps',
  games: 'Games',
  books: 'Books',
  other: 'Other',
};

function categoryFromLabel(label: string): Category {
  const l = label.toLowerCase();
  if (l.includes('anime')) return 'anime';
  if (l.includes('app')) return 'apps';
  if (l.includes('book')) return 'books';
  if (l.includes('game')) return 'games';
  if (l.includes('movie')) return 'movies';
  if (l.includes('music')) return 'music';
  if (l.includes('xxx')) return 'adult';
  if (l === 'tv' || l.startsWith('tv')) return 'tv';
  return 'other';
}

/**
 * Fragile scrape of the result table. The list has no magnet and no info hash: each row carries a
 * `detailUrl` and an empty `magnet`; `resolveMagnet` reads the detail page when the user adds it.
 * `infoHash` is a stand-in key (`therarbg:<post id>`) until then, so rows never merge with other sources.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<div|<table/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  for (const row of body.split(/<tr[\s>]/i).slice(1)) {
    if (!/class="list-entry"/i.test(row.slice(0, 40)) && !/list-entry/i.test(row.slice(0, 80))) continue;
    const link = /<td class="n">\s*<a href="(\/post-detail\/([0-9A-Za-z]+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    if (!link) continue;
    const name = stripTags(link[3]);
    if (!name) continue;
    const cell = (cls: string) => new RegExp(`<td class="${cls}">([\\s\\S]*?)</td>`, 'i').exec(row)?.[1];
    const label = stripTags(cell('k') ?? '');
    const category: Category | undefined = label ? categoryFromLabel(label) : ctx.category !== 'all' ? ctx.category : undefined;
    if (ctx.hideAdult && category === 'adult') continue;
    out.push({
      providerId: ID,
      name,
      infoHash: `${ID}:${link[2]}`,
      magnet: '',
      sizeBytes: parseSize(stripTags(cell('s') ?? '')),
      seeders: toInt(stripTags(cell('se') ?? '').replace(/,/g, '')),
      leechers: toInt(stripTags(cell('le') ?? '').replace(/,/g, '')),
      publishedAt: parseIsoLike(stripTags(cell('d') ?? '')),
      category,
      detailUrl: base + decodeEntities(link[1]),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/** The magnet link on a detail page (the href is HTML-escaped and may carry an upper-case hash). */
export function parseMagnet(body: string): { magnet: string; infoHash: string } {
  const m = /href="(magnet:\?[^"]+)"/i.exec(body);
  const magnet = m ? decodeEntities(m[1]) : '';
  const hash = infoHashFromMagnet(magnet);
  if (!hash) throw new ProviderError('parse', 'No magnet link on the page');
  return { magnet, infoHash: hash };
}

export function searchUrl(base: string, q: string, category: Category): string {
  const b = base.replace(/\/+$/, '');
  const seg = SEGMENT[category];
  return `${b}/get-posts/keywords:${encodeURIComponent(q.trim())}${seg ? `:category:${seg}` : ''}/`;
}

export const therarbg: SearchProvider = {
  id: ID,
  name: 'TheRarBg',
  abbr: 'RB',
  homepage: 'https://therarbg.com',
  mirrors: ['https://therarbg.com', 'https://therarbg.to'],
  categories: ['movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other'],
  nsfw: false,
  unsafeReason: 'Many uploads are fake or carry malware. Check the comments and the file list before opening anything.',
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  async search(q, category, _page, ctx) {
    const text = await httpText(searchUrl(ctx.baseUrl, q, category), { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    if (!result.detailUrl || !/^https?:\/\//i.test(result.detailUrl)) throw new ProviderError('parse', 'No page to read the magnet from');
    return parseMagnet(await httpText(result.detailUrl, { signal, accept: 'text/html' }));
  },
};
