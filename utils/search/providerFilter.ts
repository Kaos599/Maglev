// Which search sources cover a category, for the filter in Settings > Search sources. Pure.
import type { Category } from './types';

/** True when a source with these categories should show under the chosen filter. "all" shows everything; a general source (listed for "all") shows under every filter. */
export function providerCovers(p: { categories: readonly Category[] }, filter: Category): boolean {
  if (filter === 'all') return true;
  return p.categories.includes('all') || p.categories.includes(filter);
}
