import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useMaglevEngine } from '../../context/EngineContext';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Banner, Button, Chip, EmptyBlock, Screen } from '../../components/ui';
import { FeedItemRow } from '../../components/feeds/FeedItemRow';
import { NewFeedSheet } from '../../components/feeds/NewFeedSheet';
import { SkeletonRows } from '../../components/search/SkeletonRows';
import { NoticeBanner, addErrorNotice, useNotice } from '../../components/search/Notice';
import {
  Feed,
  FeedItem,
  fetchFeed,
  hostOf,
  loadFeeds,
  loadSeen,
  normalizeFeedUrl,
  saveFeeds,
  saveSeen,
} from '../../utils/feeds';
import { syncFeedAutomationToNative } from '../../utils/prefs/feedAutomation';
import { banners, empty } from '../../constants/copy';

interface FeedState {
  status: 'loading' | 'ok' | 'error';
  items: FeedItem[];
  error?: string;
}

const ALL = 'all';

export default function FeedsScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { startTorrent, telemetry } = useMaglevEngine();

  const [feeds, setFeeds] = useState<Feed[]>(() => loadFeeds());
  const [states, setStates] = useState<Record<string, FeedState>>({});
  const [selected, setSelected] = useState<string>(ALL);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [seen, setSeen] = useState<Record<string, string[]>>(() => loadSeen());
  const [sessionAdded, setSessionAdded] = useState<Set<string>>(() => new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const { notice, show, dismiss } = useNotice();

  // Ids that were unseen when this visit began; keeps "new" stable while the screen is open.
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const statesRef = useRef(states);
  statesRef.current = states;

  const loadOne = useCallback(async (feed: Feed) => {
    setStates((p) => ({ ...p, [feed.id]: { status: 'loading', items: p[feed.id]?.items ?? [] } }));
    try {
      const parsed = await fetchFeed(feed.url);
      const items: FeedItem[] = parsed.items.map((i) => ({ ...i, feedId: feed.id }));
      setStates((p) => ({ ...p, [feed.id]: { status: 'ok', items } }));
      // First successful load of a feed seeds "seen" so a new feed does not report everything as new.
      if (!seenRef.current[feed.id]) {
        const next = { ...seenRef.current, [feed.id]: items.map((i) => i.id) };
        setSeen(next);
        saveSeen(next);
      }
    } catch (e) {
      setStates((p) => ({
        ...p,
        [feed.id]: { status: 'error', items: p[feed.id]?.items ?? [], error: e instanceof Error ? e.message : 'Could not load this feed.' },
      }));
    }
  }, []);

  const refreshAll = useCallback(
    async (list: Feed[]) => {
      await Promise.all(list.map(loadOne));
    },
    [loadOne],
  );

  useEffect(() => {
    void refreshAll(feeds.filter((f) => !statesRef.current[f.id]));
    // Initial load only; later changes call loadOne directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A show followed from Search adds a feed while this tab stays mounted: pick it up when the tab is shown.
  useFocusEffect(
    useCallback(() => {
      const latest = loadFeeds();
      setFeeds((prev) => (JSON.stringify(prev) === JSON.stringify(latest) ? prev : latest));
      const fresh = latest.filter((f) => !statesRef.current[f.id]);
      if (fresh.length > 0) void refreshAll(fresh);
    }, [refreshAll]),
  );

  // Leaving the tab marks everything shown as seen.
  useFocusEffect(
    useCallback(() => {
      return () => {
        const next = { ...seenRef.current };
        let changed = false;
        for (const [fid, st] of Object.entries(statesRef.current)) {
          if (st.status !== 'ok') continue;
          const merged = Array.from(new Set([...(next[fid] ?? []), ...st.items.map((i) => i.id)]));
          if (merged.length !== (next[fid] ?? []).length) {
            next[fid] = merged;
            changed = true;
          }
        }
        if (changed) {
          setSeen(next);
          saveSeen(next);
        }
      };
    }, []),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshAll(feeds);
    setRefreshing(false);
  }, [feeds, refreshAll]);

  const addFeed = useCallback(
    async (rawUrl: string): Promise<string | null> => {
      const url = normalizeFeedUrl(rawUrl);
      if (!url) return 'Enter a web address that starts with http:// or https://.';
      if (feeds.some((f) => f.url === url)) return 'You already follow this feed.';
      try {
        const parsed = await fetchFeed(url);
        const feed: Feed = {
          id: `feed_${Date.now().toString(36)}`,
          name: parsed.title.trim() || hostOf(url),
          url,
        };
        const items: FeedItem[] = parsed.items.map((i) => ({ ...i, feedId: feed.id }));
        const nextFeeds = [...feeds, feed];
        setFeeds(nextFeeds);
        saveFeeds(nextFeeds);
        void syncFeedAutomationToNative();
        setStates((p) => ({ ...p, [feed.id]: { status: 'ok', items } }));
        const nextSeen = { ...seenRef.current, [feed.id]: items.map((i) => i.id) };
        setSeen(nextSeen);
        saveSeen(nextSeen);
        setSelected(feed.id);
        setSheetOpen(false);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : 'Could not load this feed.';
      }
    },
    [feeds],
  );

  const removeFeed = useCallback(
    (feed: Feed) => {
      Alert.alert(`Remove ${feed.name}?`, 'Torrents you already added stay in your list.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            const next = feeds.filter((f) => f.id !== feed.id);
            setFeeds(next);
            saveFeeds(next);
            void syncFeedAutomationToNative();
            setStates((p) => {
              const { [feed.id]: _gone, ...rest } = p;
              return rest;
            });
            const nextSeen = { ...seenRef.current };
            delete nextSeen[feed.id];
            setSeen(nextSeen);
            saveSeen(nextSeen);
            setSelected(ALL);
          },
        },
      ]);
    },
    [feeds],
  );

  const feedById = useMemo(() => new Map(feeds.map((f) => [f.id, f])), [feeds]);
  const inList = useMemo(() => new Set(telemetry.torrents.map((t) => t.id.toLowerCase())), [telemetry.torrents]);

  const newCount = useMemo(() => {
    let n = 0;
    for (const f of feeds) {
      const st = states[f.id];
      if (!st) continue;
      const known = new Set(seen[f.id] ?? []);
      n += st.items.filter((i) => !known.has(i.id)).length;
    }
    return n;
  }, [feeds, states, seen]);

  const visibleFeeds = selected === ALL ? feeds : feeds.filter((f) => f.id === selected);
  const items = useMemo(() => {
    const all: FeedItem[] = [];
    for (const f of visibleFeeds) all.push(...(states[f.id]?.items ?? []));
    return all.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  }, [visibleFeeds, states]);
  const errored = visibleFeeds.filter((f) => states[f.id]?.status === 'error');
  const loadingAny = visibleFeeds.some((f) => !states[f.id] || states[f.id].status === 'loading');

  const isAdded = useCallback(
    (item: FeedItem) => sessionAdded.has(`${item.feedId}:${item.id}`) || (!!item.infoHash && inList.has(item.infoHash)),
    [inList, sessionAdded],
  );

  const handleAdd = useCallback(
    async (item: FeedItem) => {
      if (!item.source) return;
      const key = `${item.feedId}:${item.id}`;
      setBusyId(key);
      try {
        await startTorrent(item.source);
        setSessionAdded((p) => new Set(p).add(key));
      } catch (e) {
        const { duplicate, notice: n } = addErrorNotice(e);
        if (duplicate) setSessionAdded((p) => new Set(p).add(key));
        show(n);
      } finally {
        setBusyId(null);
      }
    },
    [show, startTorrent],
  );

  const renderItem = useCallback(
    ({ item }: { item: FeedItem }) => (
      <FeedItemRow
        title={item.title}
        feedName={feedById.get(item.feedId)?.name ?? ''}
        sizeBytes={item.sizeBytes}
        publishedAt={item.publishedAt}
        hasSource={!!item.source}
        added={isAdded(item)}
        busy={busyId === `${item.feedId}:${item.id}`}
        onAdd={() => handleAdd(item)}
      />
    ),
    [busyId, feedById, handleAdd, isAdded],
  );

  const sheet = <NewFeedSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} onSubmit={addFeed} />;

  if (feeds.length === 0) {
    return (
      <Screen title="Feeds">
        <EmptyBlock
          icon="feeds"
          title={empty.feeds.none.title}
          body={empty.feeds.none.body}
          primary={{ label: 'New feed', icon: 'plus', onPress: () => setSheetOpen(true) }}
          secondary={{ label: 'Auto-download rules', onPress: () => router.push('/settings/feeds' as never) }}
        />
        {sheet}
      </Screen>
    );
  }

  const selectedFeed = selected === ALL ? null : feedById.get(selected) ?? null;

  const header = (
    <View>
      {notice ? <NoticeBanner notice={notice} onDismiss={dismiss} /> : null}
      {errored.map((f) => (
        <View key={f.id} style={styles.errorWrap}>
          <Banner
            tone="danger"
            title={banners.feeds.loadFailed(f.name).title}
            body={states[f.id]?.error}
            actionLabel="Retry"
            onAction={() => void loadOne(f)}
          />
        </View>
      ))}
    </View>
  );

  return (
    <Screen title="Feeds">
      <View style={styles.sub}>
        <Text style={styles.subText} accessibilityLiveRegion="polite">
          {`${feeds.length} ${feeds.length === 1 ? 'feed' : 'feeds'} · ${newCount} new`}
        </Text>
        <Button label="New feed" icon="plus" onPress={() => setSheetOpen(true)} />
      </View>
      <View style={styles.autoRow}>
        <Button label="Auto-download rules" icon="rule" variant="ghost" onPress={() => router.push('/settings/feeds' as never)} />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll} contentContainerStyle={styles.chips}>
        <Chip label="All" selected={selected === ALL} onPress={() => setSelected(ALL)} />
        {feeds.map((f) => (
          <Chip key={f.id} label={f.name} selected={selected === f.id} onPress={() => setSelected(f.id)} />
        ))}
      </ScrollView>
      {selectedFeed ? (
        <View style={styles.feedBar}>
          <Text style={styles.feedHost} numberOfLines={1}>
            {hostOf(selectedFeed.url)}
          </Text>
          <Button label="Remove feed" variant="danger" onPress={() => removeFeed(selectedFeed)} />
        </View>
      ) : null}
      <FlatList
        data={items}
        keyExtractor={(i) => `${i.feedId}:${i.id}`}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={
          loadingAny ? (
            <SkeletonRows />
          ) : errored.length > 0 ? undefined : (
            <EmptyBlock icon="feeds" title={empty.feeds.nothingNew.title} body={empty.feeds.nothingNew.body} />
          )
        }
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.surface} />}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={7}
      />
      {sheet}
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    sub: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    subText: { ...type.mono, fontSize: 13, color: c.textMuted },
    autoRow: { paddingHorizontal: spacing.lg, alignItems: 'flex-start', paddingBottom: spacing.xs },
    chipScroll: { flexGrow: 0, marginBottom: spacing.sm },
    chips: { paddingHorizontal: spacing.lg, gap: spacing.sm },
    feedBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
    feedHost: { ...type.mono, flex: 1, fontSize: 12, color: c.textMuted, marginRight: spacing.md },
    errorWrap: { marginBottom: spacing.sm },
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl, flexGrow: 1 },
  });
