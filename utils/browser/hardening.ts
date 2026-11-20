/**
 * Downloads without a tap, Back-button hijacking, HTTPS-first and the found-files hint: pure logic
 * (docs/NATIVE_CONTRACT.md section 24.11). Mirrored in Kotlin (BrowserHardening.kt). No React, no native imports.
 */
import { TAP_MS } from './popups.ts';

// ---- downloads ----

/** A download counts as asked for when the user typed or tapped to get it (a tap vouches for one download). */
export function downloadTapped(tapAgeMs: number | null, usesSoFar: number, userLoad: boolean, samePage = false, loading = false): boolean {
  return (
    userLoad ||
    (tapAgeMs != null && tapAgeMs >= 0 && usesSoFar === 0 && (tapAgeMs <= TAP_MS || (samePage && (tapAgeMs <= DOWNLOAD_VOUCH_MS || loading))))
  );
}

/** NATIVE_CONTRACT 39.2 B1: a tap vouches for downloads from the same document this long. Mirrors DownloadRules.VOUCH_MS. */
const DOWNLOAD_VOUCH_MS = 30_000;

/** NATIVE_CONTRACT 39.2 B1: shown when a download is held (the view still lists it in Files). */
export const DOWNLOAD_HELD_NOTICE = 'A download was held. Open Files to save it.';
export const DOWNLOAD_HELD_ACTION = 'Open';

/** The save sheet opens only for a download the user asked for. An event with no `tapped` (an old build) counts as asked for. */
export const opensSaveSheet = (tapped: boolean | undefined): boolean => tapped !== false;

// ---- back ----

/** How many entries Back steps over: to the nearest earlier entry the user made, or the first one. 0 when nothing is behind. */
export function backSteps(userMade: readonly boolean[], current: number): number {
  if (current <= 0) return 0;
  let i = current - 1;
  while (i > 0 && !(userMade[i] ?? true)) i--;
  return current - i;
}

/** What made each history entry, kept next to the WebView's own list. */
export type HistoryFlags = { urls: string[]; made: boolean[]; index: number };
export const newHistoryFlags = (): HistoryFlags => ({ urls: [], made: [], index: -1 });

/** The page reported `url` at position `current`. A step forward to an unseen entry is new; the same position keeps its flag (true wins); the rest is Back or Forward. */
export function historyVisited(h: HistoryFlags, url: string, current: number, userMade: boolean): void {
  if (current < 0) return;
  const prev = h.index;
  h.index = current;
  if (current === prev + 1 && (current >= h.made.length || h.urls[current] !== url)) {
    h.made.length = current;
    h.urls.length = current;
    h.urls.push(url);
    h.made.push(userMade);
    return;
  }
  while (h.made.length <= current) {
    h.urls.push(url);
    h.made.push(true);
  }
  if (current === prev) {
    h.urls[current] = url;
    if (userMade) h.made[current] = true;
  }
}

/** Back steps over the current entry when it is `url` (a failed https try). */
export function historySkipIfUrl(h: HistoryFlags, url: string): void {
  if (h.index >= 0 && h.index < h.made.length && h.urls[h.index] === url) h.made[h.index] = false;
}

// ---- https first ----

/** Host of an address: lower case, no user name, no port, no trailing dot. Null when there is none. */
export function httpsHostOf(url: string | null | undefined): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec((url ?? '').trim());
  if (!m) return null;
  const a = m[1].slice(m[1].lastIndexOf('@') + 1);
  if (a.startsWith('[')) return a.replace(/^\[/, '').split(']')[0].toLowerCase();
  const h = a.split(':')[0].toLowerCase().replace(/\.+$/, '');
  return h || null;
}

/** inet_aton style IPv4 literal, like LocalHost.parseV4 (decimal, octal, hex, 1 to 4 parts). */
function isV4Literal(h: string): boolean {
  const parts = h.split('.');
  if (parts.length > 4) return false;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === '') return false;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p.slice(1), 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return false;
    nums.push(n);
  }
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return false;
  return nums[nums.length - 1] < 2 ** (8 * (4 - (nums.length - 1)));
}

/** A name that is local on its face: `localhost`, `*.local`, `*.lan`, a single word. Mirrors LocalHost.looksLikeLanName. IP literals are handled apart. */
function isLocalName(h: string): boolean {
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  return !h.includes('.') || h.endsWith('.lan') || h.endsWith('.home.arpa') || h.endsWith('.localdomain');
}

/**
 * The https twin of a main-frame http address, or null when it stays http: not http, an IP address, a local name, a port
 * other than 80, a user name in the address, or a host the user already fell back on.
 */
export function upgradeToHttps(url: string, fallbackHosts: ReadonlySet<string>, method = 'GET'): string | null {
  if (method.toUpperCase() !== 'GET') return null;
  const m = /^http:\/\/([^/?#]*)([\s\S]*)$/i.exec(url.trim());
  if (!m) return null;
  const authority = m[1];
  if (!authority || authority.includes('@') || authority.startsWith('[')) return null;
  const colon = authority.indexOf(':');
  const hostPart = colon >= 0 ? authority.slice(0, colon) : authority;
  if (colon >= 0) {
    const port = authority.slice(colon + 1);
    if (port !== '80' && port !== '') return null;
  }
  const h = hostPart.toLowerCase().replace(/\.+$/, '');
  if (!h || isV4Literal(h) || isLocalName(h) || fallbackHosts.has(h)) return null;
  return `https://${hostPart}${m[2]}`;
}

const bare = (h: string | null): string | null => (h == null ? null : h.replace(/^www\./, ''));
const sameHost = (host: string | null | undefined, url: string | null | undefined): boolean =>
  host != null && bare(host) === bare(httpsHostOf(url));
/** An error or certificate failure for `failedUrl` while the https try for `pendingHost` had not loaded. */
export const isUpgradeFailure = sameHost;
/** The https try was answered with a redirect to http on the same host. */
export const isUpgradeLoop = (pendingHost: string | null | undefined, redirectUrl: string): boolean =>
  /^http:\/\//i.test(redirectUrl.trim()) && sameHost(pendingHost, redirectUrl);

// ---- found-files hint ----

/** How long the hint stays up, in ms. */
export const FOUND_HINT_MS = 6000;
export type FoundHintState = 'idle' | 'shown' | 'done';

/** The hint is due once per page: files found, the tray not opened, not shown yet. */
export const foundHintDue = (count: number, state: FoundHintState, trayOpen: boolean): boolean => count > 0 && state === 'idle' && !trayOpen;

export const foundHintText = (count: number): string => `Maglev found ${count} ${count === 1 ? 'file' : 'files'} on this page`;
