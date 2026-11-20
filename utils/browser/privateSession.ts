/**
 * The process-wide private browsing session (see privateHosts.ts for what it does and cannot do).
 * Real pieces bound here: the kv store, the WebView cookie jar, the cache clear and Search's hosts.
 */
import { clearBrowserData, clearCookies } from 'maglev-engine';
import { kvGet, kvSet } from '../prefs/kv';
import { getSearchPrefs } from '../prefs/search';
import { PROVIDERS } from '../search/aggregate';
import { createPrivateSession, searchKeepHosts } from './privateHosts';

/** Hosts to leave alone when expiring cookies: Search's sources and site checks. */
export function keepHosts(): string[] {
  const p = getSearchPrefs();
  const enabled = new Set(p.enabled);
  return searchKeepHosts({
    enabledProviders: PROVIDERS.filter((x) => enabled.has(x.id)),
    mirrorOverrides: Object.values(p.mirrorOverride ?? {}),
    torznabUrls: (p.torznab ?? []).map((t) => t.url),
    clearanceHosts: (p.clearances ?? []).map((c) => c.host),
  });
}

export const privateSession = createPrivateSession({
  kvGet,
  kvSet,
  clearCookies,
  clearCache: async () => {
    await clearBrowserData({ cookies: false, cache: true });
  },
  keepHosts,
});
