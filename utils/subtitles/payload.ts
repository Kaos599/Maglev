/**
 * Choosing the zip member, decoding the text to UTF-8 and finding the format (docs/NATIVE_CONTRACT.md section 36.7).
 * Pure: the zip is already unzipped (native `unzipSubtitles`), so this takes `{name, bytes}` members.
 * Hermes' TextDecoder only covers UTF-8 and isn't reliable, so UTF-8 and UTF-16 are decoded here by hand, and the
 * single-byte code pages are spelled out as tables (cp1251 comes from utils/search/charset.ts).
 */
import { decodeWindows1251 } from '../search/charset.ts';
import { baseLanguage } from './languages.ts';
import { parseName, parseRelease, stripName } from './parseName.ts';
import type { SubFormat } from './types.ts';

export type SubtitleErrorCode =
  | 'offline'
  | 'timeout'
  | 'error'
  | 'limit'
  | 'challenge'
  | 'nothing'
  | 'missing'
  | 'CANT_WRITE'
  | 'NO_SPACE'
  | 'VERIFY_FAILED'
  | 'NAME_TAKEN'
  | 'REPLACE_DENIED'
  | 'unsupported_archive'
  | 'unreadable_text'
  | 'ambiguous_pack';

export class SubtitleError extends Error {
  code: SubtitleErrorCode;
  constructor(code: SubtitleErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SubtitleError';
    this.code = code;
  }
}

export interface ZipMember {
  name: string;
  bytes: Uint8Array;
}

export const SUBTITLE_EXT = /\.(srt|ass|ssa|vtt)$/i;

// ---------------------------------------------------------------- zip member choice

export interface MemberWanted {
  /** The video's file name. */
  fileName: string;
  season?: number;
  episode?: number;
  absoluteEpisode?: number;
}

export type MemberChoice = { ok: true; member: ZipMember } | { ok: false; code: 'ambiguous_pack' | 'unsupported_archive' };

const base = (n: string) => n.replace(/^.*[\\/]/, '');
const words = (s: string) => new Set(stripName(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

/** 0..1: how alike two release names are (shared words, plus a bonus for the same group, source and resolution). */
export function releaseSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  let shared = 0;
  wa.forEach((w) => {
    if (wb.has(w)) shared++;
  });
  const union = wa.size + wb.size - shared;
  const jaccard = union === 0 ? 0 : shared / union;
  const ra = parseRelease(a);
  const rb = parseRelease(b);
  let bonus = 0;
  if (ra.group && ra.group === rb.group) bonus += 0.3;
  if (ra.source && ra.source === rb.source) bonus += 0.2;
  if (ra.resolution && ra.resolution === rb.resolution) bonus += 0.1;
  return jaccard + bonus;
}

function sameEpisode(name: string, w: MemberWanted): boolean {
  const p = parseName(name);
  if (w.episode !== undefined && p.episode !== undefined) {
    return p.episode === w.episode && (w.season === undefined || p.season === undefined || p.season === w.season);
  }
  if (w.absoluteEpisode !== undefined && p.absoluteEpisode !== undefined) return p.absoluteEpisode === w.absoluteEpisode;
  return false;
}

/**
 * Picks the member to save, in order: the same season and episode when known; the closest release name; the largest
 * member. When the members belong to several episodes and none can be told to be this one, nobody guesses: the
 * answer is `ambiguous_pack` ("This file has subtitles for several episodes and Maglev can't tell which one is yours.").
 */
export function pickZipMember(members: readonly ZipMember[], wanted: MemberWanted): MemberChoice {
  const subs = members.filter((m) => SUBTITLE_EXT.test(m.name) && !/(^|[\\/])(__macosx|\.)/i.test(m.name) && m.bytes.length > 0);
  if (subs.length === 0) return { ok: false, code: 'unsupported_archive' };
  if (subs.length === 1) {
    // One file: if it plainly names another episode, don't save it.
    const p = parseName(subs[0].name);
    const known = wanted.episode !== undefined || wanted.absoluteEpisode !== undefined;
    if (known && p.episodeConfidence === 'sure' && !sameEpisode(subs[0].name, wanted) && wanted.episode !== undefined) {
      return { ok: false, code: 'ambiguous_pack' };
    }
    return { ok: true, member: subs[0] };
  }

  let pool: ZipMember[] = subs;
  const known = wanted.episode !== undefined || wanted.absoluteEpisode !== undefined;
  const episodes = new Set<string>();
  for (const m of subs) {
    const p = parseName(base(m.name));
    if (p.episode !== undefined) episodes.add(`${p.season ?? ''}x${p.episode}`);
    else if (p.absoluteEpisode !== undefined) episodes.add(`a${p.absoluteEpisode}`);
  }
  const isPack = episodes.size > 1;
  if (known) {
    const same = subs.filter((m) => sameEpisode(base(m.name), wanted));
    if (same.length > 0) pool = same;
    else if (isPack) return { ok: false, code: 'ambiguous_pack' };
  } else if (isPack) {
    return { ok: false, code: 'ambiguous_pack' };
  }
  if (pool.length === 1) return { ok: true, member: pool[0] };

  let best: ZipMember[] = [];
  let top = -1;
  for (const m of pool) {
    const s = releaseSimilarity(wanted.fileName, base(m.name));
    if (s > top + 1e-9) {
      top = s;
      best = [m];
    } else if (Math.abs(s - top) <= 1e-9) best.push(m);
  }
  const largest = best.reduce((a, b) => (b.bytes.length > a.bytes.length ? b : a));
  return { ok: true, member: largest };
}

// ---------------------------------------------------------------- text decoding

const CP1250: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0083, 0x201e, 0x2026, 0x2020, 0x2021, 0x0088, 0x2030, 0x0160, 0x2039, 0x015a, 0x0164, 0x017d, 0x0179,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x0098, 0x2122, 0x0161, 0x203a, 0x015b, 0x0165, 0x017e, 0x017a,
  0x00a0, 0x02c7, 0x02d8, 0x0141, 0x00a4, 0x0104, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x015e, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x017b,
  0x00b0, 0x00b1, 0x02db, 0x0142, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00b8, 0x0105, 0x015f, 0x00bb, 0x013d, 0x02dd, 0x013e, 0x017c,
  0x0154, 0x00c1, 0x00c2, 0x0102, 0x00c4, 0x0139, 0x0106, 0x00c7, 0x010c, 0x00c9, 0x0118, 0x00cb, 0x011a, 0x00cd, 0x00ce, 0x010e,
  0x0110, 0x0143, 0x0147, 0x00d3, 0x00d4, 0x0150, 0x00d6, 0x00d7, 0x0158, 0x016e, 0x00da, 0x0170, 0x00dc, 0x00dd, 0x0162, 0x00df,
  0x0155, 0x00e1, 0x00e2, 0x0103, 0x00e4, 0x013a, 0x0107, 0x00e7, 0x010d, 0x00e9, 0x0119, 0x00eb, 0x011b, 0x00ed, 0x00ee, 0x010f,
  0x0111, 0x0144, 0x0148, 0x00f3, 0x00f4, 0x0151, 0x00f6, 0x00f7, 0x0159, 0x016f, 0x00fa, 0x0171, 0x00fc, 0x00fd, 0x0163, 0x02d9,
];

const CP1252: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
  0x00a0, 0x00a1, 0x00a2, 0x00a3, 0x00a4, 0x00a5, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x00aa, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x00af,
  0x00b0, 0x00b1, 0x00b2, 0x00b3, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00b8, 0x00b9, 0x00ba, 0x00bb, 0x00bc, 0x00bd, 0x00be, 0x00bf,
  0x00c0, 0x00c1, 0x00c2, 0x00c3, 0x00c4, 0x00c5, 0x00c6, 0x00c7, 0x00c8, 0x00c9, 0x00ca, 0x00cb, 0x00cc, 0x00cd, 0x00ce, 0x00cf,
  0x00d0, 0x00d1, 0x00d2, 0x00d3, 0x00d4, 0x00d5, 0x00d6, 0x00d7, 0x00d8, 0x00d9, 0x00da, 0x00db, 0x00dc, 0x00dd, 0x00de, 0x00df,
  0x00e0, 0x00e1, 0x00e2, 0x00e3, 0x00e4, 0x00e5, 0x00e6, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb, 0x00ec, 0x00ed, 0x00ee, 0x00ef,
  0x00f0, 0x00f1, 0x00f2, 0x00f3, 0x00f4, 0x00f5, 0x00f6, 0x00f7, 0x00f8, 0x00f9, 0x00fa, 0x00fb, 0x00fc, 0x00fd, 0x00fe, 0x00ff,
];

const CP1253: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x0088, 0x2030, 0x008a, 0x2039, 0x008c, 0x008d, 0x008e, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x0098, 0x2122, 0x009a, 0x203a, 0x009c, 0x009d, 0x009e, 0x009f,
  0x00a0, 0x0385, 0x0386, 0x00a3, 0x00a4, 0x00a5, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x00aa, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x2015,
  0x00b0, 0x00b1, 0x00b2, 0x00b3, 0x0384, 0x00b5, 0x00b6, 0x00b7, 0x0388, 0x0389, 0x038a, 0x00bb, 0x038c, 0x00bd, 0x038e, 0x038f,
  0x0390, 0x0391, 0x0392, 0x0393, 0x0394, 0x0395, 0x0396, 0x0397, 0x0398, 0x0399, 0x039a, 0x039b, 0x039c, 0x039d, 0x039e, 0x039f,
  0x03a0, 0x03a1, 0xfffd, 0x03a3, 0x03a4, 0x03a5, 0x03a6, 0x03a7, 0x03a8, 0x03a9, 0x03aa, 0x03ab, 0x03ac, 0x03ad, 0x03ae, 0x03af,
  0x03b0, 0x03b1, 0x03b2, 0x03b3, 0x03b4, 0x03b5, 0x03b6, 0x03b7, 0x03b8, 0x03b9, 0x03ba, 0x03bb, 0x03bc, 0x03bd, 0x03be, 0x03bf,
  0x03c0, 0x03c1, 0x03c2, 0x03c3, 0x03c4, 0x03c5, 0x03c6, 0x03c7, 0x03c8, 0x03c9, 0x03ca, 0x03cb, 0x03cc, 0x03cd, 0x03ce, 0xfffd,
];

const CP1254: readonly number[] = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x008e, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x009e, 0x0178,
  0x00a0, 0x00a1, 0x00a2, 0x00a3, 0x00a4, 0x00a5, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x00aa, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x00af,
  0x00b0, 0x00b1, 0x00b2, 0x00b3, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00b8, 0x00b9, 0x00ba, 0x00bb, 0x00bc, 0x00bd, 0x00be, 0x00bf,
  0x00c0, 0x00c1, 0x00c2, 0x00c3, 0x00c4, 0x00c5, 0x00c6, 0x00c7, 0x00c8, 0x00c9, 0x00ca, 0x00cb, 0x00cc, 0x00cd, 0x00ce, 0x00cf,
  0x011e, 0x00d1, 0x00d2, 0x00d3, 0x00d4, 0x00d5, 0x00d6, 0x00d7, 0x00d8, 0x00d9, 0x00da, 0x00db, 0x00dc, 0x0130, 0x015e, 0x00df,
  0x00e0, 0x00e1, 0x00e2, 0x00e3, 0x00e4, 0x00e5, 0x00e6, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb, 0x00ec, 0x00ed, 0x00ee, 0x00ef,
  0x011f, 0x00f1, 0x00f2, 0x00f3, 0x00f4, 0x00f5, 0x00f6, 0x00f7, 0x00f8, 0x00f9, 0x00fa, 0x00fb, 0x00fc, 0x0131, 0x015f, 0x00ff,
];

const CP1256: readonly number[] = [
  0x20ac, 0x067e, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0679, 0x2039, 0x0152, 0x0686, 0x0698, 0x0688,
  0x06af, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x06a9, 0x2122, 0x0691, 0x203a, 0x0153, 0x200c, 0x200d, 0x06ba,
  0x00a0, 0x060c, 0x00a2, 0x00a3, 0x00a4, 0x00a5, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x06be, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x00af,
  0x00b0, 0x00b1, 0x00b2, 0x00b3, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00b8, 0x00b9, 0x061b, 0x00bb, 0x00bc, 0x00bd, 0x00be, 0x061f,
  0x06c1, 0x0621, 0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0627, 0x0628, 0x0629, 0x062a, 0x062b, 0x062c, 0x062d, 0x062e, 0x062f,
  0x0630, 0x0631, 0x0632, 0x0633, 0x0634, 0x0635, 0x0636, 0x00d7, 0x0637, 0x0638, 0x0639, 0x063a, 0x0640, 0x0641, 0x0642, 0x0643,
  0x00e0, 0x0644, 0x00e2, 0x0645, 0x0646, 0x0647, 0x0648, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb, 0x0649, 0x064a, 0x00ee, 0x00ef,
  0x064b, 0x064c, 0x064d, 0x064e, 0x00f4, 0x064f, 0x0650, 0x00f7, 0x0651, 0x00f9, 0x0652, 0x00fb, 0x00fc, 0x200e, 0x200f, 0x06d2,
];


function fromCodes(codes: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < codes.length; i += 8192) parts.push(String.fromCharCode(...codes.slice(i, i + 8192)));
  return parts.join('');
}

function fromCodePoints(points: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < points.length; i += 8192) parts.push(String.fromCodePoint(...points.slice(i, i + 8192)));
  return parts.join('');
}

/** Strict UTF-8: null for any invalid, overlong or surrogate sequence. */
export function decodeUtf8Strict(bytes: Uint8Array, from = 0): string | null {
  const out: number[] = [];
  let i = from;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    if (b < 0x80) {
      out.push(b);
      i++;
      continue;
    }
    let need: number;
    let cp: number;
    let min: number;
    if (b >= 0xc2 && b <= 0xdf) [need, cp, min] = [1, b & 0x1f, 0x80];
    else if (b >= 0xe0 && b <= 0xef) [need, cp, min] = [2, b & 0x0f, 0x800];
    else if (b >= 0xf0 && b <= 0xf4) [need, cp, min] = [3, b & 0x07, 0x10000];
    else return null;
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out.push(cp);
    i += need + 1;
  }
  return fromCodePoints(out);
}

function decodeUtf16(bytes: Uint8Array, from: number, littleEndian: boolean): string {
  const codes: number[] = [];
  for (let i = from; i + 1 < bytes.length; i += 2) codes.push(littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
  return fromCodes(codes);
}

/** UTF-16 without a BOM: a Latin or Cyrillic subtitle has a zero in one byte of nearly every pair. */
function guessUtf16(bytes: Uint8Array): boolean | null {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 8) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) even++;
    if (bytes[i + 1] === 0) odd++;
  }
  const pairs = n / 2;
  if (odd / pairs > 0.3 && even / pairs < 0.05) return true; // little endian
  if (even / pairs > 0.3 && odd / pairs < 0.05) return false; // big endian
  return null;
}

function decodeTable(bytes: Uint8Array, table: readonly number[]): string {
  const codes: number[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    codes[i] = b < 0x80 ? b : table[b - 0x80];
  }
  return fromCodes(codes);
}

export type CodePage = 'cp1250' | 'cp1251' | 'cp1252' | 'cp1253' | 'cp1254' | 'cp1256';

const CP1250_LANGS = new Set(['cs', 'hu', 'pl', 'ro', 'sk', 'sl', 'hr', 'bs']);
const CP1251_LANGS = new Set(['ru', 'bg', 'uk', 'mk', 'be', 'kk']);
const CP1256_LANGS = new Set(['ar', 'fa', 'ur']);
/** Text in these languages that isn't Unicode is a multi-byte or other code page this version can't read (36.7). */
const UNREADABLE_LANGS = new Set(['zh', 'ja', 'ko', 'he', 'th', 'vi', 'lt', 'lv']);

function looksCyrillic(bytes: Uint8Array): boolean {
  let high = 0;
  let ascii = 0;
  for (let i = 0; i < Math.min(bytes.length, 8192); i++) {
    const b = bytes[i];
    if (b >= 0xc0) high++;
    else if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) ascii++;
  }
  return high > ascii * 0.5;
}

/** The single-byte code page for a language (36.7), or null when its legacy encodings aren't supported. */
export function codePageFor(language: string | undefined, bytes?: Uint8Array): CodePage | null {
  if (!language) return 'cp1252';
  const l = baseLanguage(language);
  if (UNREADABLE_LANGS.has(l)) return null;
  if (language === 'sr-Latn' || CP1250_LANGS.has(l)) return 'cp1250';
  if (language === 'sr-Cyrl' || CP1251_LANGS.has(l)) return 'cp1251';
  // Serbian without a script: Cyrillic text is mostly high bytes, Latin text only has a few.
  if (l === 'sr') return bytes && looksCyrillic(bytes) ? 'cp1251' : 'cp1250';
  if (l === 'el') return 'cp1253';
  if (l === 'tr') return 'cp1254';
  if (CP1256_LANGS.has(l)) return 'cp1256';
  return 'cp1252';
}

export type DecodeResult = { ok: true; text: string; encoding: string } | { ok: false; code: 'unreadable_text' };

/**
 * Subtitle bytes to text (no BOM). Order: a BOM (UTF-8, UTF-16 LE/BE), BOM-less UTF-16, valid UTF-8, then the single
 * byte code page for `language`.
 */
export function decodeSubtitleText(bytes: Uint8Array, language?: string): DecodeResult {
  const done = (text: string, encoding: string): DecodeResult => ({ ok: true, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, encoding });
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const t = decodeUtf8Strict(bytes, 3);
    return t === null ? { ok: false, code: 'unreadable_text' } : done(t, 'utf-8');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return done(decodeUtf16(bytes, 2, true), 'utf-16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return done(decodeUtf16(bytes, 2, false), 'utf-16be');
  const guess = guessUtf16(bytes);
  if (guess !== null) return done(decodeUtf16(bytes, 0, guess), guess ? 'utf-16le' : 'utf-16be');
  const utf8 = decodeUtf8Strict(bytes);
  if (utf8 !== null) return done(utf8, 'utf-8');
  const page = codePageFor(language, bytes);
  if (!page) return { ok: false, code: 'unreadable_text' };
  switch (page) {
    case 'cp1250':
      return done(decodeTable(bytes, CP1250), page);
    case 'cp1251':
      return done(decodeWindows1251(bytes), page);
    case 'cp1253':
      return done(decodeTable(bytes, CP1253), page);
    case 'cp1254':
      return done(decodeTable(bytes, CP1254), page);
    case 'cp1256':
      return done(decodeTable(bytes, CP1256), page);
    default:
      return done(decodeTable(bytes, CP1252), page);
  }
}

// ---------------------------------------------------------------- format

/**
 * Whether decoded text holds at least one subtitle cue: SRT/VTT a `-->` line between two timestamps, VTT's `WEBVTT`
 * header, ASS/SSA a `Dialogue:` line. A short message, JSON or a "limit reached" page has none. The formats the app
 * supports are srt, vtt, ass and ssa (no MicroDVD).
 */
// NATIVE_CONTRACT 39.1 S1
export function hasSubtitleCues(text: string): boolean {
  const t = text.replace(/^\uFEFF/, '');
  return /\d{1,2}:\d{2}(?::\d{2})?[,.:]\d{1,3}\s*-->\s*\d{1,2}:\d{2}/.test(t) || /^\s*WEBVTT/.test(t) || /^\s*Dialogue:/m.test(t);
}

/** From the content: `WEBVTT`; `[Script Info]` for ASS/SSA (`[V4 Styles]` without the plus is SSA); otherwise SRT. */
export function detectFormat(text: string): SubFormat {
  const head = text.replace(/^﻿/, '').trimStart();
  if (/^WEBVTT/.test(head)) return 'vtt';
  if (/^\[Script Info\]/i.test(head) || /^\s*\[Script Info\]/im.test(text.slice(0, 2048))) {
    return /^\[V4 Styles\]/im.test(text) && !/^\[V4\+ Styles\]/im.test(text) ? 'ssa' : 'ass';
  }
  return 'srt';
}

export interface PreparedText {
  text: string;
  format: SubFormat;
}

/** Bytes to UTF-8 text and its format. Throws SubtitleError('unreadable_text'). */
export function prepareText(bytes: Uint8Array, language?: string): PreparedText {
  const r = decodeSubtitleText(bytes, language);
  if (!r.ok) throw new SubtitleError('unreadable_text');
  return { text: r.text, format: detectFormat(r.text) };
}

// ---------------------------------------------------------------- bytes <-> text for the native calls

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out.push(B64[(n >> 18) & 63], B64[(n >> 12) & 63], i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=', i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out.join('');
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64_INDEX[s[i]] << 18) | (B64_INDEX[s[i + 1]] << 12) | ((B64_INDEX[s[i + 2]] ?? 0) << 6) | (B64_INDEX[s[i + 3]] ?? 0);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < s.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < s.length) out[o++] = n & 255;
  }
  return out;
}

/** Text to UTF-8 bytes without a BOM (Hermes' TextEncoder isn't guaranteed). */
function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

/** The text as the base64 of its UTF-8 bytes: what native `saveSubtitle` takes. */
export function textToBase64(text: string): string {
  return bytesToBase64(encodeUtf8(text));
}

export type ArchiveKind = 'zip' | 'rar' | '7z' | null;

/** By the first bytes: a provider may hand back an archive when it said text. */
export function archiveKind(bytes: Uint8Array): ArchiveKind {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5) && (bytes[3] === 4 || bytes[3] === 6)) return 'zip';
  if (bytes.length >= 6 && bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21) return 'rar';
  if (bytes.length >= 6 && bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf) return '7z';
  return null;
}
