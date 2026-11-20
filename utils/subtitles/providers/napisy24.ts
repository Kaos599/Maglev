// Ported from LavX/bazarr-provider-catalog providers/napisy24 (MIT), https://github.com/LavX/bazarr-provider-catalog/blob/main/providers/napisy24/provider.py
// Anonymous only: the shared "subliminal" login that the API accepts without an account.
import type { SubtitleCandidate, SubtitleContext, SubtitleProvider, SubtitleQuery } from '../types.ts';
import { ProviderError } from '../../search/http.ts';
import { baseLanguage } from '../languages.ts';
import { archiveKind } from '../payload.ts';
import { httpBytes, toPayload } from '../http.ts';
import { stripSlash } from '../match.ts';

export const ID = 'napisy24';

const USERNAME = 'subliminal';
const PASSWORD = 'lanimilbus';

export interface N24Response {
  /** 'OK-0' (unknown file), 'OK-1' (known film, no subtitle), 'OK-2' (subtitle attached), 'OK-3', or 'login error'. */
  status: string;
  fields: Record<string, string>;
  archive: Uint8Array;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** The answer is `OK-n|key:value|key:value||<archive bytes>`; a miss has an empty archive. */
export function parseResponse(body: Uint8Array): N24Response {
  let cut = -1;
  for (let i = 0; i + 1 < body.length; i++) {
    if (body[i] === 0x7c && body[i + 1] === 0x7c) {
      cut = i;
      break;
    }
  }
  const head = latin1(cut < 0 ? body : body.subarray(0, cut));
  const archive = cut < 0 ? new Uint8Array(0) : body.subarray(cut + 2);
  if (head.startsWith('login error')) return { status: 'login error', fields: {}, archive: new Uint8Array(0) };
  if (!/^OK-\d/.test(head)) throw new ProviderError('parse', 'Unexpected response');
  const [status, ...parts] = head.split('|');
  const fields: Record<string, string> = {};
  for (const p of parts) {
    const i = p.indexOf(':');
    if (i > 0) fields[p.slice(0, i)] = p.slice(i + 1);
  }
  return { status, fields, archive };
}

/** The candidate id carries what the lookup needs again: `<hash>-<bytes>-<file name>`. */
function makeId(hash: string, bytes: number, fileName: string): string {
  return `${hash}-${Math.floor(bytes)}-${encodeURIComponent(fileName)}`;
}

export function parseId(id: string): { hash: string; bytes: number; fileName: string } | null {
  const m = /^([0-9a-f]{16})-(\d+)-(.+)$/.exec(id);
  if (!m) return null;
  try {
    return { hash: m[1], bytes: Number(m[2]), fileName: decodeURIComponent(m[3]) };
  } catch {
    return null;
  }
}

export function requestBody(hash: string, bytes: number, fileName: string): string {
  return new URLSearchParams({ postAction: 'CheckSub', ua: USERNAME, ap: PASSWORD, fs: String(bytes), fh: hash, fn: fileName, n24pref: '1' }).toString();
}

/** A candidate from an OK-2 answer, or null for any other status. */
export function toCandidates(r: N24Response, q: Pick<SubtitleQuery, 'hash' | 'videoBytes' | 'fileName'>): SubtitleCandidate[] {
  if (r.status === 'login error') throw new ProviderError('http', 'Napisy24 login failed', 401);
  if (r.status !== 'OK-2' || r.archive.length === 0 || !q.hash) return [];
  const kind = archiveKind(r.archive);
  if (kind === 'rar' || kind === '7z') return [];
  return [
    {
      providerId: ID,
      id: makeId(q.hash, q.videoBytes, q.fileName),
      language: 'pl',
      releaseName: q.fileName.replace(/\.[A-Za-z0-9]{2,4}$/, ''),
      matchedBy: 'hash',
    },
  ];
}

async function lookup(base: string, hash: string, bytes: number, fileName: string, ctx: SubtitleContext): Promise<N24Response> {
  const { bytes: body } = await httpBytes(`${stripSlash(base)}/run/CheckSubAgent.php`, {
    signal: ctx.signal,
    method: 'POST',
    body: requestBody(hash, bytes, fileName),
    contentType: 'application/x-www-form-urlencoded',
    accept: '*/*',
  });
  return parseResponse(body);
}

export const napisy24: SubtitleProvider = {
  id: ID,
  name: 'Napisy24',
  homepage: 'https://napisy24.pl',
  mirrors: ['https://napisy24.pl'],
  languages: ['pl'],
  kinds: ['movie', 'episode'],
  matches: ['hash'],
  group: 'A',
  enabledByDefault: false,
  async search(q, ctx) {
    if (!q.languages.some((l) => baseLanguage(l) === 'pl')) return [];
    // The site answers by file fingerprint only.
    if (!q.hash || !(q.videoBytes > 0)) return [];
    return toCandidates(await lookup(ctx.baseUrl, q.hash, q.videoBytes, q.fileName, ctx), q);
  },
  async download(c, ctx) {
    const id = parseId(c.id);
    if (!id) throw new ProviderError('parse', 'Bad subtitle id');
    const r = await lookup(ctx.baseUrl, id.hash, id.bytes, id.fileName, ctx);
    if (r.status === 'login error') throw new ProviderError('http', 'Napisy24 login failed', 401);
    if (r.status !== 'OK-2' || r.archive.length === 0) throw new ProviderError('parse', 'Subtitle is no longer there');
    return toPayload(r.archive, 'pl');
  },
};
