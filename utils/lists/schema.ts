/**
 * The source list file (docs/NATIVE_CONTRACT.md section 31.1). Pure: no React Native imports, so Node tests run it.
 * A field that fails its check is dropped on its own; the rest of the file still applies. Only a wrong `schema`, a
 * missing `serial` or an unreadable file rejects the whole file.
 */

export const SCHEMA_VERSION = 1;
/** The file is capped at 256 KB (UTF-8 bytes). */
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_MIRRORS = 5;
export const NOTE_MAX_CHARS = 140;
export const REASON_MAX_CHARS = 140;
export const TRACKERS_MIN = 3;
export const TRACKERS_MAX = 40;
export const BLOCKLIST_URLS_MIN = 1;
export const BLOCKLIST_URLS_MAX = 5;

export interface SourceEntry {
  /** https only, at most 5. */
  mirrors?: string[];
  enabled?: boolean;
  /** Plain text, at most 140 characters, shown when the source is turned off. */
  note?: string;
  /** Replaces the built-in warning; `null` clears it. */
  unsafeReason?: string | null;
}

export interface SourcesFile {
  schema: 1;
  /** Only goes up (UTC `yyyymmddNN`). */
  serial: number;
  generatedAt: string;
  sources: Record<string, SourceEntry>;
  trackers?: string[];
  blocklistUrls?: string[];
}

export type RejectReason = 'schema' | 'size';
export type ParseResult = { ok: true; file: SourcesFile } | { ok: false; reason: RejectReason };

/** UTF-8 byte length without TextEncoder (Hermes builds differ). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Plain text: no markup characters and no control characters. */
function plainText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '' || t.length > max) return null;
  if (/[<>\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

/** `https://host/...` with no credentials and no spaces. */
export function isHttpsUrl(v: unknown): v is string {
  return typeof v === 'string' && /^https:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i.test(v);
}

/** udp, http, https and wss announce addresses. */
export function isAnnounceUrl(v: unknown): v is string {
  return typeof v === 'string' && /^(?:udp|https?|wss):\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i.test(v);
}

function urlList(v: unknown, ok: (s: unknown) => boolean, min: number, max: number): string[] | null {
  if (!Array.isArray(v) || v.length < min || v.length > max) return null;
  const out: string[] = [];
  for (const x of v) {
    if (!ok(x)) return null;
    if (!out.includes(x as string)) out.push(x as string);
  }
  return out.length >= min ? out : null;
}

function entryOf(raw: unknown): SourceEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const e: SourceEntry = {};
  const mirrors = urlList(o.mirrors, isHttpsUrl, 1, MAX_MIRRORS);
  if (mirrors) e.mirrors = mirrors;
  if (typeof o.enabled === 'boolean') e.enabled = o.enabled;
  const note = plainText(o.note, NOTE_MAX_CHARS);
  if (note) e.note = note;
  if (o.unsafeReason === null) e.unsafeReason = null;
  else {
    const reason = plainText(o.unsafeReason, REASON_MAX_CHARS);
    if (reason) e.unsafeReason = reason;
  }
  return e;
}

/**
 * Validates a parsed file. `known` limits `sources` to real provider ids (unknown ids are ignored); omit it to keep
 * every id (used when reading back a file this code already filtered).
 */
export function validateFile(raw: unknown, known?: ReadonlySet<string>): ParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'schema' };
  const o = raw as Record<string, unknown>;
  if (o.schema !== SCHEMA_VERSION) return { ok: false, reason: 'schema' };
  const serial = o.serial;
  if (typeof serial !== 'number' || !Number.isSafeInteger(serial) || serial <= 0) return { ok: false, reason: 'schema' };
  const file: SourcesFile = {
    schema: 1,
    serial,
    generatedAt: typeof o.generatedAt === 'string' && !Number.isNaN(Date.parse(o.generatedAt)) ? o.generatedAt : '',
    sources: {},
  };
  const src = o.sources;
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [id, v] of Object.entries(src as Record<string, unknown>)) {
      if (known && !known.has(id)) continue;
      const e = entryOf(v);
      if (e) file.sources[id] = e;
    }
  }
  const trackers = urlList(o.trackers, isAnnounceUrl, TRACKERS_MIN, TRACKERS_MAX);
  if (trackers) file.trackers = trackers;
  const blocklistUrls = urlList(o.blocklistUrls, isHttpsUrl, BLOCKLIST_URLS_MIN, BLOCKLIST_URLS_MAX);
  if (blocklistUrls) file.blocklistUrls = blocklistUrls;
  return { ok: true, file };
}

/** Text of the file to a validated file, or why it was rejected. */
export function parseSourcesFile(body: string, known?: ReadonlySet<string>): ParseResult {
  if (utf8Length(body) > MAX_FILE_BYTES) return { ok: false, reason: 'size' };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'schema' };
  }
  return validateFile(json, known);
}
