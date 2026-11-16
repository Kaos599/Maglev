import type { ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError, USER_AGENT } from '../http.ts';
import { buildMagnet } from '../magnet.ts';
import { fetchTorrentBytes, infoHashFromTorrent, sha1Hex } from '../torrentFile.ts';
import { decodeEntities, extractBlocks, tagAttr, tagText, toInt, toMs } from '../text.ts';

export const ID = 'acgrip';

/**
 * RSS items for ACG.RIP. The feed carries a `.torrent` enclosure and a size but no info hash, so rows come back
 * with `magnet: ''` and a stand-in key (`acgrip:<id>`); `resolveMagnet` downloads the small `.torrent` and hashes
 * its info dictionary when the user adds the result.
 */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  if (!/<rss[\s>]/i.test(body) && !/<channel[\s>]/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const item of extractBlocks(body, 'item')) {
    const name = tagText(item, 'title');
    const link = tagText(item, 'guid') ?? tagText(item, 'link');
    const id = link ? /\/t\/(\d+)/.exec(link)?.[1] : undefined;
    if (!name || !link || !id) continue;
    out.push({
      providerId: ID,
      name: decodeEntities(name),
      infoHash: `${ID}:${id}`,
      magnet: '',
      sizeBytes: toInt(tagText(item, 'torrent:contentLength')) ?? toInt(tagAttr(item, 'media:content', 'fileSize')),
      publishedAt: toMs(tagText(item, 'pubDate')),
      category: 'anime',
      detailUrl: link,
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

export { sha1Hex, infoHashFromTorrent };

export const acgrip: SearchProvider = {
  id: ID,
  name: 'ACG.RIP',
  abbr: 'AG',
  homepage: 'https://acg.rip',
  mirrors: ['https://acg.rip'],
  categories: ['anime'],
  nsfw: false,
  enabledByDefault: false,
  method: 'rss',
  canPage: true,
  async search(q, category, page, ctx) {
    const base = ctx.baseUrl.replace(/\/+$/, '');
    const url = `${base}/.xml?term=${encodeURIComponent(q)}${page > 1 ? `&page=${page}` : ''}`;
    const text = await httpText(url, { signal: ctx.signal, accept: 'application/rss+xml, application/xml, text/xml' });
    return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit });
  },
  async resolveMagnet(result, signal) {
    // Only the numeric id comes from the feed; the host is always ACG.RIP over https, so a hostile feed
    // can't point the add at another server.
    const id = result.detailUrl ? /\/t\/(\d+)$/.exec(result.detailUrl)?.[1] : undefined;
    if (!id) throw new ProviderError('parse', 'No torrent file for this result');
    const bytes = await fetchTorrentBytes(`${acgrip.mirrors[0]}/t/${id}.torrent`, signal, USER_AGENT);
    const hash = infoHashFromTorrent(bytes);
    return { magnet: buildMagnet(hash, result.name), infoHash: hash };
  },
};
