import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../../constants/theme';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { Button } from './Button';
import { IconButton } from './IconButton';

export type BannerTone = 'info' | 'warning' | 'danger' | 'success';

export interface BannerProps {
  tone?: BannerTone;
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
  testID?: string;
}

const ICONS: Record<BannerTone, PixelIconName> = {
  info: 'about',
  warning: 'warning',
  danger: 'warning',
  success: 'check',
};

export function Banner({ tone = 'info', title, body, actionLabel, onAction, onDismiss, testID }: BannerProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const tint = { info: colors.download, warning: colors.warning, danger: colors.danger, success: colors.success }[tone];
  return (
    <View
      style={[styles.wrap, { backgroundColor: alpha(tint, 0.1), borderColor: alpha(tint, 0.4) }]}
      testID={testID}
      accessibilityRole={tone === 'danger' || tone === 'warning' ? 'alert' : undefined}
      accessibilityLiveRegion={tone === 'danger' ? 'assertive' : 'polite'}
    >
      <View style={styles.icon}>
        <PixelIcon name={ICONS[tone]} size={20} color={tint} />
      </View>
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {body ? <Text style={styles.body}>{body}</Text> : null}
        {actionLabel && onAction ? (
          <View style={styles.action}>
            <Button label={actionLabel} onPress={onAction} variant="secondary" />
          </View>
        ) : null}
      </View>
      {onDismiss ? <IconButton icon="close" size={16} onPress={onDismiss} accessibilityLabel="Dismiss" /> : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      padding: spacing.lg,
      borderRadius: radius.md,
      borderWidth: 1,
    },
    icon: { paddingTop: 1 },
    text: { flex: 1 },
    title: { ...type.bodyStrong, fontSize: 14, color: c.text },
    body: { ...type.body, fontSize: 13, color: c.textMuted, marginTop: 2, lineHeight: 18 },
    action: { marginTop: spacing.md, alignSelf: 'flex-start' },
  });
