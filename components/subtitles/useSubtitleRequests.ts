import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { maglevEngine, type DetailFile } from 'maglev-engine';
import { useMaglevEngine } from '../../context/EngineContext';
import { useSettings } from '../../context/SettingsContext';
import { useListsVersion } from '../../utils/lists/hooks';
import { listSubtitleEntries } from '../../utils/lists';
import { fileKind } from '../../utils/fileKind';
import { enabledProviders } from '../../utils/subtitles/providers';
import { effectiveLanguages, privacyAckPatch } from '../../utils/subtitles/prefs';
import { searchSubtitles, type SubtitleFile } from '../../utils/subtitles/search';
import { hasExistingSubtitle } from '../../utils/subtitles/existing';
import { parseName, parsedText } from '../../utils/subtitles/parseName';
import { NOTICE_CONTINUE, privacyNotice } from '../../utils/subtitles/copy';
import {
  MAX_CONCURRENT,
  REMOVAL_GRACE_MS,
  absence,
  addedAtMs,
  askSubtitles,
  deleteRequest,
  getAutoSince,
  getRequests,
  getRequestsVersion,
  isNewSince,
  outcomeFromRanked,
  outcomeFromSources,
  planRun,
  retryAt,
  runSettled,
  setFileList,
  setRun,
  skipSubtitles,
  subscribeRequests,
  syncAutoSince,
  type FileRun,
  type RequestEntry,
  type RunKind,
} from '../../utils/subtitles/requests';
import { downloadAndSave, downloadTarget, hashIfComplete, looksOffline, torrentTarget, type SubtitleTarget } from './flow';
import { forgetState, recallTarget, recordState } from './stateStore';
import { SUBTITLE_PROVIDERS } from '../../utils/subtitles/providers';

/** A "getting" card state lasts 2 minutes (39.1 S3); a waiting request writes it again this often. */
const CARD_REFRESH_MS = 60_000;
/** The torrent's file list is read again at most this often, and only while a video still needs something. */
const DETAIL_EVERY_MS = 5_000;

interface DetailInfo {
  at: number;
  downloaded: number;
  finished: boolean;
  folder: string;
  files: DetailFile[];
}

const keyOf = (fileKey: string | null, key: string) => `${key}\n${fileKey ?? ''}`;

/**
 * NATIVE_CONTRACT 44.7 and 44.12: works the subtitle requests off. Mounted once in app/_layout.tsx. It reads the
 * torrent and download lists the engine context already holds (no polling of its own) and does nothing at all while
 * there are no requests and automatic mode is off.
 */
export function useSubtitleRequests(): void {
  const { telemetry, downloads, engineStatus, showNotice } = useMaglevEngine();
  const { settings, updateSettings } = useSettings();
  const listsVersion = useListsVersion();
  const reqVersion = useSyncExternalStore(subscribeRequests, getRequestsVersion, getRequestsVersion);
  const [tick, setTick] = useState(0);
  const wake = useCallback(() => setTick((t) => t + 1), []);

  const running = useRef(new Map<string, AbortController>());
  const absentSince = useRef(new Map<string, number>());
  const firstSeen = useRef(new Map<string, number>());
  const details = useRef(new Map<string, DetailInfo>());
  const detailBusy = useRef(new Set<string>());
  const cardAt = useRef(new Map<string, number>());
  const targets = useRef(new Map<string, SubtitleTarget>());
  const consentShown = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sub = settings.subtitles;
  const ready = engineStatus.kind === 'ready';

  // Back to the front: an offline request may go again.
  useEffect(() => {
    const s = AppState.addEventListener('change', (n) => {
      if (n === 'active') wake();
    });
    return () => s.remove();
  }, [wake]);

  useEffect(
    () => () => {
      running.current.forEach((c) => c.abort());
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    // 44.12: the on-time follows the switch.
    syncAutoSince(sub.autoNewVideos);
    const now = Date.now();
    const torrentById = new Map(telemetry.torrents.map((t) => [t.id.toLowerCase(), t]));
    const linkById = new Map(downloads.map((d) => [d.id, d]));

    // ---- Automatic mode: ask for every new transfer (44.12).
    if (ready && sub.enabled && sub.autoNewVideos) {
      const since = getAutoSince();
      const held = getRequests();
      const fresh = [];
      for (const t of telemetry.torrents) {
        const key = `t:${t.id.toLowerCase()}`;
        if (held[key]) continue;
        const seen = firstSeen.current.get(key) ?? now;
        firstSeen.current.set(key, seen);
        // Not a video by its main file: nothing to ask (the file list drops the rest once it is known).
        if (t.mainFile && fileKind(t.mainFile) !== 'video') continue;
        if (!isNewSince(since, addedAtMs(t.addedAt), seen)) continue;
        fresh.push({ key, title: parsedText(parseName(t.mainFile || t.name)) || t.name, detail: '', addedAt: addedAtMs(t.addedAt) ?? seen });
      }
      for (const d of downloads) {
        const key = `d:${d.id}`;
        if (held[key] || fileKind(d.name) !== 'video') continue;
        const seen = firstSeen.current.get(key) ?? now;
        firstSeen.current.set(key, seen);
        if (!isNewSince(since, addedAtMs(d.addedAt), seen)) continue;
        fresh.push({ key, title: parsedText(parseName(d.name)) || d.name, detail: '', addedAt: addedAtMs(d.addedAt) ?? seen });
      }
      if (fresh.length > 0) askSubtitles(fresh, { auto: true });
    }

    const reqs = getRequests();
    const keys = Object.keys(reqs);
    if (keys.length === 0) return;

    const providers = enabledProviders(sub, listSubtitleEntries());
    const languages = effectiveLanguages(sub);
    const canRun = ready && sub.enabled && providers.length > 0;
    let nextWake = Infinity;
    const soon = (at: number) => {
      nextWake = Math.min(nextWake, at);
    };

    const refreshDetail = (id: string, downloaded: number, finished: boolean) => {
      if (detailBusy.current.has(id)) return;
      detailBusy.current.add(id);
      void maglevEngine
        .getDetail(id)
        .then((r) => {
          if (r.ok) details.current.set(id, { at: Date.now(), downloaded, finished: finished || r.snapshot.finished, folder: r.snapshot.outputFolder, files: r.files });
        })
        .catch(() => {})
        .finally(() => {
          detailBusy.current.delete(id);
          wake();
        });
    };

    const writeCard = (key: string, t: SubtitleTarget, state: 'getting' | 'saved' | 'needs-look' | 'none' | 'clear', lang: string, file = '') => {
      targets.current.set(key, t);
      if (state === 'clear') forgetState(t);
      else recordState(t, { state, lang, file, savedAt: Date.now() });
      cardAt.current.set(key, Date.now());
    };

    const run = async (entry: RequestEntry, fileKey: string | null, kind: RunKind, target: SubtitleTarget, file: SubtitleFile, prev: FileRun, existingFiles: readonly string[] | null) => {
      const key = entry.ask.key;
      const rk = keyOf(fileKey, key);
      const ctl = new AbortController();
      running.current.set(rk, ctl);
      setRun(key, fileKey, { phase: 'searching', tries: prev.tries });
      writeCard(key, target, 'getting', languages[0]);
      const finish = (phase: FileRun['phase'], tries: number, extra?: { otherLang?: string | null }) => {
        setRun(key, fileKey, { phase, tries }, extra);
      };
      try {
        // Already has its subtitles in the user's language: nothing is fetched.
        if (existingFiles && languages.some((l) => hasExistingSubtitle(target.existing?.videoPath ?? file.fileName, l, existingFiles))) {
          finish('has-already', prev.tries);
          writeCard(key, target, 'clear', languages[0]);
          return;
        }
        const typed = entry.ask.searchName;
        let hash: string | undefined;
        if (kind === 'fingerprint' && !typed) {
          const h = await hashIfComplete({ ...target, complete: true }, maglevEngine);
          if (ctl.signal.aborted) return;
          if (h.missing) {
            finish('none', prev.tries + 1);
            writeCard(key, target, 'none', languages[0]);
            return;
          }
          hash = h.hash;
        }
        const res = await searchSubtitles({ ...file, hash, searchName: typed }, { providers, languages, hearingImpaired: sub.hearingImpaired, signal: ctl.signal });
        if (ctl.signal.aborted) return;
        const down = outcomeFromSources(res.sources);
        if (down) {
          finish(down === 'limited' ? 'limited' : 'offline', prev.tries);
          writeCard(key, target, 'none', languages[0]);
          return;
        }
        const out = outcomeFromRanked(res.ranked, languages);
        const tries = prev.tries + 1;
        if (out.phase === 'saved' && out.pick) {
          const provider = providers.find((p) => p.id === out.pick!.candidate.providerId);
          if (!provider) {
            finish('needs-pick', tries);
            writeCard(key, target, 'needs-look', out.pick.candidate.language);
            return;
          }
          const saved = await downloadAndSave(
            { candidate: out.pick.candidate, provider, sourceName: provider.name, target, query: res.query, choice: 'normal', signal: ctl.signal },
            { unzip: (b) => maglevEngine.unzipSubtitles(b), save: (v, n, b, r) => maglevEngine.saveSubtitle(v, n, b, r) },
          );
          if (ctl.signal.aborted && saved.status !== 'saved') return;
          if (saved.status === 'saved') {
            finish('saved', tries, { otherLang: null });
            writeCard(key, target, 'saved', saved.language, saved.fileName);
          } else if (saved.status === 'name-taken' || saved.status === 'copies-full') {
            // A subtitle of that name is already there: auto never replaces or keeps a second copy.
            finish('has-already', tries);
            writeCard(key, target, 'clear', languages[0]);
          } else {
            const code = saved.error.code;
            const net = code === 'offline' || code === 'timeout' || code === 'error' || code === 'challenge';
            finish(code === 'limit' ? 'limited' : net ? 'offline' : 'needs-pick', code === 'limit' || net ? prev.tries : tries);
            writeCard(key, target, code === 'limit' || net ? 'none' : 'needs-look', out.pick.candidate.language);
          }
          return;
        }
        finish(out.phase, tries, { otherLang: out.otherLang ?? null });
        writeCard(key, target, out.phase === 'needs-pick' ? 'needs-look' : 'none', out.otherLang ?? languages[0]);
      } catch {
        if (!ctl.signal.aborted) {
          finish('offline', prev.tries);
          writeCard(key, target, 'none', languages[0]);
        }
      } finally {
        running.current.delete(rk);
        if (ctl.signal.aborted) {
          // Cancelled (removed, or the switch went off): back to waiting; a still-present item is picked up again.
          const cur = getRequests()[key];
          const f = fileKey === null ? cur : cur?.files?.[fileKey];
          if (f && f.phase === 'searching') setRun(key, fileKey, { phase: 'queued', tries: prev.tries });
        }
        wake();
      }
    };

    let waiting = false;
    for (const key of keys) {
      const entry = reqs[key];
      const id = key.slice(2);
      const isTorrent = key.startsWith('t:');
      const t = isTorrent ? torrentById.get(id.toLowerCase()) : undefined;
      const d = isTorrent ? undefined : linkById.get(id);
      const present = !!(t || d);

      // ---- Removal (44.7): gone from the list, so cancelled; after the undo window it is deleted for good.
      if (ready) {
        const a = absence(absentSince.current.get(key), present, now);
        if (a.state === 'present') absentSince.current.delete(key);
        else if (a.state === 'delete') {
          absentSince.current.delete(key);
          for (const [rk, c] of running.current) if (rk.startsWith(`${key}\n`)) c.abort();
          const known = targets.current.get(key) ?? recallTarget(key);
          forgetState({ videoPath: known?.videoPath ?? '', ownerKey: key });
          targets.current.delete(key);
          details.current.delete(id);
          deleteRequest(key);
          continue;
        } else {
          absentSince.current.set(key, a.since!);
          soon((a.since ?? now) + REMOVAL_GRACE_MS);
          for (const [rk, c] of running.current) if (rk.startsWith(`${key}\n`)) c.abort();
          continue;
        }
      }
      if (!present || entry.phase === 'skipped') continue;

      // Cards waiting for a file keep their "getting" state alive.
      const refreshCard = (target: SubtitleTarget | null, phase: string) => {
        if (!target || (phase !== 'queued' && phase !== 'searching')) return;
        const last = cardAt.current.get(key) ?? 0;
        if (now - last >= CARD_REFRESH_MS) writeCard(key, target, 'getting', languages[0]);
        soon((cardAt.current.get(key) ?? now) + CARD_REFRESH_MS);
      };

      const typedOne = !!entry.ask.searchName;
      const needsConsent = () => {
        waiting = true;
      };

      if (t) {
        // ---- Torrent: its video files.
        const info = details.current.get(t.id);
        const finished = !!t.finished || t.state === 'COMPLETED' || t.state === 'SEEDING';
        const metaKnown = t.resolvingSecs == null && (t.totalSizeBytes > 0 || !!t.mainFile);
        if (metaKnown) {
          const open = !info || Object.values(entry.files ?? {}).some((f) => !runSettled(f, { auto: entry.auto, typed: typedOne }));
          const changed = !info || t.downloadedBytes > info.downloaded || (finished && !info.finished);
          if (open && changed && (!info || now - info.at >= DETAIL_EVERY_MS)) refreshDetail(t.id, t.downloadedBytes, finished);
          else if (open && changed && info) soon(info.at + DETAIL_EVERY_MS);
        }
        if (!info) continue;
        const videos = info.files.filter((f) => f.included && f.length > 0 && fileKind(f.path) === 'video');
        if (videos.length === 0) {
          // 44.2: no video in this torrent, so no request. A mark stops automatic mode asking again.
          skipSubtitles(key);
          continue;
        }
        setFileList(key, videos.map((f) => f.path));
        const cur = getRequests()[key] ?? entry;
        const allPaths = info.files.filter((f) => f.length > 0 && f.progressBytes >= f.length).map((f) => f.path);
        for (const f of videos) {
          const fileKey = f.path;
          const r = cur.files?.[fileKey] ?? { phase: 'queued' as const, tries: 0 };
          const started = f.progressBytes > 0 || (videos.length === 1 && t.downloadedBytes > 0);
          const complete = f.progressBytes >= f.length || (finished && videos.length === 1);
          const target = torrentTarget(t.id, info.folder, f, allPaths.map((path) => ({ path })));
          if (!target) {
            if (r.phase === 'queued') setRun(key, fileKey, { phase: 'none', tries: 0 });
            continue;
          }
          const retry = retryAt(r, cur.updatedAt);
          if (retry !== null) soon(retry);
          refreshCard(target, r.phase);
          const kind = planRun(r, { started, complete, auto: cur.auto, typed: typedOne && videos.length === 1, now, updatedAt: cur.updatedAt });
          if (!kind || running.current.has(keyOf(fileKey, key))) continue;
          if (!canRun) continue;
          if (!sub.privacyAck) {
            needsConsent();
            continue;
          }
          if (running.current.size >= MAX_CONCURRENT) continue;
          const name = f.path.replace(/^.*[\\/]/, '');
          // A typed name is for a single video; each file of a pack is searched by its own name.
          const ask = videos.length === 1 ? cur : { ...cur, ask: { ...cur.ask, searchName: undefined } };
          void run(ask, fileKey, kind, target, { fileName: name, videoBytes: f.length }, r, allPaths);
        }
      } else if (d) {
        // ---- Link download.
        if (d.downloaded > 0 || d.state === 'finished') {
          if (fileKind(d.name) !== 'video') {
            skipSubtitles(key);
            continue;
          }
        }
        const target = downloadTarget(d);
        const r = { phase: entry.phase, tries: entry.tries };
        const joining = d.state === 'verifying' || !!d.muxNeeded;
        const started = (d.state === 'finished' || d.downloaded > 0) && !joining && fileKind(d.name) === 'video';
        if (!target) {
          if (started && r.phase === 'queued') setRun(key, null, { phase: 'none', tries: 0 });
          continue;
        }
        const retry = retryAt(r, entry.updatedAt);
        if (retry !== null) soon(retry);
        refreshCard(target, r.phase);
        const kind = planRun(r, { started, complete: d.state === 'finished', auto: entry.auto, typed: typedOne, now, updatedAt: entry.updatedAt });
        if (!kind || running.current.has(keyOf(null, key)) || !canRun) continue;
        if (!sub.privacyAck) {
          needsConsent();
          continue;
        }
        if (running.current.size >= MAX_CONCURRENT) continue;
        void run(entry, null, kind, target, { fileName: target.fileName, videoBytes: target.videoBytes }, r, null);
      }
    }

    // Nothing is sent before the one-time notice (36.10): ask for the OK once.
    if (!sub.privacyAck && waiting && !consentShown.current) {
      consentShown.current = true;
      showNotice(
        {
          message: privacyNotice(providers.map((p) => p.name)),
          actionLabel: NOTICE_CONTINUE,
          onAction: () => updateSettings({ subtitles: { ...sub, ...privacyAckPatch() } }),
        },
        null,
      );
    }
    if (sub.privacyAck) consentShown.current = false;

    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (Number.isFinite(nextWake)) timer.current = setTimeout(wake, Math.max(1000, nextWake - Date.now()));
    // The effect re-runs on every list change; the pieces it reads are listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telemetry.torrents, downloads, reqVersion, tick, sub, listsVersion, ready]);
}
