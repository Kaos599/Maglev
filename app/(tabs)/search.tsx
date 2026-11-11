import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMaglevEngine } from '../../context/EngineContext';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon } from '../../components/PixelIcon';
import { Button, Chip, EmptyBlock, IconButton, Screen, SectionHeader } from '../../components/ui';
import { ResultRow } from '../../components/search/ResultRow';
import { SkeletonRows } from '../../components/search/SkeletonRows';
import { NoticeBanner, addErrorNotice, useNotice } from '../../components/search/Notice';
import { addRecentSearch, clearRecentSearches, getRecentSearches } from '../../utils/prefs/search';

interface SearchResult {
  id: string;
  infoHash: string;
  name: string;
  cat: number;
  sizeBytes: number;
  seeds: number;
  peers: number;
}

type Category = 'All' | 'Video' | 'Audio' | 'Apps' | 'Games' | 'Books' | 'Other';
const CATEGORIES: Category[] = ['All', 'Video', 'Audio', 'Apps', 'Games', 'Books', 'Other'];

// apibay category codes: 100 audio, 200 video, 300 apps, 400 games, 601 e-books, 600 other.
const CAT_PARAM: Record<Category, number> = { All: 0, Video: 200, Audio: 100, Apps: 300, Games: 400, Books: 601, Other: 600 };

const DEBOUNCE_MS = 400;
const TIMEOUT_MS = 8000;
const MIN_QUERY = 2;
const TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce', 'udp://tracker.torrent.eu.org:451/announce'];

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; results: SearchResult[] }
  | { kind: 'error'; message: string };

function magnetFor(r: SearchResult): string {
  return `magnet:?xt=urn:btih:${r.infoHash}&dn=${encodeURIComponent(r.name)}${TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;
}

async function searchApibay(query: string, category: Category, signal: AbortSignal): Promise<SearchResult[]> {
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=${CAT_PARAM[category]}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('bad response');
  if (data.length === 1 && (data[0].id === '0' || data[0].name === 'No results returned')) return [];
  const results: SearchResult[] = [];
  for (const item of data) {
    const hash = String(item.info_hash ?? '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hash)) continue;
    const cat = parseInt(item.category, 10) || 0;
    if (category === 'Other' && cat === 601) continue;
    results.push({
      id: hash,
      infoHash: hash,
      name: String(item.name ?? hash),
      cat,
      sizeBytes: parseInt(item.size, 10) || 0,
      seeds: parseInt(item.seeders, 10) || 0,
      peers: parseInt(item.leechers, 10) || 0,
    });
  }
  return results.sort((a, b) => b.seeds - a.seeds);
}

export default function SearchScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { startTorrent, telemetry } = useMaglevEngine();

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('All');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [recents, setRecents] = useState<string[]>(() => getRecentSearches());
  const [sessionAdded, setSessionAdded] = useState<Set<string>>(() => new Set());
  const [busyHash, setBusyHash] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const { notice, show, dismiss } = useNotice();
  const reqId = useRef(0);

  const trimmed = query.trim();

  useEffect(() => {
    reqId.current += 1;
    const mine = reqId.current;
    if (trimmed.length < MIN_QUERY) {
      setPhase({ kind: 'idle' });
      return;
    }
    setPhase({ kind: 'loading' });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const debounce = setTimeout(async () => {
      try {
        const results = await searchApibay(trimmed, category, controller.signal);
        if (reqId.current === mine) setPhase({ kind: 'done', results });
      } catch {
        if (reqId.current !== mine) return;
        setPhase({ kind: 'error', message: controller.signal.aborted ? 'The search took too long.' : 'Check your connection and try again.' });
      } finally {
        clearTimeout(timeout);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(debounce);
      clearTimeout(timeout);
      controller.abort();
    };
  }, [trimmed, category, retryTick]);

  const remember = useCallback((q: string) => {
    if (q.trim().length >= MIN_QUERY) setRecents(addRecentSearch(q));
  }, []);

  const inList = useMemo(() => new Set(telemetry.torrents.map((t) => t.id.toLowerCase())), [telemetry.torrents]);

  const handleAdd = useCallback(
    async (r: SearchResult) => {
      setBusyHash(r.infoHash);
      remember(trimmed);
      try {
        await startTorrent(magnetFor(r));
        setSessionAdded((prev) => new Set(prev).add(r.infoHash));
      } catch (e) {
        const { duplicate, notice: n } = addErrorNotice(e);
        if (duplicate) setSessionAdded((prev) => new Set(prev).add(r.infoHash));
        show(n);
      } finally {
        setBusyHash(null);
      }
    },
    [remember, show, startTorrent, trimmed],
  );

  const renderItem = useCallback(
    ({ item }: { item: SearchResult }) => (
      <ResultRow
        name={item.name}
        sizeBytes={item.sizeBytes}
        seeds={item.seeds}
        peers={item.peers}
        added={sessionAdded.has(item.infoHash) || inList.has(item.infoHash)}
        busy={busyHash === item.infoHash}
        onAdd={() => handleAdd(item)}
      />
    ),
    [busyHash, handleAdd, inList, sessionAdded],
  );

  let body: React.ReactNode;
  if (phase.kind === 'idle') {
    body = recents.length > 0 ? (
      <View style={styles.pad}>
        <View style={styles.recentsHead}>
          <SectionHeader title="Recent" />
          <Button
            label="Clear"
            variant="ghost"
            onPress={() => setRecents(clearRecentSearches())}
            accessibilityLabel="Clear recent searches"
          />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {recents.map((r) => (
            <Chip key={r} label={r} onPress={() => setQuery(r)} />
          ))}
        </ScrollView>
      </View>
    ) : (
      <EmptyBlock icon="search" title="Search public swarms" body="Type at least two letters. Results come from a public index." />
    );
  } else if (phase.kind === 'loading') {
    body = (
      <View style={styles.pad}>
        <SkeletonRows />
      </View>
    );
  } else if (phase.kind === 'error') {
    body = (
      <EmptyBlock
        icon="warning"
        error
        title="Search is unavailable right now"
        body={phase.message}
        primary={{ label: 'Retry', icon: 'retry', onPress: () => setRetryTick((n) => n + 1) }}
      />
    );
  } else if (phase.results.length === 0) {
    body = <EmptyBlock icon="search" title={`No results for "${trimmed}"`} body="Try fewer words or another category." />;
  } else {
    body = (
      <FlatList
        data={phase.results}
        keyExtractor={(r) => r.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={7}
      />
    );
  }

  return (
    <Screen title="Search">
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
            placeholder="Search torrents"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Search torrents"
          />
          {query.length > 0 ? <IconButton icon="close" size={16} onPress={() => setQuery('')} accessibilityLabel="Clear search" /> : null}
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.catScroll} contentContainerStyle={styles.chips}>
        {CATEGORIES.map((c) => (
          <Chip key={c} label={c} selected={c === category} onPress={() => setCategory(c)} />
        ))}
      </ScrollView>
      {notice ? (
        <View style={styles.pad}>
          <NoticeBanner notice={notice} onDismiss={dismiss} />
        </View>
      ) : null}
      <View style={styles.body}>{body}</View>
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    pad: { paddingHorizontal: spacing.lg },
    field: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 48,
      paddingLeft: spacing.lg,
      gap: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
    },
    input: { ...type.body, flex: 1, minHeight: 48, fontSize: 15, color: c.text },
    catScroll: { flexGrow: 0, marginTop: spacing.md, marginBottom: spacing.sm },
    chips: { paddingHorizontal: spacing.lg, gap: spacing.sm },
    recentsHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md },
    body: { flex: 1, marginTop: spacing.sm },
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
  });
