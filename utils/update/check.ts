/**
 * Update check (docs/NATIVE_CONTRACT.md section 27.2 and 27.6). Pure: no React Native imports, so Node tests run it.
 * The request carries no token and nothing but the app version in its User-Agent.
 */

export const RELEASES_URL = 'https://api.github.com/repos/Kaos599/Maglev/releases/latest';
export const ISSUES_URL = 'https://github.com/Kaos599/Maglev/issues/new';
export const CHECK_TIMEOUT_MS = 15_000;
export const NOTES_MAX_CHARS = 4000;
/** versionCode % 10 per plugins/withAbiSplits.js. */
export const ABI_BY_DIGIT: Readonly<Record<number, Abi>> = { 4: 'arm64-v8a', 1: 'armeabi-v7a', 3: 'x86_64', 0: 'universal' };

export type Abi = 'arm64-v8a' | 'armeabi-v7a' | 'x86_64' | 'universal';

export interface UpdateInfo {
  /** "0.23" */
  version: string;
  /** "v0.23" */
  tag: string;
  /** Release notes, markdown, at most 4,000 characters. */
  notes: string;
  pageUrl: string;
  apkUrl: string;
  /** 64 lowercase hex characters. */
  sha256: string;
  size: number;
}

export interface Installed {
  /** app.json version, "0.21". */
  version: string;
  /** The installed versionCode (base * 10 + ABI digit). */
  versionCode: number;
}

export class CheckError extends Error {
  readonly kind: 'network' | 'status' | 'parse';
  constructor(kind: 'network' | 'status' | 'parse', message: string) {
    super(message);
    this.kind = kind;
  }
}

/** `^v(\d+)\.(\d+)$`. Anything else, such as `v0.21-beta`, is ignored. */
export function parseTag(tag: unknown): { major: number; minor: number } | null {
  if (typeof tag !== 'string') return null;
  const m = /^v(\d+)\.(\d+)$/.exec(tag);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** app.json versions are `<major>.<minor>`. */
export function parseVersion(version: unknown): { major: number; minor: number } | null {
  if (typeof version !== 'string') return null;
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** True when (major, minor) of the tag is greater than the installed version. */
export function isNewer(tag: unknown, installedVersion: unknown): boolean {
  const t = parseTag(tag);
  const i = parseVersion(installedVersion);
  if (!t || !i) return false;
  return t.major > i.major || (t.major === i.major && t.minor > i.minor);
}

export function abiForVersionCode(versionCode: unknown): Abi | null {
  if (typeof versionCode !== 'number' || !Number.isInteger(versionCode) || versionCode < 0) return null;
  return ABI_BY_DIGIT[versionCode % 10] ?? null;
}

interface RawAsset {
  name?: unknown;
  browser_download_url?: unknown;
  digest?: unknown;
  size?: unknown;
}

/** The asset `Maglev-<tag>-<abi>.apk` with a `sha256:<64 hex>` digest, or null. */
export function chooseAsset(
  assets: unknown,
  tag: string,
  abi: Abi | null,
): { apkUrl: string; sha256: string; size: number } | null {
  if (!abi || !Array.isArray(assets)) return null;
  const wanted = `Maglev-${tag}-${abi}.apk`;
  const a = (assets as RawAsset[]).find((x) => x && x.name === wanted);
  if (!a || typeof a.browser_download_url !== 'string') return null;
  const d = typeof a.digest === 'string' ? /^sha256:([0-9a-fA-F]{64})$/.exec(a.digest) : null;
  if (!d) return null;
  const size = typeof a.size === 'number' && a.size > 0 ? a.size : 0;
  return { apkUrl: a.browser_download_url, sha256: d[1].toLowerCase(), size };
}

/** Release JSON to `UpdateInfo`, or null when it is not newer, not a plain tag, or has no usable asset for this phone. */
export function parseRelease(json: unknown, installed: Installed): UpdateInfo | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  const tag = r.tag_name;
  if (typeof tag !== 'string' || !parseTag(tag) || !isNewer(tag, installed.version)) return null;
  const asset = chooseAsset(r.assets, tag, abiForVersionCode(installed.versionCode));
  if (!asset) return null;
  const notes = typeof r.body === 'string' ? r.body.slice(0, NOTES_MAX_CHARS) : '';
  return {
    version: tag.slice(1),
    tag,
    notes,
    pageUrl: typeof r.html_url === 'string' ? r.html_url : `https://github.com/Kaos599/Maglev/releases/tag/${tag}`,
    apkUrl: asset.apkUrl,
    sha256: asset.sha256,
    size: asset.size,
  };
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal; credentials?: 'omit' | 'same-origin' | 'include' }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * GET /releases/latest. Throws [CheckError] on a network, status or parse failure; the caller shows only
 * "Couldn't check. Try again." and never the detail.
 */
export async function checkForUpdate(
  fetchImpl: FetchLike,
  installed: Installed,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<UpdateInfo | null> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    let res;
    try {
      res = await fetchImpl(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Maglev/${installed.version}` },
        signal: controller?.signal,
        // Never send the browser's github.com cookies (docs/NATIVE_CONTRACT.md section 30).
        credentials: 'omit',
      });
    } catch {
      throw new CheckError('network', 'request failed');
    }
    if (!res.ok) throw new CheckError('status', `status ${res.status}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new CheckError('parse', 'unreadable response');
    }
    return parseRelease(json, installed);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Release notes as plain text: markdown marks removed, trimmed, at most [max] characters. */
export function plainNotes(markdown: string, max = NOTES_MAX_CHARS): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/** The bug form with version and phone filled in (27.6). Every value is URL-encoded. */
export function buildIssueUrl(v: { version: string; android: string; device: string }): string {
  const q = [
    ['template', 'bug.yml'],
    ['version', v.version],
    ['android', v.android],
    ['device', v.device],
  ]
    .map(([k, val]) => `${k}=${encodeURIComponent(val)}`)
    .join('&');
  return `${ISSUES_URL}?${q}`;
}
