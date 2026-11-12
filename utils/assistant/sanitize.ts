// Sanitiser for every string that leaves the app towards the model (SM-31, ASSISTANT_DESIGN §4.1, §7.3).
// Torrent names, paths, tracker messages and provider text are written by strangers. This module
// makes them inert data: no control or invisible characters, no links, no role markers, bounded length.
// It reduces noise; it does not stop prompt injection. The defence is that the model has no tool that acts
// and that every action goes through a human-confirmed card (§7.3 layered controls).
// Pure TypeScript: no React, no React Native, no engine imports.

/** Cap for names, file names and paths (SM-31). */
export const NAME_MAX = 120;
/** Cap for the search query the model writes (§7.3 item 3). */
export const QUERY_MAX = 80;
/** Cap for free text such as tracker and provider messages. Not specified in the design; chosen here. */
export const MESSAGE_MAX = 300;
/** Cap for what the user types. Higher than MESSAGE_MAX so a pasted download link survives intact. */
export const USER_TEXT_MAX = 2000;

const ELLIPSIS = '…';
const LINK_PLACEHOLDER = '[link removed]';

// Invisible format characters: zero-width space/joiners, word joiner, BOM, soft hyphen, Mongolian vowel
// separator, bidi marks and overrides/isolates (LRM, RLM, ALM, LRE..PDF, LRI..PDI), and Unicode tag
// characters (U+E0000..U+E007F), which can hide ASCII text.
const INVISIBLE_RE =
  /[­؜᠎​-‏‪-‮⁠-⁯﻿\u{E0000}-\u{E007F}]/gu;

// C0 and C1 controls. Tab, LF, CR are handled earlier as whitespace.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const MARKDOWN_LINK_RE = /!?\[([^\]\n]{0,200})\]\(\s*[^)\s]*\s*\)/g;

// Everything Unicode marks as ignorable when rendering: Hangul fillers (U+3164, U+FFA0), the combining
// grapheme joiner (U+034F), variation selectors and more. NFKC turns some look-alikes into these, so strip after it.
const IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/gu;

function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, '').replace(IGNORABLE_RE, '').replace(CONTROL_RE, '');
}

// Link detection runs on a "folded" copy where look-alike letters from other scripts map to ASCII, one
// UTF-16 unit to one, so match offsets carry over to the original text. NFKC has already handled fullwidth.
const CONFUSABLES: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'һ': 'h',
  'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ɡ': 'g', 'ο': 'o', 'ν': 'v', 'ι': 'i', 'α': 'a', 'ρ': 'p', 'τ': 't', 'κ': 'k',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
  'І': 'I', 'Ѕ': 'S', 'Ј': 'J',
};
function fold(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) out += CONFUSABLES[s[i]] ?? s[i];
  return out;
}

// Suffix words that are also common title words (to, in, me, it, tv) are left out so "Back.To.The.Future" survives.
const TLDS =
  'com|net|org|info|biz|xyz|top|site|online|club|shop|store|click|link|live|icu|cc|ws|ru|su|cn|tk|ml|ga|cf|gq|pw|vip|app|dev|io|co|uk|de|fr|download|stream|pro|work|cyou|rest|fun|win|bid|loan';
const LN = '\\p{L}\\p{N}';
const DOT_OBF = '(?:\\[\\.\\]|\\(\\.\\)|\\{\\.\\}|\\[dot\\]|\\(dot\\))';
const BARE_DOMAIN_RE = new RegExp(`(?<![${LN}_-])(?:[${LN}](?:[${LN}-]*[${LN}])?\\.)+(?:${TLDS})(?![${LN}_-])(?![.-][${LN}])(?::\\d{1,5})?(?:[/?#]\\S*)?`, 'giu');
const LINK_RES: RegExp[] = [
  // Real and defanged schemes: http(s), hxxp(s), hxxps[:]//, ftp.
  /\b(?:h(?:tt|xx)ps?|ftp|sftp)(?:\[:\]|:)\s?\/\/\S*/gi,
  /\bwww\.\S+/gi,
  /\b(?:magnet|data|javascript|vbscript|file|content|intent):\S*/gi,
  // Scheme-relative: //host/path at the start or after whitespace, a bracket or a quote.
  /(?<=^|[\s(\["'<])\/\/[^\s/]\S*/g,
  // Obfuscated dots: evil[.]example, evil(dot)example.
  new RegExp(`(?<![${LN}_-])[${LN}-]+(?:\\.[${LN}-]+)*${DOT_OBF}[${LN}-]+(?:(?:${DOT_OBF}|\\.)[${LN}-]+)*(?:[/?#]\\S*)?`, 'giu'),
  // Bare domain with a well-known suffix: evil.com, shop.evil.io/pay. Release names are spared (see isReleaseName).
  BARE_DOMAIN_RE,
  // Any suffix, but only with a path and only in lower case: evil.example/pay.
  /(?<![\p{L}\p{N}_-])(?:[\p{Ll}\p{N}-]+\.)+\p{Ll}{2,24}\/\S+/gu,
];

const RELEASE_LABEL_RE =
  /^(?:s\d{1,3}(?:e\d{1,3})?|e\d{2,3}|\d{3,4}p|\d{4}|x26[45]|h26[45]|hevc|web(?:-?dl|rip)?|blu-?ray|bdrip|brrip|hdtv|dvdrip|remux|aac|flac|ac3|dts|10bit)$/i;

// Suffixes that are also ordinary words or language tags. "Movie.Pro" and "Show.Ru" are names, not sites.
const AMBIGUOUS_TLDS: ReadonlySet<string> = new Set([
  'pro', 'ru', 'su', 'co', 'io', 'app', 'dev', 'uk', 'de', 'fr', 'cn', 'cc', 'ws', 'live', 'work', 'rest', 'fun',
  'win', 'bid', 'loan', 'vip', 'download', 'stream', 'top', 'link', 'club', 'store', 'shop', 'online', 'site',
]);

/** Two Capitalised labels with an ambiguous suffix ("Movie.Pro"). No scheme, www., path or port, so not a link. */
function isTitleCasePair(labels: string[]): boolean {
  return labels.length === 2 && /^\p{Lu}/u.test(labels[0]) && /^\p{Lu}/u.test(labels[1]) && AMBIGUOUS_TLDS.has(labels[1].toLowerCase());
}

/**
 * A dotted name that only looks like a domain because its last label is a common suffix ("Stranger.Things.S04.ru",
 * "Movie.2020.Pro"). Spared when it has more than three labels, or any label is a release token. A match with a
 * path, query or port is always a link, so callers only ask about bare matches.
 */
function isReleaseName(match: string): boolean {
  if (/[/?#:]/.test(match)) return false;
  const labels = match.split('.');
  if (isTitleCasePair(labels)) return true;
  if (labels.length > 3) return true;
  return labels.slice(0, -1).some((l) => RELEASE_LABEL_RE.test(l));
}

/** Replace every link-like span with a placeholder. Detection runs on the folded text, replacement on the original. */
function removeLinks(input: string): string {
  let s = input;
  for (const re of LINK_RES) {
    const folded = fold(s);
    re.lastIndex = 0;
    let out = '';
    let last = 0;
    for (let m = re.exec(folded); m; m = re.exec(folded)) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (re === BARE_DOMAIN_RE && isReleaseName(m[0])) continue;
      out += s.slice(last, m.index) + LINK_PLACEHOLDER;
      last = m.index + m[0].length;
    }
    s = out + s.slice(last);
  }
  return s;
}

const ROLE_MARKER_RES: RegExp[] = [
  /<\|[^|>\n]{0,40}\|>/g,
  /\[\/?INST\]/gi,
  /<<\/?SYS>>/gi,
  /<\/?(?:system|assistant|user|developer)>/gi,
];
const ROLE_PREFIX_RE = /(^|\s)(?:system|assistant|developer|user)\s*:/gi;

const INSTRUCTION_LIKE_RES: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,40}\b(?:instructions?|prompts?|rules?)\b/i,
  /\byou are now\b/i,
  /\bnew instructions?\b/i,
  /\b(?:system|developer)\s*(?::|prompt|message)/i,
  /\bpropose_[a-z_]+\b/i,
  /\b(?:run|call|execute)\s+(?:the\s+)?(?:tool|function)\b/i,
];

/**
 * Turn any value into safe, short, single-line text.
 * Order: text conversion, NFC, tabs and line breaks to spaces, invisibles and controls removed,
 * links replaced, role markers replaced, whitespace collapsed, then truncated by code point.
 */
export function sanitizeText(input: unknown, maxLen: number = NAME_MAX): string {
  let s = input === null || input === undefined ? '' : String(input);
  s = s.normalize('NFKC');
  s = s.replace(/[\t\n\r]/g, ' ');
  s = stripInvisible(s);
  s = s.replace(MARKDOWN_LINK_RE, (_m, label: string) => (label.trim() ? label : LINK_PLACEHOLDER));
  s = removeLinks(s);
  for (const re of ROLE_MARKER_RES) s = s.replace(re, '?');
  s = s.replace(ROLE_PREFIX_RE, (_m, lead: string) => `${lead}?`);
  s = s.replace(/\s+/gu, ' ').trim();
  return truncate(s, maxLen);
}

/**
 * Output filter for model prose and card reasons. Keeps line breaks, drops every kind of link:
 * http(s), magnet, data, javascript, defanged and scheme-relative forms, and bare domains.
 * Markdown links keep their label. Normalises like sanitizeText so fullwidth and invisible-character tricks fail.
 */
export function filterModelOutput(text: unknown): string {
  let s = text === null || text === undefined ? '' : String(text);
  s = s.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  s = s.split('\n').map(stripInvisible).join('\n');
  s = s.replace(MARKDOWN_LINK_RE, (_m, label: string) => (label.trim() ? label : LINK_PLACEHOLDER));
  return removeLinks(s);
}

/** Truncate by code point (never splits a surrogate pair), keeping the result within maxLen. */
export function truncate(s: string, maxLen: number): string {
  if (!(maxLen >= 1)) return '';
  const chars = Array.from(s);
  if (chars.length <= maxLen) return s;
  if (maxLen === 1) return ELLIPSIS;
  return chars.slice(0, maxLen - 1).join('') + ELLIPSIS;
}

/** True when text reads like an instruction to the model. Used for logging and tests; the text is still data. */
export function looksLikeInstruction(input: unknown): boolean {
  const s = (input === null || input === undefined ? '' : String(input))
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .replace(IGNORABLE_RE, '')
    .replace(/\s+/gu, ' ');
  return INSTRUCTION_LIKE_RES.some((re) => re.test(s));
}

/** A labelled field for tool JSON: `{ name_untrusted: "..." }`. Never concatenate this into prose. */
export function untrustedField(
  key: string,
  value: unknown,
  maxLen: number = NAME_MAX,
): Record<string, string> {
  return { [`${key}_untrusted`]: sanitizeText(value, maxLen) };
}

const MAX_DEPTH = 16;

/** Deep-sanitise a JSON-like value: every string is sanitised, numbers, booleans and null pass through. */
export function sanitizeValue(value: unknown, maxLen: number = NAME_MAX, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === 'string') return sanitizeText(value, maxLen);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, maxLen, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sv = sanitizeValue(v, maxLen, depth + 1);
      if (sv !== undefined) out[k] = sv;
    }
    return out;
  }
  return null;
}

/**
 * Serialise a tool result as JSON with every string sanitised. Keys are ours and are left alone.
 * Result shape per §4.1: `{ok:true,data}` or `{ok:false,error:{code,message}}`.
 */
export function toToolJson(payload: unknown, maxLen: number = NAME_MAX): string {
  return JSON.stringify(sanitizeValue(payload, maxLen));
}
