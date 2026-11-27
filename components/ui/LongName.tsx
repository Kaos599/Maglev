import React, { useCallback, useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, TextLayoutEvent, View, useWindowDimensions } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, touch, type } from '../../constants/theme';
import { longNameCopy } from '../../constants/copy';
import { PressableScale } from './PressableScale';

export interface LongNameProps {
  name: string;
  /** Lines shown before "Show more". Default 3. */
  maxLines?: number;
  /** `title` for the top of a detail screen, `line` for a strip such as the selection bar. */
  size?: 'title' | 'line';
  /** The name is the screen's heading for screen readers (detail screens, whose header has no title). */
  heading?: boolean;
  /** What a screen reader says for the name, when it should say more than the name (a name and a state). */
  accessibilityLabel?: string;
  testID?: string;
}

/**
 * A transfer's whole name: up to `maxLines` lines, then "Show more" opens the rest in place and
 * "Show less" folds it back. A name that fits shows no button.
 */
export function LongName({ name, maxLines = 3, size = 'title', heading = false, accessibilityLabel, testID }: LongNameProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = useState(0);
  const textStyle = size === 'title' ? styles.title : styles.line;
  // Everything that changes where the name wraps. A count measured for another key is stale and ignored.
  const measureKey = `${width}:${fontScale}:${String(textStyle.fontFamily)}:${name}`;
  const [measured, setMeasured] = useState<{ key: string; lines: number } | null>(null);
  // Held per name, so a new name (a magnet that has just resolved) starts folded.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === name;
  const overflows = measured?.key === measureKey && measured.lines > maxLines;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidth((prev) => (prev === w ? prev : w));
  }, []);
  const onMeasure = useCallback(
    (e: TextLayoutEvent) => setMeasured({ key: measureKey, lines: e.nativeEvent.lines.length }),
    [measureKey],
  );

  if (!name) return null;
  return (
    <View onLayout={onLayout} testID={testID}>
      {/*
        The line count comes from a copy with no line limit. On Android, onTextLayout on a Text that has
        numberOfLines reports only the lines it draws, so the visible text cannot say whether it was cut.
        The key re-mounts the copy when the name, the width, the text size or the font changes, so it always measures again.
      */}
      {width > 0 ? (
        <View key={measureKey} style={styles.measure} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text style={textStyle} onTextLayout={onMeasure} accessible={false}>
            {name}
          </Text>
        </View>
      ) : null}
      <Text
        style={textStyle}
        numberOfLines={open ? undefined : maxLines}
        ellipsizeMode="tail"
        accessibilityRole={heading ? 'header' : 'text'}
        accessibilityLabel={accessibilityLabel ?? name}
      >
        {name}
      </Text>
      {overflows ? (
        <PressableScale
          onPress={() => setOpenFor(open ? null : name)}
          accessibilityRole="button"
          accessibilityLabel={open ? longNameCopy.less : longNameCopy.more}
          accessibilityState={{ expanded: open }}
          style={styles.toggle}
          testID={testID ? `${testID}-toggle` : undefined}
        >
          <Text style={styles.toggleText}>{open ? longNameCopy.less : longNameCopy.more}</Text>
        </PressableScale>
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    // The bold file-name face follows the font style (Inter SemiBold, or Space Mono Bold), never Silkscreen.
    title: { ...type.monoBold, fontSize: type.size.xl, lineHeight: 22, color: c.text },
    line: { ...type.mono, fontSize: type.size.md, lineHeight: 18, color: c.text },
    measure: { position: 'absolute', top: 0, left: 0, right: 0, opacity: 0 },
    toggle: { alignSelf: 'flex-start', minHeight: touch.min, minWidth: touch.min, justifyContent: 'center' },
    toggleText: { ...type.bodyStrong, fontSize: type.size.base, color: c.accentText },
  });
