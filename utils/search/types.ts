// Search contract types. See docs/SEARCH_CONTRACT.md sections 1, 2 and 4.

export type Category = 'all' | 'movies' | 'tv' | 'anime' | 'music' | 'apps' | 'games' | 'books' | 'other' | 'adult';

export const CATEGORY_ORDER: Category[] = ['all', 'movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other', 'adult'];

export interface SearchResult {
  providerId: string;
  name: string;
  infoHash: string;
  magnet: string;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  publishedAt?: number;
  category?: Category;
  detailUrl?: string;
}

export interface SearchContext {
  baseUrl: string;
  signal: AbortSignal;
  hideAdult: boolean;
  limit: number;
}

export interface SearchProvider {
  id: string;
  name: string;
  abbr: string;
  homepage: string;
  mirrors: string[];
  categories: Category[];
  nsfw: boolean;
  unsafeReason?: string;
  enabledByDefault: boolean;
  method: 'json' | 'rss' | 'html' | 'torznab';
  canPage: boolean;
  /** Set when the source can sit behind a Cloudflare check: the page the user opens to pass it. */
  cloudflare?: { solverUrl: string };
  search(q: string, category: Category, page: number, ctx: SearchContext): Promise<SearchResult[]>;
}

/** Context handed to the pure parse() functions. */
export interface ParseContext {
  baseUrl: string;
  category: Category;
  hideAdult: boolean;
  limit: number;
}

export type SourceState = 'searching' | 'done' | 'empty' | 'timeout' | 'error' | 'blocked' | 'challenge';

export interface SourceStatus {
  providerId: string;
  state: SourceState;
  count: number;
  ms: number;
  message?: string;
}

export interface MergedResult extends SearchResult {
  /** Provider ids that returned this hash, in priority order. */
  sources: string[];
}

export interface SearchUpdate {
  results: MergedResult[];
  sources: SourceStatus[];
  done: boolean;
}

export type SortKey = 'seeders' | 'newest' | 'size' | 'name';
