import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { PressableScale } from './PressableScale';
import { FocusAnchor, rowKey } from '../settings/settingsFocus';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  /** 'danger' paints the subtitle in the danger colour (an error the row can't fix itself). */
  subtitleTone?: 'danger';
  icon?: PixelIconName;
  /** Muted trailing text; shown with a chevron when the row is pressable. */
  value?: string;
  /** Trailing control (e.g. Toggle). Replaces value and chevron. */
  accessory?: React.ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  /** Radio semantics: shows a check on the selected row and no chevron. Pass true/false to opt in. */
  selected?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

export function ListRow(props: ListRowProps) {
  return (
    <FocusAnchor anchorKey={rowKey(props.title)}>
      <ListRowBody {...props} />
    </FocusAnchor>
  );
}

function ListRowBody({
  title,
  subtitle,
  subtitleTone,
  icon,
  value,
  accessory,
  onPress,
  destructive,
  selected,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: ListRowProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const tint = destructive ? colors.danger : colors.text;

  const body = (
    <>
      {icon ? (
        <View style={styles.tile}>
          <PixelIcon name={icon} size={16} color={destructive ? colors.danger : colors.textMuted} />
        </View>
      ) : null}
      <View style={styles.text}>
        <Text style={[styles.title, { color: tint }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, subtitleTone === 'danger' && { color: colors.danger }]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {selected !== undefined ? (
        <View style={styles.check}>{selected ? <PixelIcon name="check" size={20} color={colors.accentText} /> : null}</View>
      ) : accessory ? (
        <View>{accessory}</View>
      ) : (
        <>
          {value ? (
            <Text style={styles.value} numberOfLines={1}>
              {value}
            </Text>
          ) : null}
          {onPress ? (
            <View>
              <PixelIcon name="chevron-right" size={16} color={colors.textFaint} />
            </View>
          ) : null}
        </>
      )}
    </>
  );

  if (!onPress) {
    return (
      <View
        style={styles.row}
        testID={testID}
        accessible={!accessory}
        accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
      >
        {body}
      </View>
    );
  }
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole={selected !== undefined ? 'radio' : 'button'}
      accessibilityLabel={accessibilityLabel ?? [title, value, subtitle].filter(Boolean).join(', ')}
      accessibilityHint={accessibilityHint}
      accessibilityState={selected !== undefined ? { disabled: !!disabled, selected, checked: selected } : { disabled: !!disabled }}
      style={(pressed) => [styles.row, pressed && styles.pressed, disabled && styles.disabled]}
    >
      {body}
    </PressableScale>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
    },
    pressed: { backgroundColor: c.surfaceRaised },
    disabled: { opacity: 0.4 },
    tile: {
      width: 32,
      height: 32,
      borderRadius: radius.md,
      backgroundColor: c.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    text: { flex: 1 },
    check: { width: 20, height: 20 },
    title: { ...type.body, fontSize: type.size.lg },
    subtitle: { ...type.body, fontSize: type.size.sm, color: c.textMuted, marginTop: 2 },
    value: { ...type.body, fontSize: type.size.md, color: c.textMuted, maxWidth: '45%' },
  });
