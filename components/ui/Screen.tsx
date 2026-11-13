import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View, ViewStyle, StyleProp } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { IconButton } from './IconButton';

export interface ScreenProps {
  title?: string;
  onBack?: () => void;
  /** Right-side header actions (IconButtons). */
  actions?: React.ReactNode;
  scroll?: boolean;
  /** Safe-area edges to pad. Default: top + left/right (tab bars own the bottom). */
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  contentStyle?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  testID?: string;
}

export function Screen({
  title,
  onBack,
  actions,
  scroll = false,
  edges = ['top', 'left', 'right'],
  contentStyle,
  children,
  testID,
}: ScreenProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const hasHeader = !!title || !!onBack || !!actions;
  return (
    <SafeAreaView style={styles.root} edges={edges} testID={testID}>
      {hasHeader ? (
        <View style={styles.header}>
          {onBack ? <IconButton icon="back" onPress={onBack} accessibilityLabel="Go back" /> : null}
          <Text style={[styles.title, !onBack && styles.titleNoBack]} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
          <View style={styles.actions}>{actions}</View>
        </View>
      ) : null}
      {scroll ? (
        <ScrollView style={styles.fill} contentContainerStyle={contentStyle} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.fill, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    fill: { flex: 1 },
    header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm },
    title: { ...type.heading, fontSize: 17, color: c.text, flex: 1, marginLeft: spacing.xs },
    titleNoBack: { marginLeft: spacing.sm },
    actions: { flexDirection: 'row', alignItems: 'center' },
  });
