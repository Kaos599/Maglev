import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import type { ProgressStep } from '../../utils/assistant/runtime';
import { PixelIcon } from '../PixelIcon';

/** Static muted lines of real facts: "Searching 4 sources". No spinners, no dots. */
export const ProgressSteps = memo(function ProgressSteps({ steps }: { steps: ProgressStep[] }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite">
      {steps.map((s) => (
        <View key={s.callId + s.text} style={styles.row}>
          <View style={styles.slot}>
            {s.state === 'done' ? <PixelIcon name="check" size={16} color={colors.textMuted} /> : null}
            {s.state === 'failed' ? <PixelIcon name="warning" size={16} color={colors.warning} /> : null}
          </View>
          <Text style={[styles.text, s.state === 'failed' && { color: colors.warning }]}>{s.text}</Text>
        </View>
      ))}
    </View>
  );
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { gap: spacing.xs, paddingHorizontal: spacing.xs },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    slot: { width: 16, height: 16 },
    text: { ...type.body, fontSize: type.size.md, color: c.textMuted, flexShrink: 1 },
  });
