/**
 * Builds the backup object from what the app already has. Pure: the engine and the stores are injected.
 */
import { SETTINGS_SCHEMA_VERSION, type MaglevSettings } from '../../modules/maglev-engine/src/MaglevSettings.types.ts';
import type { DownloadSnapshot, Snapshot } from '../../modules/maglev-engine/src/MaglevEngine.types.ts';
import {
  BACKUP_EXTENSION,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  PREF_KEY_LIST,
  PREF_KEYS,
  buildMagnet,
  isPlainObject,
  scrubSecrets,
  scrubUrl,
  stripDeviceBound,
  type Backup,
  type BackupDownload,
  type BackupTorrent,
  type PrefKey,
} from './format.ts';

export interface TorrentRestoreData {
  trackers: string[];
  files: { index: number; included: boolean }[];
}

export interface ExportDeps {
  appVersion: string;
  now: () => number;
  settings: MaglevSettings;
  /** The parsed kv value for a key, or undefined when nothing is stored. */
  readPref: (key: PrefKey) => unknown;
  torrents: Snapshot[];
  downloads: DownloadSnapshot[];
  /** Trackers and file selection for one torrent (from getDetail). Null when the engine can't say. */
  torrentData: (id: string) => Promise<TorrentRestoreData | null>;
}

/** The assistant prefs without anything that points at a key. The key itself lives in secure store and is never read. */
export function assistantForExport(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const { keyRef: _keyRef, tokensUsed: _tokensUsed, ...rest } = raw as Record<string, unknown>;
  return rest;
}

/** Search prefs without per-site check state, recents and cookies' bookkeeping. */
export function searchForExport(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const { clearances: _c, needsCheck: _n, recents: _r, fixHintDismissedAt: _f, ...rest } = raw as Record<string, unknown>;
  return rest;
}

export function torrentToBackup(s: Snapshot, data: TorrentRestoreData | null): BackupTorrent {
  const files = data?.files ?? [];
  const included = files.filter((f) => f.included).map((f) => f.index);
  const onlyFiles = files.length > 0 && included.length < files.length ? included.sort((a, b) => a - b) : null;
  return {
    magnet: buildMagnet(s.id, s.name, data?.trackers ?? []),
    infoHash: s.id.toLowerCase(),
    name: s.name,
    folder: s.outputFolder || null,
    onlyFiles,
    paused: s.pausedBy === 'user' || (s.state === 'PAUSED' && !s.pausedBy),
    state: s.state,
    addedAt: s.addedAt,
  };
}

/** A link download that can be asked for again. Null for one that needs a new link, or has no http(s) address. */
export function downloadToBackup(d: DownloadSnapshot): BackupDownload | null {
  if (d.state === 'needs_link') return null;
  if (!/^https?:\/\//i.test(d.urlDisplay)) return null;
  return {
    url: scrubUrl(d.urlDisplay),
    name: d.name,
    folder: d.folder || null,
    paused: d.pausedBy === 'user' || d.state === 'paused',
    state: d.state,
    addedAt: d.addedAt,
  };
}

export async function buildBackup(deps: ExportDeps): Promise<Backup> {
  const prefs: Backup['prefs'] = {};
  for (const key of PREF_KEY_LIST) {
    let value = deps.readPref(key);
    if (value === undefined || value === null) continue;
    if (key === PREF_KEYS.assistant) value = assistantForExport(value);
    if (key === PREF_KEYS.search) value = searchForExport(value);
    prefs[key] = scrubSecrets(value);
  }
  const torrents: BackupTorrent[] = [];
  for (const s of deps.torrents) {
    let data: TorrentRestoreData | null = null;
    try {
      data = await deps.torrentData(s.id);
    } catch {
      data = null;
    }
    torrents.push(torrentToBackup(s, data));
  }
  const downloads = deps.downloads.flatMap((d) => downloadToBackup(d) ?? []);
  return {
    format: BACKUP_FORMAT,
    v: BACKUP_VERSION,
    app: deps.appVersion,
    created: deps.now(),
    settings: scrubSecrets(stripDeviceBound(deps.settings)),
    prefs,
    torrents,
    downloads,
  };
}

/** The file as it is written: settings in the store's own `{ version, settings }` envelope. */
export function serializeBackup(b: Backup): string {
  return JSON.stringify({ ...b, settings: b.settings ? { version: SETTINGS_SCHEMA_VERSION, settings: b.settings } : null }, null, 2);
}

export function backupFileName(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `maglev-${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}${BACKUP_EXTENSION}`;
}
