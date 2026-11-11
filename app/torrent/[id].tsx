import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { maglevEngine, type DetailFile, type FilePriority } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes, formatEta, formatSpeed } from '../../constants/format';
import { triggerHaptic } from '../../constants/haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Banner, Button, EmptyBlock, IconButton, ProgressBar, Screen, SegmentedControl } from '../../components/ui';
import { SpeedChart } from '../../components/SpeedChart';
import { PiecesMatrix } from '../../components/PiecesMatrix';
import { StateBadge } from '../../components/detail/StateBadge';
import { StatGrid } from '../../components/detail/StatGrid';
import { PeerRow, TrackerRow } from '../../components/detail/rows';
import { DeleteSheet, FileActionsSheet } from '../../components/detail/sheets';
import { FileListRow } from '../../components/detail/FileListRow';
import { PrioritySheet } from '../../components/detail/PrioritySheet';
import { TorrentMoreSheet } from '../../components/detail/TorrentMoreSheet';
import { useTorrentDetail } from '../../components/detail/useTorrentDetail';
import { buildMagnet, isMediaFile } from '../../components/detail/torrentLabels';

type Tab = 'files' | 'peers' | 'trackers' | 'pieces';

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
    [files, id, showNotice],
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
      await Clipboard.setStringAsync(buildMagnet(id, snap.name));
      triggerHaptic('success');
      showNotice({ tone: 'info', text: 'Magnet link copied.' });
    } catch {
      showNotice({ tone: 'danger', text: "Couldn't copy the magnet link." });
    }
  }, [id, snap, showNotice]);

  const handleRecheck = useCallback(async () => {
    setMoreOpen(false);
    if (!id) return;
    const res = await maglevEngine.recheck(id);
    showNotice(res.ok ? { tone: 'info', text: 'Checking files…' } : { tone: 'danger', text: res.message });
  }, [id, showNotice]);

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

  const headerActions = snap ? (
    <>
      {snap.state === 'CHECKING' || snap.state === 'INITIALIZING' ? null : (
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

  const frac = snap.totalBytes > 0 ? Math.min(1, snap.progressBytes / snap.totalBytes) : 0;
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
      {snap.error ? (
        <View style={styles.block}>
          <Banner tone="danger" title="This torrent has a problem" body={snap.error.message} actionLabel="Recheck" onAction={handleRecheck} />
        </View>
      ) : null}

      <View style={styles.summary}>
        <View style={styles.summaryTop}>
          <StateBadge state={snap.state} pausedBy={snap.pausedBy} />
          <Text style={styles.percent} accessibilityLabel={`${(frac * 100).toFixed(1)} percent`}>
            {(frac * 100).toFixed(1)}%
          </Text>
        </View>
        <ProgressBar progress={frac} tone={tone} accessibilityLabel="Download progress" />
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
    </View>
  );

  const emptyFor = (): React.ReactElement | null => {
    if (tab === 'files')
      return <EmptyBlock icon="file" title="No files yet" body="File info appears once the torrent has its metadata." />;
    if (tab === 'peers' && snap && snap.peersLive > 0)
      return <EmptyBlock icon="peers" title="Peer details aren't available yet" body={`${snap.peersLive} connected. The list fills in shortly.`} />;
    if (tab === 'peers')
      return <EmptyBlock icon="peers" title="No peers connected" body="Peers show up while the torrent is running." />;
    if (tab === 'trackers') return <EmptyBlock icon="tracker" title="No trackers" body="This torrent doesn't list any trackers." />;
    return null;
  };

  const data: unknown[] = tab === 'files' ? files : tab === 'peers' ? detail.peers : tab === 'trackers' ? detail.trackers : [];

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
                hasActions={
                  (item as DetailFile).length > 0 &&
                  ((item as DetailFile).progressBytes >= (item as DetailFile).length || isMediaFile((item as DetailFile).path))
                }
                onPress={handleFilePress}
                onLongPress={handleFileLongPress}
                onOpenActions={setFileSheet}
              />
            );
          if (tab === 'peers') return <PeerRow peer={item as never} />;
          return <TrackerRow tracker={item as never} />;
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
        extraData={selection}
      />

      {selection ? (
        <View style={[styles.selectBar, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <Text style={styles.selectCount}>{selection.size} selected</Text>
          <Button label="Cancel" variant="ghost" onPress={() => setSelection(null)} />
          <Button
            label="Set priority"
            onPress={() => {
              setPrioError(null);
              setPrioTarget([...selection]);
            }}
          />
        </View>
      ) : null}

      <PrioritySheet
        visible={!!prioTarget}
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
        onClose={() => !deleteBusy && setDeleteOpen(false)}
        onRemove={() => handleDelete(false)}
        onDeleteFiles={() => handleDelete(true)}
      />
      <FileActionsSheet id={id} file={fileSheet} onClose={() => setFileSheet(null)} />
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
    block: { marginBottom: spacing.md },
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
    tabs: { marginBottom: spacing.md },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, paddingHorizontal: spacing.xxxl },
    loadingBar: { width: '60%' },
    selectBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.bg,
    },
    selectCount: { ...type.bodyStrong, fontSize: type.size.lg, color: c.text, flex: 1 },
    muted: { ...type.body, fontSize: type.size.md, color: c.textMuted },
  });
