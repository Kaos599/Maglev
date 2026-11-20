/**
 * The Pixel city: one building per bucket (days in a week or month, Monday-start weeks in a year). Height is bytes
 * downloaded, lit windows are downloads finished, the busiest building has an accent outline and label, the moon or sun
 * sits at the hour most downloads finished. Drawn with react-native-svg at an integer scale where the width allows,
 * every shape a crisp rectangle.
 *
 * The train is the day cursor (0.27): it rides the rail under the buildings, follows a finger and snaps to the nearest day on
 * release, with a small lime tick under the selected day. The first open plays a run, Monday to today, raising each building
 * as the train reaches it. The rail ends at the last built day in a drawn buffer stop; past it the train just stops (no
 * bounce). Finished downloads are wagons behind the train. Reduce motion: no run, the train sits on a whole day.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, LayoutChangeEvent, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native';
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from 'react-native-gesture-handler';
import Svg, { Path, Text as SvgText } from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';
import { easeOutCubic, motion, type ThemeColors, type as typeTokens, type } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { MaglevMark } from '../brand/MaglevMark';
import { MARK_FX_COMPACT, MARK_RATIO } from '../brand/markPaths';
import { useReduceMotion } from '../motion';
import { fmtSize } from '../../utils/stats/format';
import { dayOfDate, partsOf, weekdayOf } from '../../utils/stats/time';
import { centreOf, cursorAt, lastBuilt, riseStart, snapIndex, wagonCount } from './trainMath';
import type { Bucket, RangeKind } from '../../utils/stats/insights';
import { frameD, rectD, spriteD, SPRITES } from './pixels';
import { statsInk } from './ink';

const H = 78;
const BASE = 62;
const RAIL_Y = 75;
const TRAIN_H = 8;
/** The mark is 44 view-box units tall and drawn 8 scene units tall; its body centre is at x = 71.5 of a view box that starts at 10. */
const VS = 44 / TRAIN_H;
const BODYC = (71.5 - 10) / VS;
const TRAIN_TOP = RAIL_Y - (83.25 - 42) / VS;
const RUN_MS = 1200; // design-exception: the opening train run is a one-off showpiece, linear on purpose (the train moves at a steady speed)
const DESIGN_W = 163;
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CRUISE_LOOPS = 3;
const WAGON_CAP = 6;

/** The city rises once per app run; after that a range change is a cross-fade. */
let roseThisRun = false;

interface Layout {
  pitch: number;
  bw: number;
  x0: number;
  maxh: number;
  wc: number[];
  ws: number;
  wr: number;
}

function layoutFor(kind: RangeKind, n: number, W: number): Layout {
  if (kind === 'year') return { pitch: 3, bw: 3, x0: Math.floor((W - n * 3) / 2), maxh: 40, wc: [1], ws: 1, wr: 2 };
  if (kind === 'month') return { pitch: 5, bw: 4, x0: Math.floor((W - n * 5) / 2), maxh: 40, wc: [1], ws: 2, wr: 2 };
  return { pitch: 22, bw: 16, x0: Math.floor((W - 7 * 22) / 2) + 3, maxh: 34, wc: [3, 7, 11], ws: 2, wr: 4 };
}

export interface PixelCityProps {
  kind: RangeKind;
  buckets: Bucket[];
  busiest: number;
  selected: number;
  /** The first bucket a drag may reach (the first stats day). */
  minIndex: number;
  /** Hour most downloads finished in the range, or null. */
  peakHour: number | null;
  /** Downloads finished in the range: one wagon each behind the train, never more than six. */
  finished: number;
  /** Something is downloading now: today's roof is cyan. */
  live: boolean;
  /** Off, day one or an empty range: the city is still and does not answer touches. */
  inert: boolean;
  onPick: (i: number) => void;
  accessibilityLabel: string;
  valueText: string;
}

export function PixelCity({ kind, buckets, busiest, selected, minIndex, peakHour, finished, live, inert, onPick, accessibilityLabel, valueText }: PixelCityProps) {
  const { colors } = useTheme();
  const ink = useMemo(() => statsInk(colors), [colors]);
  const s = useMemo(() => makeStyles(colors), [colors]);
  const reduce = useReduceMotion();
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width)), []);

  // Integer scale when there is room for at least 2 dp a unit, so every pixel lands on whole dp.
  const scale = width >= DESIGN_W * 2 ? Math.floor(width / DESIGN_W) : Math.max(1, width / DESIGN_W);
  const W = width > 0 ? Math.floor(width / scale) : DESIGN_W;
  const L = useMemo(() => layoutFor(kind, buckets.length, W), [kind, buckets.length, W]);
  const ux = useCallback((i: number) => L.x0 + i * L.pitch, [L]);
  const heights = useMemo(() => {
    const mx = Math.max(0, ...buckets.map((b) => b.downloaded));
    return buckets.map((b) => (b.downloaded > 0 && mx > 0 ? Math.max(2, Math.round((L.maxh * b.downloaded) / mx)) : 0));
  }, [buckets, L.maxh]);

  const hi = useMemo(() => lastBuilt(buckets), [buckets]);

  // First open: the train runs from the first day to the last built one and each building rises (220 ms, ease-out) as it
  // is reached. Reduce motion or a range with nothing to show: still.
  const [t, setT] = useState<number | null>(() => (roseThisRun || reduce ? null : 0));
  const cx = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (t === null || width === 0 || buckets.length === 0) return;
    roseThisRun = true;
    const total = RUN_MS + motion.duration.base;
    let raf = 0;
    const t0 = Date.now();
    cx.setValue(centreOf(L, Math.max(0, minIndex)));
    const run = Animated.timing(cx, { toValue: centreOf(L, Math.max(0, hi)), duration: RUN_MS, easing: Easing.linear, useNativeDriver: true });
    run.start();
    const step = () => {
      const e = Date.now() - t0;
      if (e >= total) {
        setT(null);
        return;
      }
      setT(e);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      run.stop();
    };
    // Runs once, when the city first has a size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width > 0, buckets.length > 0]);

  // The train settles briefly after the run, then rests. It carries wagons instead of speed lines when it has any.
  const [cruising, setCruising] = useState(false);
  useEffect(() => {
    if (reduce || inert) return;
    setCruising(true);
    const id = setTimeout(() => setCruising(false), MARK_FX_COMPACT.ms * CRUISE_LOOPS);
    return () => clearTimeout(id);
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paths = useMemo(() => {
    let gA = '';
    let gB = '';
    let fence = '';
    let bA = '';
    let bB = '';
    let wOff = '';
    let wOn = '';
    let now = '';
    let roof = '';
    let busy = '';
    buckets.forEach((b, i) => {
      const px = ux(i);
      const alt = kind === 'year' ? partsOf(b.start).m % 2 === 1 : b.weekend;
      const g = rectD(px, BASE + 1, L.bw, 2);
      if (alt) gB += g;
      else gA += g;
      if (b.future) for (let k = 0; k < L.bw; k += 2) fence += rectD(px + k, BASE - 1, 1, 1);
      const full = heights[i];
      const h = t == null ? full : Math.round(full * easeOutCubic((t - riseStart(i, Math.max(0, hi), RUN_MS)) / motion.duration.base));
      const top = BASE - h;
      // The outline follows the train: the selected building (today until the user picks another day).
      if (i === (selected >= 0 ? selected : buckets.findIndex((x) => x.current))) {
        const nh = Math.max(3, h);
        now += frameD(px, BASE - nh, L.bw, nh);
      }
      if (b.current && live && h > 0) roof += rectD(px, BASE - h, L.bw, 1);
      if (h > 0) {
        // Every building is filled, today's and the busiest too; their outlines are drawn on top.
        if (i % 2) bB += rectD(px, top, L.bw, h);
        else bA += rectD(px, top, L.bw, h);
        let k = 0;
        for (let y = BASE - 1 - L.wr; y >= top + 2; y -= L.wr) {
          for (let c = 0; c < L.wc.length; c++, k++) {
            const w = rectD(px + L.wc[c], y, L.ws, L.ws === 2 && L.wr === 2 ? 1 : L.ws);
            if (k < b.finished) wOn += w;
            else wOff += w;
          }
        }
      }
      if (i === busiest && (h > 0 || t == null)) busy += frameD(px - 1, BASE - Math.max(3, h) - 1, L.bw + 2, Math.max(3, h) + 1);
    });
    return { gA, gB, fence, bA, bB, wOff, wOn, now, roof, busy };
  }, [buckets, heights, t, ux, L, kind, busiest, hi, live, selected]);

  const sky = useMemo(() => {
    if (peakHour == null) return null;
    const night = peakHour >= 20 || peakHour < 6;
    const x = Math.round(4 + (peakHour / 23) * (W - 16));
    const y = Math.round(9 - 6 * Math.sin((Math.PI * peakHour) / 23)) - 3;
    return { night, ...spriteD(night ? SPRITES.moon : SPRITES.sun, x, y) };
  }, [peakHour, W]);

  const font = typeTokens.bodyStrong.fontFamily;
  const labels = useMemo(() => {
    if (t != null) return [];
    const out: { x: number; y: number; text: string; fill: string }[] = [];
    if (kind === 'week') {
      buckets.forEach((b, i) => {
        if (b.future) return;
        const mid = ux(i) + L.bw / 2;
        const top = BASE - Math.max(heights[i], 3);
        if (i === busiest) {
          out.push({ x: mid, y: top - 9, text: 'Busiest', fill: ink.hi });
          out.push({ x: mid, y: top - 3, text: fmtSize(b.downloaded), fill: ink.hi });
        } else out.push({ x: mid, y: top - 3, text: b.downloaded > 0 ? fmtSize(b.downloaded) : '0', fill: ink.muted });
      });
      return out;
    }
    if (busiest < 0) return out;
    const bx = ux(busiest) + Math.floor(L.bw / 2);
    const bt = BASE - heights[busiest] - 1;
    out.push({ x: Math.min(W - 20, Math.max(20, bx + 0.5)), y: bt - 6, text: kind === 'year' ? 'Busiest week' : 'Busiest day', fill: ink.hi });
    return out;
  }, [t, kind, buckets, ux, L.bw, heights, busiest, ink, W]);
  const tick = kind !== 'week' && busiest >= 0 && t == null ? rectD(ux(busiest) + Math.floor(L.bw / 2), BASE - heights[busiest] - 5, 1, 3) : '';

  // The lime tick under the selected day (the train sits above it).
  const tickD = t == null && selected >= 0 && buckets[selected] ? rectD(Math.round(centreOf(L, selected) - 1), RAIL_Y + 1, 2, 2) : '';

  // The rail ends at the last built day in a buffer stop; beyond it the track is only dotted (days to come). The buffer is
  // left out when it would not fit inside the scene.
  const rail = useMemo(() => {
    const future = hi >= 0 && hi < buckets.length - 1;
    const pad = hi >= 0 ? ux(hi) + L.bw + 2 : W;
    const fits = hi >= 0 && pad + 4 <= W;
    const end = future && fits ? pad + 4 : W;
    let dots = '';
    if (future && fits) for (let x = end + 1; x < W; x += 2) dots += rectD(x, RAIL_Y, 1, 1);
    return {
      laid: rectD(0, RAIL_Y, end, 1),
      dots,
      post: fits ? rectD(pad, 68, 1, 1) + rectD(pad + 1, 68, 1, 7) + rectD(pad + 2, 70, 1, 1) + rectD(pad + 3, 71, 1, 4) : '',
      pad: fits ? rectD(pad, 69, 1, 3) : '',
    };
  }, [hi, buckets.length, ux, L.bw, W]);

  // Hold the train on the selected day, except while a finger or the opening run is moving it.
  const dragging = useRef(false);
  useEffect(() => {
    if (width === 0 || t !== null || dragging.current) return;
    const at = selected >= 0 && buckets[selected] ? selected : Math.max(0, hi);
    const to = centreOf(L, at);
    if (reduce) cx.setValue(to);
    else Animated.timing(cx, { toValue: to, duration: motion.duration.fast, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    // The train follows the selection and the layout, nothing else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, hi, L, width, t, reduce, buckets.length]);

  const offsetX = (width - W * scale) / 2;
  // The gesture callbacks run on the JS thread and read the latest layout through a ref.
  const live2 = useRef({ inert, onPick, L, minIndex, hi, scale, offsetX, reduce, selected });
  live2.current = { inert, onPick, L, minIndex, hi, scale, offsetX, reduce, selected };
  const pickAt = (x: number, release: boolean) => {
    const l = live2.current;
    if (l.inert || l.hi < 0) return;
    const xs = (x - l.offsetX) / l.scale;
    const idx = snapIndex(xs, l.L, l.minIndex, l.hi);
    // The train follows the finger and stops at the first and last day; with Reduce motion it moves a whole day at a time.
    if (!release) cx.setValue(cursorAt(xs, l.L, l.minIndex, l.hi, l.reduce));
    if (idx !== l.selected) {
      haptic('select');
      l.onPick(idx);
    }
    live2.current.selected = idx;
    if (release) {
      dragging.current = false;
      const to = centreOf(l.L, idx);
      if (l.reduce) cx.setValue(to);
      else Animated.timing(cx, { toValue: to, duration: motion.duration.release, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
  };
  // A horizontal drag scrubs from the first 8 dp; a vertical move of 12 dp fails it so the page scrolls instead.
  const pan = usePanGesture({
    runOnJS: true,
    activeOffsetX: [-8, 8],
    failOffsetY: [-12, 12],
    onActivate: (e) => {
      dragging.current = true;
      cx.stopAnimation();
      pickAt(e.x, false);
    },
    onUpdate: (e) => pickAt(e.x, false),
    onFinalize: (e) => {
      if (dragging.current) pickAt(e.x, true);
    },
  });
  const tap = useTapGesture({ runOnJS: true, onActivate: (e) => pickAt(e.x, true) });
  const touch = useExclusiveGestures(pan, tap);
  const onAction = useCallback(
    (e: AccessibilityActionEvent) => {
      const cur = selected < 0 ? Math.max(minIndex, busiest) : selected;
      if (e.nativeEvent.actionName === 'increment') onPick(Math.min(buckets.length - 1, cur + 1));
      if (e.nativeEvent.actionName === 'decrement') onPick(Math.max(minIndex, cur - 1));
    },
    [selected, minIndex, busiest, buckets.length, onPick],
  );

  const axis = useMemo(() => {
    const out: { key: string; left: number; text: string; centre: boolean }[] = [];
    if (buckets.length === 0) return out;
    if (kind === 'year') {
      const y = partsOf(buckets[0].start).y;
      for (let m = 0; m < 12; m++) {
        const d = dayOfDate(y, m, 1);
        const i = buckets.findIndex((b) => d >= b.start && d <= b.end);
        if (i >= 0) out.push({ key: `m${m}`, left: ux(i) * scale, text: MONTHS[m], centre: false });
      }
      return out;
    }
    buckets.forEach((b, i) => {
      const p = partsOf(b.start);
      const left = (ux(i) + L.bw / 2) * scale;
      if (kind === 'month') {
        if (p.d === 1 || p.d % 7 === 1) out.push({ key: `d${i}`, left, text: String(p.d), centre: true });
      } else out.push({ key: `w${i}`, left, text: DOW[weekdayOf(b.start)], centre: true });
    });
    return out;
  }, [buckets, kind, ux, scale, L.bw]);

  const crisp = { shapeRendering: 'crispEdges' } as object;
  const trainH = Math.round(TRAIN_H * scale);
  const trainW = trainH * MARK_RATIO;
  const wagonN = wagonCount(finished, WAGON_CAP);
  // The train and its wagons move as one: translate by the cursor (scene units) to the host's left edge.
  const move = useMemo(() => Animated.add(Animated.multiply(Animated.add(cx, -BODYC), scale), offsetX), [cx, scale, offsetX]);
  const wagonD = useMemo(() => {
    let deck = '';
    let crate = '';
    for (let w = 0; w < wagonN; w++) {
      const x = 8 * (wagonN - 1 - w);
      deck += rectD(x, 5, 7, 1) + rectD(x + 7, 4, 1, 1);
      crate += frameD(x + 1, 0, 5, 5) + rectD(x + 2, 2, 3, 1);
    }
    return { deck, crate };
  }, [wagonN]);

  return (
    <View onLayout={onLayout}>
      <GestureDetector gesture={touch}>
        <View
          style={{ height: H * scale }}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={accessibilityLabel}
          accessibilityValue={{ text: valueText }}
          accessibilityActions={inert ? [] : [{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={onAction}
        >
          {width > 0 ? (
            <Svg width={W * scale} height={H * scale} viewBox={`0 0 ${W} ${H}`} style={{ marginLeft: offsetX }} pointerEvents="none" {...crisp}>
              <Path d={rectD(0, 0, W, BASE)} fill={sky && !sky.night ? ink.skyDay : ink.sky} {...crisp} />
              {sky ? <Path d={sky.main} fill={ink.muted} {...crisp} /> : null}
              {sky?.star ? <Path d={sky.star} fill={ink.faint} {...crisp} /> : null}
              <Path d={paths.gB} fill={ink.groundB} {...crisp} />
              <Path d={paths.gA} fill={ink.groundA} {...crisp} />
              <Path d={paths.bA} fill={ink.bldA} {...crisp} />
              <Path d={paths.bB} fill={ink.bldB} {...crisp} />
              <Path d={paths.wOff} fill={ink.winOff} {...crisp} />
              <Path d={paths.wOn} fill={ink.winOn} {...crisp} />
              <Path d={paths.now} fill={ink.lineStrong} {...crisp} />
              <Path d={paths.roof} fill={ink.data} {...crisp} />
              <Path d={paths.busy} fill={ink.hi} {...crisp} />
              <Path d={paths.fence} fill={ink.line} {...crisp} />
              {tick ? <Path d={tick} fill={ink.hi} {...crisp} /> : null}
              {labels.map((l, i) => (
                <SvgText key={i} x={l.x} y={l.y} textAnchor="middle" fontSize={5.5} fontFamily={font} fill={l.fill}>
                  {l.text}
                </SvgText>
              ))}
              <Path d={rectD(0, BASE, W, 1)} fill={ink.line} {...crisp} />
              <Path d={rail.laid} fill={ink.lineStrong} {...crisp} />
              <Path d={rail.dots} fill={ink.line} {...crisp} />
              <Path d={rail.post} fill={ink.lineStrong} {...crisp} />
              <Path d={rail.pad} fill={ink.muted} {...crisp} />
              <Path d={tickD} fill={ink.hi} {...crisp} />
            </Svg>
          ) : null}
          {width > 0 ? (
            <Animated.View style={[s.train, { top: TRAIN_TOP * scale, width: trainW, height: trainH, transform: [{ translateX: move }] }]} pointerEvents="none">
              {wagonN > 0 ? (
                <Svg
                  width={8 * wagonN * scale}
                  height={6 * scale}
                  viewBox={`0 0 ${8 * wagonN} 6`}
                  style={{ position: 'absolute', left: (BODYC - 16 - 8 * (wagonN - 1)) * scale, top: (68 - TRAIN_TOP) * scale }}
                  {...crisp}
                >
                  <Path d={wagonD.deck} fill={ink.lineStrong} {...crisp} />
                  <Path d={wagonD.crate} fill={ink.hi} {...crisp} />
                </Svg>
              ) : null}
              <MaglevMark height={trainH} cruising={cruising && wagonN === 0} />
            </Animated.View>
          ) : null}
        </View>
      </GestureDetector>
      <View style={s.axis} pointerEvents="none" importantForAccessibility="no-hide-descendants">
        {axis.map((a) => (
          <Text key={a.key} style={[s.axisText, a.centre ? [s.centre, { left: offsetX + a.left - 16 }] : { left: offsetX + a.left }]}>
            {a.text}
          </Text>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    train: { position: 'absolute', left: 0 },
    axis: { height: 16, marginTop: 2 },
    axisText: { ...typeTokens.mono, position: 'absolute', top: 0, fontSize: type.size.xs, lineHeight: 14, color: c.textMuted },
    centre: { width: 32, textAlign: 'center' },
  });
