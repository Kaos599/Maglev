import React, { useEffect, useMemo, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { ThemeColors, spacing, type } from '../constants/theme';
import { IconButton } from './ui';
import { MaglevMark } from './brand/MaglevMark';
import { MARK_FX_COMPACT } from './brand/markPaths';
import { useReduceMotion } from './motion/useReduceMotion';

/** The brand mark dashes this many loops, then rests. A loop that never ends keeps the screen from going idle. */
export const CRUISE_LOOPS = 3;

/**
 * True for a few loops after `active` turns on or the app returns to the foreground, then false
 * until the next start. False whenever `active` is off, the app is in the background, or reduce
 * motion is on.
 */
function useCruiseBurst(active: boolean): boolean {
  const reduce = useReduceMotion();
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!active || reduce) {
      setPlaying(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      setPlaying(false);
    };
    const start = () => {
      stop();
      setPlaying(true);
      timer = setTimeout(() => {
        timer = undefined;
        setPlaying(false);
      }, MARK_FX_COMPACT.ms * CRUISE_LOOPS);
    };
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (st) => (st === 'active' ? start() : stop()));
    return () => {
      sub.remove();
      stop();
    };
  }, [active, reduce]);
  return playing;
}

export interface HeaderSelection {
  count: number;
  allSelected: boolean;
  onClose: () => void;
  onSelectAll: () => void;
}

export interface HeaderBarProps {
  /** Right-side IconButtons. Omit for a brand-only header. */
  actions?: React.ReactNode;
  /** When set, the header swaps to the multi-select layout. */
  selection?: HeaderSelection;
  /** Dash the brand mark for a few loops (the Transfers tab sets this while something downloads and it is focused). */
  cruising?: boolean;
}

export function HeaderBar({ actions, selection, cruising = false }: HeaderBarProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const dash = useCruiseBurst(cruising);

  if (selection) {
    return (
      <View style={styles.bar}>
        <IconButton icon="close" accessibilityLabel="Exit selection" onPress={selection.onClose} />
        <Text style={styles.selectedText} accessibilityLiveRegion="polite">
          {`${selection.count} selected`}
        </Text>
        <IconButton
          icon="select"
          accessibilityLabel={selection.allSelected ? 'All selected' : 'Select all'}
          selected={selection.allSelected}
          color={selection.allSelected ? colors.accentText : colors.text}
          onPress={selection.onSelectAll}
        />
      </View>
    );
  }

  return (
    <View style={styles.bar}>
      <View style={styles.brand}>
        <MaglevMark height={22} cruising={dash} tappable arrive />
        <Text style={styles.brandTitle} accessibilityRole="header">
          MAGLEV
        </Text>
      </View>
      <View style={styles.actions}>{actions}</View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    bar: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.sm,
      backgroundColor: c.bg,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    // zIndex: the mark flies over the action buttons when tapped.
    brand: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingLeft: spacing.sm, zIndex: 1 },
    brandTitle: { ...type.brand, fontSize: 14, color: c.text },
    actions: { flexDirection: 'row', alignItems: 'center' },
    selectedText: { ...type.bodyStrong, fontSize: 17, color: c.text, flex: 1, marginLeft: spacing.xs },
  });
