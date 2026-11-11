import type { Category, ParseContext, SearchProvider, SearchResult } from '../types.ts';
import { httpText, ProviderError } from '../http.ts';
import { buildMagnet, infoHashFromMagnet, normalizeInfoHash } from '../magnet.ts';
import { extractBlocks, tagAttr, tagText, toInt, toMs, torznabAttrs } from '../text.ts';

export interface TorznabConfig {
  id: string;
  name: string;
  url: string;
  categories: Category[];
}

// Maglev category -> Torznab category code. 'all' sends no filter.
const TORZNAB_CODES: Partial<Record<Category, number>> = {
  movies: 2000,
  tv: 5000,
  music: 3000,
  apps: 4000,
  games: 4050,
  books: 7000,
  anime: 5070,
  other: 8000,
  adult: 6000,
};

function categoryFromCode(code: number | undefined): Category | undefined {
  if (code == null) return undefined;
  if (code === 5070) return 'anime';
  if (code === 4050) return 'games';
  switch (Math.floor(code / 1000)) {
    case 1:
      return 'games';
    case 2:
      return 'movies';
    case 3:
      return 'music';
    case 4:
      return 'apps';
    case 5:
      return 'tv';
    case 6:
      return 'adult';
    case 7:
      return 'books';
    default:
      return 'other';
  }
}

export function parse(body: string, ctx: ParseContext, providerId = 'torznab'): SearchResult[] {
  const err = /<error\s[^>]*description="([^"]*)"/i.exec(body);
  if (err) throw new ProviderError('http', err[1] || 'Indexer error');
  if (!/<rss[\s>]/i.test(body) && !/<channel[\s>]/i.test(body)) throw new ProviderError('parse', 'Unexpected response');
  const out: SearchResult[] = [];
  for (const item of extractBlocks(body, 'item')) {
    const name = tagText(item, 'title');
    if (!name) continue;
    const attrs = torznabAttrs(item);
    const link = tagText(item, 'link');
    const hash =
      normalizeInfoHash(attrs.infohash?.[0]) ??
      infoHashFromMagnet(attrs.magneturl?.[0]) ??
      infoHashFromMagnet(link) ??
      infoHashFromMagnet(tagAttr(item, 'enclosure', 'url'));
    if (!hash) continue; // cannot dedupe without a hash
    const magnetSrc = attrs.magneturl?.[0] ?? (link?.startsWith('magnet:') ? link : undefined);
    const seeders = toInt(attrs.seeders?.[0]);
    const peers = toInt(attrs.peers?.[0]);
    const leechers = toInt(attrs.leechers?.[0]) ?? (peers != null && seeders != null ? Math.max(peers - seeders, 0) : peers);
    const codes = (attrs.category ?? []).map((c) => toInt(c)).filter((c): c is number => c != null);
    const specific = codes.find((c) => c % 1000 !== 0) ?? codes[0];
    const category = categoryFromCode(specific);
    if (ctx.hideAdult && category === 'adult') continue;
    out.push({
      providerId,
      name,
      infoHash: hash,
      magnet: magnetSrc?.startsWith('magnet:') ? magnetSrc : buildMagnet(hash, name),
      sizeBytes: toInt(attrs.size?.[0]) ?? toInt(tagText(item, 'size')) ?? toInt(tagAttr(item, 'enclosure', 'length')),
      seeders,
      leechers,
      publishedAt: toMs(tagText(item, 'pubDate')),
      category,
      detailUrl: tagText(item, 'comments') ?? (/^https?:/.test(tagText(item, 'guid') ?? '') ? tagText(item, 'guid') : undefined),
    });
    if (out.length >= ctx.limit) break;
  }
  return out;
}

function apiBase(url: string): string {
  const t = url.trim().replace(/\/+$/, '');
  return /\/api$/i.test(t) ? t : `${t}/api`;
}

export function createTorznabProvider(cfg: TorznabConfig, apiKey: string): SearchProvider {
  const id = cfg.id.startsWith('torznab:') ? cfg.id : `torznab:${cfg.id}`;
  const letters = cfg.name.replace(/[^A-Za-z0-9]/g, '');
  return {
    id,
    name: cfg.name,
    abbr: (letters.slice(0, 2) || 'TZ').toUpperCase(),
    homepage: cfg.url,
    mirrors: [cfg.url],
    categories: cfg.categories.length ? cfg.categories : ['movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other'],
    nsfw: cfg.categories.includes('adult'),
    enabledByDefault: false,
    method: 'torznab',
    canPage: true,
    async search(q, category, page, ctx) {
      let url = `${apiBase(ctx.baseUrl)}?t=search&q=${encodeURIComponent(q)}&apikey=${encodeURIComponent(apiKey)}`;
      const code = TORZNAB_CODES[category];
      if (code) url += `&cat=${code}`;
      url += `&limit=${ctx.limit}&offset=${(page - 1) * ctx.limit}`;
      const text = await httpText(url, { signal: ctx.signal, accept: 'application/rss+xml, application/xml, text/xml' });
      return parse(text, { baseUrl: ctx.baseUrl, category, hideAdult: ctx.hideAdult, limit: ctx.limit }, id);
    },
  };
}
