import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { Button } from './Button';

export interface EmptyBlockAction {
  label: string;
  onPress: () => void;
  icon?: PixelIconName;
}

export interface EmptyBlockProps {
  icon: PixelIconName;
  title: string;
  body?: string;
  primary?: EmptyBlockAction;
  secondary?: EmptyBlockAction;
  /** Tints the icon with the danger color for error states. */
  error?: boolean;
  testID?: string;
}

export function EmptyBlock({ icon, title, body, primary, secondary, error, testID }: EmptyBlockProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.wrap} testID={testID}>
      <View style={styles.tile}>
        <PixelIcon name={icon} size={24} color={error ? colors.danger : colors.textMuted} />
      </View>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {primary || secondary ? (
        <View style={styles.actions}>
          {primary ? <Button label={primary.label} icon={primary.icon} onPress={primary.onPress} /> : null}
          {secondary ? <Button label={secondary.label} icon={secondary.icon} onPress={secondary.onPress} variant="ghost" /> : null}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { alignItems: 'center', paddingHorizontal: spacing.xxl, paddingVertical: spacing.xxxl },
    tile: {
      width: 56,
      height: 56,
      borderRadius: radius.lg,
      backgroundColor: c.surfaceRaised,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: { ...type.bodyStrong, fontSize: 17, color: c.text, marginTop: spacing.lg, textAlign: 'center' },
    body: { ...type.body, fontSize: 13, lineHeight: 19, color: c.textMuted, marginTop: spacing.sm, textAlign: 'center', maxWidth: 300 },
    actions: { marginTop: spacing.xl, alignItems: 'center', gap: spacing.sm },
  });
