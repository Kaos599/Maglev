import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';

export interface StepLayoutProps {
  /** Illustration slot (brand mark or icon tile). */
  hero: React.ReactNode;
  title: string;
  body: string;
  /** Optional extra content under the body (folder row, caption). */
  extra?: React.ReactNode;
  /** Buttons, stacked full width. */
  actions: React.ReactNode;
}

/** One chunk fades in and rises 8dp; chunks are staggered by 70ms. Remount (key) replays it. */
function Chunk({ delay, style, children }: { delay: number; style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(v, {
      toValue: 1,
      duration: 240,
      delay,
      easing: Easing.bezier(0.2, 0, 0, 1),
      useNativeDriver: true,
    }).start();
  }, [v, delay]);
  return (
    <Animated.View
      style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }]}
    >
      {children}
    </Animated.View>
  );
}

export function StepLayout({ hero, title, body, extra, actions }: StepLayoutProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.wrap}>
      <View style={styles.main}>
        <Chunk delay={0}>
          <View style={styles.hero}>{hero}</View>
        </Chunk>
        <Chunk delay={70}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          <Text style={styles.body}>{body}</Text>
        </Chunk>
        {/* The main column centres its children, so this wrapper must take the full width itself:
            otherwise it shrinks to its content and rows inside that stretch collapse to a sliver. */}
        {extra ? <Chunk delay={140} style={styles.extra}>{extra}</Chunk> : null}
      </View>
      <Chunk delay={extra ? 210 : 140}>
        <View style={styles.actions}>{actions}</View>
      </Chunk>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { flex: 1, justifyContent: 'space-between', paddingHorizontal: spacing.xxl, paddingBottom: spacing.xxl },
    main: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    hero: { alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xxl },
    extra: { alignSelf: 'stretch' },
    title: { ...type.bodyStrong, fontSize: 22, lineHeight: 28, color: c.text, textAlign: 'center' },
    body: {
      ...type.body,
      fontSize: 15,
      lineHeight: 22,
      color: c.textMuted,
      textAlign: 'center',
      marginTop: spacing.md,
      maxWidth: 320,
      alignSelf: 'center',
    },
    actions: { gap: spacing.sm },
  });
