import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, joinUrl, ProviderError } from '../http.ts';
import { buildMagnet } from '../magnet.ts';
import { fetchTorrentBytes, readTorrent } from '../torrentFile.ts';
import { decodeEntities, stripTags } from '../text.ts';
import { matchesTokens, queryTokens } from './showrss.ts';

export const ID = 'distrowatch';

/** The list changes a few times a week and is a slow page, so it is fetched once and filtered here. */
export const CACHE_MS = 6 * 60 * 60 * 1000;

const PREFIX = `${ID}:`;
const LIST_PATH = '/dwres.php?resource=bittorrent';

interface ListRow extends SearchResult {
  haystack: string;
}

/**
 * One table row per .torrent: project cell (link to the project page), torrent file name, upload date.
 * There is no size or seeders. Rows carry `magnet: ''` and a stand-in hash (`distrowatch:<file name>`):
 * `resolveMagnet` downloads the .torrent and reads the real info hash from it.
 */
export function parseList(body: string, baseUrl = 'https://distrowatch.com'): ListRow[] {
  if (!/<table/i.test(body) || !/class="torrent"/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const base = baseUrl.replace(/\/+$/, '');
  const out: ListRow[] = [];
  for (const tr of body.split(/<tr[\s>]/i).slice(1)) {
    const file = /<td class="torrent"><a href="dwres\/torrents\/([^"]+\.torrent)"/i.exec(tr)?.[1];
    if (!file) continue;
    const name = decodeEntities(file).replace(/\.torrent$/i, '');
    const project = /<td class="torrent"[^>]*><a href="([^"]+)">([\s\S]*?)<\/a><\/td>/i.exec(tr);
    const projectName = project ? stripTags(project[2]) : '';
    const date = /class="torrentdate"[^>]*>(\d{4})-(\d{2})-(\d{2})/.exec(tr);
    out.push({
      providerId: ID,
      name,
      infoHash: `${PREFIX}${decodeEntities(file)}`,
      magnet: '',
      publishedAt: date ? Date.UTC(+date[1], +date[2] - 1, +date[3]) : undefined,
      category: 'apps',
      detailUrl: project && !/^[a-z]+:/i.test(project[1]) ? `${base}/${project[1]}` : undefined,
      haystack: `${projectName} ${name}`,
    });
  }
  return out;
}

const strip = ({ haystack: _h, ...r }: ListRow): SearchResult => r;

/** Pure: the list's rows, limited (no query: ParseContext has none). */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  return parseList(body, ctx.baseUrl).slice(0, ctx.limit).map(strip);
}

export function filterList(rows: ListRow[], q: string, limit: number): SearchResult[] {
  const tokens = queryTokens(q);
  return rows.filter((r) => matchesTokens(r.haystack, tokens)).slice(0, limit).map(strip);
}

const cache = new Map<string, { at: number; rows: ListRow[] }>();

/** Test hook: forget the cached list. */
export function resetCache(): void {
  cache.clear();
}

export { readTorrent };

export const distrowatch: SearchProvider = {
  id: ID,
  name: 'DistroWatch',
  abbr: 'DW',
  homepage: 'https://distrowatch.com',
  mirrors: ['https://distrowatch.com'],
  categories: ['apps'],
  nsfw: false,
  enabledByDefault: false,
  method: 'html',
  canPage: false,
  async search(q, category: Category, page, ctx) {
    if (page > 1 || (category !== 'all' && category !== 'apps')) return [];
    const hit = cache.get(ctx.baseUrl);
    let rows = hit && Date.now() - hit.at < CACHE_MS ? hit.rows : undefined;
    if (!rows) {
      const text = await httpText(joinUrl(ctx.baseUrl, LIST_PATH), { signal: ctx.signal, accept: 'text/html' });
      rows = parseList(text, ctx.baseUrl);
      cache.set(ctx.baseUrl, { at: Date.now(), rows });
    }
    return filterList(rows, q, ctx.limit);
  },
  async resolveMagnet(result, signal) {
    if (!result.infoHash.startsWith(PREFIX)) throw new ProviderError('parse', 'No torrent file for this result');
    const file = result.infoHash.slice(PREFIX.length);
    const bytes = await fetchTorrentBytes(`${distrowatch.mirrors[0]}/dwres/torrents/${encodeURIComponent(file)}`, signal, 'Maglev/0.1.0 (Android)');
    const { infoHash, announce } = readTorrent(bytes);
    return { magnet: buildMagnet(infoHash, result.name, announce ? [announce] : []), infoHash };
  },
};
