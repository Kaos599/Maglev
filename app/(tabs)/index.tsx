import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, BackHandler, Linking, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderBar } from '../../components/HeaderBar';
import { FilterPills } from '../../components/FilterPills';
import { CARD_GAP, TransferCard } from '../../components/TransferCard';
import { DownloadCard } from '../../components/transfers/DownloadCard';
import { closeOpenSwipe } from '../../components/transfers/SwipeRow';
import { useDownloadActions } from '../../components/transfers/useDownloadActions';
import { FloatingActionButton } from '../../components/FloatingActionButton';
import { SpeedTelemetryHeader } from '../../components/SpeedTelemetryHeader';
import { BulkBar } from '../../components/transfers/BulkBar';
import { SubtitleSheet } from '../../components/subtitles/SubtitleSheet';
import { useSubtitleAvailability } from '../../components/subtitles/useSubtitleEntry';
import { useSubtitleStateVersion } from '../../components/subtitles/useSubtitleStates';
import { cardIconModel, type SubtitleTarget } from '../../components/subtitles/flow';
import { recallTarget, stateFor } from '../../components/subtitles/stateStore';
import { ClipboardChip } from '../../components/transfers/ClipboardChip';
import { AddMenuSheet } from '../../components/add/AddMenuSheet';
import { ClearFinishedSheet } from '../../components/transfers/ClearFinishedSheet';
import { DeleteSheet } from '../../components/transfers/DeleteSheet';
import { playTorrentById } from '../../components/detail/playActions';
import { SortSheet } from '../../components/transfers/SortSheet';
import { TeachingEmptyState } from '../../components/transfers/TeachingEmptyState';
import { FILTERS, TransferFilter, countByFilter, downloadMatchesFilter, finishedTransfers, isHeldByFiles, magnetHash, matchesFilter, mergeTransfers, sortTorrents, type TransferItem } from '../../components/transfers/model';
import { Banner, Button, EmptyBlock, IconButton, TextField } from '../../components/ui/index';
import { ProgressMotionContext, type ProgressMotion } from '../../components/ui/ProgressBar';
import { steadyResolvingSecs } from '../../components/transfers/snapshots';
import { lowSpaceWarning, usableFreeOf, type LowSpaceWarning } from '../../components/transfers/lowSpace';
import { BlockBanner } from '../../components/transfers/BlockBanner';
import { BlockContextProvider, queueLimitOf, useActiveBlocks } from '../../utils/blocks/useActiveBlocks';
import * as DocumentPicker from 'expo-document-picker';
import { maglevEngine, openQuickShare, type DownloadSnapshot } from 'maglev-engine';
import { haptic } from '../../constants/haptics';
import { useEngineActions, useEngineState, useEngineTelemetry, type TransferTelemetry } from '../../context/EngineContext';
import { useSettings } from '../../context/SettingsContext';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing } from '../../constants/theme';
import { pickMainFile } from '../../utils/mainFile';
import { takeNextShared } from '../../utils/shareQueue';
import type { DownloadAction } from '../../utils/downloadCopy';
import { BulkVerb, bulkSummary, selectionKey, splitSelection } from '../../utils/bulkSummary';
import { useSearchPrefs } from '../../utils/prefs/search';
import { TransferSort, loadTransferSort, saveTransferSort } from '../../utils/prefs/transfers';
import { empty, notices, playCopy } from '../../constants/copy';
import { clipboardRoute, clipboardUsesCard } from '../../constants/clipboardCopy';
import { dismissClip, isDismissedClip } from '../../utils/prefs/clipboard';
import { openBrowser } from '../../utils/browser/openBrowser';

const Separator = () => <View style={{ height: CARD_GAP }} />;
const keyOfItem = (item: TransferItem<TransferTelemetry>) => item.key;
const typeOfItem = (item: TransferItem<TransferTelemetry>) => item.kind;
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
  const { settings } = useSettings();
  const [searchPrefs] = useSearchPrefs();
  const { telemetry: liveTelemetry, downloads: liveDownloads } = useEngineTelemetry();
  const { clipboardMagnet } = useEngineState();
  const {
    pauseTorrent,
    resumeTorrent,
    pauseAll,
    resumeAll,
    deleteTorrent,
    removeTransfers,
    // The notice banner is drawn by the global toast host in the root layout; here we only raise notices.
    showNotice,
    clearClipboardMagnet,
    pauseDownload,
    resumeDownload,
    removeDownload,
    getFreeSpace,
  } = useEngineActions();
  const focused = useIsFocused();
  const downloadActions = useDownloadActions();
  const subtitleAvail = useSubtitleAvailability();
  const subtitleVersion = useSubtitleStateVersion();
  const [subtitleTarget, setSubtitleTarget] = useState<SubtitleTarget | null>(null);
  const onCardSubtitles = useCallback((ownerKey: string) => {
    const t = recallTarget(ownerKey);
    if (t) setSubtitleTarget(t);
  }, []);
  const onTorrentSubtitles = useCallback((id: string) => onCardSubtitles(`t:${id}`), [onCardSubtitles]);
  const onDownloadSubtitles = useCallback((id: string) => onCardSubtitles(`d:${id}`), [onCardSubtitles]);
  // The card icon needs the switch on and a source on, like every other entry point; the stored state does the rest.
  const subtitleIcon = useCallback(
    (ownerKey: string) => (subtitleAvail.master && subtitleAvail.sourcesOn > 0 ? cardIconModel(stateFor(ownerKey), Date.now()) : null),
    // The version changes when any subtitle state is written.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subtitleAvail, subtitleVersion],
  );
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
  const [clearOpen, setClearOpen] = useState(false);

  const all = telemetry.torrents;
  const cruising = focused && (all.some((t) => t.state === 'DOWNLOADING') || downloads.some((d) => d.state === 'downloading'));
  // Link downloads obey the same filters and name filter as torrents, and share one sorted list with them.
  const shownDownloads = useMemo(() => {
    const q = query.trim().toLowerCase();
    return downloads.filter((d) => downloadMatchesFilter(d, filter) && (!q || d.name.toLowerCase().includes(q)));
  }, [downloads, filter, query]);
  // NATIVE_CONTRACT 40.4: the card buttons run the same handlers as the download page. "Paste new link" opens the page (40.1).
  const onDownloadAction = useCallback((d: DownloadSnapshot, action: DownloadAction) => downloadActions.run(d, action), [downloadActions]);
  const selectionMode = selectedIds.size > 0;
  const finished = useMemo(() => finishedTransfers(all, downloads), [all, downloads]);
  const finishedCount = finished.torrents.length + finished.downloads.length;

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

  // Why transfers are held (NATIVE_CONTRACT 35): one list for the banner and every card's line.
  const activeBlocks = useActiveBlocks();
  const queueLimit = queueLimitOf(settings.bandwidth.maxActiveDownloads);
  const blockCtx = useMemo(() => ({ blocks: activeBlocks, queueLimit }), [activeBlocks, queueLimit]);
  const hasUnfinished = useMemo(() => all.some((t) => !t.finished) || downloads.some((d) => d.state !== 'finished'), [all, downloads]);
  const hasSeedEligible = useMemo(() => all.some((t) => t.finished || t.state === 'SEEDING' || t.state === 'COMPLETED'), [all]);

  // Low-space banner. Free space and what unfinished downloads still need are read at the same
  // moment, so the numbers agree with each other (and the text changes every 30 s, not every tick).
  // Read again when the unfinished set changes. Unknown free space shows nothing.
  const [lowSpace, setLowSpace] = useState<LowSpaceWarning | null>(null);
  // Link downloads count too (SM-35): see pendingNeedOf for which states and sizes.
  const allRef = useRef(all);
  allRef.current = all;
  const downloadsRef = useRef(downloads);
  downloadsRef.current = downloads;
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
          if (alive) setLowSpace(lowSpaceWarning(res.ok ? usableFreeOf(res) : null, allRef.current, downloadsRef.current));
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
    if (!clipboardMagnet || isDismissedClip(clipboardMagnet)) return false;
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
      // NATIVE_CONTRACT 40.1: a tap on a link-download card opens its page.
      else router.push({ pathname: '/download/[id]', params: { id } });
    },
    [selectionMode, toggleSelected, router],
  );
  const onResumeAnyway = useCallback(
    (id: string) => {
      void maglevEngine.resumeAnyway(id).then((res) => {
        if (!res.ok) showNotice({ message: res.message || notices.common.retryFailed });
      });
    },
    [showNotice],
  );
  // A finished card's Open: the main file when there is one clear choice, else the detail screen (several videos).
  const onOpenTorrent = useCallback(
    (id: string) => {
      const toDetail = () => router.push({ pathname: '/torrent/[id]', params: { id } });
      void maglevEngine
        .getDetail(id)
        .then((res) => {
          const main = res.ok ? pickMainFile(res.files).main : null;
          if (!main) return toDetail();
          return maglevEngine.openFile(id, main.index).then((opened) => {
            if (!opened.ok) showNotice({ message: opened.message || 'No app can open this file.' });
          });
        })
        .catch(toDetail);
    },
    [router, showNotice],
  );
  // Play on a card (0.19): the file list is fetched, the largest video or audio file is picked, then it opens or streams.
  const playListRef = useRef(all);
  playListRef.current = all;
  const onPlay = useCallback(
    (id: string) => {
      const t = playListRef.current.find((x) => x.id === id);
      if (!t) return;
      void playTorrentById(id, t, () => resumeTorrent(id)).then((res) => {
        if (!res.ok) showNotice({ message: res.message || playCopy.failed });
        else if (res.resumed) showNotice({ message: playCopy.resumedToPlay });
      });
    },
    [resumeTorrent, showNotice],
  );
  const onPause = useCallback((id: string) => void pauseTorrent(id), [pauseTorrent]);
  const onResume = useCallback((id: string) => void resumeTorrent(id), [resumeTorrent]);
  // Swipe left and the Remove accessibility action: out of the list now, files kept, "Removed . Undo" for 5 seconds.
  const onSwipeRemove = useCallback((id: string) => removeTransfers([id], []), [removeTransfers]);
  const onSwipeRemoveDownload = useCallback((id: string) => removeTransfers([], [id]), [removeTransfers]);
  const swipeEnabled = settings.appearance.swipeActions;
  const showFileIcons = settings.appearance.showFileIcons;
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
    async (
      verb: BulkVerb,
      torrentFn: (id: string) => Promise<boolean>,
      downloadFn: (id: string) => Promise<boolean>,
      skipTorrent?: (id: string) => boolean,
    ) => {
      const { torrents: allTIds, downloads: dIds } = splitSelection(selectedIds);
      const tIds = skipTorrent ? allTIds.filter((id) => !skipTorrent(id)) : allTIds;
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
      all.reduce((sum, t) => (selectedIds.has(selectionKey('t', t.id)) ? sum + (t.heldBytes ?? t.downloadedBytes) : sum), 0) +
      downloads.reduce((sum, d) => (selectedIds.has(selectionKey('d', d.id)) ? sum + d.downloaded : sum), 0),
    [all, downloads, selectedIds],
  );
  const confirmDelete = useCallback(
    (deleteFiles: boolean) => {
      setDeleteOpen(false);
      if (deleteFiles) {
        void bulk('Deleted', (id) => deleteTorrent(id, true), (id) => removeDownload(id, true));
      } else {
        // Keep files: rows leave now and the notice offers Undo for 5 seconds, torrents and links alike.
        const { torrents: tIds, downloads: dIds } = splitSelection(selectedIds);
        exitSelection();
        removeTransfers(tIds, dIds);
      }
    },
    [bulk, deleteTorrent, removeTransfers, removeDownload, selectedIds, exitSelection],
  );

  // Files shared together: when this screen is focused again (the add flow closed), open the next one.
  useFocusEffect(
    useCallback(() => {
      const next = takeNextShared();
      if (next) router.push({ pathname: '/add-torrent', params: { source: next } });
    }, [router]),
  );

  // + opens a menu of every way in (paste, type, file, Search, Browser), not the torrent screen directly.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addFabRef = useRef<any>(null);
  const goAdd = useCallback(() => router.push('/add-torrent'), [router]);
  const addClipboard = useCallback(() => {
    if (!clipboardMagnet) return;
    // A plain file link opens the same quick share card as a share from another app: one tap to Download.
    if (clipboardUsesCard(clipboardMagnet) && openQuickShare(clipboardMagnet)) {
      dismissClip(clipboardMagnet);
      clearClipboardMagnet();
      return;
    }
    router.push(clipboardRoute(clipboardMagnet));
  }, [clipboardMagnet, clearClipboardMagnet, router]);
  const dismissClipboard = useCallback(() => {
    if (clipboardMagnet) dismissClip(clipboardMagnet);
    clearClipboardMagnet();
  }, [clipboardMagnet, clearClipboardMagnet]);

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

  const renderTorrent = useCallback(
    (item: TransferItem<TransferTelemetry> & { kind: 'torrent' }) => (
      <TransferCard
        torrent={steadyRow(item.torrent)}
        selectionMode={selectionMode}
        selected={selectedIds.has(selectionKey('t', item.torrent.id))}
        onPress={onCardPress}
        onLongPress={startSelection}
        onPause={onPause}
        onResume={onResume}
        onKeepTrying={onKeepTrying}
        onOpen={onOpenTorrent}
        onResumeAnyway={onResumeAnyway}
        onPlay={onPlay}
        onRemove={onSwipeRemove}
        swipeEnabled={swipeEnabled}
        subtitle={subtitleIcon(`t:${item.torrent.id}`)}
        onSubtitles={onTorrentSubtitles}
        showFileIcon={showFileIcons}
      />
    ),
    [selectionMode, selectedIds, onCardPress, startSelection, onPause, onResume, onKeepTrying, onOpenTorrent, onResumeAnyway, onPlay, onSwipeRemove, swipeEnabled, subtitleIcon, onTorrentSubtitles, showFileIcons],
  );
  // One list: torrents and link downloads, ordered by the current sort.
  const items = useMemo(() => mergeTransfers(visible, shownDownloads, sort), [visible, shownDownloads, sort]);
  const renderItem = useCallback(
    ({ item }: { item: TransferItem<TransferTelemetry> }) =>
      item.kind === 'torrent' ? (
        renderTorrent(item)
      ) : (
        <DownloadCard
          download={item.download}
          onPress={onDownloadPress}
          onAction={onDownloadAction}
          selectionMode={selectionMode}
          selected={selectedIds.has(selectionKey('d', item.download.id))}
          onLongPress={startDownloadSelection}
          onRemove={onSwipeRemoveDownload}
          swipeEnabled={swipeEnabled}
          subtitle={subtitleIcon(`d:${item.download.id}`)}
          onSubtitles={onDownloadSubtitles}
          showFileIcon={showFileIcons}
        />
      ),
    [renderTorrent, onDownloadPress, onDownloadAction, selectionMode, selectedIds, startDownloadSelection, onSwipeRemoveDownload, swipeEnabled, subtitleIcon, onDownloadSubtitles, showFileIcons],
  );
  const progressMotion = useMemo<ProgressMotion>(() => ({ active: focused, sweeps: LIST_SWEEPS }), [focused]);

  const filtering = filter !== 'all' || query.trim().length > 0;
  const filterLabel = FILTERS.find((f) => f.id === filter)?.label ?? '';
  const emptyFilter = query.trim() ? empty.transfers.noMatch : empty.transfers.noneInFilter(filterLabel);

  return (
    <BlockContextProvider value={blockCtx}>
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <HeaderBar
        cruising={cruising}
        selection={
          selectionMode
            ? {
                count: selectedIds.size,
                allSelected: selectedIds.size === selectableCount,
                onClose: exitSelection,
                onSelectAll: selectAll,
              }
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
          <TextField
            leadingIcon="search"
            clearable
            clearLabel="Clear filter text"
            size="lg"
            mono
            placeholder="Filter by name"
            value={query}
            onChangeText={setQuery}
            autoFocus
            returnKeyType="search"
            accessibilityLabel="Filter transfers by name"
          />
        </View>
      ) : null}

      {!nothingHere ? (
        <BlockBanner
          blocks={activeBlocks}
          hasUnfinished={hasUnfinished}
          hasSeedEligible={hasSeedEligible}
          lowSpace={lowSpace}
          onFreeSpace={() => void openStorageSettings()}
        />
      ) : null}

      {/* Off by default (Settings → Appearance → Speed totals); Pause all / Resume all also live in the notification. */}
      {settings.appearance.showSpeedTotals && !nothingHere ? (
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
        <ClipboardChip link={clipboardMagnet} onAdd={addClipboard} onDismiss={dismissClipboard} />
      ) : null}

      {fileError && all.length === 0 ? (
        <View style={styles.fileError}>
          <Banner tone="warning" title={fileError} onDismiss={() => setFileError(null)} />
        </View>
      ) : null}

      {nothingHere ? (
        <TeachingEmptyState onAdd={goAdd} onOpenFile={openFile} onSearch={() => router.navigate('/search')} onBrowse={() => openBrowser(router)} searchSources={searchPrefs.enabled.length} />
      ) : (
        <ProgressMotionContext.Provider value={progressMotion}>
          <FilterPills value={filter} counts={counts} onChange={setFilter} />
          {filter === 'done' && finishedCount > 0 && !selectionMode ? (
            <View style={styles.clearRow}>
              <Button label="Clear finished" icon="trash" variant="secondary" fullWidth onPress={() => setClearOpen(true)} />
            </View>
          ) : null}
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
              data={items}
              keyExtractor={keyOfItem}
              getItemType={typeOfItem}
              renderItem={renderItem}
              extraData={selectedIds}
              onScrollBeginDrag={closeOpenSwipe}
              ItemSeparatorComponent={Separator}
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
          onResume={() =>
            // NATIVE_CONTRACT 47.4: a torrent held by a file health tag needs Recheck, so Resume skips it.
            void bulk('Resumed', resumeTorrent, resumeDownload, (id) => {
              const t = all.find((x) => x.id === id);
              return !!t && isHeldByFiles(t);
            })
          }
          onDelete={() => setDeleteOpen(true)}
        />
      ) : (
        <>
          <FloatingActionButton buttonRef={addFabRef} onPress={() => setAddMenuOpen(true)} />
          <AddMenuSheet
            visible={addMenuOpen}
            returnFocusRef={addFabRef}
            onClose={() => setAddMenuOpen(false)}
            clipboard={clipboardMagnet ?? undefined}
            onPaste={addClipboard}
            onType={goAdd}
            onOpenFile={() => void openFile()}
            onSearch={() => router.navigate('/search')}
            onBrowse={() => openBrowser(router)}
          />
        </>
      )}

      <SubtitleSheet target={subtitleTarget} onClose={() => setSubtitleTarget(null)} />
      <ClearFinishedSheet
        visible={clearOpen}
        count={finished.torrents.length + finished.downloads.length}
        onClose={() => setClearOpen(false)}
        onConfirm={() => {
          setClearOpen(false);
          removeTransfers(finished.torrents, finished.downloads);
        }}
      />
      <SortSheet
        visible={sortOpen}
        sort={sort}
        onChange={changeSort}
        onClose={() => setSortOpen(false)}
        finishedCount={finishedCount}
        onClearFinished={() => {
          setSortOpen(false);
          setClearOpen(true);
        }}
      />
      <DeleteSheet visible={deleteOpen} count={selectedIds.size} bytes={selectedBytes} onClose={() => setDeleteOpen(false)} onConfirm={confirmDelete} />
    </View>
    </BlockContextProvider>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    clearRow: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    searchWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
    fileError: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    noMatch: { flex: 1, justifyContent: 'center' },
    listContent: { paddingTop: spacing.xs, paddingBottom: 96 }, // design-exception: bottom inset clears the floating add button
  });

export { ErrorBoundary } from '../../components/ErrorScreen';
