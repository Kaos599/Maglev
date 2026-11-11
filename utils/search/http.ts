// Thin fetch wrapper: generic User-Agent, no cookies, Cloudflare/blocked detection.
// Exception (SEARCH_CONTRACT section 8): a host the user passed a Cloudflare check on gets the WebView's
// User-Agent and the shared cookie jar (credentials 'include'), for that host only.

import { hostOf, isCloudflareChallenge } from './challenge.ts';
import { clearanceFor, dropClearance } from './clearance.ts';
import { decodeWindows1251, isWindows1251 } from './charset.ts';

export const APP_VERSION = '0.1.0';
export const USER_AGENT = `Maglev/${APP_VERSION} (Android)`;

export type ProviderErrorKind = 'network' | 'http' | 'blocked' | 'challenge' | 'parse' | 'timeout' | 'cancelled';

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  status?: number;
  /** True when trying the next mirror makes sense (network error or 5xx). */
  retryable: boolean;
  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryable = kind === 'network' || (kind === 'http' && (status ?? 0) >= 500);
  }
}

export interface HttpOptions {
  signal: AbortSignal;
  accept: string;
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  /** Extra request headers (for example X-Requested-With). */
  headers?: Record<string, string>;
}

export async function httpText(url: string, opts: HttpOptions): Promise<string> {
  const cleared = clearanceFor(url);
  const headers: Record<string, string> = { ...opts.headers, 'User-Agent': cleared?.userAgent ?? USER_AGENT, Accept: opts.accept };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      signal: opts.signal,
      headers,
      body: opts.body,
      credentials: cleared ? 'include' : 'omit',
    });
  } catch (e) {
    if (opts.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  const type = res.headers.get('content-type') ?? '';
  let text: string;
  try {
    // fetch().text() always reads UTF-8; some Cyrillic sites still answer in windows-1251.
    text = isWindows1251(type) ? decodeWindows1251(new Uint8Array(await res.arrayBuffer())) : await res.text();
  } catch (e) {
    if (opts.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  if (isCloudflareChallenge(res.status, res.headers, text)) {
    // A cleared host that is challenged again has lost its clearance: the chip must come back.
    if (cleared) dropClearance(hostOf(url));
    throw new ProviderError('challenge', 'Needs a quick check', res.status);
  }
  if (res.status === 403 || res.status === 503) {
    if (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(text)) {
      throw new ProviderError('blocked', 'Blocked by a bot check', res.status);
    }
  }
  if (!res.ok) throw new ProviderError('http', `HTTP ${res.status}`, res.status);
  return text;
}

export function parseJson(body: string): any {
  try {
    return JSON.parse(body);
  } catch {
    // An HTML challenge or error page served with 200.
    if (/^\s*<(!doctype|html)/i.test(body)) throw new ProviderError('blocked', 'Blocked by a bot check');
    throw new ProviderError('parse', 'Unexpected response');
  }
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + path;
}
