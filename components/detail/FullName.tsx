import React, { useMemo } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';

/** The whole name of a transfer, wrapped with no line limit, for the top of a detail screen. The header keeps one line. Long-press to copy. */
export function FullName({ name }: { name: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  if (!name) return null;
  return (
    <Text style={styles.name} selectable accessibilityLabel={name} testID="full-name">
      {name}
    </Text>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    name: { ...type.mono, fontSize: type.size.base, color: c.text, marginBottom: spacing.md },
  });
