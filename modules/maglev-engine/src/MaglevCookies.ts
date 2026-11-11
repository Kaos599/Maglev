import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

// Thin access to Android's CookieManager (the WebView cookie jar) for the Cloudflare site checks.
// Contract: docs/SEARCH_CONTRACT.md section 8. Native side: MaglevEngineModule.kt getCookies / clearCookies.

let Native: any = null;
try {
  Native = Platform.OS === 'android' ? requireOptionalNativeModule('MaglevEngine') : null;
} catch {
  Native = null;
}

/** Cookies the WebView jar holds for `url` as "a=1; b=2", or '' (also when the native module is missing). */
export async function getCookies(url: string): Promise<string> {
  try {
    if (typeof Native?.getCookies !== 'function') return '';
    return (await Native.getCookies(url)) ?? '';
  } catch {
    return '';
  }
}

/** Expires all cookies the jar holds for each URL. Returns how many were removed. */
export async function clearCookies(urls: string[]): Promise<number> {
  try {
    if (typeof Native?.clearCookies !== 'function' || urls.length === 0) return 0;
    return Number((await Native.clearCookies(urls)) ?? 0);
  } catch {
    return 0;
  }
}

/** True when a cookie header string contains a Cloudflare clearance. */
export function hasClearanceCookie(cookies: string): boolean {
  return /(^|;\s*)cf_clearance=/.test(cookies);
}
