// Ported from prajwalch/TorrentSearch (MIT), https://github.com/prajwalch/TorrentSearch/blob/main/app/src/main/kotlin/com/prajwalch/torrentsearch/providers/AniRena.kt
// TorrentSearch scrapes the old HTML site and reads the magnet from a redirect header. The current site has an RSS
// feed with no hash, and the detail page shows the info hash, so Maglev uses RSS plus `resolveMagnet`.
import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, normalizeInfoHash } from '../magnet.ts';
import { extractBlocks, parseSize, tagText, toMs } from '../text.ts';

export const ID = 'anirena';

function categoryFromLabel(label: string): Category {
  if (/^anime/i.test(label)) return 'anime';
  if (/^(audio|music)/i.test(label)) return 'music';
  if (/^(manga|book)/i.test(label)) return 'books';
  if (/^live action/i.test(label)) return 'tv';
  return 'other';
}

/**
 * RSS items: "[Anime > RAW] Title" with a description "Size: 5.7 GB | Uploader: .. | Category: ..".
 * No magnet or hash in the feed: rows carry `detailUrl` and an empty `magnet`, and `infoHash` is a stand-in key
 * (`anirena:<id>`) until `resolveMagnet` reads the detail page.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<rss[\s>]/i.test(body) && !/<channel[\s>]/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const item of extractBlocks(body, 'item')) {
    const raw = tagText(item, 'title');
    const link = tagText(item, 'link');
    const id = link ? /\/torrent\/([0-9a-f-]+)/i.exec(link)?.[1] : undefined;
    if (!raw || !id || !link) continue;
    const m = /^\[([^\]]*)\]\s*([\s\S]*)$/.exec(raw);
    const name = (m ? m[2] : raw).trim();
    if (!name) continue;
    out.push({
      providerId: ID,
      name,
      infoHash: `${ID}:${id}`,
      magnet: '',
      sizeBytes: parseSize(/Size:\s*([\d.,]+\s*[A-Za-z]+)/.exec(tagText(item, 'description') ?? '')?.[1]),
      publishedAt: toMs(tagText(item, 'pubDate')),
      category: categoryFromLabel(m ? m[1] : ''),
      detailUrl: link,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

/** The detail page shows the info hash in `<code data-label="Info Hash (SHA-1)">`. */
export function parseMagnet(body: string, name = ''): { magnet: string; infoHash: string } {
  const hash = normalizeInfoHash(/data-label="Info Hash[^"]*"[^>]*>\s*([0-9a-fA-F]{40})\s*</.exec(body)?.[1]);
  if (!hash) throw new ProviderError('parse', 'No info hash on the page');
  return { magnet: buildMagnet(hash, name, ['udp://tracker-udp.anirena.com:80/announce', 'https://tracker.anirena.com/announce']), infoHash: hash };
}

export const anirena: SearchProvider = {
  id: ID,
  name: 'AniRena',
  abbr: 'AR',
  homepage: 'https://www.anirena.com',
  mirrors: ['https://www.anirena.com'],
  categories: ['anime', 'music', 'books', 'tv', 'other'],
  nsfw: false,
  enabledByDefault: false,
  method: 'rss',
  canPage: false,
  async search(q, category, page, ctx) {
    if (page > 1) return [];
    const url = `${ctx.baseUrl.replace(/\/+$/, '')}/rss?q=${encodeURIComponent(q)}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/rss+xml, application/xml, text/xml' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    if (!result.detailUrl) throw new ProviderError('parse', 'No detail page for this result');
    const text = await httpText(result.detailUrl, { signal, accept: 'text/html' });
    return parseMagnet(text, result.name);
  },
};
