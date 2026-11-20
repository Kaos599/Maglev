import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { bookmarkCopy } from '../../constants/bookmarkCopy';
import { haptic } from '../../constants/haptics';
import { useBrowserPrefs } from '../../utils/prefs/browser';
import { listHistory, useHistoryVersion, type HistoryEntry } from '../../utils/history';
import { moveBookmark, useBookmarks, type Bookmark } from '../../utils/browser/bookmarks';
import { frequentSites, type FrequentSite } from '../../utils/browser/frequentSites';
import { EmptyBlock, ListRow, PressableScale } from '../ui';
import { BookmarkSheet } from './BookmarkSheet';
import { FloatingSheet, afterSheetCloses } from './FloatingSheet';
import { removeWithUndo } from './bookmarkActions';

/** How many recent pages and frequent sites the page lists. */
export const START_RECENT_LIMIT = 6;
export const START_FREQUENT_LIMIT = 8;
/** Bookmark tiles on the page; the rest are on the Bookmarks screen. */
export const START_BOOKMARK_LIMIT = 8;
/** History rows read to work out frequent sites. */
const HISTORY_SAMPLE = 300;

export interface StartPageProps {
  /** Opens an address. `newTab` is true for "Open in new tab"; otherwise it loads in the current tab. */
  onOpen: (url: string, opts?: { newTab?: boolean }) => void;
  /**
   * A private tab: Frequent sites and Recent are hidden, so the page never shows what normal browsing saved.
   * Bookmarks stay (they are the user's own choice).
   */
  privateMode?: boolean;
  /** Frequent sites to show instead of reading history here. Pass [] to hide the section. */
  frequent?: FrequentSite[];
}

/** The address without its scheme, as a row shows it. */
const shown = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
/** The glyph on a tile: the first letter or digit of the site, upper case. No favicon fetching, no network. */
export const siteInitial = (host: string) => ((host ?? '').replace(/^www\./i, '').match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();

/**
 * What a blank tab shows: Bookmarks, Frequent sites and Recent pages (the old RecentHistory list, now a section),
 * or one empty block when there is nothing at all. Tap opens; long-press on a bookmark offers Open in new tab,
 * Rename and Remove (with Undo).
 */
export function StartPage({ onOpen, privateMode = false, frequent }: StartPageProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { showNotice } = useMaglevEngine();
  const [prefs] = useBrowserPrefs();
  const version = useHistoryVersion();
  const bookmarks = useBookmarks();
  const [rows, setRows] = useState<HistoryEntry[]>([]);
  const [menu, setMenu] = useState<Bookmark | null>(null);
  const [renaming, setRenaming] = useState<Bookmark | null>(null);
  const [lastMenu, setLastMenu] = useState<Bookmark | null>(null);

  const readHistory = prefs.saveHistory && !privateMode;
  useEffect(() => {
    let live = true;
    if (!readHistory) {
      setRows([]);
      return;
    }
    listHistory({ limit: HISTORY_SAMPLE }).then(
      (r) => live && setRows(r),
      () => live && setRows([]),
    );
    return () => {
      live = false;
    };
  }, [readHistory, version]);

  const recent = readHistory ? rows.slice(0, START_RECENT_LIMIT) : [];
  const frequentList = useMemo(
    () => (privateMode ? [] : frequent ?? (readHistory ? frequentSites(rows, START_FREQUENT_LIMIT) : [])),
    [privateMode, frequent, readHistory, rows],
  );
  const nothing = bookmarks.length === 0 && frequentList.length === 0 && recent.length === 0;

  const open = (url: string, newTab?: boolean) => {
    haptic('tap');
    onOpen(url, newTab ? { newTab: true } : undefined);
  };
  const openMenu = (b: Bookmark) => {
    haptic('select');
    setLastMenu(b);
    setMenu(b);
  };
  const closeMenu = () => setMenu(null);
  const target = menu ?? lastMenu;
  const M = bookmarkCopy.menu;

  if (nothing) {
    return (
      <View style={styles.empty}>
        <EmptyBlock icon="bookmark" title={bookmarkCopy.empty.title} body={bookmarkCopy.empty.body} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.headerRow}>
        <Text style={styles.heading} accessibilityRole="header">
          {bookmarkCopy.section}
        </Text>
        {bookmarks.length > 0 ? (
          <PressableScale
            onPress={() => router.push('/browser-bookmarks')}
            accessibilityRole="button"
            accessibilityLabel={bookmarkCopy.seeAllBookmarksLabel}
            hitSlop={8}
            style={styles.seeAll}
          >
            <Text style={styles.seeAllText}>{bookmarkCopy.seeAll}</Text>
          </PressableScale>
        ) : null}
      </View>
      {bookmarks.length === 0 ? <Text style={styles.hint}>{bookmarkCopy.empty.body}</Text> : null}
      <View style={styles.grid} accessibilityLabel={bookmarkCopy.sectionLabel}>
        {bookmarks.slice(0, START_BOOKMARK_LIMIT).map((b) => (
          <Tile key={b.id} title={b.title} sub={b.host} glyph={siteInitial(b.host)} styles={styles} onPress={() => open(b.url)} onLongPress={() => openMenu(b)} hint={bookmarkCopy.tileHint} />
        ))}
      </View>

      {frequentList.length > 0 ? (
        <>
          <Text style={styles.heading} accessibilityRole="header">
            {bookmarkCopy.frequent}
          </Text>
          <View style={styles.grid} accessibilityLabel={bookmarkCopy.frequentLabel}>
            {frequentList.map((s) => (
              <Tile key={s.host} title={s.host} glyph={siteInitial(s.host)} styles={styles} onPress={() => open(s.url)} />
            ))}
          </View>
        </>
      ) : null}

      {recent.length > 0 ? (
        <>
          <View style={styles.headerRow}>
            <Text style={styles.heading} accessibilityRole="header">
              {bookmarkCopy.recent}
            </Text>
            <PressableScale
              onPress={() => router.push('/browser-history')}
              accessibilityRole="button"
              accessibilityLabel={bookmarkCopy.seeAllLabel}
              hitSlop={8}
              style={styles.seeAll}
            >
              <Text style={styles.seeAllText}>{bookmarkCopy.seeAll}</Text>
            </PressableScale>
          </View>
          <View accessibilityLabel={bookmarkCopy.recentLabel}>
            {recent.map((r) => (
              <PressableScale
                key={r.url}
                onPress={() => open(r.url)}
                accessibilityRole="button"
                accessibilityLabel={`${r.title || r.host}, ${shown(r.url)}`}
                style={styles.row}
              >
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {r.title || r.host}
                </Text>
                <Text style={styles.rowUrl} numberOfLines={1}>
                  {shown(r.url)}
                </Text>
              </PressableScale>
            ))}
          </View>
        </>
      ) : null}

      <FloatingSheet visible={menu != null} onClose={closeMenu} title={target?.title ?? ''} subtitle={target?.host}>
        <ListRow
          icon="plus"
          title={M.openNewTab}
          onPress={() => {
            closeMenu();
            if (target) open(target.url, true);
          }}
        />
        {target && bookmarks[0]?.id !== target.id ? (
          <ListRow
            icon="arrow-up"
            title={M.moveToTop}
            onPress={() => {
              closeMenu();
              moveBookmark(target.id, 0);
            }}
          />
        ) : null}
        <ListRow
          icon="pencil"
          title={M.rename}
          onPress={() => {
            closeMenu();
            const b = target;
            if (b) afterSheetCloses(() => setRenaming(b));
          }}
        />
        <ListRow
          icon="trash"
          title={M.remove}
          destructive
          onPress={() => {
            closeMenu();
            if (target) removeWithUndo(target.id, showNotice);
          }}
        />
      </FloatingSheet>
      <BookmarkSheet visible={renaming != null} onClose={() => setRenaming(null)} url={renaming?.url ?? ''} title={renaming?.title ?? ''} />
    </ScrollView>
  );
}

function Tile({
  title,
  sub,
  glyph,
  styles,
  onPress,
  onLongPress,
  hint,
}: {
  title: string;
  sub?: string;
  glyph: string;
  styles: ReturnType<typeof makeStyles>;
  onPress: () => void;
  onLongPress?: () => void;
  hint?: string;
}) {
  return (
    <PressableScale
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={sub ? `${title}, ${sub}` : title}
      accessibilityHint={hint}
      containerStyle={styles.tileOuter}
      style={styles.tile}
    >
      <View style={styles.glyph}>
        <Text style={styles.glyphText}>{glyph}</Text>
      </View>
      <View style={styles.tileText}>
        <Text style={styles.tileTitle} numberOfLines={1}>
          {title}
        </Text>
        {sub ? (
          <Text style={styles.tileSub} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
    </PressableScale>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    content: { padding: spacing.lg, paddingBottom: spacing.xxxl },
    empty: { flex: 1, backgroundColor: c.bg },
    heading: { ...type.heading, fontSize: type.size.md, color: c.text, paddingTop: spacing.lg, paddingBottom: spacing.sm },
    hint: { ...type.body, fontSize: type.size.sm, color: c.textMuted, paddingBottom: spacing.sm },
    headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    seeAll: { minHeight: touch.min, minWidth: touch.min, justifyContent: 'center', alignItems: 'flex-end' },
    seeAllText: { ...type.body, fontSize: type.size.sm, color: c.accent },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    tileOuter: { width: '48.5%' },
    tile: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.sm,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
    },
    glyph: {
      width: touch.min,
      height: touch.min,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.bg,
      borderRadius: radius.sm,
    },
    glyphText: { ...type.heading, fontSize: type.size.xl, color: c.accentText },
    tileText: { flex: 1 },
    tileTitle: { ...type.body, fontSize: type.size.base, color: c.text },
    tileSub: { ...type.mono, fontSize: type.size.xs, color: c.textMuted },
    row: {
      minHeight: 56,
      justifyContent: 'center',
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    rowTitle: { ...type.body, fontSize: type.size.md, color: c.text },
    rowUrl: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
  });
