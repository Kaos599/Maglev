import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMaglevEngine } from '../../context/EngineContext';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon } from '../../components/PixelIcon';
import { Button, Chip, EmptyBlock, IconButton, Screen, Sheet } from '../../components/ui';
import { ResultRow } from '../../components/search/ResultRow';
import { SkeletonRows } from '../../components/search/SkeletonRows';
import { SourceScoreboard, ScoreboardEntry } from '../../components/search/SourceScoreboard';
import { SourcesCard } from '../../components/search/SourcesCard';
import { NoticeBanner, addErrorNotice, useNotice } from '../../components/search/Notice';
import { buildExtraProviders, loadExtraProviders } from '../../components/search/extra';
import { CATEGORY_LABEL, formatAge, providerMap } from '../../components/search/meta';
import { admit, oneTapDecision, pendingNeedOf } from '../../utils/admission';
import { formatBytes } from '../../constants/format';
import { riskySources } from '../../utils/search/safety';
import { addRecentSearch, clearRecentSearches, getSearchPrefs, useSearchPrefs } from '../../utils/prefs/search';
import { availableCategories, eligibleProviders, mergeInto, rerunProvider, resolveResult, searchAll } from '../../utils/search/aggregate';
import { CloudflareSolverSheet } from '../../components/search/CloudflareSolverSheet';
import { tallySources, unansweredNote } from '../../utils/search/answered';
import type { Category, MergedResult, SearchUpdate } from '../../utils/search/types';

const DEBOUNCE_MS = 400;
const MIN_QUERY = 2;

type SortKey = 'seeders' | 'newest' | 'size' | 'name';
const SORT_LABEL: Record<SortKey, string> = { seeders: 'Most seeders', newest: 'Newest', size: 'Largest', name: 'Name' };
const SORT_ORDER: SortKey[] = ['seeders', 'newest', 'size', 'name'];

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
  const { startTorrent, telemetry, getFreeSpace } = useMaglevEngine();
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
  const [recents, setRecents] = useState<string[]>(() => prefs.recents);
  const [sessionAdded, setSessionAdded] = useState<Set<string>>(() => new Set());
  const [busyHash, setBusyHash] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [confirm, setConfirm] = useState<{ result: MergedResult; reason: string } | null>(null);
  const [solving, setSolving] = useState<string | null>(null);
  const { notice, show, dismiss } = useNotice();
  const reqId = useRef(0);
  const controller = useRef<AbortController | null>(null);

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
  }, [solving, trimmed, category]);

  const stop = useCallback(() => {
    reqId.current += 1;
    controller.current?.abort();
    setSearching(false);
    setStopped(true);
  }, []);

  const remember = useCallback((q: string) => {
    if (q.trim().length >= MIN_QUERY) setRecents(addRecentSearch(q));
  }, []);

  const inList = useMemo(() => new Set(telemetry.torrents.map((t) => t.id.toLowerCase())), [telemetry.torrents]);

  const handleAdd = useCallback(
    async (r: MergedResult) => {
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
        await startTorrent(ready.magnet);
        setSessionAdded((prev) => new Set(prev).add(r.infoHash));
        if (tightNotice) show({ tone: 'info', title: tightNotice });
      } catch (e) {
        const { duplicate, notice: n } = addErrorNotice(e);
        if (duplicate) setSessionAdded((prev) => new Set(prev).add(r.infoHash));
        show(n);
      } finally {
        clearTimeout(timer);
        setBusyHash(null);
      }
    },
    [remember, show, startTorrent, trimmed, getFreeSpace, telemetry.torrents, router],
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

  const nameOf = useCallback((id: string) => providers.get(id)?.name ?? id, [providers]);

  // After Stop, sources that never answered are left out of the scoreboard.
  const sources = useMemo(() => (update?.sources ?? []).filter((s) => !(stopped && s.state === 'searching')), [update, stopped]);
  // A source behind a Cloudflare check, or one that failed, has not answered.
  const tally = useMemo(() => tallySources(sources), [sources]);
  const answered = tally.answered;
  const unanswered = unansweredNote(tally);
  const total = update?.sources.length ?? 0;

  const shown = useMemo(() => {
    const base = update?.results ?? [];
    const filtered = sourceFilter ? base.filter((r) => r.sources.includes(sourceFilter)) : base;
    return sortResults(filtered, prefs.sort);
  }, [update, sourceFilter, prefs.sort]);

  const entries: ScoreboardEntry[] = useMemo(() => sources.map((status) => ({ status, name: nameOf(status.providerId) })), [sources, nameOf]);

  const renderItem = useCallback(
    ({ item }: { item: MergedResult }) => (
      <ResultRow
        name={item.name}
        sizeBytes={item.sizeBytes}
        seeders={item.seeders}
        leechers={item.leechers}
        age={formatAge(item.publishedAt)}
        via={item.sources.map(nameOf).join(' · ')}
        risky={riskySources(item, providers, prefs.warnUnsafe)}
        added={sessionAdded.has(item.infoHash) || inList.has(item.infoHash)}
        busy={busyHash === item.infoHash}
        onAdd={() => requestAdd(item)}
      />
    ),
    [busyHash, requestAdd, inList, nameOf, sessionAdded, providers, prefs.warnUnsafe],
  );

  const openProviders = useCallback(() => router.push('/settings/search-providers' as never), [router]);

  const idle = trimmed.length < MIN_QUERY;
  const hasResults = (update?.results.length ?? 0) > 0;

  let body: React.ReactNode;
  if (idle) {
    body = (
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.idle}>
        {recents.length > 0 ? (
          <View>
            <View style={styles.recentsHead}>
              <Text style={styles.sectionLabel} accessibilityRole="header">
                Recent
              </Text>
              <Button label="Clear" variant="ghost" onPress={() => setRecents(clearRecentSearches())} accessibilityLabel="Clear recent searches" />
            </View>
            <View style={styles.wrapRow}>
              {recents.map((r) => (
                <Chip key={r} label={r} onPress={() => setQuery(r)} />
              ))}
            </View>
          </View>
        ) : null}
        <SourcesCard providers={onProviders} onChange={openProviders} />
        <Text style={styles.disclaimer}>Maglev doesn't host or index anything. You're responsible for what you download.</Text>
      </ScrollView>
    );
  } else if (failed) {
    body = (
      <EmptyBlock
        icon="warning"
        error
        title="Search is unavailable right now"
        body="Check your connection and try again."
        primary={{ label: 'Retry', icon: 'retry', onPress: () => setRetryTick((n) => n + 1) }}
      />
    );
  } else if (eligible.length === 0) {
    body = (
      <EmptyBlock
        icon="search"
        title="No source covers this category"
        body="Turn on a source that searches it."
        primary={{ label: 'Change sources', onPress: openProviders }}
      />
    );
  } else {
    const list = (
      <FlatList
        data={shown}
        keyExtractor={(r) => r.infoHash}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={7}
        ListFooterComponent={searching ? <SkeletonRows count={hasResults ? 2 : 5} /> : undefined}
        ListEmptyComponent={
          !searching ? (
            update && answered === 0 ? (
              <EmptyBlock
                icon="warning"
                error
                title="No source answered"
                body="Check your connection or try other sources."
                primary={{ label: 'Retry', icon: 'retry', onPress: () => setRetryTick((n) => n + 1) }}
              />
            ) : (
              <EmptyBlock icon="search" title={`No results for "${trimmed}"`} body="Try fewer words or another category." />
            )
          ) : undefined
        }
      />
    );
    body = (
      <>
        <View style={styles.sources} accessibilityLiveRegion="polite">
          <View style={styles.summaryRow}>
            <Text style={styles.summary}>
              {searching
                ? `${answered}/${total || eligible.length} sources answered, results appear as they arrive`
                : `${stopped ? 'Stopped. ' : ''}${answered}/${total} sources answered${unanswered ? ` · ${unanswered}` : ''} · ${update?.results.length ?? 0} results`}
            </Text>
            {!searching && hasResults ? (
              <Button
                label={SORT_LABEL[prefs.sort]}
                icon="sort"
                variant="ghost"
                onPress={() => setSortOpen(true)}
                accessibilityLabel={`Sort: ${SORT_LABEL[prefs.sort]}`}
              />
            ) : null}
          </View>
          {entries.length > 0 ? <SourceScoreboard entries={entries} selected={sourceFilter} onSelect={setSourceFilter} onSolve={(id) => providers.get(id)?.cloudflare && setSolving(id)} /> : null}
        </View>
        {list}
      </>
    );
  }

  return (
    <Screen
      title="Search"
      actions={
        <IconButton
          icon="filter"
          badge={prefs.enabled.length}
          selected={!!sourceFilter}
          onPress={openProviders}
          accessibilityLabel={`Search sources, ${prefs.enabled.length} on`}
        />
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
          />
          {searching ? (
            <Button label="Stop" variant="ghost" onPress={stop} accessibilityLabel="Stop searching" />
          ) : query.length > 0 ? (
            <IconButton icon="close" size={16} onPress={() => setQuery('')} accessibilityLabel="Clear search" />
          ) : null}
        </View>
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
      <Sheet visible={sortOpen}onClose={() => setSortOpen(false)} title="Sort results">
        <View style={styles.wrapRow}>
          {SORT_ORDER.map((s) => (
            <Chip
              key={s}
              label={SORT_LABEL[s]}
              selected={prefs.sort === s}
              onPress={() => {
                updatePrefs({ sort: s });
                setSortOpen(false);
              }}
            />
          ))}
        </View>
      </Sheet>
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
    recentsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    sectionLabel: { ...type.bodyStrong, fontSize: 12, color: c.textMuted },
    wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    disclaimer: { ...type.body, fontSize: 11, lineHeight: 16, color: c.textMuted },
    sources: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm },
    summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
    summary: { ...type.body, flex: 1, fontSize: 12, lineHeight: 17, color: c.textMuted },
    body: { flex: 1, marginTop: spacing.sm },
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
  });
