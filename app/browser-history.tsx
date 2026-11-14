import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useMaglevEngine } from '../context/EngineContext';
import { ThemeColors, radius, spacing, type } from '../constants/theme';
import { haptic } from '../constants/haptics';
import { empty, historyCopy, notices } from '../constants/copy';
import { PixelIcon } from '../components/PixelIcon';
import { EmptyBlock, IconButton, ListRow, PressableScale, Screen, Sheet } from '../components/ui';
import { ClearHistorySheet } from '../components/browser/ClearHistorySheet';
import { useBrowserPrefs } from '../utils/prefs/browser';
import {
  initHistory,
  listHistory,
  removeHost,
  removePages,
  restorePages,
  useHistoryVersion,
  type HistoryEntry,
} from '../utils/history';

/** Rows asked for at a time. */
const PAGE = 100;
/** How long Undo stays after a removal. */
const UNDO_MS = 5000;
const SEARCH_DEBOUNCE_MS = 200;

/** H2: Loading, then Ready (Empty, List, NoResults) or Failed. Paging and removing happen inside Ready. */
type Status = 'loading' | 'ready' | 'failed';

type Item = { kind: 'header'; key: string; label: string } | { kind: 'row'; key: string; entry: HistoryEntry };

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Today, Yesterday, or a weekday and date. */
function dayLabel(ms: number, now: number): string {
  const day = startOfDay(ms);
  const today = startOfDay(now);
  if (day === today) return historyCopy.today;
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (day === y.getTime()) return historyCopy.yesterday;
  try {
    return new Date(ms).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  } catch {
    return new Date(ms).toDateString();
  }
}

function timeLabel(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return new Date(ms).toTimeString().slice(0, 5);
  }
}

function group(rows: HistoryEntry[], now: number): Item[] {
  const out: Item[] = [];
  let last = '';
  for (const entry of rows) {
    const label = dayLabel(entry.lastVisited, now);
    if (label !== last) {
      last = label;
      out.push({ kind: 'header', key: `h:${label}`, label });
    }
    out.push({ kind: 'row', key: entry.url, entry });
  }
  return out;
}

export default function BrowserHistoryScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { showNotice } = useMaglevEngine();
  const [prefs] = useBrowserPrefs();
  const version = useHistoryVersion();

  const [status, setStatus] = useState<Status>('loading');
  const [rows, setRows] = useState<HistoryEntry[]>([]);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<HistoryEntry | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

  const rowsRef = useRef<HistoryEntry[]>([]);
  rowsRef.current = rows;
  const seq = useRef(0);

  // Search: the list follows the text after a short pause.
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);

  // Loading and List. Runs again for a new search, a store write (a removal, Undo, a clear) and Retry.
  // initHistory is idempotent; on a cold start it finishes the wipe or prune first, so the screen stays on Loading.
  const [attempt, setAttempt] = useState(0);
  const first = useRef(true);
  const prevQuery = useRef('');
  useEffect(() => {
    const mine = ++seq.current;
    // A new search or a first load asks for one page; a store write keeps what is already listed.
    const fresh = first.current || prevQuery.current !== query;
    prevQuery.current = query;
    const keep = fresh ? PAGE : Math.max(PAGE, rowsRef.current.length);
    if (first.current) setStatus('loading');
    (async () => {
      try {
        await initHistory();
        const r = await listHistory({ query: query || undefined, limit: keep });
        if (mine !== seq.current) return;
        first.current = false;
        setRows(r);
        setMore(r.length >= keep);
        setStatus('ready');
      } catch {
        if (mine !== seq.current) return;
        first.current = true;
        setStatus('failed');
      }
    })();
  }, [query, version, attempt]);

  const loadMore = useCallback(async () => {
    const last = rowsRef.current[rowsRef.current.length - 1];
    if (!last || !more || loadingMore || status !== 'ready') return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const r = await listHistory({ query: query || undefined, limit: PAGE, before: last.lastVisited });
      if (mine !== seq.current) return;
      const seen = new Set(rowsRef.current.map((x) => x.url));
      setRows((prev) => [...prev, ...r.filter((x) => !seen.has(x.url))]);
      setMore(r.length >= PAGE);
    } catch {
      setMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [more, loadingMore, status, query]);

  const open = useCallback(
    (url: string) => {
      haptic('tap');
      router.dismissTo({ pathname: '/browser', params: { url } });
    },
    [router],
  );

  // Removing: the rows go at once; Undo for 5 seconds puts them back exactly.
  const offerUndo = useCallback(
    (message: string, removed: HistoryEntry[]) => {
      if (removed.length === 0) return;
      showNotice(
        {
          message,
          actionLabel: 'Undo',
          onAction: () => {
            restorePages(removed).catch(() => showNotice({ message: notices.browser.historyRestoreFailed }, 3000));
          },
        },
        UNDO_MS,
      );
    },
    [showNotice],
  );

  const removeOne = useCallback(
    async (entry: HistoryEntry) => {
      setMenuFor(null);
      try {
        const removed = await removePages([entry.url]);
        haptic('done');
        offerUndo(notices.browser.historyRemoved, removed);
      } catch {
        haptic('fail');
        showNotice({ message: notices.browser.historyRemoveFailed }, 3000);
      }
    },
    [offerUndo, showNotice],
  );

  const removeAllFrom = useCallback(
    async (entry: HistoryEntry) => {
      setMenuFor(null);
      try {
        const removed = await removeHost(entry.host);
        haptic('done');
        offerUndo(notices.browser.historyHostRemoved(removed.length, entry.host), removed);
      } catch {
        haptic('fail');
        showNotice({ message: notices.browser.historyRemoveFailed }, 3000);
      }
    },
    [offerUndo, showNotice],
  );

  const items = useMemo(() => group(rows, Date.now()), [rows]);
  const searching = query !== '';

  const body = () => {
    if (status === 'loading') return <View style={styles.fill} accessibilityLiveRegion="polite" />;
    if (status === 'failed') {
      return (
        <EmptyBlock
          icon="warning"
          error
          title={empty.browser.historyFailed.title}
          body={empty.browser.historyFailed.body}
          primary={{
            label: historyCopy.retry,
            onPress: () => {
              haptic('tap');
              setStatus('loading');
              setAttempt((a) => a + 1);
            },
          }}
        />
      );
    }
    if (rows.length === 0) {
      const e = searching ? empty.browser.historyNoResults : prefs.saveHistory ? empty.browser.historyEmpty : empty.browser.historyOff;
      return <EmptyBlock icon="clock" title={e.title} body={e.body} />;
    }
    return (
      <FlatList
        data={items}
        keyExtractor={(i) => i.key}
        keyboardShouldPersistTaps="handled"
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        ListFooterComponent={loadingMore ? <Text style={styles.more}>{historyCopy.loadMore}</Text> : undefined}
        renderItem={({ item }) =>
          item.kind === 'header' ? (
            <Text style={styles.header} accessibilityRole="header">
              {item.label}
            </Text>
          ) : (
            <View style={styles.row}>
              <PressableScale
                onPress={() => open(item.entry.url)}
                accessibilityRole="button"
                accessibilityLabel={`${item.entry.title || item.entry.host}, ${item.entry.host}, ${timeLabel(item.entry.lastVisited)}`}
                style={styles.rowMain}
              >
                <Text style={styles.title} numberOfLines={1}>
                  {item.entry.title || item.entry.host}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {item.entry.host} · {timeLabel(item.entry.lastVisited)}
                </Text>
              </PressableScale>
              <IconButton
                icon="more"
                accessibilityLabel={historyCopy.rowMenuLabel(item.entry.title || item.entry.host)}
                onPress={() => setMenuFor(item.entry)}
              />
            </View>
          )
        }
      />
    );
  };

  return (
    <Screen
      title={historyCopy.title}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      edges={['top', 'left', 'right', 'bottom']}
      actions={
        <IconButton
          icon="trash"
          accessibilityLabel={historyCopy.clearLabel}
          disabled={status !== 'ready'}
          onPress={() => {
            haptic('warn');
            setClearOpen(true);
          }}
        />
      }
    >
      <View style={styles.search}>
        <PixelIcon name="search" size={16} color={colors.textMuted} />
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={historyCopy.searchPlaceholder}
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accent}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="search"
          accessibilityLabel={historyCopy.searchLabel}
        />
        {text ? <IconButton icon="close" accessibilityLabel="Clear search" onPress={() => setText('')} /> : null}
      </View>
      <View style={styles.fill}>{body()}</View>

      <Sheet
        visible={menuFor != null}
        onClose={() => setMenuFor(null)}
        title={menuFor ? menuFor.title || menuFor.host : historyCopy.title}
        subtitle={menuFor?.host}
      >
        <ListRow icon="trash" title={historyCopy.remove} onPress={() => menuFor && void removeOne(menuFor)} />
        <ListRow
          icon="trash"
          title={historyCopy.removeHost(menuFor?.host ?? '')}
          destructive
          onPress={() => menuFor && void removeAllFrom(menuFor)}
        />
      </Sheet>
      <ClearHistorySheet visible={clearOpen} mode="range" onClose={() => setClearOpen(false)} />
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1 },
    search: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: 44,
      marginHorizontal: spacing.lg,
      marginBottom: spacing.sm,
      paddingLeft: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
    },
    input: { ...type.body, flex: 1, minWidth: 0, fontSize: type.size.md, color: c.text, paddingVertical: 0, minHeight: 44 },
    header: { ...type.heading, fontSize: type.size.md, color: c.textMuted, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.xs },
    row: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.lg, paddingRight: spacing.xs },
    rowMain: { flex: 1, minHeight: 56, justifyContent: 'center', minWidth: 0 },
    title: { ...type.body, fontSize: type.size.md, color: c.text },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    more: { ...type.mono, fontSize: type.size.sm, color: c.textMuted, textAlign: 'center', padding: spacing.lg },
  });
