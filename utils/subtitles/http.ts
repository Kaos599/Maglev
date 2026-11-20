/**
 * The one bytes fetch and the one download-to-payload step for every subtitle source (contract 36.3).
 * `utils/search/http.ts` only reads text, so downloads and binary-safe pages come through here. Same User-Agent as
 * `httpText`, no cookies, no timeout of its own (the caller's AbortSignal ends the request).
 */
import { ProviderError, USER_AGENT, httpText } from '../search/http.ts';
import { isCloudflareChallenge } from '../search/challenge.ts';
import { archiveKind, decodeSubtitleText, decodeUtf8Strict, detectFormat, hasSubtitleCues } from './payload.ts';
import type { SubFormat, SubtitlePayload } from './types.ts';

export const UNSUPPORTED_TYPE = "This subtitle's file type isn't supported";

export interface BytesOptions {
  signal: AbortSignal;
  accept?: string;
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  referer?: string;
  /** Extra request headers (for example X-Requested-With). */
  headers?: Record<string, string>;
  /** A response over this size is refused (a subtitle is small). Default 32 MB. */
  maxBytes?: number;
  /** Statuses that are returned instead of thrown (a site that sends its answer with a 500). */
  okStatuses?: number[];
}

export interface BytesResult {
  status: number;
  bytes: Uint8Array;
  contentType: string;
}

const DEFAULT_MAX = 32 * 1024 * 1024;
const BOT_CHECK = /cloudflare|cf-chl|challenge-platform|just a moment|captcha|ddos-guard|checking your browser/i;

/** Latin-1 view of the first bytes, for sniffing a page. */
export function latin1(b: Uint8Array, max = 4096): string {
  let s = '';
  const n = Math.min(b.length, max);
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** UTF-8 when valid, else Latin-1 (every byte becomes the code point of the same value). */
export function textOf(bytes: Uint8Array): string {
  const utf8 = decodeUtf8Strict(bytes);
  if (utf8 !== null) return utf8.replace(/^﻿/, '');
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

/**
 * One request, whole body as bytes. 429 is a limit (`http`, status 429); a bot-check page is `challenge`; other 403
 * is `blocked`; 502/503/504 is the site being down; other failures are `http`.
 */
export async function httpBytes(url: string, opts: BytesOptions): Promise<BytesResult> {
  const headers: Record<string, string> = { ...opts.headers, 'User-Agent': USER_AGENT, Accept: opts.accept ?? '*/*' };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  if (opts.referer) headers.Referer = opts.referer;
  const max = opts.maxBytes ?? DEFAULT_MAX;
  let res: Response;
  let bytes: Uint8Array;
  try {
    res = await fetch(url, { method: opts.method ?? 'GET', signal: opts.signal, headers, body: opts.body, credentials: 'omit' });
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) throw new ProviderError('parse', 'The file is too large');
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (opts.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (opts.okStatuses?.includes(res.status)) return { status: res.status, bytes, contentType };
  if (res.status === 429) throw new ProviderError('http', 'Too many requests', 429);
  if (res.status === 403 || res.status === 503) {
    const head = latin1(bytes);
    const html = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(head);
    if (isCloudflareChallenge(res.status, res.headers, head) || (html && BOT_CHECK.test(head))) {
      throw new ProviderError('challenge', 'Needs a quick check', res.status);
    }
    if (res.status === 403) throw new ProviderError('blocked', 'Blocked by a bot check', 403);
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new ProviderError('http', res.status === 503 ? 'Down for maintenance' : 'Not answering right now', res.status);
  }
  if (!res.ok) throw new ProviderError('http', `HTTP ${res.status}`, res.status);
  if (bytes.length > max) throw new ProviderError('parse', 'The file is too large');
  return { status: res.status, bytes, contentType };
}

/** A page as text through `httpBytes`: UTF-8 when valid, else Latin-1. */
export async function httpPageBytes(url: string, opts: BytesOptions): Promise<string> {
  return textOf((await httpBytes(url, opts)).bytes);
}

export interface PageOptions {
  signal: AbortSignal;
  referer?: string;
  /** Form fields, sent as a POST. */
  form?: Record<string, string>;
}

function formBody(form: Record<string, string>): string {
  return Object.keys(form)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(form[k])}`)
    .join('&');
}

/** An HTML page through `httpText` (charset handling, clearance for a host the user passed a check on). */
export async function httpPage(url: string, o: PageOptions): Promise<string> {
  const headers: Record<string, string> = {};
  if (o.referer) headers.Referer = o.referer;
  return httpText(url, {
    signal: o.signal,
    accept: 'text/html',
    headers,
    ...(o.form ? { method: 'POST' as const, body: formBody(o.form), contentType: 'application/x-www-form-urlencoded' } : {}),
  });
}

/** Like `httpPage`, but a 500 that carries a page is read as that page (the moviesubtitles search). */
export async function httpPageLoose(url: string, o: PageOptions): Promise<string> {
  const res = await httpBytes(url, {
    signal: o.signal,
    accept: 'text/html',
    referer: o.referer,
    okStatuses: [500],
    ...(o.form ? { method: 'POST' as const, body: formBody(o.form), contentType: 'application/x-www-form-urlencoded' } : {}),
  });
  const text = textOf(res.bytes);
  if (res.status === 500 && !/<(html|body|table)/i.test(text)) throw new ProviderError('http', 'HTTP 500', 500);
  return text;
}

export interface PayloadOptions {
  /** Helps decode a legacy-charset text file. */
  language?: string;
  /** A file name that may state the format (".srt"); wins over the content. */
  nameHint?: string;
  /** Refuse a text body that has no subtitle cues (a source that answers with a short message). On unless set to false. */
  requireCues?: boolean;
}

export function formatFromName(name: string): SubFormat | undefined {
  const m = /\.(srt|ass|ssa|vtt)$/i.exec(name.trim());
  return m ? (m[1].toLowerCase() as SubFormat) : undefined;
}

/** The format of a text subtitle from its content; SRT when the text can't be read yet (the app decodes it on save). */
export function sniffFormat(bytes: Uint8Array, language?: string): SubFormat {
  const r = decodeSubtitleText(bytes, language);
  if (r.ok) return detectFormat(r.text);
  return detectFormat(latin1(bytes, 2048));
}

/**
 * What a download gave: a zip stays a zip (the member choice comes later), RAR and 7z are refused, a web page is
 * refused, anything else is a text subtitle with its format read from the name or the content. A plain string as
 * the second argument is the language.
 */
export function toPayload(bytes: Uint8Array, options: PayloadOptions | string = {}): SubtitlePayload {
  const opts: PayloadOptions = typeof options === 'string' ? { language: options } : options;
  const kind = archiveKind(bytes);
  if (kind === 'zip') return { kind: 'zip', bytes };
  if (kind === 'rar' || kind === '7z') throw new ProviderError('parse', UNSUPPORTED_TYPE);
  if (bytes.length === 0) throw new ProviderError('parse', 'The source sent an empty file');
  const r = decodeSubtitleText(bytes, opts.language);
  const text = r.ok ? r.text : latin1(bytes);
  if (/^\s*<(!doctype|html|\?xml|head|body)/i.test(text)) throw new ProviderError('parse', 'The source sent a web page instead of a subtitle');
  // NATIVE_CONTRACT 39.1 S1: every provider's body must hold a cue, whatever the provider passed.
  if (opts.requireCues !== false && !hasSubtitleCues(text)) {
    throw new ProviderError('parse', 'The source has no file for this subtitle right now');
  }
  const format = (opts.nameHint ? formatFromName(opts.nameHint) : undefined) ?? (r.ok ? detectFormat(r.text) : detectFormat(latin1(bytes, 2048)));
  return { kind: 'text', bytes, format };
}
