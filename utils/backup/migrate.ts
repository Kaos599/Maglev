/**
 * Reads a backup file: validates the shape and version, then runs every part through the same
 * normalisers the app uses for its own stored data. Pure TypeScript.
 */
import { migrateSettings } from '../../modules/maglev-engine/src/MaglevSettingsStore.ts';
import { normalizeInfoHash } from '../../modules/maglev-engine/src/magnet.ts';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  PREF_KEY_LIST,
  buildMagnet,
  isPlainObject,
  scrubSecrets,
  stripDeviceBound,
  type Backup,
  type BackupDownload,
  type BackupTorrent,
} from './format.ts';

export const MESSAGES = {
  notBackup: "That isn't a Maglev backup.",
  tooNew: 'This backup is from a newer Maglev. Update the app and try again.',
} as const;

export type ParseResult = { ok: true; backup: Backup } | { ok: false; reason: 'not_backup' | 'too_new'; message: string };

const fail = (reason: 'not_backup' | 'too_new'): ParseResult => ({
  ok: false,
  reason,
  message: reason === 'too_new' ? MESSAGES.tooNew : MESSAGES.notBackup,
});

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function folderOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function indicesOf(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.filter((i): i is number => Number.isInteger(i) && i >= 0))].sort((a, b) => a - b);
  return out.length ? out : null;
}

export function normalizeTorrent(raw: unknown): BackupTorrent | null {
  if (!isPlainObject(raw)) return null;
  const hash = normalizeInfoHash(str(raw.infoHash));
  if (!hash) return null;
  const name = str(raw.name);
  const trackers: string[] = [];
  // Trackers are read from the stored magnet, so the two can never disagree.
  const magnetIn = str(raw.magnet);
  if (magnetIn) {
    for (const pair of magnetIn.slice(magnetIn.indexOf('?') + 1).split('&')) {
      if (pair.toLowerCase().startsWith('tr=')) {
        try {
          trackers.push(decodeURIComponent(pair.slice(3).replace(/\+/g, ' ')));
        } catch {
          // skip a broken tracker
        }
      }
    }
  }
  return {
    magnet: buildMagnet(hash, name, trackers),
    infoHash: hash,
    name,
    folder: folderOf(raw.folder),
    onlyFiles: indicesOf(raw.onlyFiles),
    paused: raw.paused === true,
    state: str(raw.state),
    addedAt: num(raw.addedAt),
  };
}

export function normalizeDownload(raw: unknown): BackupDownload | null {
  if (!isPlainObject(raw)) return null;
  const url = str(raw.url).trim();
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return null;
  return {
    url,
    name: str(raw.name),
    folder: folderOf(raw.folder),
    paused: raw.paused === true,
    state: str(raw.state),
    addedAt: num(raw.addedAt),
  };
}

/** Parses the text of a backup file. Never throws. */
export function parseBackup(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('not_backup');
  }
  return migrateBackup(raw);
}

/** Upgrades a parsed backup of any supported version to the current shape. */
export function migrateBackup(raw: unknown): ParseResult {
  if (!isPlainObject(raw) || raw.format !== BACKUP_FORMAT) return fail('not_backup');
  const v = raw.v;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return fail('not_backup');
  if (v > BACKUP_VERSION) return fail('too_new');

  // v1 is current: nothing to upgrade yet. Later versions add a step here, oldest first.
  const prefsIn = isPlainObject(raw.prefs) ? raw.prefs : {};
  const prefs: Backup['prefs'] = {};
  for (const key of PREF_KEY_LIST) {
    const value = prefsIn[key];
    if (value === undefined || value === null || typeof value !== 'object') continue;
    prefs[key] = scrubSecrets(value);
  }
  const settings = isPlainObject(raw.settings) ? stripDeviceBound(migrateSettings(scrubSecrets(raw.settings))) : null;

  const seenHashes = new Set<string>();
  const torrents: BackupTorrent[] = [];
  for (const t of Array.isArray(raw.torrents) ? raw.torrents : []) {
    const n = normalizeTorrent(t);
    if (n && !seenHashes.has(n.infoHash)) {
      seenHashes.add(n.infoHash);
      torrents.push(n);
    }
  }
  const seenUrls = new Set<string>();
  const downloads: BackupDownload[] = [];
  for (const d of Array.isArray(raw.downloads) ? raw.downloads : []) {
    const n = normalizeDownload(d);
    if (n && !seenUrls.has(n.url)) {
      seenUrls.add(n.url);
      downloads.push(n);
    }
  }

  return {
    ok: true,
    backup: {
      format: BACKUP_FORMAT,
      v: BACKUP_VERSION,
      app: str(raw.app),
      created: num(raw.created),
      settings,
      prefs,
      torrents,
      downloads,
    },
  };
}
