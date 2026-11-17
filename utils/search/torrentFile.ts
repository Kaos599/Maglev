import { ProviderError } from './http.ts';

/** SHA-1 of the bytes as lowercase hex (Hermes has no crypto.subtle, so this is plain arithmetic). */
export function sha1Hex(data: Uint8Array): string {
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  const len = data.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  view.setUint32(padded.length - 4, (len << 3) >>> 0);
  let h0 = 0x67452301, h1 = 0xefcdab89 | 0, h2 = 0x98badcfe | 0, h3 = 0x10325476, h4 = 0xc3d2e1f0 | 0;
  const w = new Int32Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc | 0; }
      else { f = b ^ c ^ d; k = 0xca62c1d6 | 0; }
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Index just past the bencoded value that starts at `p`. Throws on malformed data. */
function skipValue(b: Uint8Array, p: number, depth = 0): number {
  if (depth > 32 || p >= b.length) throw new Error('bad bencode');
  const c = b[p];
  if (c === 0x69) { // i<n>e
    while (p < b.length && b[p] !== 0x65) p++;
    if (p >= b.length) throw new Error('bad bencode');
    return p + 1;
  }
  if (c === 0x6c || c === 0x64) { // l...e / d...e
    p++;
    while (p < b.length && b[p] !== 0x65) p = skipValue(b, p, depth + 1);
    if (p >= b.length) throw new Error('bad bencode');
    return p + 1;
  }
  if (c >= 0x30 && c <= 0x39) { // <len>:<bytes>
    let n = 0;
    while (p < b.length && b[p] >= 0x30 && b[p] <= 0x39) n = n * 10 + (b[p++] - 0x30);
    if (b[p] !== 0x3a || p + 1 + n > b.length) throw new Error('bad bencode');
    return p + 1 + n;
  }
  throw new Error('bad bencode');
}

const text = (b: Uint8Array, s: number, e: number): string => new TextDecoder().decode(b.subarray(s, e));

/** Payload of the bencoded string spanning [p, end). */
const stringBody = (b: Uint8Array, p: number, end: number): string => text(b, b.indexOf(0x3a, p) + 1, end);

/** Info hash (SHA-1 of the raw top-level `info` dictionary) and the `announce` URL of a .torrent file. */
export function readTorrent(bytes: Uint8Array): { infoHash: string; announce?: string } {
  let info: [number, number] | undefined;
  let announce: string | undefined;
  try {
    if (bytes[0] !== 0x64) throw new Error('not a dictionary');
    let p = 1;
    while (p < bytes.length && bytes[p] !== 0x65) {
      const keyEnd = skipValue(bytes, p);
      const key = stringBody(bytes, p, keyEnd);
      const valEnd = skipValue(bytes, keyEnd);
      if (key === 'info') info = [keyEnd, valEnd];
      else if (key === 'announce' && bytes[keyEnd] >= 0x30 && bytes[keyEnd] <= 0x39) announce = stringBody(bytes, keyEnd, valEnd);
      p = valEnd;
    }
  } catch {
    throw new ProviderError('parse', 'Not a torrent file');
  }
  if (!info) throw new ProviderError('parse', 'No info section in the torrent file');
  return { infoHash: sha1Hex(bytes.subarray(info[0], info[1])), announce };
}

/** The info hash of a `.torrent` file. */
export function infoHashFromTorrent(bytes: Uint8Array): string {
  return readTorrent(bytes).infoHash;
}

/** Downloads a .torrent file. Refuses anything over `maxBytes`. */
export async function fetchTorrentBytes(url: string, signal: AbortSignal, userAgent: string, maxBytes = 8 * 1024 * 1024): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { 'User-Agent': userAgent, Accept: 'application/x-bittorrent' }, credentials: 'omit' });
  } catch (e) {
    if (signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  if (!res.ok) throw new ProviderError('http', `HTTP ${res.status}`, res.status);
  // Refuse a declared oversize body before reading it: arrayBuffer() holds the whole response in memory.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ProviderError('parse', 'Torrent file is too large');
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (signal.aborted) throw new ProviderError('cancelled', 'Cancelled');
    throw new ProviderError('network', e instanceof Error ? e.message : 'Network error');
  }
  if (bytes.length > maxBytes) throw new ProviderError('parse', 'Torrent file is too large');
  return bytes;
}
