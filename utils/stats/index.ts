/**
 * Stats runtime (docs/NATIVE_CONTRACT.md section 34.2): opens the database once, feeds engine snapshots to the recorder,
 * and offers the store to the Stats screen and to backup. Never throws into callers.
 */
import type { DownloadSnapshot, Snapshot } from '../../modules/maglev-engine/src/MaglevEngine.types.ts';
import { kvGet, kvSet } from '../prefs/kv.ts';
import { openStatsDb } from './db.ts';
import { getStatsPrefs } from './prefs.ts';
import { createRecorder, type Baseline } from './recorder.ts';
import { originTags } from './sourceStore.ts';
import { createStatsStore, type StatsStore } from './store.ts';

const BASELINE_KEY = 'maglev.stats.baseline.v1';

let storePromise: Promise<StatsStore> | null = null;
let recorder: ReturnType<typeof createRecorder> | null = null;
let lastDownloads: DownloadSnapshot[] | null = null;
const removedIds = new Set<string>();

/** Call when the engine confirms the user removed these items: an unfinished one counts as cancelled. */
export function noteRemoved(ids: readonly string[]): void {
  for (const id of ids) removedIds.add(id);
}

/** The store, opened (and migrated) on first use. A failed open is retried on the next call. */
export function getStatsStore(): Promise<StatsStore> {
  if (!storePromise) {
    storePromise = openStatsDb()
      .then(async (db) => {
        const store = createStatsStore(db, getStatsPrefs);
        void store.foldOld(Date.now()).catch(() => {});
        return store;
      })
      .catch((e) => {
        storePromise = null;
        throw e;
      });
  }
  return storePromise;
}

const baselineIO = {
  load: (): Baseline | null => {
    try {
      const raw = kvGet(BASELINE_KEY);
      const v = raw ? JSON.parse(raw) : null;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Baseline) : null;
    } catch {
      return null;
    }
  },
  save: (b: Baseline | null) => {
    try {
      kvSet(BASELINE_KEY, b ? JSON.stringify(b) : '');
    } catch {
      // The next write tries again.
    }
  },
};

/**
 * Call with every engine telemetry or list result. `downloads` undefined means "same as last time"; until a downloads list has
 * been seen nothing is recorded, so a torrent-only event can never make every link download look cancelled.
 */
export async function recordSnapshot(torrents: readonly Snapshot[], downloads?: readonly DownloadSnapshot[]): Promise<void> {
  try {
    if (downloads) lastDownloads = [...downloads];
    if (!lastDownloads) return;
    if (!getStatsPrefs().keepStats && !recorder) {
      if (kvGet(BASELINE_KEY)) baselineIO.save(null);
      return;
    }
    if (!recorder) {
      const store = await getStatsStore();
      recorder = createRecorder({
        store,
        prefs: getStatsPrefs,
        baselineIO,
        origin: (kind, id, urlDisplay) => originTags.lookup(kind, id, urlDisplay),
        now: () => Date.now(),
        removed: removedIds,
      });
    }
    await recorder.onSnapshot(torrents, lastDownloads);
  } catch {
    // Stats never break the transfer list.
  }
}
