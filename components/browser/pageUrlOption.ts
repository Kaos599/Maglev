import { getBrowserPrefs } from '../../utils/prefs/browser';

/**
 * The `pageUrl` download option for a download started from the in-app browser (NATIVE_CONTRACT "Auto-refresh").
 * Only a real web page the user was on is sent; an empty value, `about:blank` or any other scheme sends nothing,
 * so a page is never invented. Nothing is sent while Private browsing is on. The engine drops a secret-looking query before it saves the URL.
 */
export function pageUrlOption(
  pageUrl: string | null | undefined,
  privateBrowsing: () => boolean = () => getBrowserPrefs().privateBrowsing,
): { pageUrl?: string } {
  // Private browsing keeps no history, so the download doesn't remember which page it came from either.
  if (privateBrowsing()) return {};
  const u = (pageUrl ?? '').trim();
  return /^https?:\/\/[^/?#\s]+/i.test(u) ? { pageUrl: u } : {};
}
