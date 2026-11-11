import { PROVIDERS } from '../../utils/search/aggregate';
import type { Category, SearchProvider } from '../../utils/search/types';
import type { SearchPrefs } from '../../utils/prefs/search';

export const CATEGORY_LABEL: Record<Category, string> = {
  all: 'All',
  movies: 'Movies',
  tv: 'TV',
  anime: 'Anime',
  music: 'Music',
  apps: 'Apps',
  games: 'Games',
  books: 'Books',
  other: 'Other',
  adult: 'Adult',
};

/** The part of a provider the UI needs. Built-ins and user Torznab entries both fit. */
export type ProviderInfo = Pick<
  SearchProvider,
  'id' | 'name' | 'abbr' | 'method' | 'categories' | 'nsfw' | 'unsafeReason' | 'mirrors' | 'enabledByDefault' | 'cloudflare'
> & { custom?: boolean };

export const TORZNAB_PREFIX = 'torznab:';

/** Built-in providers followed by the user's Torznab indexers. */
export function allProviderInfo(prefs: SearchPrefs): ProviderInfo[] {
  const custom: ProviderInfo[] = prefs.torznab.map((t) => ({
    id: `${TORZNAB_PREFIX}${t.id}`,
    name: t.name,
    abbr: t.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'TZ',
    method: 'torznab',
    categories: t.categories,
    nsfw: t.categories.includes('adult'),
    mirrors: [t.url],
    enabledByDefault: false,
    custom: true,
  }));
  return [...PROVIDERS, ...custom];
}

export function providerMap(prefs: SearchPrefs): Map<string, ProviderInfo> {
  return new Map(allProviderInfo(prefs).map((p) => [p.id, p]));
}

export function methodLine(method: SearchProvider['method']): string {
  switch (method) {
    case 'json':
      return 'JSON API';
    case 'rss':
      return 'RSS feed';
    case 'html':
      return 'Web page, read directly';
    case 'torznab':
      return 'Torznab indexer';
  }
}

/** Short plain-English summary of what a provider covers. */
export function coverage(p: ProviderInfo): string {
  const cats = p.categories.filter((c) => c !== 'all');
  if (cats.length === 0) return 'Everything else';
  const nonAdult = cats.filter((c) => c !== 'adult');
  if (nonAdult.length >= 8) return 'Everything';
  if (nonAdult.length === 0) return 'Adult';
  const shown = nonAdult.slice(0, 3).map((c) => CATEGORY_LABEL[c]);
  return nonAdult.length > 3 ? `${shown.join(', ')} and more` : shown.join(', ');
}

const MIN = 60_000;
const DAY = 86_400_000;

/** Compact age: "3 d", "2 mo", "3 yr". Empty when unknown. */
export function formatAge(publishedAt: number | undefined, now = Date.now()): string {
  if (!publishedAt || publishedAt > now + DAY) return '';
  const diff = now - publishedAt;
  if (diff < 60 * MIN) return `${Math.max(1, Math.round(diff / MIN))} min`;
  if (diff < DAY) return `${Math.round(diff / (60 * MIN))} h`;
  const days = Math.round(diff / DAY);
  if (days < 30) return `${days} d`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  return `${Math.round(days / 365)} yr`;
}

export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
