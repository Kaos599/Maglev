/**
 * Restore: turns a parsed backup into changes. Pure: the engine, the stores and the file system are injected.
 * Settings and prefs replace what is there; torrents and downloads are only added, always paused.
 */
import type { MaglevSettings } from '../../modules/maglev-engine/src/MaglevSettings.types.ts';
import type { AddTorrentOptions, DownloadOptions, EngineResult } from '../../modules/maglev-engine/src/MaglevEngine.types.ts';
import {
  PART_PREFS,
  mergeDeviceBound,
  type Backup,
  type BackupDownload,
  type BackupPart,
  type BackupTorrent,
  type PrefKey,
} from './format.ts';

export interface ImportEngine {
  addTorrent(source: string, options: AddTorrentOptions): Promise<EngineResult<{ id: string; infoHash: string }>>;
  addDownload(url: string, options: DownloadOptions): Promise<EngineResult<{ id: string }>>;
  recheck(id: string): Promise<EngineResult>;
  resume(id: string): Promise<EngineResult>;
  resumeDownload(id: string): Promise<EngineResult>;
}

export interface ImportDeps {
  engine: ImportEngine;
  /** True when the folder exists and the app can use it on this phone. */
  folderExists: (path: string) => boolean | Promise<boolean>;
  /** Info hashes (lowercase) of torrents already in the engine. */
  existingHashes: ReadonlySet<string>;
  /** Link downloads already in the engine, as shown by the engine (`urlDisplay`). */
  existingUrls: readonly string[];
  currentSettings: MaglevSettings;
  applySettings: (settings: MaglevSettings) => void;
  /** Hands a pref to the store that owns it (it normalises and notifies). */
  applyPref: (key: PrefKey, value: unknown) => void;
  /** Pushes schedule and feed rules to the engine. */
  syncNative?: () => Promise<void>;
}

/** Same address, ignoring a trailing slash, the case of the host and any query or fragment. */
export function urlKey(url: string): string {
  const m = /^(https?):\/\/([^/?#]*)([^?#]*)/i.exec(url.trim());
  if (!m) return url.trim();
  const host = m[2].includes('@') ? m[2].slice(m[2].lastIndexOf('@') + 1) : m[2];
  const path = m[3].replace(/\/+$/, '');
  return `${m[1].toLowerCase()}://${host.toLowerCase()}${path}`;
}

export interface TorrentPlanItem {
  entry: BackupTorrent;
  /** The folder to use, or null for the default folder. */
  folder: string | null;
  usesDefaultFolder: boolean;
}

export interface Plan<T> {
  toAdd: T[];
  duplicates: number;
  /** Items whose saved folder is not on this phone. */
  defaultFolder: number;
}

async function resolveFolder(folder: string | null, exists: ImportDeps['folderExists']): Promise<{ folder: string | null; fellBack: boolean }> {
  if (!folder) return { folder: null, fellBack: false };
  let ok = false;
  try {
    ok = await exists(folder);
  } catch {
    ok = false;
  }
  return ok ? { folder, fellBack: false } : { folder: null, fellBack: true };
}

export async function planTorrents(
  torrents: readonly BackupTorrent[],
  existingHashes: ReadonlySet<string>,
  folderExists: ImportDeps['folderExists'],
): Promise<Plan<TorrentPlanItem>> {
  const plan: Plan<TorrentPlanItem> = { toAdd: [], duplicates: 0, defaultFolder: 0 };
  for (const entry of torrents) {
    if (existingHashes.has(entry.infoHash.toLowerCase())) {
      plan.duplicates++;
      continue;
    }
    const r = await resolveFolder(entry.folder, folderExists);
    if (r.fellBack) plan.defaultFolder++;
    plan.toAdd.push({ entry, folder: r.folder, usesDefaultFolder: r.folder === null });
  }
  return plan;
}

export async function planDownloads(
  downloads: readonly BackupDownload[],
  existingUrls: readonly string[],
  folderExists: ImportDeps['folderExists'],
): Promise<Plan<{ entry: BackupDownload; folder: string | null }>> {
  const have = new Set(existingUrls.map(urlKey));
  const plan: Plan<{ entry: BackupDownload; folder: string | null }> = { toAdd: [], duplicates: 0, defaultFolder: 0 };
  for (const entry of downloads) {
    const key = urlKey(entry.url);
    if (have.has(key)) {
      plan.duplicates++;
      continue;
    }
    have.add(key);
    const r = await resolveFolder(entry.folder, folderExists);
    if (r.fellBack) plan.defaultFolder++;
    plan.toAdd.push({ entry, folder: r.folder });
  }
  return plan;
}

export interface RestoreResult {
  settingsApplied: boolean;
  prefsApplied: PrefKey[];
  torrentsAdded: number;
  torrentsSkipped: number;
  torrentsFailed: number;
  downloadsAdded: number;
  downloadsSkipped: number;
  downloadsFailed: number;
  /** Items that went to the default folder because the saved one is not on this phone. */
  defaultFolderCount: number;
  /** Engine ids added by this restore: what "Start all" resumes. */
  addedTorrentIds: string[];
  addedDownloadIds: string[];
}

/** Applies the chosen parts. Never throws: a failed item is counted, not raised. */
export async function restoreBackup(backup: Backup, parts: ReadonlySet<BackupPart>, deps: ImportDeps): Promise<RestoreResult> {
  const result: RestoreResult = {
    settingsApplied: false,
    prefsApplied: [],
    torrentsAdded: 0,
    torrentsSkipped: 0,
    torrentsFailed: 0,
    downloadsAdded: 0,
    downloadsSkipped: 0,
    downloadsFailed: 0,
    defaultFolderCount: 0,
    addedTorrentIds: [],
    addedDownloadIds: [],
  };

  if (parts.has('settings') && backup.settings) {
    try {
      deps.applySettings(mergeDeviceBound(backup.settings, deps.currentSettings));
      result.settingsApplied = true;
    } catch {
      // settings stay as they were
    }
  }
  for (const part of ['settings', 'search', 'feeds', 'schedule', 'assistant'] as const) {
    if (!parts.has(part)) continue;
    for (const key of PART_PREFS[part]) {
      const value = backup.prefs[key];
      if (value === undefined) continue;
      try {
        deps.applyPref(key, value);
        result.prefsApplied.push(key);
      } catch {
        // that pref stays as it was
      }
    }
  }
  if (deps.syncNative && (parts.has('schedule') || parts.has('feeds'))) {
    try {
      await deps.syncNative();
    } catch {
      // the next change or app start pushes it
    }
  }

  if (parts.has('torrents')) {
    const plan = await planTorrents(backup.torrents, deps.existingHashes, deps.folderExists);
    result.torrentsSkipped = plan.duplicates;
    result.defaultFolderCount += plan.defaultFolder;
    for (const { entry, folder } of plan.toAdd) {
      const options: AddTorrentOptions = { paused: true, outputFolder: folder, onlyFiles: entry.onlyFiles };
      let res: EngineResult<{ id: string; infoHash: string }>;
      try {
        res = await deps.engine.addTorrent(entry.magnet, options);
      } catch {
        result.torrentsFailed++;
        continue;
      }
      if (res.ok) {
        result.torrentsAdded++;
        result.addedTorrentIds.push(res.id);
        // Files may already be at the saved folder: let the engine check them. Best effort.
        try {
          await deps.engine.recheck(res.id);
        } catch {
          // fine: it stays paused either way
        }
      } else if (res.code === 'DUPLICATE') {
        result.torrentsSkipped++;
      } else {
        result.torrentsFailed++;
      }
    }
  }

  if (parts.has('downloads')) {
    const plan = await planDownloads(backup.downloads, deps.existingUrls, deps.folderExists);
    result.downloadsSkipped = plan.duplicates;
    result.defaultFolderCount += plan.defaultFolder;
    for (const { entry, folder } of plan.toAdd) {
      const options: DownloadOptions = { name: entry.name || null, folder, paused: true };
      try {
        const res = await deps.engine.addDownload(entry.url, options);
        if (res.ok) {
          result.downloadsAdded++;
          result.addedDownloadIds.push(res.id);
        } else if (res.code === 'DUPLICATE') {
          result.downloadsSkipped++;
        } else {
          result.downloadsFailed++;
        }
      } catch {
        result.downloadsFailed++;
      }
    }
  }
  return result;
}

/** Resumes exactly what a restore added. Returns how many started. */
export async function startAdded(result: Pick<RestoreResult, 'addedTorrentIds' | 'addedDownloadIds'>, engine: Pick<ImportEngine, 'resume' | 'resumeDownload'>): Promise<number> {
  let started = 0;
  for (const id of result.addedTorrentIds) {
    try {
      const r = await engine.resume(id);
      if (r.ok) started++;
    } catch {
      // skip
    }
  }
  for (const id of result.addedDownloadIds) {
    try {
      const r = await engine.resumeDownload(id);
      if (r.ok) started++;
    } catch {
      // skip
    }
  }
  return started;
}
