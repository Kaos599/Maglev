// Shared helpers for the batch 4 subtitle sources (docs/NATIVE_CONTRACT.md section 36.3): a byte fetch (utils/search/http.ts
// only returns text), title matching, and turning a downloaded body into a SubtitlePayload. No network in the pure parts.
import { ProviderError, USER_AGENT } from '../../search/http.ts';
import { isCloudflareChallenge } from '../../search/challenge.ts';
import { archiveKind, decodeSubtitleText, detectFormat, releaseSimilarity } from '../payload.ts';
import type { SubFormat, SubtitleCandidate, SubtitlePayload, SubtitleQuery } from '../types.ts';

export const UNSUPPORTED_TYPE = "This subtitle's file type isn't supported";

export interface BytesOptions {
  signal: AbortSignal;
  accept: string;
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Refuse bodies over this many bytes (default 8 MB). */
  maxBytes?: number;
}

export interface BytesResult {
  bytes: Uint8Array;
  contentType: string;
}

const latin1 = (b: Uint8Array): string => {
  let s = '';
  const n = Math.min(b.length, 4096);
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
  return s;
};

/**
 * One request, whole body as bytes. Same rules as `httpText`: generic User-Agent, no cookies, a Cloudflare check is
 * `challenge`, 403 is `blocked`, 429 is an `http` error with status 429 (a limit), other 4xx/5xx are `http`.
 */
export async function httpBytes(url: string, opts: BytesOptions): Promise<BytesResult> {
  const headers: Record<string, string> = { ...opts.headers, 'User-Agent': USER_AGENT, Accept: opts.accept };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  const max = opts.maxBytes ?? 8 * 1024 * 1024;
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? 'GET', signal: opts.signal, headers, body: opts.body, credentials: 'omit' });
  } catch (e) {
    if (opts.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new ProviderError('parse', 'The file is too large');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (opts.signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  if (bytes.length > max) throw new ProviderError('parse', 'The file is too large');
  const contentType = res.headers.get('content-type') ?? '';
  if (res.status === 429) throw new ProviderError('http', 'Too many requests', 429);
  if (isCloudflareChallenge(res.status, res.headers, latin1(bytes))) throw new ProviderError('challenge', 'Needs a quick check', res.status);
  if (res.status === 403) throw new ProviderError('blocked', 'Blocked by a bot check', res.status);
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new ProviderError('http', res.status === 503 ? 'Down for maintenance' : 'Not answering right now', res.status);
  }
  if (!res.ok) throw new ProviderError('http', `HTTP ${res.status}`, res.status);
  return { bytes, contentType };
}

// ---------------------------------------------------------------- names

const FOLD: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', ı: 'i' };

/** Lower case, accents folded, everything but letters and digits turned into single spaces. */
export function normTitle(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[ßæœøđłı]/g, (c) => FOLD[c] ?? c)
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const noThe = (s: string) => s.replace(/^the /, '');

/** True when two titles are the same after `normTitle` (a leading "The" doesn't count). */
export function sameTitle(a: string, b: string): boolean {
  const x = noThe(normTitle(a));
  const y = noThe(normTitle(b));
  return x.length > 0 && x === y;
}

/** True when `title` equals the wanted title or one of its " / " or "(aka ...)" parts. */
export function titleMatches(wanted: string, title: string): boolean {
  if (sameTitle(wanted, title)) return true;
  const parts = title.split(/\s+\/\s+|\s*\(aka\.?\s+|\s+aka\.?\s+/i).map((p) => p.replace(/\)\s*$/, ''));
  return parts.length > 1 && parts.some((p) => sameTitle(wanted, p));
}

/** 'release' when the listed release name resembles the video's file name, otherwise 'title'. */
export function matchKind(q: Pick<SubtitleQuery, 'fileName'>, releaseName: string): SubtitleCandidate['matchedBy'] {
  return releaseName && releaseSimilarity(releaseName, q.fileName) >= 0.45 ? 'release' : 'title';
}

/**
 * Some listings put every release a file fits in one comment ("A.B.2019-X; A.B.2019.720p-Y si ..."). This picks the one
 * closest to the video's file name; with none close, the first, cut to a readable length.
 */
export function bestRelease(q: Pick<SubtitleQuery, 'fileName'>, text: string): { name: string; matchedBy: SubtitleCandidate['matchedBy'] } {
  const parts = text
    .split(/\||;|\s+si\s+|\s+(?=\S+\.\S+\.\S+\.\S+)/i)
    .map((p) => p.replace(/[\s.]+$/, '').trim())
    .filter((p) => p.length > 2);
  let best = '';
  let bestScore = -1;
  for (const p of parts) {
    const sc = releaseSimilarity(p, q.fileName);
    if (sc > bestScore) {
      best = p;
      bestScore = sc;
    }
  }
  if (!best) return { name: text.slice(0, 120).trim(), matchedBy: 'title' };
  return bestScore >= 0.45 ? { name: best, matchedBy: 'release' } : { name: (parts[0] ?? best).slice(0, 120), matchedBy: 'title' };
}

export function formatFromName(name: string): SubFormat | undefined {
  const m = /\.(srt|ass|ssa|vtt)$/i.exec(name.trim());
  return m ? (m[1].toLowerCase() as SubFormat) : undefined;
}

/** "2026-06-03" or "26.11.2009" to epoch milliseconds (UTC); undefined when it isn't a date. */
export function parseDate(s: string): number | undefined {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  const dmy = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  const [y, m, d] = iso ? [+iso[1], +iso[2], +iso[3]] : dmy ? [+dmy[3], +dmy[2], +dmy[1]] : [0, 0, 0];
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return Date.UTC(y, m - 1, d);
}

// ---------------------------------------------------------------- download body

/**
 * A downloaded body as a payload. A zip is handed back for the member choice (36.7); RAR and 7z are not supported;
 * HTML or a short message instead of a subtitle is a failure; anything else must look like subtitle text.
 */
export function payloadFromBody(bytes: Uint8Array, language: string, nameHint = ''): SubtitlePayload {
  const kind = archiveKind(bytes);
  if (kind === 'zip') return { kind: 'zip', bytes };
  if (kind === 'rar' || kind === '7z') throw new ProviderError('parse', UNSUPPORTED_TYPE);
  if (bytes.length === 0) throw new ProviderError('parse', 'The source sent an empty file');
  const r = decodeSubtitleText(bytes, language);
  const text = r.ok ? r.text : latin1(bytes);
  if (/^\s*<(!doctype|html)/i.test(text)) throw new ProviderError('parse', 'The source sent a web page instead of a subtitle');
  const looksLikeSubtitle = /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(text) || /^\s*WEBVTT/.test(text) || /\[Script Info\]/i.test(text) || /^\s*Dialogue:/m.test(text);
  if (!looksLikeSubtitle) throw new ProviderError('parse', 'The source has no file for this subtitle right now');
  return { kind: 'text', bytes, format: formatFromName(nameHint) ?? detectFormat(text) };
}
