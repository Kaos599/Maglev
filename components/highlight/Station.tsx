import React, { useMemo } from 'react';
import { PixelRatio, StyleSheet, Text, View } from 'react-native';
import Animated, { SharedValue, useAnimatedStyle } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { MARK_BODY, MARK_LINES } from '../brand/markPaths';
import { useMarkInk } from '../brand/MaglevMark';
import { BADGE, CQ_PER_U, HIGHLIGHT_MOTION as M, RAIL, STATION_CQ } from './timing';
import { badgeParts, burstLayout, type Particle } from './burst';
import { TRACK, burstAt, dustAt, flashAt, railLitAt, railStarts, sparkAt, speedAt, stampAt, trainDip, trainX } from './timeline';

/** The train's own box: the body's bounds inside the mark's coordinates (10 45 to 117 76), 107 by 31 units. */
const TRAIN_VIEWBOX = '10 45 107 31';
const TRAIN_W = 107;
const TRAIN_H = 31;
/** The train floats this many units above the rail. */
const FLOAT_U = 7.25;
/** The burst leaves from the middle of the roof, a little left of the train's centre. */
const BURST_X_U = -4;
const BURST_TOP_U = 38.25;
/** The speed lines stretch from their right end, 25.2% across the train box. */
const SPEED_ORIGIN = '25.2% 50%';

/**
 * The top of the highlight card: the track, the train pulling in and braking, a burst of square pixels, and the
 * "NEW | 0.30" badge that slams onto the card's top edge with a flash and dust. Everything reads `clock` (ms) through
 * the pure functions in `timeline.ts`; nothing here loops and nothing takes a touch. `cq` is 1% of the design's phone
 * width in points (the card is 86 cq wide), so the whole station scales with the card.
 */
export function Station({ version, clock, cq }: { version: string; clock: SharedValue<number>; cq: number }) {
  const { colors } = useTheme();
  const ink = useMarkInk();
  const u = CQ_PER_U * cq;
  const s = useMemo(() => makeStyles(colors, cq), [colors, cq]);
  const particles = useMemo(() => burstLayout(M.burstCount, M.burstSizes, M.burstWaves), []);
  const starts = useMemo(() => railStarts(), []);

  const trainStyle = useAnimatedStyle(() => ({ transform: [{ translateX: trainX(clock.value) * u }] }));
  const bobStyle = useAnimatedStyle(() => ({ transform: [{ translateY: trainDip(clock.value) * u }] }));
  const speedStyle = useAnimatedStyle(() => {
    const k = speedAt(clock.value);
    return { opacity: k.opacity, transform: [{ scaleX: k.stretch }] };
  });
  const edgeStyle = useAnimatedStyle(() => {
    const k = flashAt(clock.value);
    return { opacity: k.opacity, transform: [{ scaleX: k.stretch }] };
  });
  const stampStyle = useAnimatedStyle(() => {
    const k = stampAt(clock.value);
    return { opacity: k.opacity, transform: [{ translateY: k.rise * cq }, { scaleX: k.sx }, { scaleY: k.sy }, { rotate: `${k.tilt}deg` }] };
  });

  const step = PixelRatio.roundToNearestPixel(Math.max(2, BADGE.step * cq));
  const verStep = PixelRatio.roundToNearestPixel(Math.max(1, BADGE.verStep * cq));
  const parts = badgeParts(version);
  const pad = (p: readonly number[]) => ({ paddingTop: p[0] * cq, paddingRight: p[1] * cq, paddingBottom: p[2] * cq, paddingLeft: p[3] * cq });

  return (
    <View style={s.station} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View style={s.clip}>
        <View style={s.anchor}>
          {TRACK.map((piece, i) => (
            <RailPiece key={i} piece={piece} start={starts[i]} clock={clock} u={u} cq={cq} color={ink.lines} />
          ))}
          <Animated.View style={[s.train, trainStyle]}>
            <Animated.View style={[StyleSheet.absoluteFill, bobStyle]}>
              <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: SPEED_ORIGIN }, speedStyle]}>
                <Svg width="100%" height="100%" viewBox={TRAIN_VIEWBOX}>
                  <Path d={MARK_LINES} fill={ink.lines} />
                </Svg>
              </Animated.View>
              <Svg width="100%" height="100%" viewBox={TRAIN_VIEWBOX}>
                <Path d={MARK_BODY} fill={ink.body} fillRule="evenodd" />
              </Svg>
            </Animated.View>
          </Animated.View>
        </View>
      </View>

      <View style={s.burst}>
        {particles.map((v, i) => (
          <Pixel key={i} v={v} clock={clock} u={u} color={v.tint === 0 ? colors.accent : colors.download} />
        ))}
      </View>

      <View style={s.impact}>
        <Animated.View style={[s.edge, edgeStyle]} />
        {M.dust.map(([x0, dx, dy], i) => (
          <Dust key={i} x0={x0} dx={dx} dy={dy} clock={clock} u={u} color={colors.accent} />
        ))}
      </View>

      <View style={s.stampWrap}>
        <View style={s.stampPlace}>
          <Animated.View style={[{ transformOrigin: '50% 55%' }, stampStyle]}>
            <View style={{ padding: step }}>
              <Cross color={colors.accent} step={step} />
              <View style={s.row}>
                <Text style={[s.badgeText, pad(BADGE.newPad), { color: colors.onAccent }]}>{parts.label}</Text>
                <View>
                  <Cross color={colors.surface} step={verStep} />
                  <Text style={[s.badgeText, pad(BADGE.verPad), { color: colors.accentText }]}>{parts.version}</Text>
                </View>
              </View>
            </View>
            <Spark i={0} clock={clock} size={3 * cq} grid={5} color={colors.accent} place={{ left: -3.6 * cq, top: -2 * cq }} />
            <Spark i={1} clock={clock} size={2.2 * cq} grid={5} color={colors.download} place={{ right: -2.2 * cq, top: -3 * cq }} />
            <Spark i={2} clock={clock} size={1.8 * cq} grid={3} color={colors.accent} place={{ left: -2 * cq, bottom: -3 * cq }} />
          </Animated.View>
        </View>
      </View>
    </View>
  );
}

/** A plate with its four corners stepped in by `step`: two overlapping bars, so it needs no clip path and no measuring. */
function Cross({ color, step }: { color: string; step: number }) {
  return (
    <>
      <View style={[StyleSheet.absoluteFill, { top: step, bottom: step, backgroundColor: color }]} />
      <View style={[StyleSheet.absoluteFill, { left: step, right: step, backgroundColor: color }]} />
    </>
  );
}

/** One piece of track. It lights the moment the train's nose reaches it, then steps back to dim. A null start stays dim. */
function RailPiece({ piece, start, clock, u, cq, color }: { piece: { d: string; a: number; b: number }; start: number | null; clock: SharedValue<number>; u: number; cq: number; color: string }) {
  const style = useAnimatedStyle(() => ({ opacity: start === null ? M.railDim : railLitAt(clock.value, start) }));
  return (
    <Animated.View style={[{ position: 'absolute', left: (piece.a - M.markCenterX) * u, bottom: STATION_CQ.railBottom * cq, width: (piece.b - piece.a) * u, height: RAIL.h * u }, style]}>
      <Svg width="100%" height="100%" viewBox={`${piece.a} ${RAIL.y} ${piece.b - piece.a} ${RAIL.h}`} preserveAspectRatio="none">
        <Path d={piece.d} fill={color} />
      </Svg>
    </Animated.View>
  );
}

function Pixel({ v, clock, u, color }: { v: Particle; clock: SharedValue<number>; u: number; color: string }) {
  const size = v.size * u;
  const style = useAnimatedStyle(() => {
    const k = burstAt(clock.value, v);
    return { opacity: k.opacity, transform: [{ translateX: k.x * u }, { translateY: k.y * u }] };
  });
  return <Animated.View style={[{ position: 'absolute', left: BURST_X_U * u - size / 2, top: -size / 2, width: size, height: size, backgroundColor: color, opacity: 0 }, style]} />;
}

function Dust({ x0, dx, dy, clock, u, color }: { x0: number; dx: number; dy: number; clock: SharedValue<number>; u: number; color: string }) {
  const style = useAnimatedStyle(() => {
    const k = dustAt(clock.value, dx, dy);
    return { opacity: k.opacity, transform: [{ translateX: k.x * u }, { translateY: k.y * u }] };
  });
  return <Animated.View style={[{ position: 'absolute', left: x0 * u, top: -2 * u, width: 2 * u, height: 2 * u, backgroundColor: color, opacity: 0 }, style]} />;
}

const SPARK_PATH = {
  5: 'M2 0h1v2h2v1H3v2H2V3H0V2h2z',
  3: 'M1 0h1v1h1v1H2v1H1V2H0V1h1z',
} as const;

function Spark({ i, clock, size, grid, color, place }: { i: number; clock: SharedValue<number>; size: number; grid: 3 | 5; color: string; place: { left?: number; right?: number; top?: number; bottom?: number } }) {
  const style = useAnimatedStyle(() => {
    const k = sparkAt(clock.value, i);
    return { opacity: k.opacity, transform: [{ scale: k.scale }] };
  });
  return (
    <Animated.View style={[{ position: 'absolute', width: size, height: size }, place, style]}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${grid} ${grid}`}>
        <Path d={SPARK_PATH[grid]} fill={color} />
      </Svg>
    </Animated.View>
  );
}

const makeStyles = (c: ThemeColors, cq: number) => {
  const u = CQ_PER_U * cq;
  return StyleSheet.create({
    // Reaches the card's edges and sits on its top edge; things that fly past the edge are drawn outside it.
    station: {
      height: STATION_CQ.height * cq,
      marginHorizontal: -spacing.xl,
      marginTop: -spacing.xl,
      marginBottom: STATION_CQ.below * cq,
    },
    clip: {
      ...StyleSheet.absoluteFill,
      overflow: 'hidden',
      borderTopLeftRadius: radius.xl - 1,
      borderTopRightRadius: radius.xl - 1,
      borderBottomWidth: 1,
      borderColor: c.border,
    },
    // Zero-width column down the middle of the card; everything in it is placed from the mark's centre.
    anchor: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 0 },
    train: { position: 'absolute', left: (-TRAIN_W / 2) * u, bottom: STATION_CQ.railBottom * cq + FLOAT_U * u, width: TRAIN_W * u, height: TRAIN_H * u },
    burst: { position: 'absolute', left: '50%', top: (STATION_CQ.height - STATION_CQ.railBottom) * cq - BURST_TOP_U * u, width: 0, height: 0, zIndex: 1 },
    impact: { position: 'absolute', left: '50%', top: -1, width: 0, height: 0, zIndex: 2 },
    edge: { position: 'absolute', left: -30 * cq, width: 60 * cq, top: 0, height: 1, backgroundColor: c.accent, opacity: 0 },
    // The badge is centred on the top edge, 55% of its height above it.
    stampWrap: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', zIndex: 3 },
    stampPlace: { transform: [{ translateY: '-55%' }] },
    row: { flexDirection: 'row', alignItems: 'stretch' },
    // Silkscreen is one weight; its glyphs carry their spacing on the right, so each segment pads more on the left.
    badgeText: { ...type.brand, fontSize: BADGE.fontCq * cq, lineHeight: BADGE.fontCq * cq, letterSpacing: BADGE.spacing * BADGE.fontCq * cq, includeFontPadding: false },
  });
};
