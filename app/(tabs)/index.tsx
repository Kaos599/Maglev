import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, BackHandler, Linking, StyleSheet, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderBar } from '../../components/HeaderBar';
import { FilterPills } from '../../components/FilterPills';
import { CARD_GAP, TransferCard } from '../../components/TransferCard';
import { DownloadCard } from '../../components/transfers/DownloadCard';
import { DownloadSheet } from '../../components/transfers/DownloadSheet';
import { FloatingActionButton } from '../../components/FloatingActionButton';
import { SpeedTelemetryHeader } from '../../components/SpeedTelemetryHeader';
import { BulkBar } from '../../components/transfers/BulkBar';
import { ClipboardChip } from '../../components/transfers/ClipboardChip';
import { DeleteSheet } from '../../components/transfers/DeleteSheet';
import { SortSheet } from '../../components/transfers/SortSheet';
import { TeachingEmptyState } from '../../components/transfers/TeachingEmptyState';
import { FILTERS, TransferFilter, countByFilter, downloadMatchesFilter, magnetHash, matchesFilter, sortTorrents } from '../../components/transfers/model';
import { PixelIcon } from '../../components/PixelIcon';
import { Banner, EmptyBlock, IconButton } from '../../components/ui/index';
import { ProgressMotionContext, type ProgressMotion } from '../../components/ui/ProgressBar';
import { steadyResolvingSecs } from '../../components/transfers/snapshots';
import { lowSpaceWarning, usableFreeOf, type LowSpaceWarning } from '../../components/transfers/lowSpace';
import * as DocumentPicker from 'expo-document-picker';
import { maglevEngine, type DownloadSnapshot } from 'maglev-engine';
import { haptic } from '../../constants/haptics';
import { useMaglevEngine } from '../../context/EngineContext';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { takeNextShared } from '../../utils/shareQueue';
import { allowDeviceFailureText, openFailureText, type DownloadAction } from '../../utils/downloadCopy';
import { BulkVerb, bulkSummary, selectionKey, splitSelection } from '../../utils/bulkSummary';
import { TransferSort, loadTransferSort, saveTransferSort } from '../../utils/prefs/transfers';
import { empty, notices } from '../../constants/copy';

const Separator = () => <View style={{ height: CARD_GAP }} />;
const keyOfTorrent = (t: { id: string }) => t.id;
/**
 * Off: the list is re-sorted by live values (speed, progress), and FlashList's default anchoring
 * would scroll to follow whichever card was on top. FlatList never did that; neither does this.
 */
const NO_ANCHOR = { disabled: true } as const;

/** How often free space is read while Transfers is on screen. */
const FREE_SPACE_EVERY_MS = 30_000;
/** Indeterminate bars sweep this many times, then rest (an endless sweep keeps Android from going idle). */
const LIST_SWEEPS = 3;

/**
 * The value as it was when the screen lost focus. Tabs stay mounted, so without this every
 * telemetry tick re-ran the list's filtering and sorting behind other tabs.
 */
function useHeldWhileBlurred<T>(value: T, focused: boolean): T {
  const held = useRef(value);
  if (focused) held.current = value;
  return held.current;
}

/** The row as the card shows it: the looking-for-peers time moves in steps, not every second. */
function steadyRow<T extends { resolvingSecs?: number | null }>(t: T): T {
  if (t.resolvingSecs == null) return t;
  const secs = steadyResolvingSecs(t.resolvingSecs);
  return secs === t.resolvingSecs ? t : { ...t, resolvingSecs: secs };
}

async function openStorageSettings() {
  try {
    await Linking.sendIntent('android.settings.INTERNAL_STORAGE_SETTINGS');
  } catch {
    await Linking.openSettings();
  }
}

export default function TransfersScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    telemetry: liveTelemetry,
    pauseTorrent,
    resumeTorrent,
    pauseAll,
    resumeAll,
    deleteTorrent,
    removeTorrents,
    notice,
    showNotice,
    dismissNotice,
    clipboardMagnet,
    clearClipboardMagnet,
    downloads: liveDownloads,
    pauseDownload,
    resumeDownload,
    retryDownload,
    removeDownload,
    refreshDownloadUrl,
    getFreeSpace,
  } = useMaglevEngine();
  const focused = useIsFocused();
  const telemetry = useHeldWhileBlurred(liveTelemetry, focused);
  const downloads = useHeldWhileBlurred(liveDownloads, focused);

  const [sort, setSort] = useState<TransferSort>(loadTransferSort);
  const [filter, setFilter] = useState<TransferFilter>('all');
  // An optional `filter` route param (from assistant links) is applied once, then cleared.
  const { filter: filterParam } = useLocalSearchParams<{ filter?: string }>();
  useEffect(() => {
    if (typeof filterParam !== 'string' || !filterParam) return;
    const wanted = FILTERS.find((f) => f.id === filterParam);
    if (wanted) setFilter(wanted.id);
    router.setParams({ filter: undefined });
  }, [filterParam, router]);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [fileError, setFileError] = useState<string | null>(null);
  const [sheetDownloadId, setSheetDownloadId] = useState<string | null>(null);

  const all = telemetry.torrents;
  const cruising = focused && (all.some((t) => t.state === 'DOWNLOADING') || downloads.some((d) => d.state === 'downloading'));
  // Downloads from links show above the torrents, obey the same filters, and obey the name filter.
  const shownDownloads = useMemo(() => {
    const q = query.trim().toLowerCase();
    return downloads.filter((d) => downloadMatchesFilter(d, filter) && (!q || d.name.toLowerCase().includes(q)));
  }, [downloads, filter, query]);
  const sheetDownload = useMemo(() => downloads.find((d) => d.id === sheetDownloadId) ?? null, [downloads, sheetDownloadId]);
  const openDownload = useCallback(
    (id: string) => {
      void maglevEngine.openDownload(id).then((res) => {
        if (!res.ok) showNotice({ message: openFailureText(res.code, res.message) });
      });
    },
    [showNotice],
  );
  const allowDevice = useCallback(
    (id: string) => {
      void maglevEngine.allowLanHost(id).then((res) => {
        if (!res.ok) showNotice({ message: allowDeviceFailureText(res.code, res.message) });
        else void retryDownload(id);
      });
    },
    [showNotice, retryDownload],
  );
  const onDownloadAction = useCallback(
    (d: DownloadSnapshot, action: DownloadAction) => {
      switch (action.kind) {
        case 'pause':
          void pauseDownload(d.id);
          break;
        case 'resume':
          void resumeDownload(d.id);
          break;
        case 'retry':
        case 'restart':
          void retryDownload(d.id);
          break;
        case 'newLink':
          setSheetDownloadId(d.id);
          break;
        case 'open':
          openDownload(d.id);
          break;
        case 'allowDevice':
          allowDevice(d.id);
          break;
      }
    },
    [pauseDownload, resumeDownload, retryDownload, openDownload, allowDevice],
  );
  const selectionMode = selectedIds.size > 0;

  const counts = useMemo(() => countByFilter(all, downloads), [all, downloads]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = all.filter((t) => matchesFilter(t, filter) && (!q || t.name.toLowerCase().includes(q)));
    return sortTorrents(filtered, sort);
  }, [all, filter, query, sort]);

  const anyRunning = useMemo(
    () =>
      all.some((t) => t.state === 'DOWNLOADING' || t.state === 'SEEDING' || t.state === 'QUEUED') ||
      downloads.some((d) => d.state === 'downloading' || d.state === 'queued'),
    [all, downloads],
  );
  const anyPaused = useMemo(
    () => all.some((t) => t.state === 'PAUSED') || downloads.some((d) => d.state === 'paused'),
    [all, downloads],
  );
  const nothingHere = all.length === 0 && downloads.length === 0;

  // Low-space banner. Free space and what unfinished downloads still need are read at the same
  // moment, so the numbers agree with each other (and the text changes every 30 s, not every tick).
  // Read again when the unfinished set changes. Unknown free space shows nothing.
  const [lowSpace, setLowSpace] = useState<LowSpaceWarning | null>(null);
  // Link downloads count too: a known size is what they still need, an unknown one needs nothing yet.
  const needRows = useMemo(
    () => [
      ...all,
      ...downloads.map((d) => ({ finished: d.state === 'finished', includedBytes: d.size ?? 0, downloadedBytes: d.downloaded })),
    ],
    [all, downloads],
  );
  const allRef = useRef(needRows);
  allRef.current = needRows;
  const unfinishedKey = useMemo(
    () =>
      [...all.filter((t) => !t.finished).map((t) => t.id), ...downloads.filter((d) => d.state !== 'finished').map((d) => `d:${d.id}`)].join(','),
    [all, downloads],
  );
  useEffect(() => {
    if (!focused) return;
    let alive = true;
    const read = () => {
      if (AppState.currentState === 'background') return;
      void getFreeSpace()
        .then((res) => {
          if (alive) setLowSpace(lowSpaceWarning(res.ok ? usableFreeOf(res) : null, allRef.current));
        })
        .catch(() => {
          if (alive) setLowSpace(null);
        });
    };
    read();
    const timer = setInterval(read, FREE_SPACE_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [focused, unfinishedKey, getFreeSpace]);

  const clipboardIsNew = useMemo(() => {
    if (!clipboardMagnet) return false;
    const hash = magnetHash(clipboardMagnet);
    return !(hash && all.some((t) => t.id.toLowerCase() === hash));
  }, [clipboardMagnet, all]);

  // Drop selections that no longer exist (deleted or removed elsewhere).
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const live = new Set([...all.map((t) => selectionKey('t', t.id)), ...downloads.map((d) => selectionKey('d', d.id))]);
    const next = new Set([...selectedIds].filter((key) => live.has(key)));
    if (next.size !== selectedIds.size) setSelectedIds(next);
  }, [all, downloads, selectedIds]);

  // The tab bar stays mounted and visible during selection. The bulk bar sits above it (the screen
  // ends where the tab bar begins), so no hide/show happens under the finger while a tap lands.
  // Hiding it used to re-show the bar in the same frame as the Pause tap, and the follow-up touch
  // reached the Search tab.

  // Android Back leaves selection mode before anything else.
  useEffect(() => {
    if (!selectionMode) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelectedIds(new Set());
      return true;
    });
    return () => sub.remove();
  }, [selectionMode]);

  const exitSelection = useCallback(() => setSelectedIds(new Set()), []);
  // Selection keys carry the kind ("t:" torrent, "d:" link download) so the two id spaces never collide.
  const toggleSelected = useCallback((key: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const startSelection = useCallback((id: string) => {
    haptic('select');
    setSelectedIds((prev) => (prev.has(selectionKey('t', id)) ? prev : new Set(prev).add(selectionKey('t', id))));
  }, []);
  const startDownloadSelection = useCallback((id: string) => {
    haptic('select');
    setSelectedIds((prev) => (prev.has(selectionKey('d', id)) ? prev : new Set(prev).add(selectionKey('d', id))));
  }, []);
  const selectableCount = visible.length + shownDownloads.length;
  const selectAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === selectableCount
        ? new Set()
        : new Set([...visible.map((t) => selectionKey('t', t.id)), ...shownDownloads.map((d) => selectionKey('d', d.id))]),
    );
  }, [visible, shownDownloads, selectableCount]);

  const onCardPress = useCallback(
    (id: string) => {
      if (selectionMode) toggleSelected(selectionKey('t', id));
      else router.push({ pathname: '/torrent/[id]', params: { id } });
    },
    [selectionMode, toggleSelected, router],
  );
  const onDownloadPress = useCallback(
    (id: string) => {
      if (selectionMode) toggleSelected(selectionKey('d', id));
      else setSheetDownloadId(id);
    },
    [selectionMode, toggleSelected],
  );
  const onPause = useCallback((id: string) => void pauseTorrent(id), [pauseTorrent]);
  const onResume = useCallback((id: string) => void resumeTorrent(id), [resumeTorrent]);
  // SM-37: clear the no_peers tag so the torrent looks for peers again.
  const onKeepTrying = useCallback(
    (id: string) => {
      void maglevEngine.setHealth(id, '').then((res) => {
        if (!res.ok) showNotice({ message: res.message || notices.common.retryFailed });
      });
    },
    [showNotice],
  );

  const changeSort = useCallback((next: TransferSort) => {
    setSort(next);
    saveTransferSort(next);
  }, []);

  const bulk = useCallback(
    async (verb: BulkVerb, torrentFn: (id: string) => Promise<boolean>, downloadFn: (id: string) => Promise<boolean>) => {
      const { torrents: tIds, downloads: dIds } = splitSelection(selectedIds);
      // Leave selection after the press has fully finished, never inside the onPress frame.
      setTimeout(exitSelection, 0);
      const results = await Promise.all([
        ...tIds.map((id) => torrentFn(id).catch(() => false)),
        ...dIds.map((id) => downloadFn(id).catch(() => false)),
      ]);
      // One notice for the whole action. It replaces the per-row "Couldn't pause X" notices.
      const summary = bulkSummary(verb, results);
      if (summary) showNotice({ message: summary });
    },
    [selectedIds, exitSelection, showNotice],
  );
  const selectedBytes = useMemo(
    () =>
      all.reduce((sum, t) => (selectedIds.has(selectionKey('t', t.id)) ? sum + t.downloadedBytes : sum), 0) +
      downloads.reduce((sum, d) => (selectedIds.has(selectionKey('d', d.id)) ? sum + d.downloaded : sum), 0),
    [all, downloads, selectedIds],
  );
  const confirmDelete = useCallback(
    (deleteFiles: boolean) => {
      setDeleteOpen(false);
      if (deleteFiles) {
        void bulk('Deleted', (id) => deleteTorrent(id, true), (id) => removeDownload(id, true));
      } else {
        // Keep files: torrent rows leave now and the notice offers Undo for 5 seconds. Link downloads go at once.
        const { torrents: tIds, downloads: dIds } = splitSelection(selectedIds);
        exitSelection();
        if (tIds.length > 0) removeTorrents(tIds);
        for (const id of dIds) void removeDownload(id, false);
      }
    },
    [bulk, deleteTorrent, removeTorrents, removeDownload, selectedIds, exitSelection],
  );

  // Files shared together: when this screen is focused again (the add flow closed), open the next one.
  useFocusEffect(
    useCallback(() => {
      const next = takeNextShared();
      if (next) router.push({ pathname: '/add-torrent', params: { source: next } });
    }, [router]),
  );

  const goAdd = useCallback(() => router.push('/add-torrent'), [router]);
  const addClipboard = useCallback(() => {
    if (!clipboardMagnet) return;
    router.push({ pathname: '/add-torrent', params: { source: clipboardMagnet } });
  }, [clipboardMagnet, router]);

  const openFile = useCallback(async () => {
    setFileError(null);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/x-bittorrent', 'application/octet-stream', '*/*'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.length) return;
      const asset = res.assets[0];
      if (!/\.torrent$/i.test(asset.name)) {
        setFileError(notices.inline.notTorrentFile);
        return;
      }
      router.push({ pathname: '/add-torrent', params: { source: asset.uri } });
    } catch {
      setFileError(notices.inline.openFileFailed);
    }
  }, [router]);

  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      if (open) setQuery('');
      return !open;
    });
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: (typeof visible)[number] }) => (
      <TransferCard
        torrent={steadyRow(item)}
        selectionMode={selectionMode}
        selected={selectedIds.has(selectionKey('t', item.id))}
        onPress={onCardPress}
        onLongPress={startSelection}
        onPause={onPause}
        onResume={onResume}
        onKeepTrying={onKeepTrying}
      />
    ),
    [selectionMode, selectedIds, onCardPress, startSelection, onPause, onResume, onKeepTrying],
  );

  // A new header element every render made the list re-render it on every telemetry tick.
  const listHeader = useMemo(
    () =>
      shownDownloads.length > 0 ? (
        <View style={styles.downloads}>
          {shownDownloads.map((d) => (
            <DownloadCard
              key={d.id}
              download={d}
              onPress={onDownloadPress}
              onAction={onDownloadAction}
              selectionMode={selectionMode}
              selected={selectedIds.has(selectionKey('d', d.id))}
              onLongPress={startDownloadSelection}
            />
          ))}
          {visible.length > 0 ? <Separator /> : null}
        </View>
      ) : undefined,
    [shownDownloads, visible.length, styles, onDownloadPress, onDownloadAction, selectionMode, selectedIds, startDownloadSelection],
  );
  const progressMotion = useMemo<ProgressMotion>(() => ({ active: focused, sweeps: LIST_SWEEPS }), [focused]);

  const filtering = filter !== 'all' || query.trim().length > 0;
  const filterLabel = FILTERS.find((f) => f.id === filter)?.label ?? '';
  const emptyFilter = query.trim() ? empty.transfers.noMatch : empty.transfers.noneInFilter(filterLabel);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <HeaderBar
        cruising={cruising}
        selection={
          selectionMode
            ? { count: selectedIds.size, allSelected: selectedIds.size === selectableCount, onClose: exitSelection, onSelectAll: selectAll }
            : undefined
        }
        actions={
          <>
            <IconButton icon="sort" accessibilityLabel="Sort transfers" onPress={() => setSortOpen(true)} />
            <IconButton
              icon="search"
              accessibilityLabel={searchOpen ? 'Close filter' : 'Filter transfers by name'}
              selected={searchOpen}
              color={searchOpen ? colors.accentText : undefined}
              onPress={toggleSearch}
            />
          </>
        }
      />

      {searchOpen && !selectionMode ? (
        <View style={styles.searchWrap}>
          <View style={styles.searchField}>
            <PixelIcon name="search" size={16} color={colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              placeholder="Filter by name"
              placeholderTextColor={colors.textFaint}
              value={query}
              onChangeText={setQuery}
              autoFocus
              returnKeyType="search"
              accessibilityLabel="Filter transfers by name"
            />
            {query.length > 0 ? <IconButton icon="close" size={16} accessibilityLabel="Clear filter text" onPress={() => setQuery('')} /> : null}
          </View>
        </View>
      ) : null}

      {lowSpace && !nothingHere ? (
        <View style={styles.lowSpace}>
          <Banner
            tone="warning"
            title={lowSpace.title}
            body={lowSpace.body}
            actionLabel="Free up space"
            onAction={() => void openStorageSettings()}
          />
        </View>
      ) : null}

      {!nothingHere ? (
        <SpeedTelemetryHeader
          downloadBytes={telemetry.totalDownloadSpeedBytes}
          uploadBytes={telemetry.totalUploadSpeedBytes}
          canPause={anyRunning && !selectionMode}
          canResume={!anyRunning && anyPaused && !selectionMode}
          onPauseAll={() => void pauseAll()}
          onResumeAll={() => void resumeAll()}
        />
      ) : null}

      {clipboardMagnet && clipboardIsNew && !selectionMode ? (
        <ClipboardChip link={clipboardMagnet} onAdd={addClipboard} onDismiss={clearClipboardMagnet} />
      ) : null}

      {fileError && all.length === 0 ? (
        <View style={styles.fileError}>
          <Banner tone="warning" title={fileError} onDismiss={() => setFileError(null)} />
        </View>
      ) : null}

      {nothingHere ? (
        <TeachingEmptyState canPaste={!!clipboardMagnet && clipboardIsNew} onPaste={addClipboard} onOpenFile={openFile} onSearch={() => router.navigate('/search')} onBrowse={() => router.push('/browser')} />
      ) : (
        <ProgressMotionContext.Provider value={progressMotion}>
          <FilterPills value={filter} counts={counts} onChange={setFilter} />
          {visible.length === 0 && shownDownloads.length === 0 ? (
            <View style={styles.noMatch}>
              <EmptyBlock
                icon="filter"
                title={emptyFilter.title}
                body={emptyFilter.body}
                primary={
                  filtering
                    ? {
                        label: 'Clear filters',
                        onPress: () => {
                          setFilter('all');
                          setQuery('');
                        },
                      }
                    : undefined
                }
              />
            </View>
          ) : (
            <FlashList
              data={visible}
              keyExtractor={keyOfTorrent}
              renderItem={renderItem}
              extraData={selectedIds}
              ItemSeparatorComponent={Separator}
              ListHeaderComponent={listHeader}
              contentContainerStyle={styles.listContent}
              maintainVisibleContentPosition={NO_ANCHOR}
              showsVerticalScrollIndicator={false}
            />
          )}
        </ProgressMotionContext.Provider>
      )}

      {selectionMode ? (
        <BulkBar
          disabled={false}
          onPause={() => void bulk('Paused', pauseTorrent, pauseDownload)}
          onResume={() => void bulk('Resumed', resumeTorrent, resumeDownload)}
          onDelete={() => setDeleteOpen(true)}
        />
      ) : (
        <FloatingActionButton onPress={goAdd} />
      )}

      {notice ? (
        <View style={styles.notice} pointerEvents="box-none">
          <Banner
            tone="info"
            title={notice.message}
            actionLabel={notice.actionLabel}
            onAction={notice.onAction}
            onDismiss={notice.actionLabel ? undefined : dismissNotice}
          />
        </View>
      ) : null}

      <DownloadSheet
        download={sheetDownload}
        onClose={() => setSheetDownloadId(null)}
        onRetry={(id) => void retryDownload(id)}
        onOpen={openDownload}
        onAllowDevice={allowDevice}
        onRemove={(id, deleteFiles) => void removeDownload(id, deleteFiles)}
        onNewLink={refreshDownloadUrl}
      />
      <SortSheet visible={sortOpen} sort={sort} onChange={changeSort} onClose={() => setSortOpen(false)} />
      <DeleteSheet visible={deleteOpen} count={selectedIds.size} bytes={selectedBytes} onClose={() => setDeleteOpen(false)} onConfirm={confirmDelete} />
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    searchWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
    searchField: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingLeft: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
    },
    searchInput: { ...type.mono, flex: 1, fontSize: 13, color: c.text, paddingVertical: 0 },
    fileError: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    lowSpace: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
    notice: { position: 'absolute', left: spacing.lg, right: spacing.lg, bottom: spacing.lg + 56 + spacing.sm },
    noMatch: { flex: 1, justifyContent: 'center' },
    downloads: { gap: CARD_GAP },
    listContent: { paddingTop: spacing.xs, paddingBottom: 96 },
  });
