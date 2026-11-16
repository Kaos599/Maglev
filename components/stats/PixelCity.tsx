/**
 * The Pixel city: one building per bucket (days in a week or month, Monday-start weeks in a year). Height is bytes
 * downloaded, lit windows are downloads finished, the busiest building has an accent outline and label, the moon or sun
 * sits at the hour most downloads finished. Drawn with react-native-svg at an integer scale where the width allows,
 * every shape a crisp rectangle. Drag across it, or use the steppers, to read one building.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View, type AccessibilityActionEvent, type GestureResponderEvent } from 'react-native';
import Svg, { Path, Text as SvgText } from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';
import { easeOutCubic, type ThemeColors, type as typeTokens } from '../../constants/theme';
import { MaglevMark } from '../brand/MaglevMark';
import { MARK_FX_COMPACT } from '../brand/markPaths';
import { useReduceMotion } from '../motion';
import { fmtSize } from '../../utils/stats/format';
import { dayOfDate, partsOf, weekdayOf } from '../../utils/stats/time';
import type { Bucket, RangeKind } from '../../utils/stats/insights';
import { frameD, rectD, spriteD, SPRITES } from './pixels';
import { statsInk } from './ink';

const H = 78;
const BASE = 62;
const RAIL_Y = 75;
const TRAIN_H = 8;
const TRAIN_X = 2;
const DESIGN_W = 163;
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CRUISE_LOOPS = 3;

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
  /** Off, day one or an empty range: the city is still and does not answer touches. */
  inert: boolean;
  onPick: (i: number) => void;
  accessibilityLabel: string;
  valueText: string;
}

export function PixelCity({ kind, buckets, busiest, selected, minIndex, peakHour, inert, onPick, accessibilityLabel, valueText }: PixelCityProps) {
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

  // First open: buildings rise (220 ms each, staggered, ease-out). Reduce motion: still.
  const [t, setT] = useState<number | null>(() => (roseThisRun || reduce ? null : 0));
  useEffect(() => {
    if (t === null || width === 0 || buckets.length === 0) return;
    roseThisRun = true;
    const stagger = Math.min(8, 300 / buckets.length);
    const total = 220 + stagger * buckets.length;
    let raf = 0;
    const t0 = Date.now();
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
    return () => cancelAnimationFrame(raf);
    // Runs once, when the city first has a size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width > 0, buckets.length > 0]);

  // The train dashes a few loops on first open, then rests.
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
    let busy = '';
    const stagger = Math.min(8, 300 / Math.max(1, buckets.length));
    buckets.forEach((b, i) => {
      const px = ux(i);
      const alt = kind === 'year' ? partsOf(b.start).m % 2 === 1 : b.weekend;
      const g = rectD(px, BASE + 1, L.bw, 2);
      if (alt) gB += g;
      else gA += g;
      if (b.future) for (let k = 0; k < L.bw; k += 2) fence += rectD(px + k, BASE - 1, 1, 1);
      const full = heights[i];
      const h = t == null ? full : Math.round(full * easeOutCubic((t - i * stagger) / 220));
      const top = BASE - h;
      if (b.current) {
        const nh = Math.max(3, h);
        now += frameD(px, BASE - nh, L.bw, nh);
      }
      if (h > 0) {
        if (!b.current) {
          if (i % 2) bB += rectD(px, top, L.bw, h);
          else bA += rectD(px, top, L.bw, h);
        }
        let k = 0;
        for (let y = BASE - 1 - L.wr; y >= top + 2; y -= L.wr) {
          for (let c = 0; c < L.wc.length; c++, k++) {
            const w = rectD(px + L.wc[c], y, L.ws, L.ws === 2 && L.wr === 2 ? 1 : L.ws);
            if (k < b.finished) wOn += w;
            else if (!b.current) wOff += w;
          }
        }
      }
      if (i === busiest && (h > 0 || t == null)) busy += frameD(px - 1, BASE - Math.max(3, h) - 1, L.bw + 2, Math.max(3, h) + 1);
    });
    return { gA, gB, fence, bA, bB, wOff, wOn, now, busy };
  }, [buckets, heights, t, ux, L, kind, busiest]);

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
        const cx = ux(i) + L.bw / 2;
        const top = BASE - Math.max(heights[i], 3);
        if (i === busiest) {
          out.push({ x: cx, y: top - 9, text: 'Busiest', fill: ink.hi });
          out.push({ x: cx, y: top - 3, text: fmtSize(b.downloaded), fill: ink.hi });
        } else out.push({ x: cx, y: top - 3, text: b.downloaded > 0 ? fmtSize(b.downloaded) : '0', fill: ink.muted });
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

  const sel = selected >= 0 && buckets[selected] ? frameD(ux(selected) - 2, BASE - Math.max(3, heights[selected]) - 2, L.bw + 4, Math.max(3, heights[selected]) + 2) : '';

  // One touch across the whole city: snap to the nearest building by x.
  const unitAt = useCallback(
    (xDp: number) => {
      const i = Math.round((xDp / scale - L.x0 - L.bw / 2) / L.pitch);
      return Math.max(minIndex, Math.min(buckets.length - 1, i));
    },
    [scale, L, minIndex, buckets.length],
  );
  const offsetX = (width - W * scale) / 2;
  const onTouch = useCallback((e: GestureResponderEvent) => onPick(unitAt(e.nativeEvent.locationX - offsetX)), [onPick, unitAt, offsetX]);
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
  const trainTop = (RAIL_Y - (83.25 - 42) * (TRAIN_H / 44)) * scale;

  return (
    <View onLayout={onLayout}>
      <View
        style={{ height: H * scale }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: valueText }}
        accessibilityActions={inert ? [] : [{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={onAction}
        onStartShouldSetResponder={() => !inert}
        onResponderGrant={onTouch}
        onResponderMove={onTouch}
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
            <Path d={paths.busy} fill={ink.hi} {...crisp} />
            <Path d={paths.fence} fill={ink.line} {...crisp} />
            {tick ? <Path d={tick} fill={ink.hi} {...crisp} /> : null}
            {labels.map((l, i) => (
              <SvgText key={i} x={l.x} y={l.y} textAnchor="middle" fontSize={5.5} fontFamily={font} fill={l.fill}>
                {l.text}
              </SvgText>
            ))}
            <Path d={sel} fill={ink.text} {...crisp} />
            <Path d={rectD(0, BASE, W, 1) + rectD(0, RAIL_Y, W, 1)} fill={ink.line} {...crisp} />
          </Svg>
        ) : null}
      </View>
      {width > 0 ? (
        <View style={[s.train, { left: offsetX + TRAIN_X * scale, top: trainTop }]}>
          <MaglevMark height={trainH} cruising={cruising} tappable />
        </View>
      ) : null}
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
    train: { position: 'absolute' },
    axis: { height: 16, marginTop: 2 },
    axisText: { ...typeTokens.mono, position: 'absolute', top: 0, fontSize: 11, lineHeight: 14, color: c.textMuted },
    centre: { width: 32, textAlign: 'center' },
  });
