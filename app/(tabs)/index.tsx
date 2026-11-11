import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, FlatList, StyleSheet, TextInput, View } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { useTabBarStyle } from '../../components/tabBarStyle';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderBar } from '../../components/HeaderBar';
import { FilterPills } from '../../components/FilterPills';
import { CARD_GAP, CARD_HEIGHT, TransferCard } from '../../components/TransferCard';
import { FloatingActionButton } from '../../components/FloatingActionButton';
import { SpeedTelemetryHeader } from '../../components/SpeedTelemetryHeader';
import { BulkBar } from '../../components/transfers/BulkBar';
import { ClipboardChip } from '../../components/transfers/ClipboardChip';
import { DeleteSheet } from '../../components/transfers/DeleteSheet';
import { SortSheet } from '../../components/transfers/SortSheet';
import { TeachingEmptyState } from '../../components/transfers/TeachingEmptyState';
import { FILTERS, TransferFilter, countByFilter, magnetHash, matchesFilter, sortTorrents } from '../../components/transfers/model';
import { PixelIcon } from '../../components/PixelIcon';
import { Banner, EmptyBlock, IconButton } from '../../components/ui/index';
import * as DocumentPicker from 'expo-document-picker';
import { triggerHaptic } from '../../constants/haptics';
import { useMaglevEngine } from '../../context/EngineContext';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { TransferSort, loadTransferSort, saveTransferSort } from '../../utils/prefs/transfers';

const ITEM_SPAN = CARD_HEIGHT + CARD_GAP;
const getItemLayout = (_: unknown, index: number) => ({ length: ITEM_SPAN, offset: ITEM_SPAN * index, index });
const Separator = () => <View style={{ height: CARD_GAP }} />;

export default function TransfersScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useNavigation();
  const tabBarStyle = useTabBarStyle();
  const {
    telemetry,
    pauseTorrent,
    resumeTorrent,
    pauseAll,
    resumeAll,
    deleteTorrent,
    removeTorrents,
    notice,
    dismissNotice,
    clipboardMagnet,
    clearClipboardMagnet,
  } = useMaglevEngine();

  const [sort, setSort] = useState<TransferSort>(loadTransferSort);
  const [filter, setFilter] = useState<TransferFilter>('all');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [fileError, setFileError] = useState<string | null>(null);

  const all = telemetry.torrents;
  const selectionMode = selectedIds.size > 0;

  const counts = useMemo(() => countByFilter(all), [all]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = all.filter((t) => matchesFilter(t, filter) && (!q || t.name.toLowerCase().includes(q)));
    return sortTorrents(filtered, sort);
  }, [all, filter, query, sort]);

  const anyRunning = useMemo(() => all.some((t) => t.state === 'DOWNLOADING' || t.state === 'SEEDING' || t.state === 'QUEUED'), [all]);
  const anyPaused = useMemo(() => all.some((t) => t.state === 'PAUSED'), [all]);

  const clipboardIsNew = useMemo(() => {
    if (!clipboardMagnet) return false;
    const hash = magnetHash(clipboardMagnet);
    return !(hash && all.some((t) => t.id.toLowerCase() === hash));
  }, [clipboardMagnet, all]);

  // Drop selections that no longer exist (deleted or removed elsewhere).
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const live = new Set(all.map((t) => t.id));
    const next = new Set([...selectedIds].filter((id) => live.has(id)));
    if (next.size !== selectedIds.size) setSelectedIds(next);
  }, [all, selectedIds]);

  // Selecting hides the tab bar so the bulk bar owns the bottom edge.
  useEffect(() => {
    navigation.setOptions({ tabBarStyle: selectionMode ? { display: 'none' } : tabBarStyle });
  }, [navigation, selectionMode, tabBarStyle]);

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
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const startSelection = useCallback((id: string) => {
    triggerHaptic('medium');
    setSelectedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  const selectAll = useCallback(() => {
    setSelectedIds((prev) => (prev.size === visible.length ? new Set() : new Set(visible.map((t) => t.id))));
  }, [visible]);

  const onCardPress = useCallback(
    (id: string) => {
      if (selectionMode) toggleSelected(id);
      else router.push({ pathname: '/torrent/[id]', params: { id } });
    },
    [selectionMode, toggleSelected, router],
  );
  const onPause = useCallback((id: string) => void pauseTorrent(id), [pauseTorrent]);
  const onResume = useCallback((id: string) => void resumeTorrent(id), [resumeTorrent]);

  const changeSort = useCallback((next: TransferSort) => {
    setSort(next);
    saveTransferSort(next);
  }, []);

  const bulk = useCallback(
    async (fn: (id: string) => Promise<boolean>) => {
      const ids = [...selectedIds];
      exitSelection();
      await Promise.all(ids.map(fn));
    },
    [selectedIds, exitSelection],
  );
  const selectedBytes = useMemo(
    () => all.reduce((sum, t) => (selectedIds.has(t.id) ? sum + t.downloadedBytes : sum), 0),
    [all, selectedIds],
  );
  const confirmDelete = useCallback(
    (deleteFiles: boolean) => {
      setDeleteOpen(false);
      if (deleteFiles) {
        void bulk((id) => deleteTorrent(id, true));
      } else {
        // Keep files: the rows leave now and the notice offers Undo for 5 seconds.
        const ids = [...selectedIds];
        exitSelection();
        removeTorrents(ids);
      }
    },
    [bulk, deleteTorrent, removeTorrents, selectedIds, exitSelection],
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
        setFileError("That isn't a .torrent file.");
        return;
      }
      router.push({ pathname: '/add-torrent', params: { source: asset.uri } });
    } catch {
      setFileError("Couldn't open that file.");
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
        torrent={item}
        selectionMode={selectionMode}
        selected={selectedIds.has(item.id)}
        onPress={onCardPress}
        onLongPress={startSelection}
        onPause={onPause}
        onResume={onResume}
      />
    ),
    [selectionMode, selectedIds, onCardPress, startSelection, onPause, onResume],
  );

  const filtering = filter !== 'all' || query.trim().length > 0;
  const filterLabel = FILTERS.find((f) => f.id === filter)?.label ?? '';
  const listBottom = 96;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <HeaderBar
        selection={
          selectionMode
            ? { count: selectedIds.size, allSelected: selectedIds.size === visible.length, onClose: exitSelection, onSelectAll: selectAll }
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

      {all.length > 0 ? (
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
        <ClipboardChip magnet={clipboardMagnet.startsWith('magnet:')} onAdd={addClipboard} onDismiss={clearClipboardMagnet} />
      ) : null}

      {fileError && all.length === 0 ? (
        <View style={styles.fileError}>
          <Banner tone="warning" title={fileError} onDismiss={() => setFileError(null)} />
        </View>
      ) : null}

      {all.length === 0 ? (
        <TeachingEmptyState canPaste={!!clipboardMagnet && clipboardIsNew} onPaste={addClipboard} onOpenFile={openFile} />
      ) : (
        <>
          <FilterPills value={filter} counts={counts} onChange={setFilter} />
          {visible.length === 0 ? (
            <View style={styles.noMatch}>
              <EmptyBlock
                icon="filter"
                title={query.trim() ? 'No matching transfers' : `No ${filterLabel.toLowerCase()} transfers`}
                body={query.trim() ? `Nothing matches "${query.trim()}".` : undefined}
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
            <FlatList
              data={visible}
              keyExtractor={(t) => t.id}
              renderItem={renderItem}
              extraData={selectedIds}
              ItemSeparatorComponent={Separator}
              getItemLayout={getItemLayout}
              contentContainerStyle={{ paddingTop: spacing.xs, paddingBottom: listBottom }}
              initialNumToRender={8}
              windowSize={7}
              showsVerticalScrollIndicator={false}
            />
          )}
        </>
      )}

      {selectionMode ? (
        <BulkBar
          disabled={false}
          onPause={() => void bulk(pauseTorrent)}
          onResume={() => void bulk(resumeTorrent)}
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
    notice: { position: 'absolute', left: spacing.lg, right: spacing.lg, bottom: spacing.lg + 56 + spacing.sm },
    noMatch: { flex: 1, justifyContent: 'center' },
  });
