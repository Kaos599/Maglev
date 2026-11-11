/**
 * Maglev Torrent Metadata & Bencode Engine
 *
 * Provides:
 * 1. Zero-dependency fast Bencode parser (BEP 0003) with binary hash protection
 * 2. Magnet URI parser & parameter extractor (BEP 0009)
 * 3. Swarm metadata resolution delegated to the engine (`resolveMetadata`)
 */

import { base32ToHex } from 'maglev-engine/src/magnet.ts';

export interface ParsedTorrentFile {
  id: number;
  name: string;
  path: string;
  size: number;
  selected: boolean;
  priority: 0 | 1 | 2; // 0 = skip, 1 = normal, 2 = high
}

export interface ResolvedMetadata {
  infoHash: string;
  name: string;
  totalSize: number;
  files: ParsedTorrentFile[];
  trackers: string[];
  pieceLength?: number;
  pieceCount?: number;
  isPendingSwarm: boolean;
}

/**
 * Parses a magnet URI or raw info-hash into components (infoHash, name, size, trackers).
 */
export function parseMagnetUri(uri: string): {
  infoHash: string;
  name: string;
  exactLength?: number;
  trackers: string[];
} {
  const clean = uri.trim();
  let infoHash = '';
  let name = '';
  let exactLength: number | undefined;
  const trackerSet = new Set<string>();

  // Match all tr=<tracker> (supporting URL-encoded or raw, deduplicating via Set)
  const trMatches = clean.matchAll(/tr=([^&]+)/gi);
  for (const match of trMatches) {
    if (match[1]) {
      try {
        const decoded = decodeURIComponent(match[1]);
        trackerSet.add(decoded);
      } catch {
        trackerSet.add(match[1]);
      }
    }
  }
  const trackers: string[] = Array.from(trackerSet);

  // Direct 40-character hex hash support
  if (/^[a-fA-F0-9]{40}$/.test(clean)) {
    infoHash = clean.toLowerCase();
    return { infoHash, name: `Torrent_${infoHash.slice(0, 8)}`, trackers };
  }

  // Direct 32-character base32 hash support
  if (/^[2-7a-zA-Z]{32}$/.test(clean)) {
    try {
      infoHash = base32ToHex(clean);
      return { infoHash, name: `Torrent_${infoHash.slice(0, 8)}`, trackers };
    } catch {
      return { infoHash: '', name: 'Invalid Magnet Hash', trackers };
    }
  }

  // Match xt=urn:btih:<hash> or xt=urn%3Abtih%3A<hash> or xt=urn:btmh:<hash>
  const xtMatch = clean.match(/xt=urn(?:%3A|:)(?:btih|btmh)(?:%3A|:)([a-zA-Z0-9]+)/i);
  if (xtMatch && xtMatch[1]) {
    infoHash = xtMatch[1].toLowerCase();
    // If base32 (32 chars), safely convert to 40 char hex, catching invalid characters
    if (infoHash.length === 32) {
      try {
        infoHash = base32ToHex(infoHash);
      } catch {
        infoHash = '';
      }
    }
  }

  // Match dn=<name>
  const dnMatch = clean.match(/dn=([^&]+)/i);
  if (dnMatch && dnMatch[1]) {
    try {
      name = decodeURIComponent(dnMatch[1].replace(/\+/g, ' '));
    } catch {
      name = dnMatch[1];
    }
  }

  // Match xl=<exact_length>
  const xlMatch = clean.match(/xl=([0-9]+)/i);
  if (xlMatch && xlMatch[1]) {
    exactLength = parseInt(xlMatch[1], 10);
  }

  if (!name && infoHash) {
    name = `Torrent_${infoHash.slice(0, 8)}`;
  } else if (!name && !infoHash) {
    name = 'Invalid Magnet Link';
  }

  return { infoHash, name, exactLength, trackers };
}

/**
 * Fast zero-dependency Bencode Decoder (BEP 0003 compliant).
 * Preserves binary piece hashes as Uint8Array without UTF-8 corruption.
 * Protects against infinite loops on malformed inputs.
 */
export function decodeBencode(data: Uint8Array): any {
  let pos = 0;

  function decode(keyContext?: string): any {
    if (pos >= data.length) {
      throw new Error('Unexpected EOF while decoding bencode');
    }

    const startPos = pos;
    const byte = data[pos];

    // End marker: 'e' (0x65)
    if (byte === 0x65) {
      return null;
    }

    // Integer: i<num>e
    if (byte === 0x69) { // 'i'
      pos++;
      let start = pos;
      while (pos < data.length && data[pos] !== 0x65) { // 'e'
        pos++;
      }
      if (pos >= data.length) {
        throw new Error('Unterminated integer in bencode');
      }
      const str = bytesToString(data.subarray(start, pos));
      pos++; // skip 'e'
      return parseInt(str, 10);
    }

    // List: l<items>e
    if (byte === 0x6c) { // 'l'
      pos++;
      const list: any[] = [];
      while (pos < data.length && data[pos] !== 0x65) {
        const itemStart = pos;
        const item = decode();
        list.push(item);
        if (pos === itemStart) {
          throw new Error(`Infinite loop detected in bencode list at offset ${pos}`);
        }
      }
      if (pos >= data.length) {
        throw new Error('Unterminated list in bencode');
      }
      pos++; // skip 'e'
      return list;
    }

    // Dictionary: d<key><value>...e
    if (byte === 0x64) { // 'd'
      pos++;
      const dict: Record<string, any> = {};
      while (pos < data.length && data[pos] !== 0x65) {
        const keyStart = pos;
        const key = decode();
        if (pos === keyStart || typeof key !== 'string') {
          throw new Error(`Invalid dictionary key at offset ${pos}`);
        }
        const valStart = pos;
        const value = decode(key);
        if (pos === valStart) {
          throw new Error(`Infinite loop detected in bencode dictionary value for key "${key}" at offset ${pos}`);
        }
        dict[key] = value;
      }
      if (pos >= data.length) {
        throw new Error('Unterminated dictionary in bencode');
      }
      pos++; // skip 'e'
      return dict;
    }

    // Byte string: <length>:<bytes>
    if (byte >= 0x30 && byte <= 0x39) { // '0'..'9'
      let start = pos;
      while (pos < data.length && data[pos] !== 0x3a) { // ':'
        pos++;
      }
      if (pos >= data.length) {
        throw new Error('Unterminated string length in bencode');
      }
      const lenStr = bytesToString(data.subarray(start, pos));
      const len = parseInt(lenStr, 10);
      pos++; // skip ':'
      if (pos + len > data.length) {
        throw new Error(`String length ${len} exceeds bencode data bounds at offset ${pos}`);
      }
      const strBytes = data.subarray(pos, pos + len);
      pos += len;

      // Crucial: preserve binary SHA-1 piece hashes as Uint8Array
      if (keyContext === 'pieces') {
        return strBytes;
      }

      // Try UTF-8 string decode with strict validation
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(strBytes);
      } catch {
        // Fallback for non-strict strings or binary data
        return bytesToString(strBytes);
      }
    }

    throw new Error(`Unexpected bencode byte 0x${byte.toString(16)} at offset ${startPos}`);
  }

  return decode();
}

function bytesToString(bytes: Uint8Array): string {
  let res = '';
  for (let i = 0; i < bytes.length; i++) {
    res += String.fromCharCode(bytes[i]);
  }
  return res;
}

/**
 * Parses bencoded torrent dictionary into structured ResolvedMetadata.
 */
export function parseTorrentData(bencodedData: Uint8Array, defaultHash?: string): ResolvedMetadata {
  const torrent = decodeBencode(bencodedData);
  if (!torrent || !torrent.info) {
    throw new Error('Invalid .torrent structure: missing info dictionary');
  }

  const info = torrent.info;
  const name = info['name.utf-8'] || info.name || 'Torrent Download';
  const pieceLength = info['piece length'] || 262144;
  const pieces = info.pieces;
  const pieceCount =
    pieces instanceof Uint8Array
      ? Math.floor(pieces.length / 20)
      : typeof pieces === 'string'
      ? Math.floor(pieces.length / 20)
      : 256;

  const files: ParsedTorrentFile[] = [];
  let totalSize = 0;

  if (Array.isArray(info.files) && info.files.length > 0) {
    // Multi-file torrent
    info.files.forEach((file: any, index: number) => {
      const length = typeof file.length === 'number' ? file.length : 0;
      totalSize += length;
      const pathParts = Array.isArray(file['path.utf-8'])
        ? file['path.utf-8']
        : Array.isArray(file.path)
        ? file.path
        : [`file_${index}`];
      const filePath = pathParts.join('/');
      const fileName = pathParts[pathParts.length - 1] || `file_${index}`;

      files.push({
        id: index,
        name: fileName,
        path: filePath,
        size: length,
        selected: true,
        priority: 1,
      });
    });
  } else {
    // Single-file torrent
    const length = typeof info.length === 'number' ? info.length : 0;
    totalSize = length;
    files.push({
      id: 0,
      name,
      path: name,
      size: length,
      selected: true,
      priority: 1,
    });
  }

  // Collect announce / announce-list trackers
  const trackers: string[] = [];
  if (typeof torrent.announce === 'string') {
    trackers.push(torrent.announce);
  }
  if (Array.isArray(torrent['announce-list'])) {
    torrent['announce-list'].forEach((tier: any) => {
      if (Array.isArray(tier)) {
        tier.forEach((t: any) => {
          if (typeof t === 'string' && !trackers.includes(t)) {
            trackers.push(t);
          }
        });
      }
    });
  }

  return {
    infoHash: defaultHash || '0000000000000000000000000000000000000000',
    name,
    totalSize,
    files,
    trackers,
    pieceLength,
    pieceCount,
    isPendingSwarm: false,
  };
}

/**
 * Resolves metadata through the engine (`resolveMetadata`, librqbit `list_only`). The engine is the source of
 * truth on device; the simulator answers the same call in dev and on web. No JS-side network lookups.
 * If the swarm does not answer in time, returns the magnet's own fields with `isPendingSwarm: true`.
 */
export async function resolveMagnetMetadata(magnetUri: string, timeoutMs: number = 30_000): Promise<ResolvedMetadata> {
  const { infoHash, name, exactLength, trackers } = parseMagnetUri(magnetUri);
  const pending: ResolvedMetadata = {
    infoHash,
    name: name || 'Unknown Magnet Link',
    totalSize: exactLength || 0,
    // Placeholder row so the picker has something to show until the swarm answers; size is unknown (0) without xl=.
    files: [{ id: 0, name: name || 'Unknown Magnet Link', path: name || 'Unknown Magnet Link', size: exactLength || 0, selected: true, priority: 1 }],
    trackers,
    isPendingSwarm: true,
  };
  if (!infoHash) return pending;

  let res;
  try {
    // Loaded lazily so the pure parsers above stay usable from Node scripts without the Expo runtime.
    const { maglevEngine } = await import('maglev-engine');
    res = await maglevEngine.resolveMetadata(magnetUri, timeoutMs);
  } catch {
    return pending;
  }
  if (res.ok === false) return pending;

  return {
    infoHash: res.infoHash,
    name: res.name,
    totalSize: res.totalBytes,
    files: res.files.map((f) => ({
      id: f.index,
      name: f.path.split('/').pop() || f.path,
      path: f.path,
      size: f.length,
      selected: true,
      priority: 1 as const,
    })),
    trackers,
    isPendingSwarm: false,
  };
}
