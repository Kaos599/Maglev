// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/LimeTorrents.kt
import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { parseRelative } from '../dates.ts';
import { decodeEntities, parseSize, stripTags, toInt } from '../text.ts';

export const ID = 'limetorrents';

// Maglev category -> LimeTorrents search segment. Books have no segment of their own: they live under "all".
const SEGMENT: Partial<Record<Category, string>> = {
  movies: 'movies',
  tv: 'tv',
  anime: 'anime',
  music: 'music',
  apps: 'applications',
  games: 'games',
  other: 'other',
};

/** The site's "in <Category>" label on a row -> Maglev category. */
function categoryFromLabel(label: string | undefined): Category | undefined {
  if (!label) return undefined;
  const l = label.toLowerCase();
  if (l.includes('anime')) return 'anime';
  if (l.includes('tv')) return 'tv';
  if (l.includes('movie')) return 'movies';
  if (l.includes('music')) return 'music';
  if (l.includes('app') || l.includes('software')) return 'apps';
  if (l.includes('game')) return 'games';
  if (l.includes('book')) return 'books';
  if (l.includes('xxx') || l.includes('adult')) return 'adult';
  return 'other';
}

/**
 * Scrape of the result table. The list has no magnet, but the ".torrent" link of each row carries
 * the info hash (itorrents.net/torrent/<HASH>.torrent), so no detail request is needed.
 */
export function parse(body: string, ctx: ParseContext, now = Date.now()): SearchResult[] {
  if (!/<html|<body|<div|<table/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  for (const row of body.split(/<tr[\s>]/i).slice(1)) {
    const dl = /href="[^"]*\/torrent\/([0-9A-Fa-f]{40})\.torrent/i.exec(row);
    const hash = normalizeInfoHash(dl?.[1]);
    const block = /<div class="tt-name">([\s\S]*?)<\/div>/i.exec(row)?.[1];
    if (!hash || !block) continue; // header row or a stray row
    let name = '';
    let href = '';
    for (const a of block.matchAll(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const text = stripTags(a[2]);
      if (text) {
        name = text;
        href = a[1];
      }
    }
    if (!name) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    // cells: name, "<age> - in <Category>", size, seeders, leechers, health
    const [age, label] = (cells[1] ?? '').split(/\s+-\s+in\s+/i);
    const category = categoryFromLabel(label?.replace(/\.$/, '').trim()) ?? (ctx.category !== 'all' ? ctx.category : undefined);
    if (ctx.hideAdult && category === 'adult') continue;
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet: buildMagnet(hash, name),
      sizeBytes: parseSize(cells[2]),
      seeders: toInt(cells[3]?.replace(/,/g, '')),
      leechers: toInt(cells[4]?.replace(/,/g, '')),
      publishedAt: parseRelative(age, now),
      category,
      detailUrl: href.startsWith('/') ? base + decodeEntities(href) : undefined,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export function searchUrl(base: string, q: string, category: Category, page: number): string {
  const b = base.replace(/\/+$/, '');
  return `${b}/search/${SEGMENT[category] ?? 'all'}/${encodeURIComponent(q.trim())}/seeds/${page}/`;
}

export const limetorrents: SearchProvider = {
  id: ID,
  name: 'LimeTorrents',
  abbr: 'LT',
  homepage: 'https://limetorrents.fun',
  mirrors: ['https://limetorrents.fun', 'https://www.limetorrents.lol'],
  categories: ['movies', 'tv', 'anime', 'music', 'apps', 'games', 'other'],
  nsfw: false,
  unsafeReason: 'Many uploads are fake or carry malware. Check the file list before opening anything.',
  enabledByDefault: false,
  method: 'html',
  canPage: true,
  async search(q, category, page, ctx) {
    const text = await httpText(searchUrl(ctx.baseUrl, q, category, page), { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
};
