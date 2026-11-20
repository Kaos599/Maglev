import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { maglevEngine } from 'maglev-engine';
import { useMaglevEngine } from '../../context/EngineContext';
import { useSettings } from '../../context/SettingsContext';
import { useListsVersion } from '../../utils/lists/hooks';
import { listSubtitleEntries } from '../../utils/lists';
import { enabledProviders } from '../../utils/subtitles/providers';
import { effectiveLanguages } from '../../utils/subtitles/prefs';
import { buildQuery, searchSubtitles } from '../../utils/subtitles/search';
import { bulkResult } from '../../utils/subtitles/copy';
import type { SubtitleCandidate, SubtitleProvider } from '../../utils/subtitles/types';
import {
  epochOk,
  getRequests,
  getRequestsVersion,
  markSaved,
  outcomeFromSources,
  packCardState,
  registerRun,
  subscribeRequests,
  unregisterRun,
} from '../../utils/subtitles/requests';
import { needPickCount, qualifyingRuns, runBulk, toStored, type BestRun, type SaveResult, type StoredCandidate } from '../../utils/subtitles/season';
import { downloadAndSave, hashIfComplete, torrentTarget, type SubtitleTarget } from './flow';
import { forgetOwnerState, recordOwnerState, recordVideoState } from './stateStore';

/**
 * NATIVE_CONTRACT 46.3 and 46.4: "Use the best match". The loop and its rules are in utils/subtitles/season.ts; this
 * file gives them the engine, the sources and the store. One bulk runs at a time. It only happens on the user's tap.
 */

export interface BulkEnv {
  providers: readonly SubtitleProvider[];
  languages: string[];
  hearingImpaired: 'both' | 'prefer' | 'avoid';
  /** The engine's own id for a request key (`t:<hash>`). */
  idFor(key: string): string;
}

interface Active {
  keys: string[];
  done: number;
  total: number;
}

let active: Active | null = null;
let last: { keys: string[]; text: string } | null = null;
let version = 0;
const listeners = new Set<() => void>();
const bump = (): void => {
  version++;
  listeners.forEach((l) => l());
};
const subscribeBulk = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const getBulkVersion = (): number => version;

/** The tap's result line is for the sheet that is open; it is cleared when a sheet opens. */
export function clearBulkResult(): void {
  if (!last) return;
  last = null;
  bump();
}

/** Codes where a new search can't help. */
const NO_RETRY = new Set(['CANT_WRITE', 'NO_SPACE', 'REPLACE_DENIED', 'VERIFY_FAILED', 'missing']);

/** Saves the best stored candidate of every qualifying run of these requests. Returns the result line, or null when nothing ran. */
async function startBulk(keys: readonly string[], env: BulkEnv): Promise<string | null> {
  if (active) return null;
  try {
    return await bulkOnce(keys, env);
  } finally {
    // A throw anywhere above must not leave the button on "Saving…" until the app restarts.
    if (active) {
      active = null;
      bump();
    }
  }
}

async function bulkOnce(keys: readonly string[], env: BulkEnv): Promise<string | null> {
  const reqs = getRequests();
  const runs: BestRun[] = [];
  const epochs = new Map<string, number>();
  for (const key of keys) {
    const found = qualifyingRuns(reqs[key], env.languages);
    if (found.length > 0) epochs.set(key, reqs[key].epoch ?? 0);
    runs.push(...found);
  }
  if (runs.length === 0) return null;
  const involved = [...epochs.keys()];
  active = { keys: involved, done: 0, total: runs.length };
  last = null;
  bump();

  // Where each episode's file is: the engine's file list, read once per torrent.
  const targets = new Map<string, SubtitleTarget>();
  await Promise.all(
    involved.map(async (key) => {
      try {
        const d = await maglevEngine.getDetail(env.idFor(key));
        if (!d.ok) return;
        const done = d.files.filter((f) => f.length > 0 && f.progressBytes >= f.length).map((f) => ({ path: f.path }));
        for (const r of runs.filter((x) => x.askKey === key)) {
          const f = d.files.find((x) => x.path === r.fileKey);
          const t = f ? torrentTarget(key.slice(2), d.snapshot.outputFolder, f, done) : null;
          if (t) targets.set(`${key}\n${r.fileKey}`, t);
        }
      } catch {
        // those episodes stay in needs-pick
      }
    }),
  );
  const savedAs = new Map<string, { lang: string; file: string }>();
  const targetOf = (r: BestRun) => targets.get(`${r.askKey}\n${r.fileKey}`);

  const guarded = async <T>(r: BestRun, fallback: T, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const ctl = new AbortController();
    registerRun(r.askKey, r.fileKey, ctl);
    try {
      return await work(ctl.signal);
    } catch {
      return fallback;
    } finally {
      unregisterRun(r.askKey, r.fileKey, ctl);
    }
  };

  const outcome = await runBulk(runs, {
    valid: (r) => {
      const e = getRequests()[r.askKey];
      return epochOk(e, epochs.get(r.askKey) ?? 0) && e.phase !== 'skipped' && e.files?.[r.fileKey]?.phase === 'needs-pick';
    },
    save: (r, cand: StoredCandidate): Promise<SaveResult> =>
      guarded<SaveResult>(r, 'failed', async (signal) => {
        const target = targetOf(r);
        const provider = env.providers.find((p) => p.id === cand.p);
        if (!target) return 'stay';
        if (!provider) return 'failed';
        const candidate: SubtitleCandidate = { providerId: cand.p, id: cand.id, language: cand.l, releaseName: cand.rel, matchedBy: 'title' };
        const query = buildQuery({ fileName: target.fileName, videoBytes: target.videoBytes }, env.languages);
        const res = await downloadAndSave(
          { candidate, provider, sourceName: provider.name, target, query, choice: 'normal', signal },
          { unzip: (b) => maglevEngine.unzipSubtitles(b), save: (v, n, b, rep) => maglevEngine.saveSubtitle(v, n, b, rep) },
        );
        if (res.status === 'saved') {
          savedAs.set(`${r.askKey}\n${r.fileKey}`, { lang: res.language, file: res.fileName });
          return 'saved';
        }
        if (res.status === 'name-taken' || res.status === 'copies-full') return 'stay';
        return NO_RETRY.has(res.error.code) ? 'stay' : 'failed';
      }),
    research: (r) =>
      guarded<StoredCandidate[] | null>(r, null, async (signal) => {
        const target = targetOf(r);
        if (!target) return null;
        const h = await hashIfComplete(target, maglevEngine);
        const res = await searchSubtitles({ fileName: target.fileName, videoBytes: target.videoBytes, hash: h.hash }, { providers: [...env.providers], languages: env.languages, hearingImpaired: env.hearingImpaired, signal });
        if (signal.aborted || outcomeFromSources(res.sources, true)) return null;
        return toStored(res.ranked, env.languages);
      }),
    saved: (r) => {
      markSaved(r.askKey, r.fileKey);
      const target = targetOf(r);
      const how = savedAs.get(`${r.askKey}\n${r.fileKey}`);
      if (target && how) recordVideoState(target, { state: 'saved', lang: how.lang, file: how.file, savedAt: Date.now() });
    },
    progress: (done, total) => {
      active = { keys: involved, done, total };
      bump();
    },
  });

  // 44.15 D7: the pack card follows the roll-up of its episodes.
  for (const key of involved) {
    const files = getRequests()[key]?.files;
    const any = [...targets.entries()].find(([k]) => k.startsWith(`${key}\n`))?.[1];
    if (!files || !any || (getRequests()[key].epoch ?? 0) !== epochs.get(key)) continue;
    const card = packCardState(Object.values(files).map((f) => f.phase));
    if (card === 'clear') forgetOwnerState(key);
    else recordOwnerState(any, { state: card, lang: env.languages[0] ?? '', file: '', savedAt: Date.now() });
  }

  const left = involved.reduce((n, key) => n + needPickCount(getRequests()[key]?.files), 0);
  const text = bulkResult(outcome.saved, left);
  active = null;
  last = { keys: involved, text };
  bump();
  return text;
}

export interface SeasonBulk {
  /** 46.3: how many needs-pick episode runs of these requests have a best stored candidate that qualifies. */
  best(keys: readonly string[]): number;
  /** Set while a bulk save runs for any of these keys: how many have ended and how many there are. */
  progress(keys: readonly string[]): { done: number; total: number } | null;
  /** True while any bulk save runs (only one runs at a time). */
  busy: boolean;
  /** The line the last bulk left for these keys, or null. */
  result(keys: readonly string[]): string | null;
  start(keys: readonly string[]): Promise<string | null>;
}

/** The hook the page row and the status sheet share. */
export function useSeasonBulk(): SeasonBulk {
  const { telemetry } = useMaglevEngine();
  const { settings } = useSettings();
  const listsVersion = useListsVersion();
  useSyncExternalStore(subscribeRequests, getRequestsVersion, getRequestsVersion);
  useSyncExternalStore(subscribeBulk, getBulkVersion, getBulkVersion);
  const sub = settings.subtitles;
  const providers = useMemo(
    () => enabledProviders(sub, listSubtitleEntries()),
    // The signed list can change without the settings changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sub, listsVersion],
  );
  const languages = useMemo(() => effectiveLanguages(sub), [sub]);
  // Candidates exist only after a search, which needs the one-time OK; a switch turned off since stops it again.
  const usable = sub.enabled && sub.privacyAck && providers.length > 0;
  const torrents = telemetry.torrents;

  const best = useCallback((keys: readonly string[]) => (usable ? keys.reduce((n, k) => n + qualifyingRuns(getRequests()[k], languages).length, 0) : 0), [usable, languages]);
  const start = useCallback(
    (keys: readonly string[]) =>
      startBulk(keys, {
        providers,
        languages,
        hearingImpaired: sub.hearingImpaired,
        idFor: (key) => torrents.find((t) => `t:${t.id.toLowerCase()}` === key)?.id ?? key.slice(2),
      }),
    [providers, languages, sub.hearingImpaired, torrents],
  );
  return {
    best,
    progress: (keys) => (active && keys.some((k) => active!.keys.includes(k)) ? { done: active.done, total: active.total } : null),
    busy: active !== null,
    result: (keys) => (last && keys.some((k) => last!.keys.includes(k)) ? last.text : null),
    start,
  };
}
