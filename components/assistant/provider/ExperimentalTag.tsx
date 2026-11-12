import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../../constants/theme';

/** Small text badge: the Assistant is experimental. Plain, no icon. */
export function ExperimentalTag() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={s.tag} accessible accessibilityLabel="Experimental">
      <Text style={s.text}>Experimental</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    tag: {
      alignSelf: 'flex-start',
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    text: { ...type.bodyStrong, fontSize: 11, color: c.textMuted },
  });
