// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/TorrentDownload.kt
import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { parseRelative } from '../dates.ts';
import { decodeEntities, parseSize, stripTags, toInt } from '../text.ts';

export const ID = 'torrentdownload';

/** The "&raquo; <Category>" label on a row -> Maglev category. */
function categoryFromLabel(label: string | undefined): Category | undefined {
  if (!label) return undefined;
  const l = label.toLowerCase().replace(/[^a-z]+/g, '');
  if (/xxx|adult|porn/.test(l)) return 'adult';
  if (l.includes('anime')) return 'anime';
  if (l.includes('book') || l.includes('comics')) return 'books';
  if (l.includes('game')) return 'games';
  if (l.includes('music') || l.includes('audio')) return l.includes('audiobook') ? 'books' : 'music';
  if (l.includes('movie') || l.includes('video')) return 'movies';
  if (l === 'tv' || l.startsWith('tv') || l.includes('television')) return 'tv';
  if (l.includes('application') || l.includes('software')) return 'apps';
  return 'other';
}

/**
 * Scrape of the result table. The info hash is the first path segment of each detail link
 * (`/<HASH>/<slug>`), so the magnet is built from it. The "Fast Links" table above the results has no
 * hash in its links and is skipped.
 */
export function parse(body: string, ctx: ParseContext, now = Date.now()): SearchResult[] {
  if (!/<html|<body|<div|<table/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  for (const row of body.split(/<tr[\s>]/i).slice(1)) {
    const link = /<div class="tt-name">\s*<a\s+href="(\/([0-9A-Fa-f]{40})\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    const hash = normalizeInfoHash(link?.[2]);
    if (!link || !hash) continue;
    const name = stripTags(link[3]);
    if (!name) continue;
    const label = /<span class="smallish">([\s\S]*?)<\/span>/i.exec(row)?.[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    // cells: name + category, age, size, seeders, leechers
    const category = categoryFromLabel(label ? stripTags(label) : undefined) ?? (ctx.category !== 'all' ? ctx.category : undefined);
    if (ctx.hideAdult && category === 'adult') continue;
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name),
      sizeBytes: parseSize(cells[2]),
      seeders: toInt(cells[3]?.replace(/,/g, '')),
      leechers: toInt(cells[4]?.replace(/,/g, '')),
      publishedAt: parseRelative(cells[1], now),
      category,
      detailUrl: base + decodeEntities(link[1]),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export function searchUrl(base: string, q: string, page: number): string {
  const b = base.replace(/\/+$/, '');
  return `${b}/search?q=${encodeURIComponent(q.trim())}${page > 1 ? `&p=${page}` : ''}`;
}

export const torrentdownload: SearchProvider = {
  id: ID,
  name: 'TorrentDownload',
  abbr: 'TD',
  homepage: 'https://torrentdownload.info',
  mirrors: ['https://www.torrentdownload.info', 'https://torrentdownload.info'],
  // The site has no category filter in its search: every query returns all categories.
  categories: ['movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: true,
  async search(q, category, page, ctx) {
    const text = await httpText(searchUrl(ctx.baseUrl, q, page), { signal: ctx.signal, accept: 'text/html' });
    const rows = parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit * 4 });
    // No server-side category filter, so narrow here when the user picked one.
    const kept = category === 'all' ? rows : rows.filter((r) => r.category === category);
    return kept.slice(0, ctx.limit);
  },
};
