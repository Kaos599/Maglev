/**
 * Pure source parsing shared by the simulator and the add-torrent UI.
 * On device the native engine is the source of truth (`resolveMetadata`); these helpers
 * only validate and normalize input before it is handed over.
 */

export interface ParsedSource {
  kind: 'magnet' | 'torrent';
  /** 40-char lowercase hex. For `.torrent` URLs/paths without a known hash this is a stable placeholder. */
  infoHash: string;
  name: string | null;
  trackers: string[];
  exactLength?: number;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 to lowercase hex. Throws on characters outside the alphabet. */
export function base32ToHex(base32: string): string {
  let bits = '';
  const upper = base32.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const val = BASE32.indexOf(upper.charAt(i));
    if (val === -1) throw new Error(`Invalid Base32 character at index ${i}: ${upper.charAt(i)}`);
    bits += val.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.substring(i, i + 4), 2).toString(16);
  }
  return hex.toLowerCase();
}

/** Returns the 40-char lowercase hex info-hash for a 40-hex or 32-base32 string, or null. */
export function normalizeInfoHash(raw: string): string | null {
  const h = raw.trim();
  if (/^[0-9a-fA-F]{40}$/.test(h)) return h.toLowerCase();
  if (/^[2-7a-zA-Z]{32}$/.test(h)) {
    try {
      return base32ToHex(h);
    } catch {
      return null;
    }
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Deterministic 40-hex stand-in hash, used only by the simulator for `.torrent` sources. */
export function pseudoHash(input: string): string {
  let out = '';
  for (let seed = 0; seed < 5; seed++) {
    let h = (0x811c9dc5 ^ (seed * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

/** Parses a magnet URI. Returns null unless it carries a valid btih (40 hex or 32 base32). */
export function parseMagnet(uri: string): ParsedSource | null {
  const clean = uri.trim();
  if (!/^magnet:\?/i.test(clean)) return null;
  const query = clean.slice(clean.indexOf('?') + 1);
  let infoHash: string | null = null;
  let name: string | null = null;
  let exactLength: number | undefined;
  const trackers: string[] = [];
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).toLowerCase();
    const value = safeDecode(pair.slice(eq + 1));
    if (key === 'xt' && !infoHash) {
      const m = /^urn:btih:([a-zA-Z0-9]+)$/i.exec(value);
      if (m) infoHash = normalizeInfoHash(m[1]);
    } else if (key === 'dn' && !name) {
      name = value;
    } else if (key === 'xl' && /^\d+$/.test(value)) {
      exactLength = parseInt(value, 10);
    } else if (key === 'tr' && value && !trackers.includes(value)) {
      trackers.push(value);
    }
  }
  if (!infoHash) return null;
  return { kind: 'magnet', infoHash, name, trackers, exactLength };
}

/** Accepts a magnet URI, an http(s) URL to a .torrent, or an absolute/file/content path to a .torrent. */
export function parseSource(source: string): ParsedSource | null {
  const clean = (source ?? '').trim();
  if (!clean) return null;
  if (/^magnet:/i.test(clean)) return parseMagnet(clean);

  const isUrl = /^https?:\/\/[^\s/]+\S*$/i.test(clean);
  const isFile = /^file:\/\/\S+$/i.test(clean) || (/^\/[^\0]+$/.test(clean) && !/^\/\//.test(clean));
  const isContent = /^content:\/\/\S+$/i.test(clean);
  if (!isUrl && !isFile && !isContent) return null;

  const pathPart = clean.split(/[?#]/)[0];
  if (!isContent && !/\.torrent$/i.test(pathPart)) return null;

  const base = safeDecode(pathPart.split('/').pop() || '').replace(/\.torrent$/i, '');
  return { kind: 'torrent', infoHash: pseudoHash(clean), name: base || null, trackers: [] };
}
