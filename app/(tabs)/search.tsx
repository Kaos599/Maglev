import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Dimensions, ScrollView, StyleSheet, Text, TextInput, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMaglevEngine } from '../../context/EngineContext';
import { useSettings } from '../../context/SettingsContext';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon } from '../../components/PixelIcon';
import { Button, Chip, EmptyBlock, IconButton, PressableScale, Screen, Sheet } from '../../components/ui';
import { ResultRow } from '../../components/search/ResultRow';
import { SKELETON_FIRST_COUNT, SKELETON_MORE_COUNT, SkeletonRows } from '../../components/search/SkeletonRows';
import { seenRowCount, stableOrder } from '../../components/search/stableOrder';
import { prefetchAllowed } from '../../components/search/prefetch';
import { magnetHash, metadataPrefetch } from '../../components/search/metadataCache';
import { useTabPrefs } from '../../components/tabs/tabPrefsStore';
import { FollowSheet } from '../../components/search/FollowSheet';
import { followRuleFromResult, type FollowTarget } from '../../utils/follow';
import { NoticeBanner, addErrorNotice, useNotice } from '../../components/search/Notice';
import { buildExtraProviders, loadExtraProviders } from '../../components/search/extra';
import { CATEGORY_LABEL, formatAge, providerMap } from '../../components/search/meta';
import { admit, oneTapDecision, pendingNeedOf } from '../../utils/admission';
import { formatBytes } from '../../constants/format';
import { riskySources } from '../../utils/search/safety';
import { addRecentSearch, clearRecentSearches, getSearchPrefs, removeRecentSearch, useSearchPrefs } from '../../utils/prefs/search';
import { availableCategories, eligibleProviders, mergeInto, rerunProvider, resolveResult, searchAll } from '../../utils/search/aggregate';
import { CloudflareSolverSheet } from '../../components/search/CloudflareSolverSheet';
import { nextNeedsCheck, shouldShowFixHint, tallySources } from '../../utils/search/answered';
import { formatAgeLong } from '../../utils/search/age';
import type { Category, MergedResult, SearchUpdate } from '../../utils/search/types';
import { ResultPreviewSheet } from '../../components/search/ResultPreviewSheet';
import { MobileDataSheet } from '../../components/search/MobileDataSheet';
import { passesResultFilter } from '../../components/search/sharing';
import { oneTapAddNote } from '../../utils/addChecks';
import { empty } from '../../constants/copy';

const DEBOUNCE_MS = 400;
const MIN_QUERY = 2;
/** The top row must hold its place this long, while sources still answer, before its file list is read. */
const PREFETCH_STABLE_MS = 1500;
/** After every source answered, a short pause so the read never competes with the last render. */
const PREFETCH_SETTLED_MS = 300;

const keyOfResult = (r: MergedResult) => r.infoHash;

/** The one line in the list that is not a result: "N sources need a quick check". */
interface FixHintItem {
  fixHint: true;
}
type ListItem = MergedResult | FixHintItem;
const FIX_AFTER = 3;

type SortKey = 'seeders' | 'newest' | 'size' | 'name';
const SORT_LABEL: Record<SortKey, string> = { seeders: 'Most shared', newest: 'Newest', size: 'Largest', name: 'Name' };
const SORT_ORDER: SortKey[] = ['seeders', 'newest', 'size', 'name'];
const MIN_SIZES: { label: string; bytes: number }[] = [
  { label: 'Any size', bytes: 0 },
  { label: 'Over 100 MB', bytes: 100e6 },
  { label: 'Over 1 GB', bytes: 1e9 },
];

/** Missing numbers sort last in every numeric order. */
function sortResults(list: MergedResult[], sort: SortKey): MergedResult[] {
  const num = (a: number | undefined, b: number | undefined) => (b ?? -1) - (a ?? -1);
  const copy = [...list];
  switch (sort) {
    case 'seeders':
      return copy.sort((a, b) => num(a.seeders, b.seeders));
    case 'newest':
      return copy.sort((a, b) => num(a.publishedAt, b.publishedAt));
    case 'size':
      return copy.sort((a, b) => num(a.sizeBytes, b.sizeBytes));
    case 'name':
      return copy.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export default function SearchScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { startTorrent, telemetry, getFreeSpace, downloads, onMeteredNetwork } = useMaglevEngine();
  const { settings } = useSettings();
  const [prefs, updatePrefs] = useSearchPrefs();

  const [query, setQuery] = useState('');
  // An optional `q` route param (from assistant links) prefills the query once, then is cleared.
  // The search effect below runs on the trimmed query, so setting it starts the search.
  const { q: qParam } = useLocalSearchParams<{ q?: string }>();
  useEffect(() => {
    if (typeof qParam !== 'string' || !qParam.trim()) return;
    setQuery(qParam);
    router.setParams({ q: undefined });
  }, [qParam, router]);
  const [searching, setSearching] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [update, setUpdate] = useState<SearchUpdate | null>(null);
  const [failed, setFailed] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [hideNoShare, setHideNoShare] = useState(false);
  const [minBytes, setMinBytes] = useState(0);
  const [preview, setPreview] = useState<MergedResult | null>(null);
  const [mobileAsk, setMobileAsk] = useState<{ result: MergedResult; note: string } | null>(null);
  const [recents, setRecents] = useState<string[]>(() => prefs.recents);
  const [sessionAdded, setSessionAdded] = useState<Set<string>>(() => new Set());
  const [busyHash, setBusyHash] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [confirm, setConfirm] = useState<{ result: MergedResult; reason: string } | null>(null);
  const [solving, setSolving] = useState<string | null>(null);
  // True while the user is working through the "needs a quick check" line: after one solve, the next opens.
  const fixing = useRef(false);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const tabs = useTabPrefs();
  const browserTabShown = !tabs.hidden.includes('browse');
  const [following, setFollowing] = useState<FollowTarget | null>(null);
  const followCache = useRef(new Map<string, FollowTarget | null>());
  const { notice, show, dismiss } = useNotice();
  const reqId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  // Stable order while sources answer (components/search/stableOrder.ts): the keys last shown, and
  // how far down the user has seen (bottom edge of the screen, in px of list content).
  const shownKeys = useRef<string[]>([]);
  const viewportH = useRef(0);
  // Before the list is measured, the window height stands in (more rows pinned, never fewer).
  const highWater = useRef(Dimensions.get('window').height);
  // Bumped when the user picks a sort (even the same one): rank every row again from the top.
  const [rankTick, setRankTick] = useState(0);

  const trimmed = query.trim();
  const providers = useMemo(() => providerMap(prefs), [prefs]);

  const extra = useMemo(() => buildExtraProviders(prefs.torznab), [prefs.torznab]);
  const engPrefs = useMemo(() => ({ ...prefs, extraProviders: extra }), [prefs, extra]);

  const categories = useMemo<Category[]>(() => {
    const list = availableCategories(engPrefs);
    return ['all', ...list.filter((c) => c !== 'all')];
  }, [engPrefs]);
  const category: Category = categories.includes(prefs.lastCategory) ? prefs.lastCategory : 'all';

  const eligible = useMemo(() => eligibleProviders(category, engPrefs), [category, engPrefs]);
  const onProviders = useMemo(
    () => prefs.enabled.map((id) => providers.get(id)).filter((p): p is NonNullable<typeof p> => !!p),
    [prefs.enabled, providers],
  );

  // Anything that changes what a search asks for restarts it. Sort and recents do not.
  const searchKey = JSON.stringify([prefs.enabled, prefs.useFor, prefs.mirrorOverride, prefs.adult, prefs.waitSeconds, prefs.limit, prefs.hideDead, prefs.torznab]);

  useEffect(() => {
    reqId.current += 1;
    const mine = reqId.current;
    shownKeys.current = [];
    highWater.current = viewportH.current || Dimensions.get('window').height;
    setUpdate(null);
    setFailed(false);
    setStopped(false);
    setSourceFilter(null);
    if (trimmed.length < MIN_QUERY) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const ctl = new AbortController();
    controller.current = ctl;
    const debounce = setTimeout(() => {
      const current = getSearchPrefs();
      loadExtraProviders(current.torznab).then((extraProviders) =>
        searchAll(trimmed, category, {
          ...current,
          extraProviders,
          signal: ctl.signal,
          onUpdate: (u: SearchUpdate) => {
            if (reqId.current !== mine) return;
            setUpdate(u);
            if (u.done) setSearching(false);
          },
        }),
      ).then(
        () => {
          if (reqId.current === mine) setSearching(false);
        },
        () => {
          if (reqId.current !== mine || ctl.signal.aborted) return;
          setFailed(true);
          setSearching(false);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(debounce);
      ctl.abort();
    };
    // searchKey stands in for the prefs fields a search depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, category, retryTick, searchKey]);

  // After the user passes a Cloudflare check: one re-run of that source only (SEARCH_CONTRACT section 8).
  const solvingProvider = solving ? providers.get(solving) : undefined;
  const handleSolved = useCallback(() => {
    const id = solving;
    setSolving(null);
    if (!id) return;
    updatePrefs((p) => ({ needsCheck: p.needsCheck.filter((x) => x !== id) }));
    const next = fixing.current
      ? (update?.sources ?? []).find((x) => x.state === 'challenge' && x.providerId !== id && providers.get(x.providerId)?.cloudflare)
      : undefined;
    if (next) setSolving(next.providerId);
    else fixing.current = false;
    const mine = reqId.current;
    setUpdate((u) => (u ? { ...u, sources: u.sources.map((s) => (s.providerId === id ? { ...s, state: 'searching' as const } : s)) } : u));
    loadExtraProviders(getSearchPrefs().torznab)
      .then((extraProviders) => rerunProvider(id, trimmed, category, { ...getSearchPrefs(), extraProviders }))
      .then((out) => {
        if (!out || reqId.current !== mine) return;
        setUpdate((u) =>
          u
            ? {
                ...u,
                results: mergeInto(u.results, out.results, getSearchPrefs().enabled),
                sources: u.sources.map((s) => (s.providerId === id ? out.status : s)),
              }
            : u,
        );
      })
      .catch(() => {});
  }, [solving, trimmed, category, update, providers, updatePrefs]);

  // Remember which sources sat behind a check, so Settings and the header dot can say so after the search is gone.
  useEffect(() => {
    if (!update?.done) return;
    const prev = getSearchPrefs().needsCheck;
    const next = nextNeedsCheck(prev, update.sources);
    if (next.length !== prev.length || next.some((id, i) => id !== prev[i])) updatePrefs({ needsCheck: next });
  }, [update, updatePrefs]);

  const stop = useCallback(() => {
    reqId.current += 1;
    controller.current?.abort();
    setSearching(false);
    setStopped(true);
  }, []);

  const remember = useCallback((q: string) => {
    if (q.trim().length >= MIN_QUERY) setRecents(addRecentSearch(q));
  }, []);

  // Keyed by the ids, not the array: telemetry ticks every second, and a new Set would re-render every row.
  const inListKey = useMemo(() => telemetry.torrents.map((t) => t.id.toLowerCase()).join(','), [telemetry.torrents]);
  const inList = useMemo(() => new Set(inListKey ? inListKey.split(',') : []), [inListKey]);

  const handleAdd = useCallback(
    async (r: MergedResult, skipMobileAsk = false) => {
      setBusyHash(r.infoHash);
      remember(trimmed);
      const wait = new AbortController();
      const timer = setTimeout(() => wait.abort(), 15000);
      try {
        // Some sources only show the magnet on a detail page: read it now.
        const ready = await resolveResult(r, wait.signal);
        // SM-35: the metadata size is not known before the add, so the search result's size decides.
        let tightNotice: string | null = null;
        const size = ready.sizeBytes ?? r.sizeBytes;
        if (size && size > 0) {
          try {
            const fs = await getFreeSpace();
            if (fs.ok) {
              const out = admit({
                freeBytes: Math.min(fs.freeBytes, fs.targetFreeBytes ?? fs.freeBytes),
                pendingNeed: pendingNeedOf(telemetry.torrents),
                stagingFactor: fs.mode === 'staging' ? 2 : 1,
                selectionBytes: size,
              });
              const decision = oneTapDecision(out.result);
              if (decision === 'openSheet') {
                // Doesn't fit: let the user pick files in the add flow instead of adding it all.
                router.push({ pathname: '/add-torrent', params: { source: ready.magnet } });
                return;
              }
              if (decision === 'addWithNotice') tightNotice = `Leaves ${formatBytes(out.leftAfter)} free`;
            }
          } catch {
            // Free space unknown: add as before.
          }
        }
        // On mobile data a big file should never start by surprise. With Wi-Fi only on, the add just waits.
        const mobileNote = oneTapAddNote({ sizeBytes: size, onMetered: onMeteredNetwork, wifiOnly: settings.network.wifiOnly });
        if (mobileNote && !settings.network.wifiOnly && !skipMobileAsk) {
          setMobileAsk({ result: r, note: mobileNote });
          return;
        }
        // Added directly: a background read of the same torrent is no longer needed.
        const readHash = magnetHash(ready.magnet);
        if (readHash) metadataPrefetch.cancelIf(readHash);
        await startTorrent(ready.magnet);
        setSessionAdded((prev) => new Set(prev).add(r.infoHash));
        show({
          tone: 'success',
          title: 'Added to Transfers',
          body: tightNotice ?? mobileNote ?? undefined,
          actionLabel: 'View',
          onAction: () => router.push('/' as never),
        });
      } catch (e) {
        const { duplicate, notice: n } = addErrorNotice(e);
        if (duplicate) setSessionAdded((prev) => new Set(prev).add(r.infoHash));
        show(n);
      } finally {
        clearTimeout(timer);
        setBusyHash(null);
      }
    },
    [remember, show, startTorrent, trimmed, getFreeSpace, telemetry.torrents, router, onMeteredNetwork, settings.network.wifiOnly],
  );

  // Tapping Add on a warned row asks first; with the warning off it is one tap.
  const requestAdd = useCallback(
    (r: MergedResult) => {
      const risky = riskySources(r, providers, prefs.warnUnsafe);
      if (!risky) {
        void handleAdd(r);
        return;
      }
      const reason = r.sources.map((id) => providers.get(id)?.unsafeReason).find((x): x is string => !!x) ?? '';
      setConfirm({ result: r, reason });
    },
    [handleAdd, providers, prefs.warnUnsafe],
  );

  const followTargetOf = useCallback(
    (r: MergedResult): FollowTarget | null => {
      const cat = r.category ?? category;
      const key = `${cat}|${trimmed}|${r.name}`;
      const cache = followCache.current;
      if (!cache.has(key)) {
        if (cache.size > 400) cache.clear();
        cache.set(key, followRuleFromResult(r.name, trimmed, cat));
      }
      return cache.get(key) ?? null;
    },
    [category, trimmed],
  );

  const onFollowed = useCallback(
    (target: FollowTarget, status: 'followed' | 'already') => {
      setFollowing(null);
      show({
        tone: 'success',
        title: status === 'already' ? `Already following ${target.title}` : `Following ${target.title}`,
        actionLabel: 'Open Feeds',
        onAction: () => router.push('/feeds' as never),
      });
    },
    [router, show],
  );

  const nameOf = useCallback((id: string) => providers.get(id)?.name ?? id, [providers]);

  // After Stop, sources that never answered are left out of the scoreboard.
  const sources = useMemo(() => (update?.sources ?? []).filter((s) => !(stopped && s.state === 'searching')), [update, stopped]);
  // A source behind a Cloudflare check, or one that failed, has not answered.
  const tally = useMemo(() => tallySources(sources), [sources]);
  const answered = tally.answered;
  const total = update?.sources.length ?? 0;

  // Rows the user has had on screen keep their slots while later sources answer; new rows are ranked
  // below them. A new sort, source filter or search ranks everything again (and the list starts at the top).
  const rankKey = `${prefs.sort}|${sourceFilter ?? ''}|${rankTick}|${hideNoShare}|${minBytes}`;
  const lastRankKey = useRef(rankKey);
  const shown = useMemo(() => {
    const base = update?.results ?? [];
    const bySource = sourceFilter ? base.filter((r) => r.sources.includes(sourceFilter)) : base;
    const filtered = bySource.filter((r) => passesResultFilter(r, { hideDead: hideNoShare, minBytes }));
    const ranked = sortResults(filtered, prefs.sort);
    if (lastRankKey.current !== rankKey) return ranked;
    return stableOrder(shownKeys.current, ranked, seenRowCount(highWater.current), keyOfResult);
  }, [update, sourceFilter, prefs.sort, rankKey, hideNoShare, minBytes]);
  useEffect(() => {
    if (lastRankKey.current !== rankKey) {
      lastRankKey.current = rankKey;
      highWater.current = viewportH.current || Dimensions.get('window').height;
    }
    shownKeys.current = shown.map(keyOfResult);
  }, [shown, rankKey]);

  const onListLayout = useCallback((e: LayoutChangeEvent) => {
    viewportH.current = e.nativeEvent.layout.height;
    if (highWater.current < viewportH.current) highWater.current = viewportH.current;
  }, []);
  const onListScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement } = e.nativeEvent;
    const edge = contentOffset.y + layoutMeasurement.height;
    if (edge > highWater.current) highWater.current = edge;
  }, []);

  // Look inside before the tap: read the top result's file list in the background, once it has held
  // its place (or every source answered), so Add -> choose files opens at once. One read at a time,
  // magnets only, never a download (components/search/prefetch.ts), and only when the network rule allows.
  const netOk = useMemo(
    () => prefetchAllowed({ wifiOnly: settings.network.wifiOnly, torrents: telemetry.torrents, downloads }),
    [settings.network.wifiOnly, telemetry.torrents, downloads],
  );
  const top = shown[0];
  const topMagnet = top && top.magnet && !sessionAdded.has(top.infoHash) && !inList.has(top.infoHash.toLowerCase()) ? top.magnet : null;
  const topKey = topMagnet ? magnetHash(topMagnet) : null;
  useEffect(() => {
    if (!topKey || !topMagnet || !netOk) return;
    const timer = setTimeout(() => {
      if (AppState.currentState === 'active') metadataPrefetch.start(topKey, topMagnet);
    }, searching ? PREFETCH_STABLE_MS : PREFETCH_SETTLED_MS);
    return () => clearTimeout(timer);
  }, [topKey, topMagnet, netOk, searching]);
  // A new top row, a new search, the network rule closing, or leaving the screen stops the read
  // (unless the Add screen already took it).
  useEffect(() => {
    if (!topKey || !netOk) return;
    return () => metadataPrefetch.cancelIf(topKey);
  }, [topKey, netOk]);

  // Sources that returned results, most first: the choices for "show only one source".
  const sourceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of update?.results ?? []) for (const id of r.sources) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [update]);

  const challenged = useMemo(() => sources.filter((s) => s.state === 'challenge' && providers.get(s.providerId)?.cloudflare), [sources, providers]);
  const showFix = shouldShowFixHint(Date.now(), prefs.fixHintDismissedAt, challenged.length);
  const startFix = useCallback(() => {
    const first = challenged[0];
    if (!first) return;
    fixing.current = true;
    setSolving(first.providerId);
  }, [challenged]);
  const needsCheckOn = prefs.needsCheck.filter((id) => prefs.enabled.includes(id)).length > 0;

  const fixBanner = useMemo(
    () => (
      <View style={styles.fix}>
        <View style={styles.fixMark} importantForAccessibility="no-hide-descendants">
          <Text style={styles.fixMarkText}>?</Text>
        </View>
        <View style={styles.fixText}>
          <Text style={styles.fixTitle}>{challenged.length === 1 ? '1 source needs a quick check' : `${challenged.length} sources need a quick check`}</Text>
          <Text style={styles.fixBody}>They'll add more results.</Text>
        </View>
        <Button label="Fix" variant="ghost" onPress={startFix} accessibilityLabel="Fix sources that need a quick check" />
        <IconButton icon="close" size={16} onPress={() => updatePrefs({ fixHintDismissedAt: Date.now() })} accessibilityLabel="Dismiss" />
      </View>
    ),
    [styles, challenged.length, startFix, updatePrefs],
  );

  const listData = useMemo<readonly ListItem[]>(() => {
    if (!showFix || shown.length === 0) return shown;
    return [...shown.slice(0, FIX_AFTER), { fixHint: true }, ...shown.slice(FIX_AFTER)];
  }, [shown, showFix]);

  const renderItem = useCallback(
    ({ item }: { item: ListItem }) =>
      'fixHint' in item ? (
        fixBanner
      ) : (
      <ResultRow
        name={item.name}
        category={item.category}
        sizeBytes={item.sizeBytes}
        seeders={item.seeders}
        leechers={item.leechers}
        age={formatAgeLong(item.publishedAt)}
        via={item.sources.map(nameOf).join(' · ')}
        risky={riskySources(item, providers, prefs.warnUnsafe)}
        added={sessionAdded.has(item.infoHash) || inList.has(item.infoHash)}
        busy={busyHash === item.infoHash}
        onAdd={() => requestAdd(item)}
        onOpen={() => setPreview(item)}
        onFollow={followTargetOf(item) ? () => setFollowing(followTargetOf(item)) : undefined}
      />
      ),
    [fixBanner, followTargetOf, busyHash, requestAdd, setPreview, inList, nameOf, sessionAdded, providers, prefs.warnUnsafe],
  );

  const openProviders = useCallback(() => router.push('/settings/search-providers' as never), [router]);

  const idle = trimmed.length < MIN_QUERY;
  const showRecents = focused && idle && recents.length > 0;
  const hasResults = (update?.results.length ?? 0) > 0;

  const enabledCount = prefs.enabled.length;
  let body: React.ReactNode;
  if (idle) {
    body =
      enabledCount === 0 ? (
        <EmptyBlock
          icon="search"
          title={empty.search.noSource.title}
          body={empty.search.noSource.body}
          primary={{ label: 'Change sources', onPress: openProviders }}
        />
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.idle}>
          <EmptyBlock
            icon="search"
            title={empty.search.idle(enabledCount).title}
            body={empty.search.idle(enabledCount).body}
          />
          <View style={styles.disclaimerRow}>
            <PixelIcon name="shield" size={16} color={colors.textMuted} />
            <Text style={styles.disclaimer}>Maglev doesn't host or index anything. You're responsible for what you download.</Text>
          </View>
        </ScrollView>
      );
  } else if (failed) {
    body = (
      <EmptyBlock
        icon="warning"
        error
        title={empty.search.unavailable.title}
        body={empty.search.unavailable.body}
        primary={{ label: 'Retry', icon: 'retry', onPress: () => setRetryTick((n) => n + 1) }}
      />
    );
  } else if (eligible.length === 0) {
    body = (
      <EmptyBlock
        icon="search"
        title={empty.search.noSource.title}
        body={empty.search.noSource.body}
        primary={{ label: 'Change sources', onPress: openProviders }}
      />
    );
  } else {
    const emptyResults =
      update && answered === 0 ? (
        <EmptyBlock
          icon="warning"
          error
          title={empty.search.noAnswer.title}
          body={empty.search.noAnswer.body}
          primary={{ label: 'Retry', icon: 'retry', onPress: () => setRetryTick((n) => n + 1) }}
        />
      ) : (
        <EmptyBlock icon="search" title={empty.search.noResults(trimmed).title} body={empty.search.noResults(trimmed).body} />
      );
    const list = (
      <View style={styles.listWrap} onLayout={onListLayout}>
        <FlashList
          key={rankKey}
          data={listData}
          keyExtractor={(item: ListItem) => ('fixHint' in item ? 'fix-hint' : keyOfResult(item))}
          getItemType={(item: ListItem) => ('fixHint' in item ? 'fix' : 'result')}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          onScroll={onListScroll}
          ListFooterComponent={searching && shown.length > 0 ? <SkeletonRows count={SKELETON_MORE_COUNT} /> : null}
          ListEmptyComponent={
            searching ? (
              <SkeletonRows count={SKELETON_FIRST_COUNT} />
            ) : (
              showFix ? (
                <>
                  {fixBanner}
                  {emptyResults}
                </>
              ) : (
                emptyResults
              )
            )
          }
        />
      </View>
    );
    body = (
      <>
        <View style={styles.sources} accessibilityLiveRegion="polite">
          {searching ? (
            <>
              <View style={styles.summaryRow}>
                <Text style={styles.summary}>{`Searching… ${answered} of ${total || eligible.length} sources`}</Text>
                <Button label="Stop" variant="ghost" onPress={stop} accessibilityLabel="Stop searching" />
              </View>
              <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <View style={[styles.trackFill, { width: `${Math.min(100, Math.round((answered / Math.max(1, total || eligible.length)) * 100))}%` }]} />
              </View>
            </>
          ) : (
            <View style={styles.summaryRow}>
              <Text style={styles.summary}>{`${stopped ? 'Stopped · ' : ''}${shown.length} ${shown.length === 1 ? 'result' : 'results'}`}</Text>
              {hasResults ? (
                <Button
                  label={SORT_LABEL[prefs.sort]}
                  icon="sort"
                  variant="ghost"
                  onPress={() => setSortOpen(true)}
                  accessibilityLabel={`Sort: ${SORT_LABEL[prefs.sort]}`}
                />
              ) : null}
            </View>
          )}
        </View>
        {list}
      </>
    );
  }

  return (
    <Screen
      title="Search"
      actions={
        <>
          {/* Labelled, not icon-only: people could not tell the globe opened the browser. Hidden when the Browser tab is on. */}
          {!browserTabShown ? (
            <PressableScale
              onPress={() => router.push('/browser')}
              style={styles.browserBtn}
              accessibilityRole="button"
              accessibilityLabel="Open the browser"
            >
              <PixelIcon name="network" size={16} color={colors.text} />
              <Text style={styles.browserText}>Browser</Text>
            </PressableScale>
          ) : null}
          <IconButton
            icon="filter"
            dot={needsCheckOn}
            onPress={openProviders}
            accessibilityLabel={`Sources, ${prefs.enabled.length} on${needsCheckOn ? ', some need a quick check' : ''}`}
          />
        </>
      }
    >
      <View style={styles.pad}>
        <View style={styles.field}>
          <PixelIcon name="search" size={20} color={colors.textMuted} />
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => {
              remember(query);
              setRetryTick((n) => n + 1);
            }}
            placeholder="Name, show, file…"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Search torrents"
            ref={inputRef}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
          {query.length > 0 ? <IconButton icon="close" size={16} onPress={() => setQuery('')} accessibilityLabel="Clear search" /> : null}
        </View>
        {showRecents ? (
          // A scroll view with handled taps: a tap on a row registers before the field loses focus.
          <ScrollView keyboardShouldPersistTaps="handled" scrollEnabled={false} style={styles.recentsWrap}>
            <View style={styles.recentsCard}>
              <View style={styles.recentsHead}>
                <Text style={styles.sectionLabel} accessibilityRole="header">
                  Recent
                </Text>
                <Button label="Clear" variant="ghost" onPress={() => setRecents(clearRecentSearches())} accessibilityLabel="Clear recent searches" />
              </View>
              {recents.map((r) => (
                <View key={r} style={styles.recentRow}>
                  <PressableScale
                    containerStyle={styles.recentMain}
                    style={styles.recentMainInner}
                    onPress={() => {
                      setQuery(r);
                      remember(r);
                      inputRef.current?.blur();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Search ${r}`}
                  >
                    <PixelIcon name="clock" size={16} color={colors.textMuted} />
                    <Text style={styles.recentText} numberOfLines={1}>
                      {r}
                    </Text>
                  </PressableScale>
                  <IconButton icon="close" size={16} onPress={() => setRecents(removeRecentSearch(r))} accessibilityLabel={`Remove ${r} from recent searches`} />
                </View>
              ))}
            </View>
          </ScrollView>
        ) : null}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catScroll} contentContainerStyle={styles.chips}>
        {categories.map((c) => (
          <Chip key={c} label={CATEGORY_LABEL[c]} selected={c === category} onPress={() => updatePrefs({ lastCategory: c })} />
        ))}
      </ScrollView>
      {notice ? (
        <View style={styles.pad}>
          <NoticeBanner notice={notice} onDismiss={dismiss} />
        </View>
      ) : null}
      <View style={styles.body}>{body}</View>
      {solvingProvider?.cloudflare ? (
        <CloudflareSolverSheet
          visible
          providerName={solvingProvider.name}
          solverUrl={solvingProvider.cloudflare.solverUrl}
          onClose={() => setSolving(null)}
          onSolved={handleSolved}
        />
      ) : null}
      <FollowSheet target={following} onClose={() => setFollowing(null)} onDone={onFollowed} />
      <Sheet visible={sortOpen} onClose={() => setSortOpen(false)} title="Sort and filter">
        <View style={styles.wrapRow}>
          {SORT_ORDER.map((s) => (
            <Chip
              key={s}
              label={SORT_LABEL[s]}
              selected={prefs.sort === s}
              onPress={() => {
                updatePrefs({ sort: s });
                setRankTick((n) => n + 1);
                setSortOpen(false);
              }}
            />
          ))}
        </View>
        {sourceCounts.length > 1 ? (
          <>
            <Text style={[styles.sectionLabel, styles.filterRow]} accessibilityRole="header">
              Source
            </Text>
            <View style={[styles.wrapRow, styles.sourceChips]}>
              <Chip label="All" selected={sourceFilter === null} onPress={() => setSourceFilter(null)} />
              {sourceCounts.map(([id, n]) => (
                <Chip key={id} label={`${nameOf(id)} ${n}`} selected={sourceFilter === id} onPress={() => setSourceFilter(id)} />
              ))}
            </View>
          </>
        ) : null}
        <View style={[styles.wrapRow, styles.filterRow]}>
          {MIN_SIZES.map((m) => (
            <Chip key={m.bytes} label={m.label} selected={minBytes === m.bytes} onPress={() => setMinBytes(m.bytes)} />
          ))}
          <Chip label="Hide no one sharing" selected={hideNoShare} onPress={() => setHideNoShare((v) => !v)} />
        </View>
      </Sheet>
      <ResultPreviewSheet
        result={
          preview
            ? {
                name: preview.name,
                sizeBytes: preview.sizeBytes,
                seeders: preview.seeders,
                leechers: preview.leechers,
                age: formatAge(preview.publishedAt),
                via: preview.sources.map(nameOf).join(' · '),
                detailUrl: preview.detailUrl,
                added: sessionAdded.has(preview.infoHash) || inList.has(preview.infoHash.toLowerCase()),
              }
            : null
        }
        onClose={() => setPreview(null)}
        onAdd={() => {
          const r = preview;
          setPreview(null);
          if (r) requestAdd(r);
        }}
        onOpenInBrowser={() => {
          const url = preview?.detailUrl;
          setPreview(null);
          if (url) router.push({ pathname: '/browser', params: { url } });
        }}
      />
      <MobileDataSheet
        note={mobileAsk?.note ?? null}
        onClose={() => setMobileAsk(null)}
        onConfirm={() => {
          const r = mobileAsk?.result;
          setMobileAsk(null);
          if (r) void handleAdd(r, true);
        }}
      />
      <Sheet visible={!!confirm} onClose={() => setConfirm(null)} title="Add from a risky source?" subtitle={confirm?.reason}>
        <View style={styles.confirmActions}>
          <Button
            label="Add anyway"
            fullWidth
            onPress={() => {
              const r = confirm?.result;
              setConfirm(null);
              if (r) void handleAdd(r);
            }}
          />
          <Button label="Cancel" variant="secondary" fullWidth onPress={() => setConfirm(null)} />
        </View>
      </Sheet>
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    pad: { paddingHorizontal: spacing.lg },
    confirmActions: { gap: spacing.sm },
    filterRow: { marginTop: spacing.md },
    field: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 48,
      paddingLeft: spacing.lg,
      paddingRight: spacing.xs,
      gap: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
    },
    input: { ...type.body, flex: 1, minHeight: 48, fontSize: 15, color: c.text },
    catScroll: { flexGrow: 0, marginTop: spacing.md, marginBottom: spacing.sm },
    chips: { paddingHorizontal: spacing.lg, gap: spacing.sm },
    idle: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xxxl, gap: spacing.xxl },
    recentsWrap: { flexGrow: 0, marginTop: spacing.sm },
    recentsCard: { borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, paddingBottom: spacing.xs },
    recentsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: spacing.lg, paddingRight: spacing.xs },
    recentRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.lg, paddingRight: spacing.xs },
    recentMain: { flex: 1, minHeight: 44 },
    recentMainInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
    recentText: { ...type.body, flex: 1, fontSize: 14, color: c.text },
    sourceChips: { marginTop: spacing.sm },
    sectionLabel: { ...type.bodyStrong, fontSize: 12, color: c.textMuted },
    wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    disclaimerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingTop: spacing.lg, borderTopWidth: 1, borderTopColor: c.border },
    disclaimer: { ...type.body, flex: 1, fontSize: 11, lineHeight: 16, color: c.textMuted, textAlign: 'left' },
    browserBtn: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2, height: 44, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: c.borderStrong, backgroundColor: c.surface },
    browserText: { ...type.bodyStrong, fontSize: 13, color: c.text },
    track: { height: 2, backgroundColor: c.border },
    trackFill: { height: 2, backgroundColor: c.accent },
    fix: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 64, paddingVertical: spacing.sm, paddingLeft: spacing.md, paddingRight: spacing.xs, marginBottom: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    fixMark: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm + 2, borderWidth: 1, borderColor: c.accent },
    fixMarkText: { ...type.monoBold, fontSize: 14, color: c.accentText },
    fixText: { flex: 1, gap: 2 },
    fixTitle: { ...type.bodyStrong, fontSize: 13, color: c.text },
    fixBody: { ...type.body, fontSize: 12, color: c.textMuted },
    sources: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm },
    summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
    summary: { ...type.body, flex: 1, fontSize: 12, lineHeight: 17, color: c.textMuted },
    body: { flex: 1, marginTop: spacing.sm },
    listWrap: { flex: 1 },
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
  });
