// Helpers shared by the batch 5 subtitle sources (contract 36.3): a binary-safe fetch, URL joining, title matching
// and the download-to-payload step. Pure except `httpRaw`.
import { ProviderError, USER_AGENT } from '../../search/http.ts';
import { decodeUtf8Strict, archiveKind, detectFormat } from '../payload.ts';
import type { SubtitlePayload } from '../types.ts';

export interface RawResponse {
  status: number;
  bytes: Uint8Array;
  contentType: string;
}

export interface RawOptions {
  signal: AbortSignal;
  accept?: string;
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  referer?: string;
  /** Statuses that are returned instead of thrown (a site that sends its answer with a 500). */
  okStatuses?: number[];
}

/** One request, body as bytes. 429 is a limit; 403 and a 503 bot-check page are blocked; other failures are plain. */
export async function httpRaw(url: string, opts: RawOptions): Promise<RawResponse> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: opts.accept ?? '*/*' };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  if (opts.referer) headers.Referer = opts.referer;
  let res: Response;
  let bytes: Uint8Array;
  try {
    res = await fetch(url, { method: opts.method ?? 'GET', signal: opts.signal, headers, body: opts.body, credentials: 'omit' });
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (opts.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (opts.okStatuses?.includes(res.status)) return { status: res.status, bytes, contentType };
  if (res.status === 429) throw new ProviderError('http', 'Too many requests', 429);
  if (res.status === 403 || (res.status === 503 && /html/i.test(contentType))) {
    const head = textOf(bytes.subarray(0, 4096));
    if (/cloudflare|cf-chl|just a moment|captcha|ddos-guard|checking your browser/i.test(head)) throw new ProviderError('challenge', 'Needs a quick check', res.status);
    if (res.status === 403) throw new ProviderError('blocked', 'Blocked by a bot check', res.status);
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new ProviderError('http', 'Not answering right now', res.status);
  if (!res.ok) throw new ProviderError('http', `HTTP ${res.status}`, res.status);
  return { status: res.status, bytes, contentType };
}

/** UTF-8 when valid, else Latin-1 (every byte becomes the code point of the same value). */
export function textOf(bytes: Uint8Array): string {
  const utf8 = decodeUtf8Strict(bytes);
  if (utf8 !== null) return utf8.replace(/^\uFEFF/, '');
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

export async function httpPage(url: string, opts: RawOptions): Promise<string> {
  return textOf((await httpRaw(url, opts)).bytes);
}

/** `href` resolved against the page it was found on. Handles absolute, protocol-relative, root-relative and relative. */
export function resolveHref(pageUrl: string, href: string): string {
  const h = href.trim();
  if (/^https?:\/\//i.test(h)) return h;
  const m = /^(https?:\/\/[^/?#]+)([^?#]*)/i.exec(pageUrl);
  if (!m) return h;
  if (h.startsWith('//')) return `${/^https?:/i.exec(pageUrl)?.[0] ?? 'https:'}${h}`;
  if (h.startsWith('/')) return m[1] + h;
  const dir = m[2].replace(/[^/]*$/, '');
  const parts = (dir + h).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  }
  return m[1] + out.join('/').replace(/^\/*/, '/');
}

/** "https://host/a/b?x=1" -> "/a/b?x=1": what a candidate id keeps, so any mirror host can serve it. */
export function pathOf(url: string): string {
  const m = /^https?:\/\/[^/?#]+(.*)$/i.exec(url);
  return m ? m[1] || '/' : url;
}

export function joinBase(base: string, path: string): string {
  return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

/** Letters and digits only, lower case, accents removed. */
export function fold(s: string | undefined | null): string {
  let t = String(s ?? '');
  try {
    t = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  } catch {
    // keep as is
  }
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function tokens(s: string | undefined | null): string[] {
  return fold(s).split(' ').filter(Boolean);
}

/** True when every word of `wanted` is in `candidate`. */
export function titleMatches(wanted: string | undefined, candidate: string | undefined): boolean {
  const w = tokens(wanted);
  if (w.length === 0) return false;
  const c = new Set(tokens(candidate));
  return w.every((t) => c.has(t));
}

export function unsupportedType(): ProviderError {
  return new ProviderError('parse', "This subtitle's file type isn't supported");
}

/**
 * What a source sent for a download: a zip goes on as it is, RAR and 7z are refused, a page is refused, anything
 * else is the subtitle text (its format read from the content).
 */
export function toPayload(bytes: Uint8Array): SubtitlePayload {
  if (bytes.length === 0) throw new ProviderError('parse', 'Empty download');
  const kind = archiveKind(bytes);
  if (kind === 'zip') return { kind: 'zip', bytes };
  if (kind) throw unsupportedType();
  const head = textOf(bytes.subarray(0, 2048));
  if (/^\s*<(!doctype|html|\?xml|head|body)/i.test(head)) throw new ProviderError('parse', 'The source sent a page, not a subtitle');
  return { kind: 'text', bytes, format: detectFormat(head) };
}

/** The ProviderError a source's "limit reached" page becomes (429 so the app shows the limit message). */
export function limitError(message = 'Daily limit reached'): ProviderError {
  return new ProviderError('http', message, 429);
}

/** A JSON array body as a list of loose objects; anything else (a page, an object) is an empty list. */
export function parseJsonList(body: string): any[] {
  try {
    const v = JSON.parse(body);
    return Array.isArray(v) ? v : [];
  } catch {
    if (/^\s*<(!doctype|html)/i.test(body)) throw new ProviderError('blocked', 'Blocked by a bot check');
    throw new ProviderError('parse', 'Unexpected response');
  }
}
