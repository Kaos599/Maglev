/**
 * Device glue for backup and restore: files, the engine and the stores. The logic lives in
 * format.ts, export.ts, import.ts and migrate.ts (pure, tested under node).
 *
 * Save: expo-file-system `Directory.pickDirectoryAsync()` (system folder picker), `createFile`, `write`.
 * Read: expo-document-picker `getDocumentAsync` (copies to cache), then `File.text()`.
 * Docs: https://docs.expo.dev/versions/latest/sdk/filesystem/ and https://docs.expo.dev/versions/latest/sdk/document-picker/
 */
import Constants from 'expo-constants';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File } from 'expo-file-system';
import { maglevEngine, settingsStore } from 'maglev-engine';
import { kvGet, kvSet } from '../prefs/kv';
import { normalizeSearchPrefs, updateSearchPrefs } from '../prefs/search';
import { importBookmarks } from '../browser/bookmarks';
import { normalizeBrowserPrefs, updateBrowserPrefs } from '../prefs/browser';
import { updateSchedule, syncScheduleToNative } from '../prefs/schedule';
import { updateFeedAutomation, syncFeedAutomationToNative } from '../prefs/feedAutomation';
import { assistantPrefs } from '../prefs/assistantApp';
import { normalizeAssistantPrefs } from '../prefs/assistant';
import { loadFeeds, refreshFeedsNewCountFromStorage, saveFeeds } from '../feeds';
import { setTabPrefs } from '../../components/tabs/tabPrefsStore';
import { getStatsStore } from '../stats';
import { buildStatsSection } from '../stats/backup';
import { backupFileName, buildBackup, serializeBackup } from './export';
import { parseBackup, type ParseResult } from './migrate';
import { restoreBackup, type RestoreResult } from './import';
import { PREF_KEYS, isPlainObject, type Backup, type BackupPart, type PrefKey, type RestorePart } from './format';

const LAST_BACKUP_KEY = 'maglev.backup.lastAt.v1';

export function getLastBackupAt(): number {
  const n = Number(kvGet(LAST_BACKUP_KEY));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readPref(key: PrefKey): unknown {
  try {
    const raw = kvGet(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

async function collectBackup(opts: { includeStats?: boolean } = {}): Promise<Backup> {
  const list = await maglevEngine.listTorrents();
  const torrents = list.ok ? list.torrents : [];
  const downloads = list.ok ? (list.downloads ?? []) : [];
  let stats = null;
  if (opts.includeStats) {
    try {
      stats = buildStatsSection(await (await getStatsStore()).exportSection());
    } catch {
      stats = null;
    }
  }
  return buildBackup({
    stats,
    appVersion: Constants.expoConfig?.version ?? '',
    now: () => Date.now(),
    settings: settingsStore.getSettings(),
    readPref,
    torrents,
    downloads,
    torrentData: async (id) => {
      const d = await maglevEngine.getDetail(id);
      if (!d.ok) return null;
      return {
        trackers: d.trackers.map((t) => t.url),
        files: d.files.map((f) => ({ index: f.index, included: f.included })),
      };
    },
  });
}

export type SaveOutcome = { ok: true; fileName: string; count: number } | { cancelled: true } | { ok: false };

/** Builds the backup and writes it to a folder the user picks. */
export async function exportBackup(opts: { includeStats?: boolean } = {}): Promise<SaveOutcome> {
  let dir: Directory;
  try {
    dir = await Directory.pickDirectoryAsync();
  } catch {
    // The picker rejects when the user backs out.
    return { cancelled: true };
  }
  try {
    const backup = await collectBackup(opts);
    const fileName = backupFileName(Date.now());
    const file = dir.createFile(fileName, 'application/json');
    await file.write(serializeBackup(backup));
    kvSet(LAST_BACKUP_KEY, String(Date.now()));
    return { ok: true, fileName, count: backup.torrents.length + backup.downloads.length };
  } catch {
    return { ok: false };
  }
}

export type ReadOutcome = { ok: true; result: ParseResult } | { cancelled: true } | { ok: false };

/** Lets the user pick a backup file and reads it. */
export async function pickBackup(): Promise<ReadOutcome> {
  try {
    const res = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'application/octet-stream', '*/*'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.length) return { cancelled: true };
    const text = await new File(res.assets[0].uri).text();
    return { ok: true, result: parseBackup(text) };
  } catch {
    return { ok: false };
  }
}

/** Hands one pref to the store that owns it, so it is normalised and the screens update. */
export function applyPref(key: PrefKey, value: unknown): void {
  switch (key) {
    case PREF_KEYS.search: {
      const { clearances: _c, needsCheck: _n, recents: _r, fixHintDismissedAt: _f, ...rest } = normalizeSearchPrefs(value, []);
      updateSearchPrefs(rest);
      return;
    }
    case PREF_KEYS.feeds:
      if (Array.isArray(value)) {
        saveFeeds(value.filter((f) => isPlainObject(f) && typeof f.id === 'string' && typeof f.url === 'string' && typeof f.name === 'string') as ReturnType<typeof loadFeeds>);
        refreshFeedsNewCountFromStorage();
      }
      return;
    case PREF_KEYS.feedAutomation:
      if (isPlainObject(value)) updateFeedAutomation(value);
      return;
    case PREF_KEYS.schedule:
      if (isPlainObject(value)) updateSchedule(value);
      return;
    case PREF_KEYS.tabs:
      setTabPrefs(value as never);
      return;
    case PREF_KEYS.browser:
      updateBrowserPrefs(normalizeBrowserPrefs(value));
      return;
    case PREF_KEYS.bookmarks:
      // Merged, not replaced: what is on this phone stays, and the same page is never saved twice.
      importBookmarks(value);
      return;
    case PREF_KEYS.assistant: {
      const n = normalizeAssistantPrefs(value);
      // The key never travels in a backup: keep this phone's key only while the provider is the same.
      assistantPrefs.update((cur) => ({
        presetId: n.presetId,
        baseUrl: n.baseUrl,
        model: n.model,
        modelName: n.modelName,
        enabled: n.enabled,
        warningAcceptedAt: n.warningAcceptedAt,
        capabilitiesSeenAt: n.capabilitiesSeenAt,
        keyRef: cur.presetId === n.presetId ? cur.keyRef : null,
      }));
      return;
    }
  }
}

function folderExists(path: string): boolean {
  try {
    return new Directory(path.startsWith('file://') ? path : `file://${path}`).exists;
  } catch {
    return false;
  }
}

/** Applies the chosen parts to this phone. */
export async function applyBackup(backup: Backup, parts: ReadonlySet<RestorePart>): Promise<RestoreResult> {
  const list = await maglevEngine.listTorrents();
  const existingHashes = new Set((list.ok ? list.torrents : []).map((t) => t.id.toLowerCase()));
  const existingUrls = (list.ok ? (list.downloads ?? []) : []).map((d) => d.urlDisplay);
  return restoreBackup(backup, parts, {
    engine: maglevEngine,
    folderExists,
    existingHashes,
    existingUrls,
    currentSettings: settingsStore.getSettings(),
    applySettings: (s) => {
      settingsStore.updateSettings(s);
    },
    applyPref,
    applyStats: async (section) => (await getStatsStore()).importSection(section),
    syncNative: async () => {
      await syncScheduleToNative();
      await syncFeedAutomationToNative();
    },
  });
}
