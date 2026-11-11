import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { FlatList, Linking, Share, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { maglevEngine, type DetailFile, type FilePriority, type TorrentLimits } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes, formatEta, formatSpeed } from '../../constants/format';
import { triggerHaptic } from '../../constants/haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PixelIcon } from '../../components/PixelIcon';
import { friendlyPath } from '../../components/settings/SettingsParts';
import { Banner, Button, EmptyBlock, IconButton, ProgressBar, Screen, SegmentedControl } from '../../components/ui';
import { SpeedChart } from '../../components/SpeedChart';
import { PiecesMatrix } from '../../components/PiecesMatrix';
import { StateBadge } from '../../components/detail/StateBadge';
import { StatGrid } from '../../components/detail/StatGrid';
import { PeerRow, TrackerRow } from '../../components/detail/rows';
import { DeleteSheet, FileActionsSheet, RemoveFilesSheet, SavedTorrentSheet } from '../../components/detail/sheets';
import { AddTrackerSheet, RemoveTrackerSheet } from '../../components/detail/TrackerSheets';
import { REMOVE_FILES_INITIAL, removeFilesStep } from '../../components/detail/removeFilesMachine';
import { TRACKER_EDIT_INITIAL, trackerEditStep } from '../../components/detail/trackerEditMachine';
import {
  FILE_HEALTH_INITIAL,
  fileHealthBanner,
  fileHealthStep,
  healthBannerFor,
  type BannerButtonId,
  type HealthBanner,
} from '../../components/detail/fileHealthMachine';
import { FileListRow } from '../../components/detail/FileListRow';
import { PrioritySheet } from '../../components/detail/PrioritySheet';
import { TorrentMoreSheet } from '../../components/detail/TorrentMoreSheet';
import { SpeedLimitSheet } from '../../components/detail/SpeedLimitSheet';
import { MoveSheet } from '../../components/detail/MoveSheet';
import { useTorrentDetail } from '../../components/detail/useTorrentDetail';
import { buildMagnet, clockTime, isStreamable, limitText, moveFailure } from '../../components/detail/torrentLabels';
import { actionsFor, type ErrorAction } from '../../components/detail/errorActions';

type Tab = 'files' | 'peers' | 'trackers' | 'pieces';

/**
 * Runs a pure machine (SM-27, SM-28). The reducer holds the state for rendering. `send` steps the machine on a ref
 * so its effects can run at once, then hands them to `run`, which may call `send` again with an engine result.
 */
function useMachine<S, E, F>(
  step: (state: S, event: E) => { state: S; effects: F[] },
  initial: S,
  run: (effects: F[], send: (event: E) => void) => void,
): [S, (event: E) => void] {
  const [state, dispatch] = useReducer((s: S, e: E) => step(s, e).state, initial);
  const stateRef = useRef(initial);
  const runRef = useRef(run);
  runRef.current = run;
  const send = useCallback(
    (event: E) => {
      const next = step(stateRef.current, event);
      stateRef.current = next.state;
      dispatch(event);
      runRef.current(next.effects, send);
    },
    [step],
  );
  return [state, send];
}

const TABS = [
  { value: 'files', label: 'Files' },
  { value: 'peers', label: 'Peers' },
  { value: 'trackers', label: 'Trackers' },
  { value: 'pieces', label: 'Pieces' },
] as const;

interface Notice {
  tone: 'info' | 'danger';
  text: string;
}

export default function TorrentDetailScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { pauseTorrent, resumeTorrent, deleteTorrent } = useMaglevEngine();

  const [tab, setTab] = useState<Tab>('files');
  const { detail, pieces, status, error, tick, retry } = useTorrentDetail(id, tab === 'pieces');

  const [moreOpen, setMoreOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [fileSheet, setFileSheet] = useState<DetailFile | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<Record<number, FilePriority>>({});
  const [prioTarget, setPrioTarget] = useState<number[] | null>(null);
  const [prioError, setPrioError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<number> | null>(null);
  const [limitOpen, setLimitOpen] = useState(false);
  const [limitPending, setLimitPending] = useState<TorrentLimits | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<{ text: string; pickAgain: boolean } | null>(null);
  /** Trackers removed a moment ago, hidden until the next detail read stops listing them. */
  const [hiddenTrackers, setHiddenTrackers] = useState<string[]>([]);
  const [savedTorrent, setSavedTorrent] = useState<{ path: string; name: string; folder: string } | null>(null);
  const [resumesAt, setResumesAt] = useState<string | null>(null);
  const [retryUntil, setRetryUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const insets = useSafeAreaInsets();
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((n: Notice) => {
    setNotice(n);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 3500);
  }, []);
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
  }, []);

  // SM-27 Remove files. The machine decides; this runs its effects.
  const [removeState, sendRemove] = useMachine(removeFilesStep, REMOVE_FILES_INITIAL, (effects, send) => {
    for (const e of effects) {
      switch (e.type) {
        case 'notice':
          showNotice({ tone: e.tone, text: e.text });
          break;
        case 'haptic':
          triggerHaptic(e.style);
          break;
        case 'clearSelection':
          setSelection(null);
          break;
        case 'call':
          if (!id) {
            send({ type: 'RESULT_ERR', code: 'NOT_FOUND', message: '' });
            break;
          }
          maglevEngine
            .removeFiles(id, e.indices)
            .then((res) => {
              if (res.ok) {
                send({ type: 'RESULT_OK', freedBytes: res.freedBytes });
                send({ type: 'NOTICE_SHOWN' });
              } else {
                send({ type: 'RESULT_ERR', code: res.code, message: res.message });
              }
            })
            .catch(() => send({ type: 'RESULT_ERR', code: 'UNKNOWN', message: '' }));
          break;
        default:
          // openSheet and closeSheet need no work: the sheets' visibility is read from the state.
          break;
      }
    }
  });

  // SM-28 Tracker edit. The machine decides; this runs its effects.
  const [trk, sendTrk] = useMachine(trackerEditStep, TRACKER_EDIT_INITIAL, (effects, send) => {
    for (const e of effects) {
      switch (e.type) {
        case 'notice':
          showNotice({ tone: e.tone, text: e.text });
          break;
        case 'call':
          if (!id) {
            send({ type: 'ERR', message: 'Torrent not found.' });
            break;
          }
          if (e.fn === 'addTrackers') {
            maglevEngine
              .addTrackers(id, e.urls)
              .then((res) => {
                if (res.ok) send({ type: 'OK', addedCount: res.added });
                else send({ type: 'ERR', message: res.message || "Couldn't add the trackers." });
              })
              .catch(() => send({ type: 'ERR', message: "Couldn't add the trackers. Try again." }));
          } else {
            const url = e.url;
            maglevEngine
              .removeTracker(id, url)
              .then((res) => {
                if (res.ok) {
                  setHiddenTrackers((h) => [...h, url]);
                  send({ type: 'OK' });
                } else {
                  send({ type: 'ERR', message: res.message || "Couldn't remove the tracker." });
                }
              })
              .catch(() => send({ type: 'ERR', message: "Couldn't remove the tracker." }));
          }
          break;
        default:
          // openSheet, closeSheet and show need no work: the sheets read their state from the machine.
          break;
      }
    }
  });

  // SM-32 Files changed outside Maglev. The machine decides; this runs its effects.
  const [fh, sendFh] = useMachine(fileHealthStep, FILE_HEALTH_INITIAL, (effects, send) => {
    for (const e of effects) {
      switch (e.type) {
        case 'haptic':
          triggerHaptic(e.style);
          break;
        case 'pickFolder':
          maglevEngine
            .pickFolder()
            .then((picked) => send('cancelled' in picked ? { type: 'FOLDER_CANCELLED' } : { type: 'FOLDER_PICKED', dir: picked.uri }))
            .catch(() => send({ type: 'PICK_FAILED' }));
          break;
        case 'call':
          if (!id) {
            send({ type: 'RESULT_ERR', code: 'NOT_FOUND', message: '' });
            break;
          }
          maglevEngine
            .resolveFiles(id, e.action, e.indices, e.dir)
            .then((res) => send(res.ok ? { type: 'RESULT_OK' } : { type: 'RESULT_ERR', code: res.code, message: res.message }))
            .catch(() => send({ type: 'RESULT_ERR', code: 'UNKNOWN', message: '' }));
          break;
      }
    }
  });
  const [missingIdx, setMissingIdx] = useState<number[]>([]);
  const healthTag = detail?.snapshot.health ?? null;
  // Read which files are missing whenever the tag is set, and again on every poll while it is.
  useEffect(() => {
    if (!id) return;
    if (healthTag !== 'files_missing' && healthTag !== 'files_changed') {
      setMissingIdx((m) => (m.length ? [] : m));
      sendFh({ type: 'SYNC', health: healthTag, missing: [] });
      return;
    }
    let alive = true;
    maglevEngine
      .fileHealth(id)
      .then((res) => {
        if (!alive) return;
        const missing = res.ok ? res.files.filter((f) => f.state === 'missing').map((f) => f.index) : [];
        setMissingIdx(missing);
        sendFh({ type: 'SYNC', health: healthTag, missing });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, healthTag, tick, sendFh]);
  const missingSet = useMemo(() => new Set(missingIdx), [missingIdx]);

  // Tick once a second while the "Find more peers" cool-down is showing.
  useEffect(() => {
    if (!moreOpen || retryUntil <= Date.now()) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [moreOpen, retryUntil]);
  const retryInSecs = Math.max(0, Math.ceil((retryUntil - now) / 1000));

  // Drop optimistic priorities once the engine reports the same value.
  useEffect(() => {
    if (!detail) return;
    setPending((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const next = { ...prev };
      for (const f of detail.files) if (f.index in next && next[f.index] === f.priority) delete next[f.index];
      return Object.keys(next).length === keys.length ? prev : next;
    });
  }, [detail]);

  const snap = detail?.snapshot ?? null;

  // Forget a hidden tracker once the engine no longer lists it.
  useEffect(() => {
    if (!detail) return;
    setHiddenTrackers((prev) => {
      const next = prev.filter((u) => detail.trackers.some((t) => t.url === u));
      return next.length === prev.length ? prev : next;
    });
  }, [detail]);
  const trackers = useMemo(
    () => (detail ? detail.trackers.filter((t) => !hiddenTrackers.includes(t.url)) : []),
    [detail, hiddenTrackers],
  );

  // Drop the optimistic limit once the engine reports the same values.
  useEffect(() => {
    if (limitPending && snap && snap.downLimitBps === limitPending.downBps && snap.upLimitBps === limitPending.upBps) {
      setLimitPending(null);
    }
  }, [limitPending, snap]);
  const limits: TorrentLimits = limitPending ?? { downBps: snap?.downLimitBps ?? 0, upBps: snap?.upLimitBps ?? 0 };
  const limitSummary = limitText(limits);

  // "resumes HH:MM" on a scheduled pause, when the schedule knows its next boundary.
  const scheduled = snap?.state === 'PAUSED' && snap.pausedBy === 'schedule';
  useEffect(() => {
    if (!scheduled) {
      setResumesAt(null);
      return;
    }
    let alive = true;
    maglevEngine
      .getScheduleStatus()
      .then((st) => {
        if (alive) setResumesAt(st.nextBoundary ? clockTime(st.nextBoundary) : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [scheduled]);
  const files = useMemo(
    () => (detail ? detail.files.map((f) => (f.index in pending ? { ...f, priority: pending[f.index], included: pending[f.index] !== 'skip' } : f)) : []),
    [detail, pending],
  );

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const applyPriority = useCallback(
    async (indices: number[], priority: FilePriority) => {
      if (!id) return;
      const chosen = new Set(indices);
      const next = files.map((f) => ({ index: f.index, priority: chosen.has(f.index) ? priority : f.priority }));
      if (next.every((e) => e.priority === 'skip')) {
        setPrioError('Keep at least one file');
        // From the selection bar there is no sheet to show the error in.
        if (!prioTarget) showNotice({ tone: 'danger', text: 'Keep at least one file.' });
        triggerHaptic('warning');
        return;
      }
      triggerHaptic('selection');
      setPrioError(null);
      setPrioTarget(null);
      setSelection(null);
      setPending((p) => ({ ...p, ...Object.fromEntries(indices.map((i) => [i, priority])) }));
      const res = await maglevEngine.setFilePriorities(id, next);
      if (!res.ok) {
        setPending((p) => {
          const rest = { ...p };
          for (const i of indices) delete rest[i];
          return rest;
        });
        showNotice({ tone: 'danger', text: res.message || "Couldn't change the file priority." });
      }
    },
    [files, id, prioTarget, showNotice],
  );

  // Asks before deleting. The SM-27 machine refuses when no included file would be left.
  const askRemove = useCallback(
    (indices: number[]) => {
      setPrioTarget(null);
      setPrioError(null);
      // Skipped files hold no data to remove, so only included ones count toward the guard.
      const included = indices.filter((i) => files.some((f) => f.index === i && f.priority !== 'skip'));
      sendRemove({
        type: 'REQUEST',
        indices: included,
        bytes: files.filter((f) => included.includes(f.index)).reduce((n, f) => n + f.progressBytes, 0),
        allIncludedCount: files.filter((f) => f.priority !== 'skip').length,
      });
    },
    [files, sendRemove],
  );

  const handleFilePress = useCallback((file: DetailFile) => {
    if (selection) {
      setSelection((prev) => {
        const s = new Set(prev);
        if (s.has(file.index)) s.delete(file.index);
        else s.add(file.index);
        return s.size === 0 ? null : s;
      });
      return;
    }
    setPrioError(null);
    setPrioTarget([file.index]);
  }, [selection]);

  const handleFileLongPress = useCallback((file: DetailFile) => {
    triggerHaptic('medium');
    setSelection((prev) => (prev ? prev : new Set([file.index])));
  }, []);

  const handleReannounce = useCallback(async () => {
    setMoreOpen(false);
    if (!id) return;
    const res = await maglevEngine.reannounce(id);
    if (res.ok) {
      setRetryUntil(Date.now() + 60_000);
      showNotice({ tone: 'info', text: 'Looking for more peers…' });
    } else if (res.retryAfterSecs) {
      setRetryUntil(Date.now() + res.retryAfterSecs * 1000);
      showNotice({ tone: 'info', text: `Try again in ${res.retryAfterSecs} s.` });
    } else {
      showNotice({ tone: 'danger', text: res.message || "Couldn't ask for more peers." });
    }
  }, [id, showNotice]);

  const handleCopyMagnet = useCallback(async () => {
    setMoreOpen(false);
    if (!id || !snap) return;
    try {
      await Clipboard.setStringAsync(buildMagnet(id, snap.name, trackers.map((t) => t.url)));
      triggerHaptic('success');
      showNotice({ tone: 'info', text: 'Magnet link copied.' });
    } catch {
      showNotice({ tone: 'danger', text: "Couldn't copy the magnet link." });
    }
  }, [id, snap, showNotice, trackers]);

  const handleShareMagnet = useCallback(async () => {
    setMoreOpen(false);
    if (!id || !snap) return;
    try {
      // Only the magnet link goes out: no title, no url, no extra text.
      await Share.share({ message: buildMagnet(id, snap.name, trackers.map((t) => t.url)) });
    } catch {
      showNotice({ tone: 'danger', text: "Couldn't share the magnet link." });
    }
  }, [id, snap, showNotice, trackers]);

  const handleSaveTorrent = useCallback(async () => {
    setMoreOpen(false);
    if (!id) return;
    const res = await maglevEngine.exportTorrent(id);
    if (res.ok) {
      triggerHaptic('success');
      setSavedTorrent({ path: res.path, name: res.name, folder: res.folder });
    } else {
      showNotice({ tone: 'danger', text: res.message || "Couldn't save the .torrent file." });
    }
  }, [id, showNotice]);

  const handleLimits = useCallback(
    async (next: TorrentLimits) => {
      if (!id) return;
      setLimitPending(next);
      const res = await maglevEngine.setTorrentLimits(id, next);
      if (!res.ok) {
        setLimitPending(null);
        showNotice({ tone: 'danger', text: res.message || "Couldn't change the speed limit." });
      }
    },
    [id, showNotice],
  );

  const startMove = useCallback(
    async (target: { kind: 'default' } | { kind: 'tree'; uri: string }) => {
      if (!id) return;
      setMoveBusy(true);
      setMoveError(null);
      try {
        const res = await maglevEngine.moveStorage(id, target);
        if (res.ok) {
          setMoveOpen(false);
          showNotice({ tone: 'info', text: 'Moving files…' });
        } else {
          setMoveError(moveFailure(res.code, res.message));
          triggerHaptic('warning');
        }
      } finally {
        setMoveBusy(false);
      }
    },
    [id, showNotice],
  );

  const handlePickMove = useCallback(async () => {
    setMoveError(null);
    try {
      const picked = await maglevEngine.pickFolder();
      if ('cancelled' in picked) return;
      await startMove({ kind: 'tree', uri: picked.uri });
    } catch {
      setMoveError({ text: "Couldn't open the folder picker. Try again.", pickAgain: true });
    }
  }, [startMove]);

  const handleRecheck = useCallback(async () => {
    setMoreOpen(false);
    if (!id) return;
    const res = await maglevEngine.recheck(id);
    showNotice(res.ok ? { tone: 'info', text: 'Checking files…' } : { tone: 'danger', text: res.message });
  }, [id, showNotice]);

  const handleFreeSpace = useCallback(async () => {
    try {
      await Linking.sendIntent('android.settings.INTERNAL_STORAGE_SETTINGS');
    } catch {
      await Linking.openSettings();
    }
  }, []);

  const handleOpenFolder = useCallback(async () => {
    setMoreOpen(false);
    if (!id) return;
    const res = await maglevEngine.openFolder(id);
    if (!res.ok) showNotice({ tone: 'danger', text: res.message || "Couldn't open the folder." });
  }, [id, showNotice]);

  const handleDelete = useCallback(
    async (withFiles: boolean) => {
      if (!id) return;
      setDeleteBusy(true);
      setDeleteError(null);
      const ok = await deleteTorrent(id, withFiles);
      setDeleteBusy(false);
      if (ok) {
        triggerHaptic('warning');
        setDeleteOpen(false);
        goBack();
      } else {
        setDeleteError('The engine could not remove this torrent. Try again.');
      }
    },
    [deleteTorrent, goBack, id],
  );

  const handlePlayPause = useCallback(async () => {
    if (!id || !snap) return;
    triggerHaptic('light');
    const running = snap.state === 'DOWNLOADING' || snap.state === 'SEEDING' || snap.state === 'QUEUED';
    const ok = running ? await pauseTorrent(id) : await resumeTorrent(id);
    if (!ok) showNotice({ tone: 'danger', text: "Couldn't change the torrent state." });
  }, [id, pauseTorrent, resumeTorrent, showNotice, snap]);

  const handleScanFiles = useCallback(async () => {
    const res = await maglevEngine.scanFileHealth();
    showNotice(res.ok ? { tone: 'info', text: 'Checking files…' } : { tone: 'danger', text: res.message });
  }, [showNotice]);

  const handleKeepTrying = useCallback(async () => {
    if (!id) return;
    triggerHaptic('light');
    const res = await maglevEngine.setHealth(id, '');
    if (!res.ok) showNotice({ tone: 'danger', text: res.message || "Couldn't try again." });
  }, [id, showNotice]);

  const handleBannerButton = useCallback(
    (button: BannerButtonId) => {
      switch (button) {
        case 'stop':
          sendFh({ type: 'STOP' });
          return;
        case 'again':
          sendFh({ type: 'AGAIN' });
          return;
        case 'folder':
          sendFh({ type: 'PICK_FOLDER' });
          return;
        case 'recheck':
          sendFh({ type: 'RECHECK' });
          return;
        case 'stopSharing':
          sendFh({ type: 'STOP_SHARING' });
          return;
        case 'freeSpace':
          void handleFreeSpace();
          return;
        case 'move':
          setMoveError(null);
          setMoveOpen(true);
          return;
        case 'keepTrying':
          void handleKeepTrying();
          return;
        case 'remove':
          void handleDelete(false);
          return;
      }
    },
    [handleDelete, handleFreeSpace, handleKeepTrying, sendFh],
  );

  const handleErrorAction = useCallback(
    (action: ErrorAction) => {
      switch (action) {
        case 'freeSpace':
          void handleFreeSpace();
          return;
        case 'move':
          setMoveOpen(true);
          return;
        case 'pickFolder':
          router.push('/settings/storage');
          return;
        case 'retry':
          void handlePlayPause();
          return;
        case 'filesMissing':
          // One file scan now. It sets the files_missing tag, and the SM-32 choices appear as a banner.
          void handleScanFiles();
          return;
        case 'recheck':
          void handleRecheck();
          return;
        case 'none':
          return;
      }
    },
    [handleFreeSpace, handlePlayPause, handleRecheck, handleScanFiles, router],
  );

  const headerActions = snap ? (
    <>
      {snap.state === 'CHECKING' || snap.state === 'INITIALIZING' || snap.state === 'MOVING' ? null : (
        <IconButton
          icon={
            snap.state === 'ERROR' ? 'retry' : snap.state === 'DOWNLOADING' || snap.state === 'SEEDING' || snap.state === 'QUEUED' ? 'pause' : 'play'
          }
          accessibilityLabel={
            snap.state === 'ERROR' ? 'Retry' : snap.state === 'DOWNLOADING' || snap.state === 'SEEDING' || snap.state === 'QUEUED' ? 'Pause' : 'Resume'
          }
          onPress={handlePlayPause}
        />
      )}
      <IconButton icon="more" accessibilityLabel="More options" onPress={() => setMoreOpen(true)} />
    </>
  ) : null;

  if (!id || status === 'missing') {
    return (
      <Screen title="Torrent" onBack={goBack}>
        <EmptyBlock
          icon="warning"
          error
          title="Torrent not found"
          body="It may have been removed."
          primary={{ label: 'Back to transfers', onPress: goBack }}
        />
      </Screen>
    );
  }

  if (status === 'loading' && !detail) {
    return (
      <Screen title="Torrent" onBack={goBack}>
        <View style={styles.centered} accessibilityLiveRegion="polite">
          <View style={styles.loadingBar}>
            <ProgressBar indeterminate accessibilityLabel="Loading torrent" />
          </View>
          <Text style={styles.muted}>Loading…</Text>
        </View>
      </Screen>
    );
  }

  if (status === 'error' && !detail) {
    return (
      <Screen title="Torrent" onBack={goBack}>
        <EmptyBlock
          icon="warning"
          error
          title="Couldn't load this torrent"
          body={error ?? undefined}
          primary={{ label: 'Retry', onPress: retry }}
          secondary={{ label: 'Back', onPress: goBack }}
        />
      </Screen>
    );
  }

  if (!snap || !detail) return null;

  const errorMap = snap.error ? actionsFor(snap.error.code, { pausedBy: snap.pausedBy }) : null;
  const errorButtons: { action: ErrorAction; label: string; variant: 'primary' | 'secondary' }[] = [];
  if (errorMap) {
    const labels: Record<ErrorAction, string> = {
      freeSpace: 'Free up space',
      move: 'Move',
      pickFolder: 'Pick folder again',
      filesMissing: 'Recheck',
      retry: 'Retry',
      recheck: 'Recheck',
      none: '',
    };
    if (errorMap.primary !== 'none') errorButtons.push({ action: errorMap.primary, label: labels[errorMap.primary], variant: 'primary' });
    if (errorMap.secondary) errorButtons.push({ action: errorMap.secondary, label: labels[errorMap.secondary], variant: 'secondary' });
  }

  // SM-32 has its own machine; SM-33 and SM-37 banners come from the health tag. A health banner replaces the error one.
  const healthBanner: HealthBanner | null = fileHealthBanner(fh) ?? healthBannerFor(snap.health);
  const healthBusy = fh.kind === 'working' || fh.kind === 'picking';
  const busyButton = fh.action === 'stop' ? 'stop' : fh.action === 'again' ? 'again' : fh.action === 'folder' ? 'folder' : fh.action === 'recheck' ? 'recheck' : null;
  const resolving =
    snap.state === 'INITIALIZING' && snap.resolvingSecs != null ? { peersSeen: snap.peersSeen, secs: snap.resolvingSecs } : null;
  const storageGone = snap.health === 'storage_unavailable' || snap.pausedBy === 'storage_unavailable';

  const moving = snap.state === 'MOVING';
  const frac = moving
    ? Math.min(1, Math.max(0, snap.moveProgress ?? 0))
    : snap.totalBytes > 0
      ? Math.min(1, snap.progressBytes / snap.totalBytes)
      : 0;
  const tone =
    snap.state === 'ERROR' ? 'error' : snap.state === 'PAUSED' ? 'paused' : snap.state === 'SEEDING' || snap.state === 'COMPLETED' ? 'seed' : 'download';

  const header = (
    <View>
      {notice ? (
        <View style={styles.block}>
          <Banner tone={notice.tone} title={notice.text} onDismiss={() => setNotice(null)} />
        </View>
      ) : null}
      {error ? (
        <View style={styles.block}>
          <Banner tone="warning" title="Updates paused" body={error} actionLabel="Retry" onAction={retry} />
        </View>
      ) : null}
      {healthBanner ? (
        <View style={styles.block}>
          <Banner tone={healthBanner.tone} title={healthBanner.title} body={fh.error} />
          <View style={styles.errorActions}>
            {healthBanner.buttons.map((b) => (
              <Button
                key={b.id}
                label={b.label}
                variant={b.variant}
                loading={healthBusy && busyButton === b.id}
                disabled={healthBusy}
                onPress={() => handleBannerButton(b.id)}
              />
            ))}
          </View>
        </View>
      ) : null}
      {snap.error && !healthBanner ? (
        <View style={styles.block}>
          <Banner tone="danger" title="This torrent has a problem" body={errorMap?.message} />
          {errorButtons.length ? (
            <View style={styles.errorActions}>
              {errorButtons.map((b) => (
                <Button key={b.action} label={b.label} variant={b.variant} onPress={() => handleErrorAction(b.action)} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={styles.summary}>
        <View style={styles.summaryTop}>
          <StateBadge state={snap.state} pausedBy={snap.pausedBy} moveProgress={snap.moveProgress} resumesAt={resumesAt} resolving={resolving} />
          <Text style={styles.percent} accessibilityLabel={`${(frac * 100).toFixed(1)} percent`}>
            {(frac * 100).toFixed(1)}%
          </Text>
        </View>
        <ProgressBar progress={frac} tone={tone} accessibilityLabel={moving ? 'Move progress' : 'Download progress'} />
        {limitSummary ? (
          <View style={styles.limitRow} accessibilityLabel={`Speed limit: ${limitSummary}`}>
            <PixelIcon name="speed-limit" size={16} color={colors.textMuted} />
            <Text style={styles.limitText}>{limitSummary}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.block}>
        <StatGrid
          stats={[
            { label: 'Download', value: formatSpeed(snap.downBps), tint: colors.download },
            { label: 'Upload', value: formatSpeed(snap.upBps), tint: colors.upload },
            { label: 'ETA', value: snap.etaSecs > 0 ? formatEta(snap.etaSecs) : '—' },
            { label: 'Ratio', value: snap.ratio >= 0 ? snap.ratio.toFixed(2) : '—' },
            { label: 'Peers', value: `${snap.peersLive}/${snap.peersSeen}` },
            { label: 'Size', value: snap.totalBytes > 0 ? formatBytes(snap.totalBytes) : '—' },
          ]}
        />
      </View>

      <View style={styles.block}>
        <SpeedChart downBps={snap.downBps} upBps={snap.upBps} sampleId={tick} />
      </View>

      <View style={styles.tabs}>
        <SegmentedControl options={TABS} value={tab} onChange={setTab} accessibilityLabel="Detail section" />
      </View>
      {tab === 'trackers' ? (
        <View style={styles.block}>
          <Button
            label="Add tracker"
            icon="plus"
            variant="secondary"
            fullWidth
            disabled={moving}
            onPress={() => sendTrk({ type: 'OPEN_ADD', existing: trackers.map((t) => t.url) })}
          />
        </View>
      ) : null}
    </View>
  );

  const emptyFor = (): React.ReactElement | null => {
    if (tab === 'files')
      return <EmptyBlock icon="file" title="No files yet" body="File info appears once the torrent has its metadata." />;
    if (tab === 'peers' && snap && snap.peersLive > 0)
      return <EmptyBlock icon="peers" title="Peer details aren't available yet" body={`${snap.peersLive} connected. The list fills in shortly.`} />;
    if (tab === 'peers')
      return <EmptyBlock icon="peers" title="No peers connected" body="Peers show up while the torrent is running." />;
    if (tab === 'trackers')
      return <EmptyBlock icon="tracker" title="No trackers" body="Peers can still be found without one. Add a tracker to look for more." />;
    return null;
  };

  const data: unknown[] = tab === 'files' ? files : tab === 'peers' ? detail.peers : tab === 'trackers' ? trackers : [];

  return (
    <Screen title={snap.name || 'Torrent'} onBack={goBack} actions={headerActions}>
      <FlatList
        data={data}
        keyExtractor={(item, i) => {
          if (tab === 'files') return String((item as DetailFile).index);
          if (tab === 'peers') return `${(item as { addr: string }).addr}-${i}`;
          return `${(item as { url: string }).url}-${i}`;
        }}
        renderItem={({ item }) => {
          if (tab === 'files')
            return (
              <FileListRow
                file={item as DetailFile}
                selecting={!!selection}
                selected={!!selection?.has((item as DetailFile).index)}
                paused={snap.state === 'PAUSED'}
                missing={missingSet.has((item as DetailFile).index)}
                hasActions={
                  (item as DetailFile).length > 0 &&
                  ((item as DetailFile).progressBytes >= (item as DetailFile).length || isStreamable((item as DetailFile).path))
                }
                onPress={handleFilePress}
                onLongPress={handleFileLongPress}
                onOpenActions={setFileSheet}
              />
            );
          if (tab === 'peers') return <PeerRow peer={item as never} />;
          return <TrackerRow tracker={item as never} onRemove={moving ? undefined : (t) => sendTrk({ type: 'ASK_REMOVE', url: t.url })} />;
        }}
        ListHeaderComponent={header}
        ListEmptyComponent={tab === 'pieces' ? undefined : (emptyFor() ?? undefined)}
        ListFooterComponent={
          tab === 'pieces' ? <PiecesMatrix cells={pieces} totalPieces={detail.pieceCount} /> : undefined
        }
        contentContainerStyle={styles.content}
        initialNumToRender={12}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        extraData={[selection, missingSet]}
      />

      {selection ? (
        <View style={[styles.selectBar, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <View style={styles.selectHead}>
            <IconButton icon="close" accessibilityLabel="Stop selecting" onPress={() => setSelection(null)} />
            <Text style={styles.selectCount}>{selection.size} selected</Text>
            <Button
              label={selection.size === files.length ? 'Select none' : 'Select all'}
              variant="ghost"
              onPress={() =>
                setSelection(selection.size === files.length ? null : new Set(files.map((f) => f.index)))
              }
            />
          </View>
          {/* The choices sit in the bar itself: no "Set priority" step and no sheet. Remove asks first. */}
          <View style={styles.selectActions} accessibilityRole="toolbar">
            <View style={styles.selectAction}>
              <Button label="First" icon="priority-first" variant="secondary" fullWidth
                accessibilityLabel="Download these first" onPress={() => void applyPriority([...selection], 'first')} />
            </View>
            <View style={styles.selectAction}>
              <Button label="Normal" icon="download" variant="secondary" fullWidth
                accessibilityLabel="Download these normally" onPress={() => void applyPriority([...selection], 'normal')} />
            </View>
            <View style={styles.selectAction}>
              <Button label="Skip" icon="checkbox-empty" variant="secondary" fullWidth
                accessibilityLabel="Don't download these" onPress={() => void applyPriority([...selection], 'skip')} />
            </View>
            <View style={styles.selectAction}>
              <Button label="Remove" icon="trash" variant="danger" fullWidth
                accessibilityLabel="Delete these files from your phone" onPress={() => askRemove([...selection])} />
            </View>
          </View>
        </View>
      ) : null}

      <PrioritySheet
        visible={!!prioTarget}
        skipBytes={prioTarget ? files.filter((f) => prioTarget.includes(f.index)).reduce((n, f) => n + f.length, 0) : undefined}
        onClose={() => {
          setPrioTarget(null);
          setPrioError(null);
        }}
        title={prioTarget && prioTarget.length > 1 ? `${prioTarget.length} files` : 'File priority'}
        subtitle={
          prioTarget && prioTarget.length === 1
            ? files.find((f) => f.index === prioTarget[0])?.path.split('/').pop()
            : undefined
        }
        current={(() => {
          if (!prioTarget) return null;
          const set = new Set(files.filter((f) => prioTarget.includes(f.index)).map((f) => f.priority));
          return set.size === 1 ? [...set][0] : null;
        })()}
        error={prioError}
        onSelect={(p) => prioTarget && applyPriority(prioTarget, p)}
        onRemove={prioTarget && prioTarget.length === 1 ? () => askRemove(prioTarget) : undefined}
      />
      <RemoveFilesSheet
        visible={removeState.kind === 'confirming' || removeState.kind === 'removing' || removeState.kind === 'failed'}
        count={removeState.indices.length}
        bytes={removeState.bytes}
        busy={removeState.kind === 'removing'}
        error={removeState.error ?? null}
        onClose={() => sendRemove({ type: 'CANCEL' })}
        onConfirm={() => sendRemove({ type: 'CONFIRM' })}
      />
      <TorrentMoreSheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        state={snap.state}
        retryInSecs={retryInSecs}
        onTogglePause={() => {
          setMoreOpen(false);
          void handlePlayPause();
        }}
        onRecheck={handleRecheck}
        onReannounce={handleReannounce}
        onCopyMagnet={handleCopyMagnet}
        onShareMagnet={handleShareMagnet}
        onSaveTorrent={handleSaveTorrent}
        storageGone={storageGone}
        limitSummary={limitSummary}
        onSpeedLimit={() => {
          setMoreOpen(false);
          setLimitOpen(true);
        }}
        onMove={() => {
          setMoreOpen(false);
          setMoveError(null);
          setMoveOpen(true);
        }}
        onOpenFolder={handleOpenFolder}
        onDelete={() => {
          setMoreOpen(false);
          setDeleteError(null);
          setDeleteOpen(true);
        }}
      />
      <DeleteSheet
        visible={deleteOpen}
        name={snap.name}
        busy={deleteBusy}
        error={deleteError}
        storageGone={storageGone}
        onClose={() => !deleteBusy && setDeleteOpen(false)}
        onRemove={() => handleDelete(false)}
        onDeleteFiles={() => handleDelete(true)}
      />
      <AddTrackerSheet
        visible={trk.kind === 'adding' || trk.kind === 'saving'}
        onClose={() => sendTrk({ type: 'CANCEL' })}
        busy={trk.kind === 'saving'}
        text={trk.text}
        onTextChange={(value) => sendTrk({ type: 'TEXT', value })}
        error={trk.error ?? null}
        count={trk.parsed.valid.length}
        onSubmit={() => sendTrk({ type: 'SUBMIT' })}
      />
      <RemoveTrackerSheet
        url={trk.kind === 'confirmRemove' || trk.kind === 'removing' ? (trk.url ?? null) : null}
        last={trackers.length <= 1}
        busy={trk.kind === 'removing'}
        onClose={() => sendTrk({ type: 'CANCEL' })}
        onRemove={() => sendTrk({ type: 'CONFIRM_REMOVE' })}
      />
      <SavedTorrentSheet saved={savedTorrent} onClose={() => setSavedTorrent(null)} />
      <SpeedLimitSheet visible={limitOpen} onClose={() => setLimitOpen(false)} limits={limits} onChange={handleLimits} />
      <MoveSheet
        visible={moveOpen}
        onClose={() => !moveBusy && setMoveOpen(false)}
        currentFolder={friendlyPath(snap.outputFolder)}
        busy={moveBusy}
        error={moveError?.text ?? null}
        pickAgain={moveError?.pickAgain}
        onDefault={() => startMove({ kind: 'default' })}
        onPick={handlePickMove}
      />
      <FileActionsSheet
        id={id}
        file={fileSheet}
        torrentState={snap.state}
        pausedBy={snap.pausedBy}
        onResume={() => resumeTorrent(id)}
        onNotice={(text) => showNotice({ tone: 'info', text })}
        onClose={() => setFileSheet(null)}
      />
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
    block: { marginBottom: spacing.md },
    errorActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
    summary: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      padding: spacing.lg,
      marginBottom: spacing.md,
      gap: spacing.md,
    },
    summaryTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    percent: { ...type.monoBold, fontSize: type.size.xxl, color: c.text },
    limitRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    limitText: { ...type.mono, fontSize: type.size.xs, color: c.textMuted },
    tabs: { marginBottom: spacing.md },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingHorizontal: spacing.xxxl },
    loadingBar: { width: '60%' },
    selectBar: {
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.bg,
    },
    selectHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    selectActions: { flexDirection: 'row', gap: spacing.sm },
    selectAction: { flex: 1 },
    selectCount: { ...type.bodyStrong, fontSize: type.size.lg, color: c.text, flex: 1 },
    muted: { ...type.body, fontSize: type.size.md, color: c.textMuted },
  });
