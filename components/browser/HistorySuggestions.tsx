import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, motion, spacing, touch, type } from '../../constants/theme';
import { addressCopy, historyCopy } from '../../constants/copy';
import { searchEngineNames } from '../../constants/browserSettingsCopy';
import { useBrowserPrefs } from '../../utils/prefs/browser';
import { SEARCH_URLS, toBrowserUrl } from '../../utils/browserUrl';
import { listHistory, suggestHistory, type HistoryEntry } from '../../utils/history';
import { useBookmarks, filterBookmarks, normalizeUrl } from '../../utils/browser/bookmarks';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { IconButton, PressableScale } from '../ui';
import { animateTo, useReduceMotion } from '../motion';
import { MAX_IDLE_BOOKMARKS, mergeSuggestions } from './suggestionMerge';

/** Wait this long after the last keystroke before asking the store. */
export const SUGGEST_DEBOUNCE_MS = 120;

/** The address without its scheme, as the row shows it. */
const shown = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '');

interface Item {
  key: string;
  icon: PixelIconName;
  accent: boolean;
  title: string;
  sub: string;
  /** What onPick receives: the typed text for the first row (go() decides search or address), else the page address. */
  pick: string;
  /** What the fill arrow puts in the field. Empty for the first row, which already is the typed text. */
  fill: string;
  heading?: string;
}

export interface HistorySuggestionsProps {
  /** What is in the address field. */
  text: string;
  /** The address already in the bar. Text equal to it, or empty, counts as nothing typed yet. */
  skip?: string;
  /** The page title, shown on the This page row. Leave `pageUrl` empty on a new tab: there is no This page row. */
  pageTitle?: string;
  pageUrl?: string;
  onPick: (value: string) => void;
  /** Put an address in the field without opening it. */
  onFill: (url: string) => void;
  onCopy: (url: string) => void;
  onShare: (url: string) => void;
  /** Put the page address in the field with the caret at the end. */
  onEdit: () => void;
}

/**
 * The full-screen surface under the address bar while it is being edited, like Chrome and Firefox on Android
 * Opaque, so the page behind it stays mounted but hidden.
 * Nothing typed: a This page row (Copy link, Share, Edit), up to 4 bookmarks, then up to 6 recent pages.
 * Typing: a Search or Go to row first, then up to 3 matching bookmarks and up to 6 saved pages from history.
 * History is hidden when Suggest from history is off, in private browsing, or when the store fails. Bookmarks stay
 * (they are the user's own saved pages). Scrolling the list hides the keyboard and keeps the surface.
 */
export function HistorySuggestions({ text, skip, pageTitle, pageUrl, onPick, onFill, onCopy, onShare, onEdit }: HistorySuggestionsProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reduceMotion = useReduceMotion();
  const [prefs] = useBrowserPrefs();
  const bookmarks = useBookmarks();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const seq = useRef(0);
  const fade = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const historyOn = prefs.suggestFromHistory && !prefs.privateBrowsing; // history is hidden while private
  const query = text.trim();
  const idle = query === '' || query === (skip ?? '').trim();
  const typed = !idle;
  const matches = useMemo(() => (typed ? filterBookmarks(bookmarks, query) : bookmarks), [typed, bookmarks, query]);
  const rows = useMemo(() => mergeSuggestions(matches, history, typed ? undefined : MAX_IDLE_BOOKMARKS), [matches, history, typed]);

  useEffect(() => {
    animateTo(fade, 1, motion.duration.press, reduceMotion);
  }, [fade, reduceMotion]);

  useEffect(() => {
    const mine = ++seq.current;
    if (!historyOn) {
      setHistory([]);
      return;
    }
    const done = (r: HistoryEntry[]) => {
      if (mine === seq.current) setHistory(r);
    };
    const fail = () => done([]);
    if (idle) {
      listHistory({ limit: 7 }).then(done, fail);
      return () => {
        seq.current++;
      };
    }
    const t = setTimeout(() => {
      suggestHistory(query, 6).then(done, fail);
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [historyOn, idle, query]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (typed) {
      const t = toBrowserUrl(query, prefs.searchEngine);
      const isSearch = t.kind === 'url' && t.url.startsWith(SEARCH_URLS[prefs.searchEngine]) && t.url !== query;
      out.push({
        key: 'first',
        icon: isSearch ? 'search' : 'external',
        accent: true,
        title:
          t.kind === 'magnet'
            ? addressCopy.addMagnet
            : isSearch
              ? addressCopy.searchFor(searchEngineNames[prefs.searchEngine], query)
              : addressCopy.goTo(t.kind === 'url' ? shown(t.url) : query),
        sub: '',
        pick: query,
        fill: '',
      });
    }
    const here = pageUrl ? normalizeUrl(pageUrl) : '';
    let lastKind = '';
    let recentCount = 0;
    for (const r of rows) {
      if (!typed && r.kind === 'history') {
        if (here && normalizeUrl(r.url) === here) continue;
        if (++recentCount > 6) break;
      }
      const heading = !typed && r.kind !== lastKind ? (r.kind === 'bookmark' ? addressCopy.bookmarks : addressCopy.recent) : undefined;
      lastKind = r.kind;
      out.push({
        key: `${r.kind}:${r.url}`,
        icon: r.kind === 'bookmark' ? 'bookmark' : 'clock',
        accent: r.kind === 'bookmark',
        title: r.title || r.host,
        sub: shown(r.url),
        pick: r.url,
        fill: r.url,
        heading,
      });
    }
    return out;
  }, [typed, query, prefs.searchEngine, rows, pageUrl]);

  return (
    <Animated.View style={[styles.root, { opacity: fade }]} accessibilityLabel={addressCopy.surfaceLabel}>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {idle && pageUrl ? (
          <View style={styles.page}>
            <Text style={styles.heading}>{addressCopy.thisPage}</Text>
            <View style={styles.pageRow}>
              <View style={styles.text}>
                <Text style={styles.title} numberOfLines={1}>
                  {pageTitle || shown(pageUrl)}
                </Text>
                <Text style={styles.url} numberOfLines={1}>
                  {shown(pageUrl)}
                </Text>
              </View>
              <IconButton icon="copy" accessibilityLabel={addressCopy.copyLink} onPress={() => onCopy(pageUrl)} />
              <IconButton icon="share" accessibilityLabel={addressCopy.share} onPress={() => onShare(pageUrl)} />
              <IconButton icon="pencil" accessibilityLabel={addressCopy.edit} onPress={onEdit} />
            </View>
          </View>
        ) : null}
        <View accessibilityLabel={historyCopy.suggestionsLabel}>
          {items.map((r) => (
            <View key={r.key}>
              {r.heading ? <Text style={styles.heading}>{r.heading}</Text> : null}
              <View style={styles.row}>
                <PressableScale
                  onPress={() => onPick(r.pick)}
                  accessibilityRole="button"
                  accessibilityLabel={r.sub ? `${r.title}, ${r.sub}${r.icon === 'bookmark' ? `, ${historyCopy.bookmarkHint}` : ''}` : r.title}
                  style={styles.main}
                >
                  <PixelIcon name={r.icon} color={r.accent ? colors.accent : colors.textMuted} />
                  <View style={styles.text}>
                    <Text style={styles.title} numberOfLines={1}>
                      {r.title}
                    </Text>
                    {r.sub ? (
                      <Text style={styles.url} numberOfLines={1}>
                        {r.sub}
                      </Text>
                    ) : null}
                  </View>
                </PressableScale>
                {r.fill ? (
                  <Pressable onPress={() => onFill(r.fill)} accessibilityRole="button" accessibilityLabel={addressCopy.fill(r.title)} style={styles.fill}>
                    <View style={styles.arrow}>
                      <PixelIcon name="back" size={20} color={colors.textMuted} />
                    </View>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </Animated.View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { ...StyleSheet.absoluteFill, backgroundColor: c.bg },
    page: { paddingBottom: spacing.sm },
    pageRow: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: spacing.lg,
      paddingRight: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    heading: { ...type.body, fontSize: type.size.sm, color: c.textMuted, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xs },
    row: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    main: {
      flex: 1,
      minWidth: 0,
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingLeft: spacing.lg,
      paddingRight: spacing.sm,
      paddingVertical: spacing.sm,
    },
    fill: { width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center', marginRight: spacing.xs },
    // The back arrow turned a quarter of the way round points up and left: "put this in the field".
    arrow: { transform: [{ rotate: '45deg' }] },
    text: { flex: 1, minWidth: 0 },
    title: { ...type.body, fontSize: type.size.md, color: c.text },
    url: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
  });
