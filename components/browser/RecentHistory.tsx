import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { historyCopy } from '../../constants/copy';
import { useBrowserPrefs } from '../../utils/prefs/browser';
import { listHistory, useHistoryVersion, type HistoryEntry } from '../../utils/history';
import { PressableScale } from '../ui';

/** How many pages the new-tab page lists (NATIVE_CONTRACT 24.11). */
export const RECENT_LIMIT = 6;

/** The address without its scheme, as the row shows it. */
const shown = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '');

/**
 * "Recent" on a blank tab: the last pages from history, newest first, with "See all" for the History screen.
 * Shows `fallback` when there is nothing to list (history empty, Save history off, or the store failing).
 */
export function RecentHistory({ onPick, fallback }: { onPick: (url: string) => void; fallback: React.ReactNode }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const [prefs] = useBrowserPrefs();
  const version = useHistoryVersion();
  const [rows, setRows] = useState<HistoryEntry[]>([]);
  const enabled = prefs.saveHistory;

  useEffect(() => {
    let live = true;
    if (!enabled) {
      setRows([]);
      return;
    }
    listHistory({ limit: RECENT_LIMIT }).then(
      (r) => {
        if (live) setRows(r);
      },
      () => {
        if (live) setRows([]);
      },
    );
    return () => {
      live = false;
    };
  }, [enabled, version]);

  if (!enabled || rows.length === 0) return <>{fallback}</>;
  return (
    <ScrollView style={styles.root} keyboardShouldPersistTaps="handled" accessibilityLabel={historyCopy.recent.label}>
      <View style={styles.header}>
        <Text style={styles.heading} accessibilityRole="header">
          {historyCopy.recent.title}
        </Text>
        <PressableScale
          onPress={() => router.push('/browser-history')}
          accessibilityRole="button"
          accessibilityLabel={historyCopy.recent.seeAllLabel}
          hitSlop={8}
          style={styles.seeAll}
        >
          <Text style={styles.seeAllText}>{historyCopy.recent.seeAll}</Text>
        </PressableScale>
      </View>
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
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      paddingBottom: spacing.sm,
    },
    heading: { ...type.heading, fontSize: type.size.md, color: c.text },
    seeAll: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' },
    seeAllText: { ...type.body, fontSize: type.size.sm, color: c.accent },
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
