/**
 * Pure helpers for the browser screens (docs/NATIVE_CONTRACT.md section 24). No React, no native modules,
 * so scripts/test-browser-ui.js runs them directly.
 */

export type SearchEngine = 'duckduckgo' | 'google' | 'bing' | 'brave';
export const SEARCH_ENGINES: readonly SearchEngine[] = ['duckduckgo', 'google', 'bing', 'brave'];

export const SEARCH_URLS: Record<SearchEngine, string> = {
  duckduckgo: 'https://html.duckduckgo.com/html/?q=',
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q=',
};

export type BrowserTarget =
  | { kind: 'empty' }
  | { kind: 'url'; url: string }
  | { kind: 'magnet'; uri: string };

const HOST_LIKE = /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const LOCAL_LIKE = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::|\/|\?|#|$)/i;

/**
 * What the user typed in the address bar. A web link loads as is, a magnet link goes to Add torrent,
 * a bare host gets a scheme, and anything else becomes a search on the chosen engine.
 * Only http and https load. Other schemes (javascript:, file:, intent:) turn into a search.
 */
export function toBrowserUrl(text: string, engine: SearchEngine = 'duckduckgo'): BrowserTarget {
  const t = (text ?? '').trim();
  if (!t) return { kind: 'empty' };
  if (/^magnet:/i.test(t)) return { kind: 'magnet', uri: t };
  if (/^https?:\/\/[^\s/?#]+\S*$/i.test(t)) return { kind: 'url', url: t };
  if (!/\s/.test(t) && HOST_LIKE.test(t)) {
    return { kind: 'url', url: `${LOCAL_LIKE.test(t) ? 'http' : 'https'}://${t}` };
  }
  return { kind: 'url', url: SEARCH_URLS[engine] + encodeURIComponent(t) };
}

/** The host of an http(s) link without a port or credentials, lower case, or '' when there is none. */
export function hostOf(url: string): string {
  const m = /^https?:\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]+)/i.exec((url ?? '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** True for an https link with a host: the only kind a block list address may be. */
export function isHttpsUrl(text: string): boolean {
  const t = (text ?? '').trim();
  return /^https:\/\/[^\s/?#]+\S*$/i.test(t) && hostOf(t) !== '';
}

/** `www.` dropped, so one choice covers the site and its www form. */
export function siteKey(host: string): string {
  return (host ?? '').toLowerCase().replace(/^www\./, '');
}

/** True when `host` is one of `allowed` or a subdomain of one. */
export function isAllowedHost(allowed: readonly string[], host: string): boolean {
  const h = siteKey(host);
  if (!h) return false;
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
}

/** Adds or removes the site of `host` from the allow list. Returns a new list. */
export function toggleAllowedHost(allowed: readonly string[], host: string): string[] {
  const key = siteKey(host);
  if (!key) return [...allowed];
  if (isAllowedHost(allowed, key)) return allowed.filter((a) => !(key === a || key.endsWith(`.${a}`)));
  return [...allowed, key];
}

/** At most one notice per `gapMs`. Returns whether to show now. */
export function noticeAllowed(lastAt: number, now: number, gapMs = 5000): boolean {
  return lastAt <= 0 || now - lastAt >= gapMs;
}

/**
 * expo-router hands `redirectSystemPath` the FULL url for a custom-scheme link
 * (`maglev://browser?url=...`, see expo-router build/getLinkingConfig.js ~L90 and link/linking.js ~L155),
 * not a bare route. Strips `maglev://` and `maglev:///` so route matching sees `/browser?...`.
 * Other strings (magnet:, https:, file:, content:, plain paths) are returned unchanged.
 */
export function appPath(path: string): string {
  const m = /^maglev:(?:\/\/\/?)?(.*)$/is.exec(path);
  if (!m) return path;
  return m[1].startsWith('/') ? m[1] : `/${m[1]}`;
}

/**
 * `maglev://browser?url=` arrives as a router path. It prefills the address bar and never loads
 * (section 24.7): the route carries `prefill`, not `url`, and every other parameter is dropped.
 * Returns null when the path is not the browser route.
 */
export function browserIntentRoute(path: string): string | null {
  const s = appPath((path ?? '').trim());
  const m = /^\/?browser(?:\/)?(?:\?([^#]*))?(?:#.*)?$/i.exec(s);
  if (!m) return null;
  let url = '';
  for (const part of (m[1] ?? '').split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    let key = part.slice(0, eq);
    try {
      key = decodeURIComponent(key);
    } catch {
      // keep the raw key
    }
    if (key.trim().toLowerCase() !== 'url') continue;
    try {
      url = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      url = '';
    }
    break;
  }
  url = url.trim();
  return /^https?:\/\/[^\s/?#]+\S*$/i.test(url) ? `/browser?prefill=${encodeURIComponent(url)}` : '/browser';
}
