/**
 * Stats (docs/NATIVE_CONTRACT.md section 34.2): the Pixel city for a week, month or year, and the card kit under it.
 * Every figure comes from the local stats tables; nothing leaves the phone.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, ScrollViewInstance, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useTheme } from '../context/ThemeContext';
import { ThemeColors, motion, radius, spacing, type } from '../constants/theme';
import { Button, IconButton, Screen, SegmentedControl, Sheet } from '../components/ui';
import { useMotion } from '../components/ui/useMotion';
import { PixelCity } from '../components/stats/PixelCity';
import { StatsKit, type SheetSpec } from '../components/stats/StatsKit';
import { getLiveCounts, getStatsStore, subscribeLive } from '../utils/stats';
import type { LiveCounts } from '../utils/stats/recorder';
import { hourReady, isThinData, mergeLive, summarySentence, vsLastWeek } from '../utils/stats/delight';
import { setStatsPrefs, useStatsPrefs } from '../utils/stats/prefs';
import {
  bucketsFor, busiestBucket, canStepRange, firstBucketIndex, firstStatsDay, mostInOneRange, rangeHolds, rangeOf, rangeStats, stepRange, switchRangeKind,
  type RangeKind, type StatsRange,
} from '../utils/stats/insights';
import { bucketReadout, fmtSize, rangeCaption, rangeTitle, shortDate } from '../utils/stats/format';
import { dayKey, dayNumber } from '../utils/stats/time';
import type { DailyRow, StatsRecord } from '../utils/stats/types';

const KINDS = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
] as const;

interface Rows {
  records: StatsRecord[];
  daily: DailyRow[];
  now: number;
}

/** The stats tables, reloaded (at most twice a second) whenever the store changes. Null until the first read. */
const NO_LIVE: LiveCounts = { days: {}, running: false };

function useStatsRows(): { rows: Rows | null; failed: boolean; live: LiveCounts } {
  const [rows, setRows] = useState<Rows | null>(null);
  // Today's bytes and seconds the recorder has counted but not written yet, so today moves while a download runs.
  const [live, setLive] = useState<LiveCounts>(NO_LIVE);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let liveTimer: ReturnType<typeof setTimeout> | undefined;
    setLive(getLiveCounts());
    const unsubLive = subscribeLive(() => {
      if (liveTimer) return;
      liveTimer = setTimeout(() => {
        liveTimer = undefined;
        if (alive) setLive(getLiveCounts());
      }, 500);
    });
    getStatsStore()
      .then((store) => {
        const load = () =>
          Promise.all([store.listRecords(), store.listDaily()])
            .then(([records, daily]) => alive && setRows({ records, daily, now: Date.now() }))
            .catch(() => alive && setFailed(true));
        void load();
        unsub = store.subscribe(() => {
          if (timer) return;
          timer = setTimeout(() => {
            timer = undefined;
            void load();
          }, 500);
        });
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      unsub?.();
      unsubLive();
      if (timer) clearTimeout(timer);
      if (liveTimer) clearTimeout(liveTimer);
    };
  }, []);
  return { rows, failed, live };
}

const EMPTY: Rows = { records: [], daily: [], now: Date.now() };

export default function StatsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const m = useMotion();
  const prefs = useStatsPrefs();
  const off = !prefs.keepStats;
  const { rows: loaded, failed, live } = useStatsRows();
  const rows = loaded ?? EMPTY;
  const today = dayNumber(dayKey(rows.now));
  const daily = useMemo(() => mergeLive(rows.daily, live), [rows.daily, live]);
  const input = useMemo(() => ({ records: rows.records, daily, now: rows.now }), [rows.records, daily, rows.now]);
  const firstDay = useMemo(() => firstStatsDay(daily), [daily]);
  const dayOne = !off && loaded != null && firstDay == null;

  // `range` follows the controls at once; `shown` is what the city and the kit draw, swapped mid cross-fade.
  const [range, setRange] = useState<StatsRange>(() => rangeOf('week', today));
  const [shown, setShown] = useState<StatsRange>(range);
  const pendingDay = useRef<number | null>(null);
  const pendingRange = useRef<StatsRange>(range);
  const fade = useSharedValue(1);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const commit = useCallback(() => setShown(pendingRange.current), []);
  useEffect(() => {
    if (!m.disabled) fade.value = withTiming(1, { duration: motion.duration.fast, easing: m.easing });
    // Fade back in once the new range is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  const go = useCallback(
    (next: StatsRange, selectDay: number | null = null) => {
      pendingDay.current = selectDay;
      pendingRange.current = next;
      setRange(next);
      if (m.disabled) {
        setShown(next);
        return;
      }
      fade.value = withTiming(0, { duration: motion.duration.exit, easing: m.easing }, (done) => {
        if (done) scheduleOnRN(commit);
      });
    },
    [m, fade, commit],
  );

  const stats = useMemo(() => rangeStats(input, shown), [input, shown]);
  const buckets = useMemo(() => bucketsFor(shown, daily, today), [shown, daily, today]);
  const busiest = useMemo(() => busiestBucket(buckets), [buckets]);
  const minIndex = useMemo(() => firstBucketIndex(buckets, firstDay), [buckets, firstDay]);
  const mostSecs = useMemo(() => mostInOneRange(rows.records, shown, undefined, firstDay, daily), [rows.records, shown, firstDay, daily]);
  const thin = useMemo(() => isThinData(firstDay, today), [firstDay, today]);
  const sentence = useMemo(() => (off ? null : summarySentence(stats, shown, today)), [off, stats, shown, today]);
  const vs = useMemo(() => (off ? null : vsLastWeek(daily, shown, today)), [off, daily, shown, today]);
  const sinceDay = firstDay != null && rangeHolds(shown, firstDay) ? firstDay : null;
  const inert = off || loaded == null || dayOne || stats.empty;

  const [sel, setSel] = useState(-1);
  // The day picked when the range was last opened. Live counts refresh `buckets` about twice a second while something
  // downloads, so the pick is only redone when the range itself changes (or the screen becomes inert/live). Before,
  // every refresh put the train back on today a second after the user moved it.
  const pickedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = `${shown.kind}:${shown.start}:${shown.end}:${inert ? 1 : 0}`;
    const d = pendingDay.current;
    if (pickedFor.current === key && d == null) {
      setSel((cur) => (cur >= buckets.length ? buckets.length - 1 : cur));
      return;
    }
    pickedFor.current = key;
    pendingDay.current = null;
    const at = d != null ? buckets.findIndex((b) => d >= b.start && d <= b.end) : -1;
    // The train rests on today in the current range; a past range opens on its busiest building.
    const cur = buckets.findIndex((b) => b.current);
    setSel(inert ? -1 : at >= 0 ? at : cur >= 0 ? cur : busiest);
  }, [buckets, busiest, inert, shown]);

  const [info, setInfo] = useState(false);
  const [sheet, setSheet] = useState<SheetSpec | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const scroll = useRef<ScrollViewInstance>(null);
  const openSheet = useCallback(
    (spec: SheetSpec) => {
      if (spec.day != null) {
        const i = buckets.findIndex((b) => spec.day! >= b.start && spec.day! <= b.end);
        if (i >= 0) setSel(i);
      }
      setSheet(spec);
      setSheetOpen(true);
    },
    [buckets],
  );
  const showDay = useCallback(() => {
    const d = sheet?.day;
    setSheetOpen(false);
    if (d == null) return;
    go(rangeOf('week', d), d);
    scroll.current?.scrollTo({ y: 0, animated: !m.disabled });
  }, [sheet, go, m.disabled]);

  const title = rangeTitle(range, today);
  const unit = shown.kind === 'year' ? 'week' : 'day';
  const b = sel >= 0 ? buckets[sel] : null;
  let r1: string;
  let r2 = '';
  let hint = '';
  if (off) {
    r1 = 'Stats are off';
    r2 = "Maglev isn't keeping stats right now.";
  } else if (failed) {
    r1 = "Stats couldn't be read";
    r2 = 'Try again later.';
  } else if (loaded == null) {
    r1 = '';
  } else if (dayOne) {
    r1 = 'Download something and your first building appears here';
  } else if (stats.empty) {
    r1 = `Nothing downloaded in ${rangeTitle(shown, today)}`;
    r2 = 'When a download finishes, its building goes up';
  } else if (b) {
    r1 = `${b.label}${b.current ? ' · so far' : ''}${sel === busiest ? ` · busiest ${b.noun}` : ''}`;
    r2 = bucketReadout(b);
    hint = 'Drag the train to read each day';
  } else r1 = '';

  const nudge = (d: number) => {
    if (inert) return;
    const cur = sel < 0 ? Math.max(minIndex, busiest) : sel;
    setSel(Math.max(minIndex, Math.min(buckets.length - 1, cur + d)));
  };

  return (
    <Screen title="Stats" onBack={() => router.back()} edges={['top', 'left', 'right', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView ref={scroll} contentContainerStyle={s.content}>
        <SegmentedControl
          options={KINDS}
          value={range.kind}
          onChange={(k: RangeKind) => !off && go(switchRangeKind(range, k, today, firstDay))}
          accessibilityLabel="Range"
        />
        <View style={s.rnav}>
          <View style={s.flip}>
            <IconButton
              icon="chevron-right"
              size={24}
              accessibilityLabel={`Previous ${range.kind}`}
              disabled={off || !canStepRange(range, -1, firstDay, today)}
              onPress={() => go(stepRange(range, -1))}
            />
          </View>
          <Text style={s.rl} accessibilityLiveRegion="polite">
            {title}
          </Text>
          <IconButton
            icon="chevron-right"
            size={24}
            accessibilityLabel={`Next ${range.kind}`}
            disabled={off || !canStepRange(range, 1, firstDay, today)}
            onPress={() => go(stepRange(range, 1))}
          />
        </View>

        <View style={s.city}>
          <View style={s.hero}>
            {sentence ? (
              <Text style={s.sentence} accessibilityLabel={`${sentence.lead}${sentence.rest}`}>
                <Text style={s.big}>{sentence.lead}</Text>
                {sentence.rest}
              </Text>
            ) : (
              <Text style={s.big}>{off ? '—' : fmtSize(stats.downloaded)}</Text>
            )}
            {vs ? <Text style={s.vs}>{vs.text}</Text> : null}
            {sinceDay != null ? <Text style={s.since}>{`Since ${shortDate(sinceDay)}`}</Text> : null}
            <View style={s.lblRow}>
              <Text style={s.lbl}>{sentence ? ' ' : off ? 'Stats are off' : rangeCaption(shown, today)}</Text>
              <IconButton icon="about" size={16} color={colors.textMuted} accessibilityLabel="What is this?" onPress={() => setInfo((v) => !v)} />
            </View>
            {info ? <Text style={s.cap}>{`Each building is one ${unit}. Taller means more downloaded. The train shows the day: drag it along the rail.`}</Text> : null}
          </View>
          <Animated.View style={fadeStyle}>
            <PixelCity
              kind={shown.kind}
              buckets={buckets}
              busiest={inert ? -1 : busiest}
              selected={sel}
              minIndex={minIndex}
              peakHour={inert || !hourReady(stats.hours) ? null : stats.peakHour}
              finished={inert ? 0 : stats.finished}
              live={live.running && stats.includesToday}
              inert={inert}
              onPick={setSel}
              accessibilityLabel={`Pixel city for ${rangeTitle(shown, today)}. Each building is one ${unit}.`}
              valueText={[r1, r2].filter(Boolean).join(', ')}
            />
          </Animated.View>
          <View style={s.readRow}>
            {inert ? null : (
              <View style={s.flip}>
                <IconButton icon="chevron-right" size={24} accessibilityLabel={`Previous ${unit}`} disabled={sel <= minIndex} onPress={() => nudge(-1)} />
              </View>
            )}
            <View style={s.readout} accessibilityLiveRegion="polite">
              <Text style={s.r1}>{r1}</Text>
              {r2 ? <Text style={s.r2}>{r2}</Text> : null}
              {hint ? <Text style={s.hint}>{hint}</Text> : null}
            </View>
            {inert ? null : (
              <IconButton icon="chevron-right" size={24} accessibilityLabel={`Next ${unit}`} disabled={sel >= buckets.length - 1} onPress={() => nudge(1)} />
            )}
          </View>
        </View>

        {off ? (
          <View style={s.offCard}>
            <Text style={s.offText}>Turn on stats to see your downloads here. Nothing is recorded while they are off.</Text>
            <Button label="Turn on stats" variant="secondary" onPress={() => setStatsPrefs({ keepStats: true })} />
          </View>
        ) : (
          <Animated.View style={fadeStyle}>
            <StatsKit
              range={shown}
              today={today}
              stats={stats}
              mostSecs={mostSecs}
              mobileLimitBytes={prefs.mobileLimitMb != null ? prefs.mobileLimitMb * 1024 * 1024 : null}
              thin={thin}
              onOpen={openSheet}
            />
          </Animated.View>
        )}
        <Text style={s.foot}>Stats stay on this phone.</Text>
      </ScrollView>

      <Sheet visible={sheetOpen} onClose={() => setSheetOpen(false)} title={sheet?.title ?? ''}>
        {sheet?.rows.map(([k, v], i) => (
          <View key={k} style={[s.trow, i === 0 && s.trowFirst]}>
            <Text style={s.tl}>{k}</Text>
            <Text style={s.tv}>{v}</Text>
          </View>
        ))}
        {sheet?.day != null && shown.kind !== 'week' ? (
          <View style={s.sact}>
            <Button label="Show this day" variant="secondary" fullWidth onPress={showDay} />
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
    rnav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: -spacing.sm, marginVertical: spacing.sm },
    flip: { transform: [{ scaleX: -1 }] },
    rl: { ...type.bodyStrong, fontSize: type.size.lg, color: c.text, fontVariant: ['tabular-nums'] },
    city: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, overflow: 'hidden' },
    hero: { paddingTop: 14, paddingHorizontal: 14, paddingBottom: 10, gap: 2 }, // design-exception: hero padding is tuned to the 37 px big-number line height
    big: { ...type.heading, fontSize: type.size.display, lineHeight: 37, color: c.text, fontVariant: ['tabular-nums'] },
    lblRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: -spacing.sm, marginRight: -10, marginBottom: -10 }, // design-exception: negative offsets pull the label row tight against the big number
    lbl: { ...type.body, fontSize: type.size.md, color: c.textMuted, flex: 1 },
    cap: { ...type.body, fontSize: type.size.md, color: c.text, marginTop: spacing.xs },
    sentence: { ...type.body, fontSize: type.size.lg, lineHeight: 37, color: c.text },
    vs: { ...type.body, fontSize: type.size.md, color: c.textMuted, fontVariant: ['tabular-nums'] },
    since: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    readRow: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: c.border, paddingHorizontal: 2, minHeight: 64 }, // design-exception: 2 px optical inset for the readout dividers, 64 px row is chart geometry
    readout: { flex: 1, paddingVertical: spacing.md, paddingHorizontal: spacing.xs, alignItems: 'center', gap: 2 },
    r1: { ...type.bodyStrong, fontSize: type.size.base, color: c.text, textAlign: 'center' },
    r2: { ...type.mono, fontSize: type.size.sm, color: c.textMuted, textAlign: 'center' },
    hint: { ...type.body, fontSize: type.size.sm, color: c.textMuted, textAlign: 'center' },
    offCard: { marginTop: spacing.xxl, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
    offText: { ...type.body, fontSize: type.size.base, lineHeight: 20, color: c.textMuted },
    foot: { ...type.body, fontSize: type.size.sm, color: c.textFaint, paddingTop: spacing.lg, paddingHorizontal: spacing.xs },
    trow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: c.border },
    trowFirst: { borderTopWidth: 0 },
    tl: { ...type.body, fontSize: type.size.md, color: c.textMuted, flexShrink: 0 },
    tv: { ...type.mono, fontSize: type.size.base, color: c.text, flexShrink: 1, textAlign: 'right' },
    sact: { paddingTop: spacing.md },
  });

export { ErrorBoundary } from '../components/ErrorScreen';
