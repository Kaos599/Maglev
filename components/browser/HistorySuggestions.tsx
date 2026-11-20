import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { historyCopy } from '../../constants/copy';
import { useBrowserPrefs } from '../../utils/prefs/browser';
import { suggestHistory, type HistoryEntry } from '../../utils/history';
import { useBookmarks, filterBookmarks } from '../../utils/browser/bookmarks';
import { PixelIcon } from '../PixelIcon';
import { PressableScale } from '../ui';
import { mergeSuggestions, type Suggestion } from './suggestionMerge';

/** Wait this long after the last keystroke before asking the store. */
export const SUGGEST_DEBOUNCE_MS = 120;

/** The address without its scheme, as the row shows it. */
const shown = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '');

/**
 * Under the address bar while it is being edited: up to 3 matching bookmarks (also in private browsing and when
 * history suggestions are off, they are the user's own saved pages), then up to 6 saved pages from history. The
 * store caps the history list and drops the exact address being typed. History is hidden when Suggest from
 * history is off, in private browsing, or when the store fails. Nothing shows for empty text. `skip` is the address already in the bar (nothing typed yet).
 */
export function HistorySuggestions({ text, skip, onPick }: { text: string; skip?: string; onPick: (url: string) => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [prefs] = useBrowserPrefs();
  const bookmarks = useBookmarks();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const seq = useRef(0);
  const historyOn = prefs.suggestFromHistory && !prefs.privateBrowsing; // history is hidden while private
  const query = text.trim();
  const active = query !== '' && query !== (skip ?? '').trim();
  const historyActive = historyOn && active;
  const matches = useMemo(() => (active ? filterBookmarks(bookmarks, query) : []), [active, bookmarks, query]);
  const rows = useMemo(() => mergeSuggestions(matches, history), [matches, history]);

  useEffect(() => {
    const mine = ++seq.current;
    if (!historyActive) {
      setHistory([]);
      return;
    }
    const t = setTimeout(() => {
      suggestHistory(query, 6).then(
        (r) => {
          if (mine === seq.current) setHistory(r);
        },
        () => {
          if (mine === seq.current) setHistory([]);
        },
      );
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [historyActive, query]);

  if (!active || rows.length === 0) return null;
  return (
    <View style={styles.root} accessibilityLabel={historyCopy.suggestionsLabel}>
      <ScrollView keyboardShouldPersistTaps="handled">
        {rows.map((r: Suggestion) => (
          <PressableScale
            key={`${r.kind}:${r.url}`}
            onPress={() => onPick(r.url)}
            accessibilityRole="button"
            accessibilityLabel={`${r.title || r.host}, ${shown(r.url)}${r.kind === 'bookmark' ? `, ${historyCopy.bookmarkHint}` : ''}`}
            style={styles.row}
          >
            <PixelIcon name={r.kind === 'bookmark' ? 'bookmark' : 'clock'} color={r.kind === 'bookmark' ? colors.accent : colors.textMuted} />
            <View style={styles.text}>
              <Text style={styles.title} numberOfLines={1}>
                {r.title || r.host}
              </Text>
              <Text style={styles.url} numberOfLines={1}>
                {shown(r.url)}
              </Text>
            </View>
          </PressableScale>
        ))}
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { ...StyleSheet.absoluteFill, backgroundColor: c.bg },
    row: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    text: { flex: 1, minWidth: 0 },
    title: { ...type.body, fontSize: type.size.md, color: c.text },
    url: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
  });
