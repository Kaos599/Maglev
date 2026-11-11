import { createTorznabProvider } from '../../utils/search/aggregate';
import type { SearchProvider } from '../../utils/search/types';
import { SearchPrefs, getTorznabApiKey } from '../../utils/prefs/search';

/** Torznab providers without their API keys: enough for category and eligibility checks in the UI. */
export function buildExtraProviders(torznab: SearchPrefs['torznab']): SearchProvider[] {
  return torznab.map((t) => createTorznabProvider(t, ''));
}

/** Torznab providers with keys read from secure storage: for real searches and Test now. */
export async function loadExtraProviders(torznab: SearchPrefs['torznab']): Promise<SearchProvider[]> {
  return Promise.all(torznab.map(async (t) => createTorznabProvider(t, await getTorznabApiKey(t.id))));
}
