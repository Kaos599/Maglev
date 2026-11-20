import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { maglevEngine, type DetailFile } from 'maglev-engine';
import { useEngineState, useEngineStatus, useEngineTelemetry } from '../../context/EngineContext';
import { useSettings } from '../../context/SettingsContext';
import { useListsVersion } from '../../utils/lists/hooks';
import { listSubtitleEntries } from '../../utils/lists';
import { fileKind } from '../../utils/fileKind';
import { enabledProviders } from '../../utils/subtitles/providers';
import { effectiveLanguages } from '../../utils/subtitles/prefs';
import { searchSubtitles, type SubtitleFile } from '../../utils/subtitles/search';
import { hasExistingSubtitle } from '../../utils/subtitles/existing';
import { parseName, parsedText } from '../../utils/subtitles/parseName';
import {
  MAX_CONCURRENT,
  MAX_DETAIL_INFLIGHT,
  REMOVAL_GRACE_MS,
  abortKey,
  abortWhere,
  absence,
  afterFailure,
  afterMissing,
  askSubtitles,
  canWriteNow,
  canWriteState,
  deleteRequest,
  detailDue,
  epochOk,
  getAutoBaseline,
  getRequests,
  getRequestsVersion,
  isNewTransfer,
  isRunning,
  isSettledPhase,
  linkNameKind,
  nextDetailAt,
  outcomeFromRanked,
  outcomeFromSources,
  ownRun,
  packCardState,
  planRun,
  registerRun,
  requestSettled,
  resetRequest,
  resolveExisting,
  retryAt,
  runningCount,
  setFileList,
  setPresentKeys,
  setRun,
  shouldRun,
  skipSubtitles,
  statePathsToClear,
  subscribeRequests,
  syncAutoBaseline,
  unregisterRun,
  videosGone,
  type FileRun,
  type RequestEntry,
  type RunKind,
} from '../../utils/subtitles/requests';
import { toStored } from '../../utils/subtitles/season';
import { downloadAndSave, downloadTarget, hashIfComplete, torrentTarget, type SubtitleTarget } from './flow';
import { forgetAll, forgetOwnerState, forgetState, forgetVideoState, recallTarget, recordOwnerState, recordState, recordVideoState } from './stateStore';

/** A "getting" card state lasts 2 minutes (39.1 S3); a waiting request writes it again this often. */
const CARD_REFRESH_MS = 60_000;

interface DetailInfo {
  at: number;
  downloaded: number;
  finished: boolean;
  folder: string;
  files: DetailFile[];
}

type CardState = 'getting' | 'saved' | 'needs-look' | 'none' | 'clear';

/**
 * NATIVE_CONTRACT 44.7, 44.12 and 44.15: works the subtitle requests off. Mounted once in app/_layout.tsx. It reads the
 * torrent and download lists the engine context already holds (no polling of its own) and does nothing at all while
 * there are no requests and automatic mode is off. The rules it applies are pure functions in utils/subtitles/requests.ts.
 * It never shows a notice: the one-time privacy notice is shown where the user opts in (44.15 D10), and a request found
 * without that OK waits.
 */
export function useSubtitleRequests(): void {
  // Narrow hooks: this runs at the app root, so it must not subscribe to notices, actions or other engine state.
  const { telemetry, downloads, listsLive } = useEngineTelemetry();
  const { engineStatus } = useEngineStatus();
  const { networkOnline } = useEngineState();
  const { settings } = useSettings();
  const listsVersion = useListsVersion();
  const reqVersion = useSyncExternalStore(subscribeRequests, getRequestsVersion, getRequestsVersion);
  const [tick, setTick] = useState(0);
  const wake = useCallback(() => setTick((t) => t + 1), []);

  const absentSince = useRef(new Map<string, number>());
  /** Requests whose transfer came back inside the grace: once its file list is read fresh, lost files start it again (F10). */
  const returned = useRef(new Map<string, number>());
  const details = useRef(new Map<string, DetailInfo>());
  const detailFail = useRef(new Map<string, { fails: number; at: number }>());
  const detailBusy = useRef(new Set<string>());
  const cardAt = useRef(new Map<string, number>());
  /** Every video target a run used, by request key and file, so a deleted request can clear each episode's state. */
  const targets = useRef(new Map<string, SubtitleTarget>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onlineRef = useRef(networkOnline);
  onlineRef.current = networkOnline;

  const sub = settings.subtitles;
  const ready = engineStatus.kind === 'ready';

  // Back to the front: waiting work may go again.
  useEffect(() => {
    const s = AppState.addEventListener('change', (n) => {
      if (n === 'active') wake();
    });
    return () => s.remove();
  }, [wake]);

  useEffect(
    () => () => {
      abortWhere(() => true);
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    const now = Date.now();
    const lid = (id: string) => id.toLowerCase();
    const torrentById = new Map(telemetry.torrents.map((t) => [lid(t.id), t]));
    const linkById = new Map(downloads.map((d) => [d.id, d]));
    const live = ready && listsLive;

    // F3: the store never evicts a request whose transfer is still in the lists.
    const presentKeys = new Set<string>([...telemetry.torrents.map((t) => `t:${lid(t.id)}`), ...downloads.map((d) => `d:${d.id}`)]);
    setPresentKeys(live ? presentKeys : null);

    // ---- D5: the baseline follows the switch; a transfer is new when its key is not in it.
    syncAutoBaseline(sub.autoNewVideos, live ? [...presentKeys] : null);

    // ---- Automatic mode: ask for every new transfer (44.12), only after the one-time OK (D10).
    if (live && sub.enabled && sub.autoNewVideos && sub.privacyAck) {
      const baseline = getAutoBaseline();
      const held = getRequests();
      const fresh = [];
      for (const t of telemetry.torrents) {
        const key = `t:${lid(t.id)}`;
        if (held[key] || !isNewTransfer(key, baseline)) continue;
        // Not a video by its main file: nothing to ask (the file list drops the rest once it is known).
        if (t.mainFile && fileKind(t.mainFile) !== 'video') continue;
        fresh.push({ key, title: parsedText(parseName(t.mainFile || t.name)) || t.name, detail: '' });
      }
      for (const d of downloads) {
        const key = `d:${d.id}`;
        // N27: a name with no extension yet is not "no": it is asked again when the name changes.
        if (held[key] || linkNameKind(d.name) !== 'video' || !isNewTransfer(key, baseline)) continue;
        fresh.push({ key, title: parsedText(parseName(d.name)) || d.name, detail: '' });
      }
      if (fresh.length > 0) askSubtitles(fresh, { auto: true, byRunner: true });
    }

    const reqs = getRequests();
    const keys = Object.keys(reqs);
    if (keys.length === 0) return;

    const providers = enabledProviders(sub, listSubtitleEntries());
    const languages = effectiveLanguages(sub);
    const gate = { enabled: sub.enabled, providers: providers.length, autoOn: sub.autoNewVideos };
    // F5: turning Subtitles off, every source off, or automatic mode off aborts the runs at once.
    abortWhere((k) => {
      const e = reqs[k];
      return !e || !shouldRun(e, gate);
    });
    const canRun = ready && sub.enabled && providers.length > 0 && sub.privacyAck;
    let nextWake = Infinity;
    const soon = (at: number) => {
      nextWake = Math.min(nextWake, at);
    };

    const bumpFail = (id: string) => {
      const f = detailFail.current.get(id);
      detailFail.current.set(id, { fails: (f?.fails ?? 0) + 1, at: Date.now() });
    };
    const refreshDetail = (id: string, downloaded: number, finished: boolean) => {
      const k = lid(id);
      if (detailBusy.current.has(k) || detailBusy.current.size >= MAX_DETAIL_INFLIGHT) return;
      detailBusy.current.add(k);
      void maglevEngine
        .getDetail(id)
        .then((r) => {
          if (r.ok) {
            detailFail.current.delete(k);
            details.current.set(k, { at: Date.now(), downloaded, finished: finished || r.snapshot.finished, folder: r.snapshot.outputFolder, files: r.files });
          } else bumpFail(k);
        })
        .catch(() => bumpFail(k))
        .finally(() => {
          detailBusy.current.delete(k);
          wake();
        });
    };

    /**
     * F6 and D7: every state write checks the request still exists with the same epoch. A pack's episodes keep their own
     * state under the video path; the card's state is the roll-up of all its episodes.
     */
    const writeCard = (ref: { key: string; epoch: number; pack: boolean }, t: SubtitleTarget, state: CardState, lang: string, file = '') => {
      const cur = getRequests()[ref.key];
      if (!canWriteState(cur, ref.epoch, state)) return;
      targets.current.set(`${ref.key}\n${t.videoPath}`, t);
      const entry = { state: state === 'clear' ? ('none' as const) : state, lang, file, savedAt: Date.now() };
      if (!ref.pack) {
        if (state === 'clear') forgetState(t);
        else recordState(t, entry);
      } else {
        if (state === 'clear') forgetVideoState(t.videoPath);
        else recordVideoState(t, entry);
        const card = packCardState(Object.values(cur?.files ?? {}).map((f) => f.phase));
        if (card === 'clear') forgetOwnerState(ref.key);
        else recordOwnerState(t, { ...entry, state: card, file: '' });
      }
      cardAt.current.set(ref.key, Date.now());
    };

    const run = async (entry: RequestEntry, fileKey: string | null, kind: RunKind, target: SubtitleTarget, file: SubtitleFile, prev: FileRun, existingFiles: readonly string[] | null, pack: boolean) => {
      const key = entry.ask.key;
      const epoch = entry.epoch ?? 0;
      const ref = { key, epoch, pack };
      const ctl = new AbortController();
      registerRun(key, fileKey, ctl);
      const base = { vp: target.videoPath, saved: prev.saved };
      // 46.4: a pack's run that ends in needs-pick keeps its top candidate per language (at most 2) for "Use best match".
      let cands: ReturnType<typeof toStored> = [];
      const finish = (phase: FileRun['phase'], tries: number, extra?: { otherLang?: string | null }) => {
        setRun(key, fileKey, { ...base, phase, tries, ...(phase === 'needs-pick' && pack && cands.length > 0 ? { cands } : {}) }, { ...extra, epoch });
      };
      setRun(key, fileKey, { ...base, phase: 'searching', tries: prev.tries, fails: prev.fails }, { epoch });
      writeCard(ref, target, 'getting', languages[0]);
      const fail = (kindOfFail: 'offline' | 'limited' | 'failed') => {
        setRun(key, fileKey, { ...afterFailure(kindOfFail, prev, Date.now()), vp: target.videoPath }, { epoch });
        writeCard(ref, target, 'none', languages[0]);
      };
      try {
        // Already has its subtitles in the user's language: nothing is fetched. D11: if Maglev saved one, it is `saved`.
        if (existingFiles && languages.some((l) => hasExistingSubtitle(target.existing?.videoPath ?? file.fileName, l, existingFiles))) {
          const res = resolveExisting(prev);
          finish(res, prev.tries);
          if (res === 'has-already') writeCard(ref, target, 'clear', languages[0]);
          return;
        }
        const typed = entry.ask.searchName;
        let hash: string | undefined;
        if (kind === 'fingerprint' && !typed) {
          const h = await hashIfComplete({ ...target, complete: true }, maglevEngine);
          if (ctl.signal.aborted) return;
          if (h.missing) {
            // F11: a video that is gone keeps an earlier needs-pick.
            const keep = afterMissing(prev.phase);
            finish(keep, prev.tries + 1);
            if (keep === 'none') writeCard(ref, target, 'none', languages[0]);
            return;
          }
          hash = h.hash;
        }
        const res = await searchSubtitles({ ...file, hash, searchName: typed }, { providers, languages, hearingImpaired: sub.hearingImpaired, signal: ctl.signal });
        if (ctl.signal.aborted) return;
        const down = outcomeFromSources(res.sources, onlineRef.current);
        if (down) {
          fail(down);
          return;
        }
        const out = outcomeFromRanked(res.ranked, languages);
        const tries = prev.tries + 1;
        if (pack && out.phase !== 'none') cands = toStored(res.ranked, languages);
        if (out.phase === 'saved' && out.pick) {
          const provider = providers.find((p) => p.id === out.pick!.candidate.providerId);
          if (!provider) {
            finish('needs-pick', tries);
            writeCard(ref, target, 'needs-look', out.pick.candidate.language);
            return;
          }
          const saved = await downloadAndSave(
            { candidate: out.pick.candidate, provider, sourceName: provider.name, target, query: res.query, choice: 'normal', signal: ctl.signal },
            { unzip: (b) => maglevEngine.unzipSubtitles(b), save: (v, n, b, r) => maglevEngine.saveSubtitle(v, n, b, r) },
          );
          if (ctl.signal.aborted && saved.status !== 'saved') return;
          if (saved.status === 'saved') {
            setRun(key, fileKey, { vp: target.videoPath, phase: 'saved', tries, saved: true }, { otherLang: null, epoch });
            writeCard(ref, target, 'saved', saved.language, saved.fileName);
          } else if (saved.status === 'name-taken' || saved.status === 'copies-full') {
            // A subtitle of that name is already there; auto never replaces or keeps a second copy. D11: if Maglev saved
            // it, the video is `saved` and its card is left alone.
            const r = resolveExisting(prev);
            finish(r, tries);
            if (r === 'has-already') writeCard(ref, target, 'clear', languages[0]);
          } else {
            const code = saved.error.code;
            if (code === 'limit') fail('limited');
            else if (code === 'offline' || code === 'timeout' || code === 'error' || code === 'challenge') fail(onlineRef.current ? 'failed' : 'offline');
            else {
              finish('needs-pick', tries);
              writeCard(ref, target, 'needs-look', out.pick.candidate.language);
            }
          }
          return;
        }
        finish(out.phase, tries, { otherLang: out.otherLang ?? null });
        writeCard(ref, target, out.phase === 'needs-pick' ? 'needs-look' : 'none', out.otherLang ?? languages[0]);
      } catch {
        if (!ctl.signal.aborted) fail(onlineRef.current ? 'failed' : 'offline');
      } finally {
        unregisterRun(key, fileKey, ctl);
        if (ctl.signal.aborted) {
          // Cancelled (removed, renamed, or the switch went off): back to waiting; a still-present item is picked up again.
          const cur = getRequests()[key];
          const f = fileKey === null ? (cur ? ownRun(cur) : undefined) : cur?.files?.[fileKey];
          if (cur && epochOk(cur, epoch) && f && f.phase === 'searching') setRun(key, fileKey, { ...base, phase: 'queued', tries: prev.tries, fails: prev.fails }, { epoch });
        }
        wake();
      }
    };

    for (const key of keys) {
      const entry = reqs[key];
      const id = key.slice(2);
      const isTorrent = key.startsWith('t:');
      const t = isTorrent ? torrentById.get(lid(id)) : undefined;
      const d = isTorrent ? undefined : linkById.get(id);
      const present = !!(t || d);

      // ---- Removal (44.7): gone from the list, so cancelled; after the undo window it is deleted for good. F2: absence
      // counts only once the lists came live from the engine.
      const a = absence(absentSince.current.get(key), present, now, REMOVAL_GRACE_MS, live);
      if (a.state === 'present') {
        if (absentSince.current.has(key)) {
          absentSince.current.delete(key);
          // F10: back within the grace; once its files are read, a request whose files are gone starts again.
          if (isTorrent && present) {
            details.current.delete(lid(id));
            returned.current.set(key, now);
          }
        }
      } else if (a.state === 'delete') {
        absentSince.current.delete(key);
        // F6: clear every episode's stored state and target, not just the last one.
        abortKey(key);
        const remembered = recallTarget(key)?.videoPath;
        const paths = new Set(statePathsToClear(entry, remembered));
        for (const [tk, tv] of targets.current) if (tk.startsWith(`${key}\n`)) {
          paths.add(tv.videoPath);
          targets.current.delete(tk);
        }
        forgetAll(key, [...paths]);
        details.current.delete(lid(id));
        detailFail.current.delete(lid(id));
        returned.current.delete(key);
        deleteRequest(key);
        continue;
      } else {
        absentSince.current.set(key, a.since!);
        soon((a.since ?? now) + REMOVAL_GRACE_MS);
        abortKey(key);
        continue;
      }
      if (!present || entry.phase === 'skipped') continue;

      // Cards waiting for a file keep their "getting" state alive (a run waiting for its retry time does not).
      const refreshCard = (ref: { key: string; epoch: number; pack: boolean }, target: SubtitleTarget | null, r: FileRun) => {
        if (!target || (r.phase !== 'queued' && r.phase !== 'searching') || r.retryAt !== undefined) return;
        const last = cardAt.current.get(key) ?? 0;
        if (now - last >= CARD_REFRESH_MS) writeCard(ref, target, 'getting', languages[0]);
        soon((cardAt.current.get(key) ?? now) + CARD_REFRESH_MS);
      };

      const typedOne = !!entry.ask.searchName;
      const runnable = canRun && shouldRun(entry, gate);
      const epoch = entry.epoch ?? 0;

      if (t) {
        // ---- Torrent: its video files.
        const k = lid(t.id);
        const info = details.current.get(k);
        const finished = !!t.finished || t.state === 'COMPLETED' || t.state === 'SEEDING';
        const metaKnown = t.resolvingSecs == null && (t.totalSizeBytes > 0 || !!t.mainFile);
        if (metaKnown) {
          // F1: a request whose runs are all settled reads no file list; failures back off; at most 3 calls at once.
          const needed = !requestSettled(entry) || returned.current.has(key);
          const changed = !info || t.downloadedBytes > info.downloaded || (finished && !info.finished);
          const at = nextDetailAt({ lastOkAt: info?.at, fail: detailFail.current.get(k) });
          if (detailDue({ needed, changed, now, at, busy: detailBusy.current.size })) refreshDetail(t.id, t.downloadedBytes, finished);
          else if (needed && changed && at > now) soon(at);
        }
        if (!info) continue;
        // F10: back within the grace: if the files are gone, the old request starts again.
        const ret = returned.current.get(key);
        if (ret !== undefined && info.at >= ret) {
          returned.current.delete(key);
          if (videosGone(info.files)) resetRequest(key);
        }
        const videos = info.files.filter((f) => f.included && f.length > 0 && fileKind(f.path) === 'video');
        if (videos.length === 0) {
          // 44.2: no video in this torrent, so no request. A mark stops automatic mode asking again.
          skipSubtitles(key);
          continue;
        }
        const pack = videos.length > 1;
        setFileList(key, videos.map((f) => f.path), Object.fromEntries(videos.map((f) => [f.path, f.length])));
        const cur = getRequests()[key] ?? entry;
        const ref = { key, epoch: cur.epoch ?? 0, pack };
        const allPaths = info.files.filter((f) => f.length > 0 && f.progressBytes >= f.length).map((f) => f.path);
        for (const f of videos) {
          const fileKey = f.path;
          const r = cur.files?.[fileKey] ?? { phase: 'queued' as const, tries: 0 };
          const started = f.progressBytes > 0 || (videos.length === 1 && t.downloadedBytes > 0);
          const complete = f.progressBytes >= f.length || (finished && videos.length === 1);
          const target = torrentTarget(t.id, info.folder, f, allPaths.map((path) => ({ path })));
          if (!target) {
            // D9: a folder Maglev can't write to (a picked SAF folder) is `unavailable`, not `none`; nothing polls it.
            if (!isSettledPhase(r.phase)) setRun(key, fileKey, { ...r, phase: 'unavailable' }, { epoch: ref.epoch });
            continue;
          }
          // F4: each file run keeps its own retry time.
          const retry = retryAt(r);
          if (retry !== null) soon(retry);
          refreshCard(ref, target, r);
          const kind = planRun(r, { started, complete, typed: typedOne && videos.length === 1, now, online: networkOnline });
          if (!kind || isRunning(key, fileKey)) continue;
          // D10: without the one-time OK a request waits; the row says "Needs your OK".
          if (!runnable) continue;
          // F10: a sidecar is never written while the transfer is being moved (the folder is stale).
          if (!canWriteNow(t.state)) continue;
          if (!networkOnline) {
            if (r.phase !== 'offline') setRun(key, fileKey, { ...afterFailure('offline', r, now), vp: target.videoPath }, { epoch: ref.epoch });
            continue;
          }
          if (runningCount() >= MAX_CONCURRENT) continue;
          const name = f.path.replace(/^.*[\\/]/, '');
          // A typed name is for a single video; each file of a pack is searched by its own name.
          const ask = videos.length === 1 ? cur : { ...cur, ask: { ...cur.ask, searchName: undefined } };
          void run(ask, fileKey, kind, target, { fileName: name, videoBytes: f.length }, r, allPaths, pack);
        }
      } else if (d) {
        // ---- Link download.
        const nameKind = linkNameKind(d.name);
        // N27: a name with no extension yet is neither a video nor not one: wait for the name to settle.
        if (nameKind === 'unknown') continue;
        if (nameKind === 'not-video') {
          if (d.downloaded > 0 || d.state === 'finished') skipSubtitles(key);
          continue;
        }
        const target = downloadTarget(d);
        const r = ownRun(entry);
        const joining = d.state === 'verifying' || !!d.muxNeeded;
        const started = (d.state === 'finished' || d.downloaded > 0) && !joining;
        const ref = { key, epoch, pack: false };
        if (!target) {
          // D9: nothing to write to: `unavailable`, and the runner stops looking at it.
          if (started && !isSettledPhase(r.phase)) setRun(key, null, { ...r, phase: 'unavailable' }, { epoch });
          continue;
        }
        const retry = retryAt(r);
        if (retry !== null) soon(retry);
        refreshCard(ref, target, r);
        const kind = planRun(r, { started, complete: d.state === 'finished', typed: typedOne, now, online: networkOnline });
        if (!kind || isRunning(key, null) || !runnable) continue;
        if (!networkOnline) {
          if (r.phase !== 'offline') setRun(key, null, { ...afterFailure('offline', r, now), vp: target.videoPath }, { epoch });
          continue;
        }
        if (runningCount() >= MAX_CONCURRENT) continue;
        void run(entry, null, kind, target, { fileName: target.fileName, videoBytes: target.videoBytes }, r, null, false);
      }
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (Number.isFinite(nextWake)) timer.current = setTimeout(wake, Math.max(1000, nextWake - Date.now()));
    // The effect re-runs on every list change; the pieces it reads are listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telemetry.torrents, downloads, reqVersion, tick, sub, listsVersion, ready, listsLive, networkOnline]);
}
