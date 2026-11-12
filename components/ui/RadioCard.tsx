import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { PressableScale } from './PressableScale';

export interface RadioCardProps {
  title: string;
  description: React.ReactNode;
  icon: PixelIconName;
  /** Icon colour. Defaults to the muted text colour. */
  iconColor?: string;
  selected: boolean;
  onPress: () => void;
  /** Dashed, transparent card that fades when not selected (the Skip option). */
  dashed?: boolean;
  /** Small node shown after the title (for example the First chip). */
  titleAccessory?: React.ReactNode;
  accessibilityLabel?: string;
  testID?: string;
}

/**
 * Option card with a square pixel radio: 32 px icon box, mono title, body description.
 * Selected state uses the `selBorder` and `selBg` tokens (UI_SPEC S11.2).
 */
export function RadioCard({
  title,
  description,
  icon,
  iconColor,
  selected,
  onPress,
  dashed,
  titleAccessory,
  accessibilityLabel,
  testID,
}: RadioCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <PressableScale
      onPress={onPress}
      haptic="select"
      testID={testID}
      scaleTo={0.99}
      accessibilityRole="radio"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ checked: selected, selected }}
      style={[styles.card, dashed && styles.dashed, selected && styles.selected]}
    >
      <View style={styles.iconBox}>
        <PixelIcon name={icon} size={20} color={iconColor ?? colors.textMuted} />
      </View>
      <View style={[styles.main, dashed && !selected && styles.faded]}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{title}</Text>
          {titleAccessory}
        </View>
        <Text style={styles.desc}>{description}</Text>
      </View>
      <View style={[styles.radio, selected && styles.radioOn]}>{selected ? <View style={styles.dot} /> : null}</View>
    </PressableScale>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 64,
      paddingVertical: 10,
      paddingHorizontal: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      backgroundColor: c.bg,
    },
    dashed: { borderStyle: 'dashed', backgroundColor: 'transparent' },
    selected: { borderStyle: 'solid', borderColor: c.selBorder, backgroundColor: c.selBg },
    iconBox: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
    },
    main: { flex: 1, minWidth: 44, minHeight: touch.min - 20 },
    faded: { opacity: 0.7 },
    titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
    title: { ...type.monoBold, fontSize: type.size.md, color: c.text },
    desc: { ...type.body, fontSize: type.size.sm, lineHeight: 17, color: c.textMuted, marginTop: 3 },
    radio: {
      width: 18,
      height: 18,
      borderWidth: 2,
      borderColor: c.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioOn: { borderColor: c.accent },
    dot: { width: 8, height: 8, backgroundColor: c.accent },
  });
