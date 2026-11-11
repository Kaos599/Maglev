// Magnet and info-hash helpers.

export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
];

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(s: string): string | null {
  let bits = '';
  for (const ch of s.toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    bits += i.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length && hex.length < 40; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.length === 40 ? hex : null;
}

/** Returns a lowercase 40-hex info hash, or null if the input is not a valid hex or base32 hash. */
export function normalizeInfoHash(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^[0-9a-fA-F]{40}$/.test(s)) {
    const h = s.toLowerCase();
    return h === '0'.repeat(40) ? null : h;
  }
  if (/^[A-Za-z2-7]{32}$/.test(s)) return base32ToHex(s);
  return null;
}

/** Extracts the info hash from a magnet URI (hex or base32 btih). */
export function infoHashFromMagnet(magnet: string | undefined | null): string | null {
  if (!magnet) return null;
  const m = /[?&]xt=urn:btih:([0-9A-Za-z]+)/i.exec(magnet);
  return m ? normalizeInfoHash(m[1]) : null;
}

export function buildMagnet(infoHash: string, name: string, extraTrackers: string[] = []): string {
  const trackers = [...extraTrackers, ...DEFAULT_TRACKERS];
  let out = `magnet:?xt=urn:btih:${infoHash.toLowerCase()}&dn=${encodeURIComponent(name)}`;
  for (const t of trackers) out += `&tr=${encodeURIComponent(t)}`;
  return out;
}
