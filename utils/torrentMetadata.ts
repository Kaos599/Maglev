/**
 * Maglev Torrent Metadata & Bencode Engine
 *
 * Provides:
 * 1. Zero-dependency fast Bencode parser (BEP 0003)
 * 2. Magnet URI parser & parameter extractor (BEP 0009)
 * 3. Swarm metadata resolution via public torrent caches & DHT gateways
 */

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
 * Parses a magnet URI into components (infoHash, name, size, trackers).
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
  const trackers: string[] = [];

  // Match xt=urn:btih:<hash>
  const xtMatch = clean.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
  if (xtMatch && xtMatch[1]) {
    infoHash = xtMatch[1].toLowerCase();
    // If base32 (32 chars), convert to 40 char hex
    if (infoHash.length === 32) {
      infoHash = base32ToHex(infoHash);
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

  // Match all tr=<tracker>
  const trMatches = clean.matchAll(/tr=([^&]+)/gi);
  for (const match of trMatches) {
    if (match[1]) {
      try {
        const decoded = decodeURIComponent(match[1]);
        if (!trackers.includes(decoded)) {
          trackers.push(decoded);
        }
      } catch {
        trackers.push(match[1]);
      }
    }
  }

  if (!name && infoHash) {
    name = `Torrent_${infoHash.slice(0, 8)}`;
  }

  return { infoHash, name, exactLength, trackers };
}

/**
 * Converts Base32 RFC 4648 string to hex string.
 */
function base32ToHex(base32: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  const upper = base32.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    const val = alphabet.indexOf(upper.charAt(i));
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    const chunk = bits.substring(i, i + 4);
    hex += parseInt(chunk, 2).toString(16);
  }
  return hex.toLowerCase();
}

/**
 * Fast zero-dependency Bencode Decoder.
 */
export function decodeBencode(data: Uint8Array): any {
  let pos = 0;

  function decode(): any {
    if (pos >= data.length) return null;

    const byte = data[pos];

    // Integer: i<num>e
    if (byte === 0x69) { // 'i'
      pos++;
      let start = pos;
      while (pos < data.length && data[pos] !== 0x65) { // 'e'
        pos++;
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
        list.push(decode());
      }
      pos++; // skip 'e'
      return list;
    }

    // Dictionary: d<key><value>...e
    if (byte === 0x64) { // 'd'
      pos++;
      const dict: Record<string, any> = {};
      while (pos < data.length && data[pos] !== 0x65) {
        const key = decode();
        const value = decode();
        if (typeof key === 'string') {
          dict[key] = value;
        }
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
      const lenStr = bytesToString(data.subarray(start, pos));
      const len = parseInt(lenStr, 10);
      pos++; // skip ':'
      const strBytes = data.subarray(pos, pos + len);
      pos += len;

      // Try UTF-8 string decode, fallback to raw string
      try {
        return new TextDecoder('utf-8', { fatal: false }).decode(strBytes);
      } catch {
        return bytesToString(strBytes);
      }
    }

    return null;
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
  const pieceCount = typeof pieces === 'string' ? Math.floor(pieces.length / 20) : 256;

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
 * Resolves metadata for a magnet URI.
 * First extracts magnet tags. Then queries public torrent caches with a fast timeout.
 */
export async function resolveMagnetMetadata(magnetUri: string): Promise<ResolvedMetadata> {
  const { infoHash, name, exactLength, trackers } = parseMagnetUri(magnetUri);

  if (!infoHash) {
    return {
      infoHash: '',
      name: name || 'Unknown Magnet Link',
      totalSize: exactLength || 0,
      files: [],
      trackers,
      isPendingSwarm: true,
    };
  }

  // Public torrent cache endpoints that index swarms by hex infoHash
  const cacheUrls = [
    `https://itorrents.org/torrent/${infoHash.toUpperCase()}.torrent`,
    `https://cache.torrentstorage.encryp.ch/${infoHash.toUpperCase()}.torrent`,
  ];

  for (const url of cacheUrls) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s quick probe

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Maglev/0.1.0' },
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > 100) {
          const parsed = parseTorrentData(new Uint8Array(arrayBuffer), infoHash);
          if (parsed.files.length > 0) {
            return parsed;
          }
        }
      }
    } catch {
      // Cache miss or network timeout, continue to fallback
    }
  }

  // Fallback: Use magnet URI parameters
  const files: ParsedTorrentFile[] = [
    {
      id: 0,
      name,
      path: name,
      size: exactLength || 1_073_741_824, // Use exactLength if present, else 1 GB nominal estimate
      selected: true,
      priority: 1,
    },
  ];

  return {
    infoHash,
    name,
    totalSize: exactLength || 1_073_741_824,
    files,
    trackers,
    isPendingSwarm: true,
  };
}
