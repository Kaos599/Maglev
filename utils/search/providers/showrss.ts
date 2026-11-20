import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, infoHashFromMagnet, normalizeInfoHash } from '../magnet.ts';
import { extractBlocks, tagText, toMs } from '../text.ts';

export const ID = 'showrss';

/** The feed holds the latest ~100 releases and cannot be searched, so it is fetched once and filtered here. */
export const CACHE_MS = 10 * 60 * 1000;

/** Lowercase, accents and punctuation removed: "90 Day Fiancé: The Other Way" -> "90 day fiance the other way". */
function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function queryTokens(q: string): string[] {
  const n = normalizeText(q);
  return n ? n.split(' ') : [];
}

/** True when every query token appears in the text (case and punctuation ignored). An empty query matches nothing. */
export function matchesTokens(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const hay = normalizeText(text);
  return tokens.every((t) => hay.includes(t));
}

interface FeedRow extends SearchResult {
  /** Show name plus release name, used for matching only. */
  haystack: string;
}

/** Every item of the feed, unfiltered and unlimited. */
export function parseFeed(body: string): FeedRow[] {
  if (!/<rss[\s>]/i.test(body) && !/<channel[\s>]/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: FeedRow[] = [];
  for (const item of extractBlocks(body, 'item')) {
    const name = tagText(item, 'tv:raw_title') || tagText(item, 'title');
    const link = tagText(item, 'link') ?? '';
    const hash = normalizeInfoHash(tagText(item, 'tv:info_hash')) ?? infoHashFromMagnet(link);
    if (!name || !hash) continue;
    const magnet = link.startsWith('magnet:') && infoHashFromMagnet(link) === hash ? link : buildMagnet(hash, name);
    const show = tagText(item, 'tv:show_name') ?? '';
    out.push({
      providerId: ID,
      name,
      infoHash: hash,
      magnet,
      publishedAt: toMs(tagText(item, 'pubDate')),
      category: 'tv',
      detailUrl: undefined,
      haystack: `${show} ${name} ${tagText(item, 'title') ?? ''}`,
    });
  }
  return out;
}

const strip = ({ haystack: _h, ...r }: FeedRow): SearchResult => r;

/** Pure: the items of the feed, limited. (The query filter lives in search(): ParseContext has no query.) */
export function parse(body: string, ctx: ParseContext): SearchResult[] {
  return parseFeed(body).slice(0, ctx.limit).map(strip);
}

/** Items that match the query, newest first as the feed lists them. */
export function filterFeed(rows: FeedRow[], q: string, limit: number): SearchResult[] {
  const tokens = queryTokens(q);
  return rows.filter((r) => matchesTokens(r.haystack, tokens)).slice(0, limit).map(strip);
}

const cache = new Map<string, { at: number; rows: FeedRow[] }>();

/** Test hook: forget the cached feed. */
export function resetCache(): void {
  cache.clear();
}

async function loadFeed(baseUrl: string, signal: AbortSignal, now: number): Promise<FeedRow[]> {
  const hit = cache.get(baseUrl);
  if (hit && now - hit.at < CACHE_MS) return hit.rows;
  const url = `${baseUrl.replace(/\/+$/, '')}/other/all.rss`;
  const text = await httpText(url, { signal, accept: 'application/rss+xml, application/xml, text/xml' });
  const rows = parseFeed(text);
  cache.set(baseUrl, { at: now, rows });
  return rows;
}

export const showrss: SearchProvider = {
  id: ID,
  name: 'ShowRSS',
  abbr: 'SR',
  homepage: 'https://showrss.info',
  mirrors: ['https://showrss.info'],
  categories: ['tv'],
  nsfw: false,
  enabledByDefault: false,
  method: 'rss',
  canPage: false,
  async search(q, category: Category, page, ctx) {
    if (page > 1 || (category !== 'all' && category !== 'tv')) return [];
    const rows = await loadFeed(ctx.baseUrl, ctx.signal, Date.now());
    return filterFeed(rows, q, ctx.limit);
  },
};
