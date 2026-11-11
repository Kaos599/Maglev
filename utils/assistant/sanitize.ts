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
const BARE_URL_RE = /\b(?:https?|ftp):\/\/\S*|\bwww\.\S+|\b(?:magnet|data|javascript|file|content|intent):\S*/gi;

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
  s = s.normalize('NFC');
  s = s.replace(/[\t\n\r]/g, ' ');
  s = s.replace(INVISIBLE_RE, '');
  s = s.replace(CONTROL_RE, '');
  s = s.replace(MARKDOWN_LINK_RE, (_m, label: string) => (label.trim() ? label : LINK_PLACEHOLDER));
  s = s.replace(BARE_URL_RE, LINK_PLACEHOLDER);
  for (const re of ROLE_MARKER_RES) s = s.replace(re, '?');
  s = s.replace(ROLE_PREFIX_RE, (_m, lead: string) => `${lead}?`);
  s = s.replace(/\s+/gu, ' ').trim();
  return truncate(s, maxLen);
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
    .normalize('NFC')
    .replace(INVISIBLE_RE, '')
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
