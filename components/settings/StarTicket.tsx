import React, { useMemo, useRef } from 'react';
import { Animated, Easing, Linking, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PressableScale } from '../ui';
import { useReduceMotion } from '../motion';

export const REPO_URL = 'https://github.com/Kaos599/Maglev';

export const starTicketCopy = {
  top: 'FREE · NO ADS · OPEN SOURCE',
  title: 'Like Maglev? Give it a star',
  body: 'It takes a second on GitHub and helps others find the app.',
  stub: 'STAR',
  label: 'Like Maglev? Give it a star on GitHub',
  hint: 'Opens Maglev on GitHub',
} as const;

const NOTCH = 18;
const DASHES = 9;
const BURST_STEPS = 4;
const BURST_MS = 480;
const BURST_REACH = 34;
/** Eight directions, in whole-pixel steps. */
const DIRS: readonly [number, number][] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/** 10x10 pixel star, drawn with Views: the brand fonts have no star glyph. */
const STAR_ROWS = ['....##....', '....##....', '...####...', '##########', '.########.', '..######..', '..######..', '.###..###.', '.##....##.', '##......##'];
const STAR_PX = 2.4;

function PixelStar({ color }: { color: string }) {
  return (
    <View style={{ width: STAR_PX * 10, height: STAR_PX * 10 }} accessible={false}>
      {STAR_ROWS.flatMap((row, y) =>
        row.split('').map((ch, x) =>
          ch === '#' ? (
            <View key={`${x}-${y}`} style={{ position: 'absolute', left: x * STAR_PX, top: y * STAR_PX, width: STAR_PX + 0.2, height: STAR_PX + 0.2, backgroundColor: color }} />
          ) : null,
        ),
      )}
    </View>
  );
}

/** Progress 0..1 turned into a few hard steps, so the squares hop outward like pixels. */
function stepped(progress: Animated.Value, reach: number): Animated.AnimatedInterpolation<number> {
  const input: number[] = [];
  const output: number[] = [];
  for (let k = 0; k < BURST_STEPS; k++) {
    input.push(k / BURST_STEPS, (k + 1) / BURST_STEPS - 0.001);
    output.push((reach * (k + 1)) / BURST_STEPS, (reach * (k + 1)) / BURST_STEPS);
  }
  input.push(1);
  output.push(reach);
  return progress.interpolate({ inputRange: input, outputRange: output });
}

/** A lime ticket asking for a GitHub star. The whole ticket is one button. */
export function StarTicket() {
  const { colors, dark } = useTheme();
  const s = useMemo(() => makeStyles(colors, dark), [colors, dark]);
  const reduceMotion = useReduceMotion();
  const progress = useRef(new Animated.Value(0)).current;

  const open = () => {
    if (!reduceMotion) {
      progress.setValue(0);
      Animated.timing(progress, { toValue: 1, duration: BURST_MS, easing: Easing.linear, useNativeDriver: true }).start();
    }
    void Linking.openURL(REPO_URL);
  };

  const fade = progress.interpolate({ inputRange: [0, 0.01, 0.7, 1], outputRange: [0, 1, 1, 0] });

  return (
    <View style={s.wrap}>
      <PressableScale
        onPress={open}
        haptic="tap"
        accessibilityRole="button"
        accessibilityLabel={starTicketCopy.label}
        accessibilityHint={starTicketCopy.hint}
        style={s.ticket}
      >
        <View style={s.main}>
          <Text style={s.top} numberOfLines={1}>
            {starTicketCopy.top}
          </Text>
          <Text style={s.title} numberOfLines={1} adjustsFontSizeToFit>
            {starTicketCopy.title}
          </Text>
          <Text style={s.body}>{starTicketCopy.body}</Text>
        </View>
        <View style={s.dashes}>
          {Array.from({ length: DASHES }, (_, i) => (
            <View key={i} style={s.dash} />
          ))}
        </View>
        <View style={s.stub}>
          <PixelStar color={colors.onAccent} />
          <Text style={s.stubLabel}>{starTicketCopy.stub}</Text>
        </View>
        <View style={[s.notch, s.notchLeft]} />
        <View style={[s.notch, s.notchRight]} />
      </PressableScale>
      <View style={s.burst} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {DIRS.map(([dx, dy], i) => (
          <Animated.View
            key={i}
            style={[
              s.spark,
              i % 2 === 0 ? s.sparkLime : s.sparkCyan,
              { opacity: fade, transform: [{ translateX: stepped(progress, dx * BURST_REACH) }, { translateY: stepped(progress, dy * BURST_REACH) }] },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

// On the dark themes the lime fill gives dark text high contrast, so the top line and body can sit softer.
// On light the fill is the darker accent and white text needs full opacity.
const makeStyles = (c: ThemeColors, dark: boolean) =>
  StyleSheet.create({
    wrap: { alignSelf: 'stretch' },
    ticket: {
      flexDirection: 'row',
      alignItems: 'stretch',
      backgroundColor: c.accent,
      borderRadius: radius.md,
      minHeight: 96,
    },
    main: { flex: 1, paddingVertical: spacing.lg, paddingLeft: spacing.xl, paddingRight: spacing.md, gap: spacing.xs, justifyContent: 'center' },
    top: { ...type.brand, fontSize: 9, letterSpacing: 0.5, color: c.onAccent, opacity: dark ? 0.7 : 1 },
    title: { ...type.bodyStrong, fontSize: 16, color: c.onAccent },
    body: { ...type.body, fontSize: 12, lineHeight: 16, color: c.onAccent, opacity: dark ? 0.8 : 1 },
    dashes: { width: 2, marginVertical: spacing.md, justifyContent: 'space-between' },
    dash: { width: 2, height: 4, backgroundColor: c.onAccent, opacity: 0.45 },
    stub: { width: 76, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
    stubLabel: { ...type.brand, fontSize: 11, color: c.onAccent },
    notch: { position: 'absolute', top: '50%', marginTop: -NOTCH / 2, width: NOTCH, height: NOTCH, borderRadius: NOTCH / 2, backgroundColor: c.bg },
    notchLeft: { left: -NOTCH / 2 },
    notchRight: { right: -NOTCH / 2 },
    burst: { position: 'absolute', right: 38, top: '50%', width: 0, height: 0 },
    spark: { position: 'absolute', width: 6, height: 6, left: -3, top: -3 },
    sparkLime: { backgroundColor: c.accent },
    sparkCyan: { backgroundColor: c.download },
  });
