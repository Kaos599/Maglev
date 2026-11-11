// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/Ext.kt
import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, parseJson, ProviderError } from '../http.ts';
import { infoHashFromMagnet } from '../magnet.ts';
import { parseDayMonthYear } from '../dates.ts';
import { sha256Hex } from '../sha256.ts';
import { decodeEntities, parseSize, stripTags, toInt } from '../text.ts';

export const ID = 'ext';

// Maglev category -> ext.to `cat` value.
const CAT_ID: Partial<Record<Category, number>> = { movies: 1, tv: 2, music: 3, games: 4, apps: 5, books: 6, anime: 7, other: 8 };

function categoryFromPath(seg: string | undefined): Category | undefined {
  switch (seg) {
    case 'anime': return 'anime';
    case 'applications': return 'apps';
    case 'books': return 'books';
    case 'games': return 'games';
    case 'movies': return 'movies';
    case 'music': return 'music';
    case 'tv': return 'tv';
    case 'xxx': return 'adult';
    case undefined: return undefined;
    default: return 'other';
  }
}

/**
 * Fragile scrape of the result table. The list has no magnet: each row carries a `detailUrl` and an
 * empty `magnet`; `resolveMagnet` fetches it when the user adds the result. `infoHash` is a stand-in key
 * (`ext:<torrent id>`) until then, so rows never merge with other sources.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<html|<body|<div|<table/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  const base = ctx.baseUrl.replace(/\/+$/, '');
  const at = body.search(/<table[^>]*search-table/i);
  if (at < 0) return out;
  for (const row of body.slice(at).split(/<tr[\s>]/i).slice(1)) {
    const link = /<a\s+href="([^"]+)"\s+class="torrent-title-link"[^>]*>([\s\S]*?)<\/a>/i.exec(row);
    const id = /search-magnet-btn[^>]*data-id="(\d+)"/i.exec(row)?.[1];
    if (!link || !id) continue; // header row or a stray row
    const name = stripTags(link[2]);
    if (!name) continue;
    const cell = (label: string) => new RegExp(`add-block">${label}</span>\\s*<span([^>]*)>([\\s\\S]*?)</span>`, 'i').exec(row);
    const age = cell('Age');
    const category = categoryFromPath(/\bin\s*<a[^>]*href="\/([a-z-]+)\/"/i.exec(row)?.[1]) ?? (ctx.category !== 'all' ? ctx.category : undefined);
    if (ctx.hideAdult && category === 'adult') continue;
    out.push({
      providerId: ID,
      name,
      infoHash: `${ID}:${id}`,
      magnet: '',
      sizeBytes: parseSize(stripTags(cell('Size')?.[2] ?? '')),
      seeders: toInt(stripTags(cell('Seeds')?.[2] ?? '').replace(/,/g, '')),
      leechers: toInt(stripTags(cell('Leechs')?.[2] ?? '').replace(/,/g, '')),
      publishedAt: parseDayMonthYear(/title="([^"]*)"/i.exec(age?.[1] ?? '')?.[1]),
      category,
      detailUrl: base + decodeEntities(link[1]),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export interface ExtMagnetForm {
  torrentId: string;
  sessionId: string;
  pageToken: string;
}

/** What the detail page hands to its magnet endpoint: torrent id, CSRF token and `window.pageToken`. */
export function parseDetailPage(body: string): ExtMagnetForm {
  const torrentId = /<a[^>]*detail-magnet-link[^>]*data-id="(\d+)"/i.exec(body)?.[1] ?? /<a[^>]*data-id="(\d+)"[^>]*detail-magnet-link/i.exec(body)?.[1];
  const sessionId = /<meta\s+name="csrf-token"\s+content="([^"]*)"/i.exec(body)?.[1] ?? /<meta\s+content="([^"]*)"\s+name="csrf-token"/i.exec(body)?.[1];
  const pageToken = /window\.pageToken\s*=\s*'([^']*)'/.exec(body)?.[1];
  if (!torrentId || !sessionId || !pageToken) throw new ProviderError('parse', 'No magnet on the page');
  return { torrentId, sessionId, pageToken };
}

/** The form body for `/ajax/getTorrentMagnet.php`. The "hmac" is a plain SHA-256 of "<id>|<timestamp>|<page token>". */
export function magnetFormBody(f: ExtMagnetForm, timestampSec: number): string {
  const hmac = sha256Hex(`${f.torrentId}|${timestampSec}|${f.pageToken}`);
  const pairs: [string, string][] = [
    ['torrent_id', f.torrentId],
    ['download_type', 'magnet'],
    ['timestamp', String(timestampSec)],
    ['hmac', hmac],
    ['sessid', f.sessionId],
  ];
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** The endpoint answers `{ "url": "magnet:?..." }`. */
export function parseMagnetResponse(body: string): { magnet: string; infoHash: string } {
  const magnet = String(parseJson(body)?.url ?? '');
  const hash = infoHashFromMagnet(magnet);
  if (!hash) throw new ProviderError('parse', 'No magnet link in the answer');
  return { magnet, infoHash: hash };
}

export function searchUrl(base: string, q: string, category: Category): string {
  const b = base.replace(/\/+$/, '');
  const cat = CAT_ID[category];
  return `${b}/browse/?${cat ? `cat=${cat}&` : ''}q=${encodeURIComponent(q.trim())}`;
}

export const ext: SearchProvider = {
  id: ID,
  name: 'Ext',
  abbr: 'EX',
  homepage: 'https://ext.to',
  mirrors: ['https://ext.to'],
  categories: ['movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  cloudflare: { solverUrl: 'https://ext.to/' },
  async search(q, category, _page, ctx) {
    const text = await httpText(searchUrl(ctx.baseUrl, q, category), { signal: ctx.signal, accept: 'text/html' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    if (!result.detailUrl || !/^https?:\/\//i.test(result.detailUrl)) throw new ProviderError('parse', 'No page to read the magnet from');
    const origin = new URL(result.detailUrl).origin;
    const form = parseDetailPage(await httpText(result.detailUrl, { signal, accept: 'text/html' }));
    const answer = await httpText(`${origin}/ajax/getTorrentMagnet.php`, {
      signal,
      accept: 'application/json, text/javascript, */*',
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: magnetFormBody(form, Math.floor(Date.now() / 1000)),
    });
    return parseMagnetResponse(answer);
  },
};
