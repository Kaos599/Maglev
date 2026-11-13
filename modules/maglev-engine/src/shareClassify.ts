/**
 * Pure classification of what the user shared into Maglev (docs/contracts-0.19/quick-share.md section 3).
 * The Kotlin twin is android/.../share/ShareClassify.kt. Both are tested against shareClassify.fixture.json.
 * Keep the two in step: same regexes, same order, same extension list.
 */

export type ShareKind = 'magnet' | 'torrent_file' | 'file_link' | 'web_page' | 'none';

export interface ShareClass {
  kind: ShareKind;
  /** The magnet, link or file URI to hand on, or null for `none`. */
  source: string | null;
  /** A name the source itself carries (`dn`, a file name). Null when it says nothing. */
  name: string | null;
  /** 40 character lower case hex for a magnet, else null. */
  infoHash: string | null;
}

const MAGNET = /magnet:\?[^\s"'<>]+/i;
const TORRENT_URL = /https?:\/\/[^\s"'<>]+\.torrent(?:\?[^\s"'<>]*)?/i;
const WEB_URL = /https?:\/\/[^\s"'<>]+/i;
const LOCAL_URI = /^(?:content|file):\/\/[^\s"'<>]+/i;
const TRAILING = /[.,;:!?)\]}]+$/;
const BTIH = /(?:^|[?&])xt=urn:btih:([a-z0-9]+)/i;
const TORRENT_MIME = /^application\/x-(?:bittorrent|torrent)$/;
const PAGE_MIME = /^(?:text\/html|application\/xhtml\+xml)$/;

/** Extensions that mean "this link is a file". Anything else is treated as a page. */
export const FILE_EXTENSIONS = [
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'xz', 'bz2', 'iso', 'img', 'dmg', 'exe', 'msi', 'apk', 'deb',
  'mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v', 'mp3', 'flac', 'wav', 'ogg', 'opus', 'm4a', 'aac',
  'pdf', 'epub', 'cbz', 'cbr',
] as const;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function base32ToHex(s: string): string | null {
  let bits = '';
  for (const ch of s.toUpperCase()) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 8 <= bits.length; i += 8) hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, '0');
  return hex.length === 40 ? hex : null;
}

function btihToHex(raw: string): string | null {
  if (/^[0-9a-f]{40}$/i.test(raw)) return raw.toLowerCase();
  if (raw.length === 32) return base32ToHex(raw);
  return null;
}

function magnetName(magnet: string): string | null {
  const q = magnet.slice(magnet.indexOf('?') + 1);
  for (const part of q.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).toLowerCase() !== 'dn') continue;
    const v = safeDecode(part.slice(eq + 1).replace(/\+/g, ' ')).trim();
    return v || null;
  }
  return null;
}

/** The last path segment, decoded, without query or fragment. */
function lastSegment(uri: string): string {
  const noQuery = uri.split(/[?#]/)[0];
  const afterScheme = noQuery.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = afterScheme.lastIndexOf('/');
  if (slash < 0) return '';
  return safeDecode(afterScheme.slice(slash + 1));
}

function extensionOf(segment: string): string {
  const dot = segment.lastIndexOf('.');
  return dot < 0 ? '' : segment.slice(dot + 1).toLowerCase();
}

function none(): ShareClass {
  return { kind: 'none', source: null, name: null, infoHash: null };
}

/**
 * @param text what was shared (text, magnet, link, or a file URI as a string)
 * @param mime the type the sender declared, or null
 */
export function classifyShare(text: string | null | undefined, mime?: string | null): ShareClass {
  const t = (text ?? '').trim();
  if (!t) return none();
  const type = (mime ?? '').split(';')[0].trim().toLowerCase();

  const magnet = MAGNET.exec(t)?.[0];
  if (magnet) {
    const raw = BTIH.exec(magnet.slice(magnet.indexOf('?')))?.[1];
    const hash = raw ? btihToHex(raw) : null;
    if (hash) return { kind: 'magnet', source: magnet, name: magnetName(magnet), infoHash: hash };
  }

  const torrentUrl = TORRENT_URL.exec(t)?.[0];
  if (torrentUrl) {
    const source = torrentUrl.replace(TRAILING, '');
    const name = lastSegment(source).replace(/\.torrent$/i, '') || null;
    return { kind: 'torrent_file', source, name, infoHash: null };
  }

  const local = LOCAL_URI.exec(t)?.[0];
  if (local && t.startsWith(local)) {
    const seg = lastSegment(local);
    if (/\.torrent$/i.test(local.split(/[?#]/)[0]) || TORRENT_MIME.test(type)) {
      const name = /\.torrent$/i.test(seg) ? seg.replace(/\.torrent$/i, '') : null;
      return { kind: 'torrent_file', source: local, name, infoHash: null };
    }
    return none();
  }

  const url = WEB_URL.exec(t)?.[0]?.replace(TRAILING, '');
  if (!url) return none();
  if (TORRENT_MIME.test(type)) return { kind: 'torrent_file', source: url, name: null, infoHash: null };
  if (PAGE_MIME.test(type)) return { kind: 'web_page', source: url, name: null, infoHash: null };
  const seg = lastSegment(url);
  const known = (FILE_EXTENSIONS as readonly string[]).includes(extensionOf(seg));
  if (/^(?:application|video|audio)\//.test(type)) return { kind: 'file_link', source: url, name: known ? seg : null, infoHash: null };
  if (known) return { kind: 'file_link', source: url, name: seg, infoHash: null };
  return { kind: 'web_page', source: url, name: null, infoHash: null };
}
