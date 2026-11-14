import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { historyCopy } from '../../constants/copy';
import { useBrowserPrefs } from '../../utils/prefs/browser';
import { suggestHistory, type HistoryEntry } from '../../utils/history';
import { PressableScale } from '../ui';

/** Wait this long after the last keystroke before asking the store. */
export const SUGGEST_DEBOUNCE_MS = 120;

/** The address without its scheme, as the row shows it. */
const shown = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '');

/**
 * Up to 6 saved pages under the address bar while it is being edited. The store caps the list and drops the
 * exact address being typed. Nothing shows when Suggest from history is off, the text is empty, or the store
 * fails. `skip` is the address already in the bar (nothing typed yet).
 */
export function HistorySuggestions({ text, skip, onPick }: { text: string; skip?: string; onPick: (url: string) => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [prefs] = useBrowserPrefs();
  const [rows, setRows] = useState<HistoryEntry[]>([]);
  const seq = useRef(0);
  const enabled = prefs.suggestFromHistory;
  const query = text.trim();
  const active = enabled && query !== '' && query !== (skip ?? '').trim();

  useEffect(() => {
    const mine = ++seq.current;
    if (!active) {
      setRows([]);
      return;
    }
    const t = setTimeout(() => {
      suggestHistory(query, 6).then(
        (r) => {
          if (mine === seq.current) setRows(r);
        },
        () => {
          if (mine === seq.current) setRows([]);
        },
      );
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [active, query]);

  if (!active || rows.length === 0) return null;
  return (
    <View style={styles.root} accessibilityLabel={historyCopy.suggestionsLabel}>
      <ScrollView keyboardShouldPersistTaps="handled">
        {rows.map((r) => (
          <PressableScale
            key={r.url}
            onPress={() => onPick(r.url)}
            accessibilityRole="button"
            accessibilityLabel={`${r.title || r.host}, ${shown(r.url)}`}
            style={styles.row}
          >
            <Text style={styles.title} numberOfLines={1}>
              {r.title || r.host}
            </Text>
            <Text style={styles.url} numberOfLines={1}>
              {shown(r.url)}
            </Text>
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
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { ...type.body, fontSize: type.size.md, color: c.text },
    url: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
  });
