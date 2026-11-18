// Shared by the batch 1 sources: a bytes fetch (utils/search/http.ts only reads text) and the payload step.
import { archiveKind, decodeSubtitleText, detectFormat } from '../payload.ts';
import type { SubFormat, SubtitlePayload } from '../types.ts';
import { ProviderError, USER_AGENT } from '../../search/http.ts';

export interface BytesOptions {
  signal: AbortSignal;
  accept?: string;
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** A response over this size is refused (a subtitle is small). */
  maxBytes?: number;
}

const DEFAULT_MAX = 32 * 1024 * 1024;

/** Generic User-Agent, no cookies. A 429 is a limit (36.3); an HTML bot-check page is a challenge. */
export async function httpBytes(url: string, opts: BytesOptions): Promise<Uint8Array> {
  const headers: Record<string, string> = { ...opts.headers, 'User-Agent': USER_AGENT, Accept: opts.accept ?? '*/*' };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? 'GET', signal: opts.signal, headers, body: opts.body, credentials: 'omit' });
  } catch (e) {
    if (opts.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  if (res.status === 429) throw new ProviderError('http', 'Rate limit reached', 429);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (opts.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  if (res.status === 403 || res.status === 503) {
    const head = String.fromCharCode(...bytes.subarray(0, 600));
    if (/^\s*<(!doctype|html)/i.test(head) && /cloudflare|captcha|just a moment|ddos-guard|checking your browser/i.test(head)) {
      throw new ProviderError('challenge', 'Needs a quick check', res.status);
    }
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new ProviderError('http', 'Not answering right now', res.status);
  if (!res.ok) throw new ProviderError('http', `HTTP ${res.status}`, res.status);
  if (bytes.length > (opts.maxBytes ?? DEFAULT_MAX)) throw new ProviderError('parse', 'Unexpected response');
  return bytes;
}

export const UNSUPPORTED_TYPE = "This subtitle's file type isn't supported";

/** The format of a text subtitle from its content; SRT when the text can't be read yet (the app decodes it on save). */
export function sniffFormat(bytes: Uint8Array, language?: string): SubFormat {
  const r = decodeSubtitleText(bytes, language);
  if (r.ok) return detectFormat(r.text);
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 2048); i++) head += String.fromCharCode(bytes[i]);
  return detectFormat(head);
}

/** What a download gave: a zip stays a zip, RAR and 7z are refused, anything else is a text subtitle. */
export function payloadFromBytes(bytes: Uint8Array, language?: string): SubtitlePayload {
  if (bytes.length === 0) throw new ProviderError('parse', 'Empty subtitle');
  const kind = archiveKind(bytes);
  if (kind === 'zip') return { kind: 'zip', bytes };
  if (kind === 'rar' || kind === '7z') throw new ProviderError('parse', UNSUPPORTED_TYPE);
  const head = String.fromCharCode(...bytes.subarray(0, 200));
  if (/^\s*<(!doctype|html)/i.test(head)) throw new ProviderError('parse', 'Unexpected response');
  return { kind: 'text', bytes, format: sniffFormat(bytes, language) };
}

/** Lowercase words and digits only, for comparing titles. */
export function words(s: string | undefined | null): string[] {
  return (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9Ѐ-ӿͰ-Ͽ]+/).filter(Boolean);
}

export function sameTitle(a: string | undefined | null, b: string | undefined | null): boolean {
  const x = words(a);
  const y = words(b);
  return x.length > 0 && x.length === y.length && x.every((w, i) => w === y[i]);
}

export function stripSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

/** Season and episode when the file name is known to be an episode; the sources have no use for a guess. */
export function episodeOf(q: { season?: number; episode?: number }): { season: number; episode: number } | null {
  return q.season !== undefined && q.episode !== undefined ? { season: q.season, episode: q.episode } : null;
}
