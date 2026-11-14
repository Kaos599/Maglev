import React, { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { findCopy } from '../../constants/copy';
import { PixelIcon } from '../PixelIcon';
import { IconButton, PressableScale } from '../ui';

/** Typing runs the search this long after the last key (contract section 28). */
export const FIND_DEBOUNCE_MS = 150;

export type FindResult = { active: number; total: number; done: boolean };

export interface FindBarProps {
  /** What the view last reported for the current query, or null while nothing has come back. */
  result: FindResult | null;
  /** Runs the search. An empty query clears the highlights. */
  onSearch(query: string): void;
  /** Moves to the next (true) or previous match. */
  onStep(forward: boolean): void;
  onClose(): void;
}

/** Replaces the address bar row while find is open. Autofocuses its input; Enter means next. */
export function FindBar({ result, onSearch, onStep, onClose }: FindBarProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [query, setQuery] = useState('');
  // What the view was last asked to find, so Enter right after typing searches instead of stepping.
  const sent = useRef('');
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => {
      sent.current = query;
      onSearch(query);
    }, FIND_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // onSearch is a fresh closure each render; only the text should restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const hasMatches = !!result && result.total > 0;
  const text = query === '' || !result ? '' : hasMatches ? findCopy.count(result.active + 1, result.total) : result.done ? findCopy.noMatches : '';
  const label = hasMatches && result ? findCopy.matchLabel(result.active + 1, result.total) : text;

  const step = (forward: boolean) => {
    if (!hasMatches) return;
    haptic('tap');
    onStep(forward);
  };

  return (
    <View style={styles.bar}>
      <View style={styles.field}>
        <PixelIcon name="search" size={16} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => {
            if (query !== sent.current) {
              sent.current = query;
              onSearch(query);
            } else step(true);
          }}
          submitBehavior="submit"
          autoFocus
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          placeholder={findCopy.placeholder}
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accent}
          style={styles.input}
          numberOfLines={1}
          accessibilityLabel={findCopy.placeholder}
        />
        {text ? (
          <Text style={styles.count} numberOfLines={1} accessibilityLabel={label} accessibilityLiveRegion="polite">
            {text}
          </Text>
        ) : null}
      </View>
      <PressableScale
        onPress={() => step(false)}
        disabled={!hasMatches}
        accessibilityRole="button"
        accessibilityLabel={findCopy.previous}
        style={[styles.step, !hasMatches && styles.dim]}
      >
        <PixelIcon name="arrow-up" size={24} color={colors.text} />
      </PressableScale>
      <PressableScale
        onPress={() => step(true)}
        disabled={!hasMatches}
        accessibilityRole="button"
        accessibilityLabel={findCopy.next}
        style={[styles.step, !hasMatches && styles.dim]}
      >
        <PixelIcon name="arrow-down" size={24} color={colors.text} />
      </PressableScale>
      <IconButton
        icon="close"
        accessibilityLabel={findCopy.close}
        onPress={() => {
          haptic('tap');
          onClose();
        }}
      />
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xs, minHeight: 56 },
    field: {
      flex: 1,
      minWidth: 44,
      height: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: radius.md,
    },
    input: { ...type.mono, flex: 1, minWidth: 0, fontSize: type.size.md, color: c.text, paddingVertical: 0 },
    count: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    step: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    dim: { opacity: 0.4 },
  });
