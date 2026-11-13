/**
 * Backup file format (docs/contracts-0.19/backup.md). Pure TypeScript, no React or expo imports,
 * so node tests run it directly.
 */
import type { MaglevSettings } from '../../modules/maglev-engine/src/MaglevSettings.types.ts';

export const BACKUP_FORMAT = 'maglev-backup';
export const BACKUP_VERSION = 1;
export const BACKUP_EXTENSION = '.maglev-backup.json';

/** The kv keys a backup carries, and which restore part each belongs to. */
export const PREF_KEYS = {
  search: 'maglev.search.prefs.v2',
  feeds: 'maglev.feeds.list.v1',
  feedAutomation: 'maglev.feeds.automation.v1',
  schedule: 'maglev.schedule.v1',
  tabs: 'maglev.tabs.prefs.v1',
  browser: 'maglev.browser.prefs.v1',
  assistant: 'maglev.assistant.prefs.v1',
} as const;
export type PrefKey = (typeof PREF_KEYS)[keyof typeof PREF_KEYS];
export const PREF_KEY_LIST: readonly PrefKey[] = Object.values(PREF_KEYS);

export type BackupPart = 'settings' | 'search' | 'feeds' | 'schedule' | 'assistant' | 'torrents' | 'downloads';
export const BACKUP_PARTS: readonly BackupPart[] = ['settings', 'search', 'feeds', 'schedule', 'assistant', 'torrents', 'downloads'];

/** Which prefs belong to which part. `settings` also covers tab and browser prefs. */
export const PART_PREFS: Record<Exclude<BackupPart, 'torrents' | 'downloads'>, readonly PrefKey[]> = {
  settings: [PREF_KEYS.tabs, PREF_KEYS.browser],
  search: [PREF_KEYS.search],
  feeds: [PREF_KEYS.feeds, PREF_KEYS.feedAutomation],
  schedule: [PREF_KEYS.schedule],
  assistant: [PREF_KEYS.assistant],
};

export interface BackupTorrent {
  magnet: string;
  /** 40-char lowercase hex. */
  infoHash: string;
  name: string;
  /** Absolute path the files were saved to on the phone that made the backup, or null. */
  folder: string | null;
  /** Included file indices, or null when every file is included. */
  onlyFiles: number[] | null;
  paused: boolean;
  state: string;
  addedAt: number;
}

export interface BackupDownload {
  url: string;
  name: string;
  folder: string | null;
  paused: boolean;
  state: string;
  addedAt: number;
}

export interface Backup {
  format: typeof BACKUP_FORMAT;
  v: number;
  app: string;
  created: number;
  settings: MaglevSettings | null;
  prefs: Partial<Record<PrefKey, unknown>>;
  torrents: BackupTorrent[];
  downloads: BackupDownload[];
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---- Secrets -------------------------------------------------------------------------------

/** A field with a name like this is dropped at any depth. */
const SECRET_NAME = /(api[-_]?key|apikey|token|secret|passw(or)?d|authorization|cookie|credential|keyref)/i;
/** Query parameters with a name like this are removed from a URL. */
const SECRET_PARAM = /^(api[-_]?key|apikey|key|token|access[-_]?token|auth|secret|passw(or)?d|pass|sig|signature|passkey|pid)$/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Removes a user name, a password and secret-looking query parameters from a URL. Not a URL: returned as is. */
export function scrubUrl(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(url.trim());
  if (!m) return url;
  const host = m[2].includes('@') ? m[2].slice(m[2].lastIndexOf('@') + 1) : m[2];
  let query = '';
  if (m[4]) {
    const kept = m[4]
      .slice(1)
      .split('&')
      .filter((pair) => pair && !SECRET_PARAM.test(decodeSafe(pair.split('=')[0])));
    query = kept.length ? `?${kept.join('&')}` : '';
  }
  return `${m[1]}${host}${m[3]}${query}${m[5] ?? ''}`;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Deep copy without any field named like a secret. Strings that are URLs under a `url` key are scrubbed too. */
export function scrubSecrets<T>(value: T, key = ''): T {
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v, key)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      if (isSecretName(k)) continue;
      out[k] = scrubSecrets(value[k], k);
    }
    return out as T;
  }
  if (typeof value === 'string' && /^url$/i.test(key)) return scrubUrl(value) as unknown as T;
  return value;
}

// ---- Device-bound settings -----------------------------------------------------------------

/**
 * Values that only make sense on the phone that wrote them. They are removed on export, and on import the
 * current phone's values win. Also drops the proxy login.
 */
export function stripDeviceBound(settings: MaglevSettings): MaglevSettings {
  const s = JSON.parse(JSON.stringify(settings)) as MaglevSettings;
  s.downloadFolder = null;
  const storage = s.storage as unknown as Record<string, unknown>;
  delete storage.customSafUri;
  delete storage.customSafPath;
  const net = s.network as unknown as Record<string, unknown>;
  delete net.ipFilterPath;
  delete net.currentSsid;
  delete net.mappedPort;
  const proxy = net.proxy as Record<string, unknown> | undefined;
  if (proxy) {
    delete proxy.username;
    delete proxy.password;
  }
  return s;
}

/** The imported settings with the current phone's device-bound values put back. */
export function mergeDeviceBound(imported: MaglevSettings, current: MaglevSettings): MaglevSettings {
  const out = JSON.parse(JSON.stringify(imported)) as MaglevSettings;
  out.downloadFolder = current.downloadFolder;
  const o = out as unknown as Record<string, Record<string, unknown>>;
  const c = current as unknown as Record<string, Record<string, unknown>>;
  for (const k of ['customSafUri', 'customSafPath']) {
    if (c.storage[k] === undefined) delete o.storage[k];
    else o.storage[k] = c.storage[k];
  }
  for (const k of ['ipFilterPath', 'currentSsid', 'mappedPort', 'ipFilterEnabled', 'ipFilterRulesCount', 'networkType', 'portForwardingStatus']) {
    if (c.network[k] === undefined) delete o.network[k];
    else o.network[k] = c.network[k];
  }
  const proxy = o.network.proxy as Record<string, unknown>;
  const curProxy = (c.network.proxy ?? {}) as Record<string, unknown>;
  for (const k of ['username', 'password']) {
    if (curProxy[k] === undefined) delete proxy[k];
    else proxy[k] = curProxy[k];
  }
  for (const k of ['isCharging', 'batteryPercentage']) o.power[k] = c.power[k];
  out.onboarded = current.onboarded;
  return out;
}

// ---- Magnet --------------------------------------------------------------------------------

/** `magnet:?xt=urn:btih:<hash>&dn=<name>&tr=<tracker>...`. */
export function buildMagnet(infoHash: string, name: string, trackers: readonly string[]): string {
  let uri = `magnet:?xt=urn:btih:${infoHash.toLowerCase()}`;
  if (name) uri += `&dn=${encodeURIComponent(name)}`;
  const seen = new Set<string>();
  for (const t of trackers) {
    if (!t || seen.has(t)) continue;
    seen.add(t);
    uri += `&tr=${encodeURIComponent(t)}`;
  }
  return uri;
}

// ---- Preview -------------------------------------------------------------------------------

export interface BackupPreview {
  torrents: number;
  downloads: number;
  hasSettings: boolean;
  searchSources: number;
  feeds: number;
  hasSchedule: boolean;
  hasAssistant: boolean;
  created: number;
}

export function previewCounts(b: Backup): BackupPreview {
  const search = b.prefs[PREF_KEYS.search];
  let sources = 0;
  if (isPlainObject(search)) {
    const enabled = Array.isArray(search.enabled) ? search.enabled.length : 0;
    const own = Array.isArray(search.torznab) ? search.torznab.length : 0;
    // A custom source is also listed in `enabled` as `torznab:<id>` when it is on; count each source once.
    const ids = new Set<string>(Array.isArray(search.enabled) ? search.enabled.filter((x): x is string => typeof x === 'string') : []);
    if (Array.isArray(search.torznab)) {
      for (const t of search.torznab) if (isPlainObject(t) && typeof t.id === 'string') ids.add(`torznab:${t.id}`);
    }
    sources = ids.size || enabled + own;
  }
  const feeds = b.prefs[PREF_KEYS.feeds];
  return {
    torrents: b.torrents.length,
    downloads: b.downloads.length,
    hasSettings: b.settings !== null,
    searchSources: sources,
    feeds: Array.isArray(feeds) ? feeds.length : 0,
    hasSchedule: b.prefs[PREF_KEYS.schedule] !== undefined,
    hasAssistant: b.prefs[PREF_KEYS.assistant] !== undefined,
    created: b.created,
  };
}

/** "This backup has 12 torrents, 3 downloads, your settings and 28 search sources." */
export function previewSentence(p: BackupPreview): string {
  const parts: string[] = [];
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  if (p.torrents) parts.push(n(p.torrents, 'torrent', 'torrents'));
  if (p.downloads) parts.push(n(p.downloads, 'download', 'downloads'));
  if (p.hasSettings) parts.push('your settings');
  if (p.searchSources) parts.push(n(p.searchSources, 'search source', 'search sources'));
  if (p.feeds) parts.push(n(p.feeds, 'feed', 'feeds'));
  if (parts.length === 0) return 'This backup is empty.';
  const last = parts.pop() as string;
  return `This backup has ${parts.length ? `${parts.join(', ')} and ${last}` : last}.`;
}
