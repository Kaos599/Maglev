/**
 * The card kit under the city, in five sections: Downloads, Habits, Data, Records, What you download. While stats are thin (under a
 * week old) Habits and Records fold into one quiet line. Every card means
 * the same in every range and reads only `RangeStats`. Unknown is "—"; a card with nothing to say has no chevron.
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import {
  categoryLabel, dayLabel, durationParts, fmtCount, fmtDays, fmtDuration, fmtHour, fmtSize, fmtSpeed, fmtTook, gaugeMax, crateUnit,
  periodName, periodPhrase, shortDate, sizeParts, sourceLabel, speedParts,
} from '../../utils/stats/format';
import { largestRemainder, type RangeStats, type StatsRange } from '../../utils/stats/insights';
import { PressableScale } from '../ui';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { BigValue, StatCard } from './StatCard';
import { Battery, Clock, Crates, CRATE_CAP, Fire, Hourglass, Phone, Speedo, UpDown } from './pictures';
import { fireStage, hourReady, SHOW_STREAK_CARD } from '../../utils/stats/delight';
import { statsInk } from './ink';

const MB = 1024 * 1024;

export interface SheetSpec {
  title: string;
  rows: [string, string][];
  /** A record's day: highlights its bucket, and "Show this day" when the range is wider than a week. */
  day?: number;
}

export interface StatsKitProps {
  range: StatsRange;
  today: number;
  stats: RangeStats;
  /** The most time spent downloading in one range of this kind (for the hourglass). */
  mostSecs: number;
  mobileLimitBytes: number | null;
  /** Stats are under a week old: Habits and Records fold into one quiet line. */
  thin: boolean;
  onOpen: (s: SheetSpec) => void;
}

export function StatsKit({ range, today, stats: A, mostSecs, mobileLimitBytes, thin, onOpen }: StatsKitProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const ink = useMemo(() => statsInk(colors), [colors]);
  const sec = (title: string, children: React.ReactNode) => (
    <View style={s.section}>
      <Text style={s.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      <View style={s.grid}>{children}</View>
    </View>
  );

  // Downloads
  const per = crateUnit(A.finished, CRATE_CAP);
  // Always one line under the number, chips or not, so the card keeps one height and the number one place.
  const chips =
    A.failed || A.cancelled ? (
      <View style={s.notes}>
        {A.failed ? <Text style={[s.note, s.noteBad]}>{`${A.failed} failed`}</Text> : null}
        {A.cancelled ? <Text style={s.note}>{`${A.cancelled} cancelled`}</Text> : null}
      </View>
    ) : (
      <View style={s.notes}>
        <Text style={s.noteLine}>{A.finished ? 'none failed' : ' '}</Text>
      </View>
    );
  const finished = (
    <StatCard
      full
      box="full"
      title="Finished"
      value={<BigValue text={fmtCount(A.finished)} tone={A.finished ? 'normal' : 'dim'} />}
      sub={chips}
      picture={<Crates finished={A.finished} ink={ink} />}
      onPress={A.empty ? undefined : () => onOpen({ title: 'Finished', rows: [['Finished', fmtCount(A.finished)], ['Failed', String(A.failed)], ['Cancelled', String(A.cancelled)], ['One crate', per === 1 ? '1 download' : `${per} downloads`]] })}
      accessibilityLabel={`Finished: ${A.finished}${A.failed ? `, ${A.failed} failed` : ''}${A.cancelled ? `, ${A.cancelled} cancelled` : ''}`}
    />
  );
  const time = (
    <StatCard
      title="Time spent"
      value={A.activeSecs > 0 ? <BigValue parts={durationParts(A.activeSecs)} /> : <BigValue />}
      sub={periodPhrase(range, today)}
      picture={<Hourglass fraction={mostSecs > 0 ? A.activeSecs / mostSecs : 0} ink={ink} />}
      onPress={A.activeSecs > 0 ? () => onOpen({ title: 'Time spent', rows: [['Downloading', fmtDuration(A.activeSecs)], [`Most in one ${range.kind}`, mostSecs ? fmtDuration(mostSecs) : '—'], ['Paused or waiting', 'Not counted']] }) : undefined}
      accessibilityLabel={`Time spent downloading ${periodPhrase(range, today)}: ${A.activeSecs > 0 ? fmtDuration(A.activeSecs) : 'unknown'}`}
    />
  );
  const mbps = A.avgBps != null ? A.avgBps / MB : 0;
  const gauge = gaugeMax(Math.max(mbps * 1.4, A.quickest ? A.quickest.bps / MB : 0));
  const speed = (
    <StatCard
      title="Average speed"
      value={A.avgBps != null ? <BigValue parts={[speedParts(A.avgBps)]} /> : <BigValue />}
      sub="while downloading"
      picture={<Speedo v={mbps} max={gauge} ink={ink} />}
      onPress={A.avgBps != null ? () => onOpen({ title: 'Average speed', rows: [['Average', fmtSpeed(A.avgBps!)], ['Worked out from', 'all bytes ÷ all time downloading'], ['Gauge goes to', `${gauge} MB/s`]] }) : undefined}
      accessibilityLabel={`Average speed while downloading: ${A.avgBps != null ? fmtSpeed(A.avgBps) : 'unknown'}`}
    />
  );

  // Streak card: built, and off until the owner decides (SHOW_STREAK_CARD in utils/stats/delight.ts). Its fire starts at the flame.
  const streak = SHOW_STREAK_CARD ? (
    <StatCard
      full
      box="full"
      title="Longest streak"
      value={A.knownDays.length === 0 ? <BigValue /> : <BigValue parts={[{ n: String(A.streak.days), unit: A.streak.days === 1 ? 'day' : 'days' }]} tone={A.streak.days ? 'normal' : 'dim'} />}
      sub={A.includesToday && A.knownDays.length > 0 ? <Text style={s.sub}>{`Now: ${fmtDays(A.currentStreak)}`}</Text> : null}
      picture={<Fire stage={fireStage(A.includesToday ? A.currentStreak : 0)} ink={ink} />}
      onPress={
        A.knownDays.length === 0
          ? undefined
          : () =>
              onOpen({
                title: 'Longest streak',
                rows: [
                  ['Longest', A.streak.days ? fmtDays(A.streak.days) : '—'],
                  ['When', A.streak.days > 1 && A.streak.from != null && A.streak.to != null ? `${shortDate(A.streak.from)}–${shortDate(A.streak.to)}` : A.streak.from != null ? shortDate(A.streak.from) : '—'],
                  ...(A.includesToday ? ([['Now', fmtDays(A.currentStreak)]] as [string, string][]) : []),
                  ['A day counts when', 'something finishes'],
                ],
              })
      }
      accessibilityLabel={A.knownDays.length === 0 ? 'Longest streak: unknown' : `Longest streak: ${fmtDays(A.streak.days)}${A.includesToday ? `. Now: ${fmtDays(A.currentStreak)}` : ''}`}
    />
  ) : null;

  // Habits
  const ready = A.peakHour != null && hourReady(A.hours);
  const hour = (
    <StatCard
      full
      box="full"
      title="Downloads usually finish"
      pre={ready ? <Text style={s.sub}>around</Text> : null}
      value={ready ? <BigValue text={fmtHour(A.peakHour!)} /> : <BigValue text={A.peakHour != null ? 'Not yet' : undefined} tone="dim" />}
      sub={ready ? null : A.peakHour != null ? <Text style={s.sub}>Shows after 5 finished downloads</Text> : null}
      picture={<Clock hour={ready ? A.peakHour : null} ink={ink} />}
      onPress={ready ? () => onOpen({ title: 'Downloads usually finish', rows: [['Around', fmtHour(A.peakHour!)], ['Counted from', 'when each download finished']] }) : undefined}
      accessibilityLabel={ready ? `Downloads usually finish around ${fmtHour(A.peakHour!)}` : 'Downloads usually finish: not enough downloads yet'}
    />
  );

  // Data
  const gaugeOn = mobileLimitBytes != null && range.kind === 'month';
  const over = gaugeOn && A.mobile > mobileLimitBytes!;
  const moved = A.wifi + A.mobile;
  const mobileSub = gaugeOn
    ? over
      ? `${fmtSize(A.mobile - mobileLimitBytes!)} over ${fmtSize(mobileLimitBytes!)}`
      : `of ${fmtSize(mobileLimitBytes!)}`
    : moved > 0
      ? `of ${fmtSize(moved)} total`
      : '';
  const mobile = (
    <StatCard
      title="Mobile data"
      value={<BigValue parts={[sizeParts(A.mobile)]} tone={over ? 'danger' : A.mobile ? 'normal' : 'dim'} />}
      sub={mobileSub ? <Text style={[s.sub, over && { color: colors.danger }]} numberOfLines={1}>{mobileSub}</Text> : null}
      picture={gaugeOn ? <Battery used={A.mobile} limit={mobileLimitBytes!} ink={ink} /> : <Phone ink={ink} />}
      onPress={
        A.empty
          ? undefined
          : () =>
              onOpen({
                title: 'Mobile data',
                rows: [
                  ['Used', fmtSize(A.mobile)],
                  ['Period', periodName(range, today)],
                  ['Monthly limit', mobileLimitBytes != null ? fmtSize(mobileLimitBytes) : 'Not set'],
                  ...(over ? ([['Over by', fmtSize(A.mobile - mobileLimitBytes!)]] as [string, string][]) : []),
                ],
              })
      }
      accessibilityLabel={`Mobile data: ${fmtSize(A.mobile)}${mobileSub ? `, ${mobileSub}` : ''}`}
    />
  );
  const shared = (
    <StatCard
      title="You shared"
      value={<BigValue parts={[sizeParts(A.uploaded)]} tone={A.uploaded ? 'normal' : 'dim'} />}
      sub={A.downloaded > 0 ? `ratio ${(A.uploaded / A.downloaded).toFixed(2)}` : ''}
      picture={<UpDown down={A.downloaded} up={A.uploaded} ink={ink} />}
      onPress={A.uploaded > 0 ? () => onOpen({ title: 'You shared', rows: [['Uploaded', fmtSize(A.uploaded)], ['Downloaded', fmtSize(A.downloaded)], ['From', 'torrents while seeding']] }) : undefined}
      accessibilityLabel={`You shared ${fmtSize(A.uploaded)}`}
    />
  );

  // Records
  const recTile = (key: string, icon: PixelIconName, title: string, day: number | null, value: React.ReactNode, sheet: SheetSpec | null) => (
    <StatCard
      key={key}
      box="none"
      title={title}
      icon={icon}
      iconColor={day != null ? ink.data : ink.lineStrong}
      value={day != null ? value : <BigValue />}
      sub={day != null ? dayLabel(day) : ''}
      onPress={sheet ? () => onOpen(sheet) : undefined}
      accessibilityLabel={day != null ? `${title}: ${sheet?.rows[0][1] ?? ''}, ${dayLabel(day)}` : `${title}: none yet`}
    />
  );
  const { biggest, quickest, longest, busiestDay } = A;
  const records = [
    recTile('big', 'storage', 'Biggest', biggest?.day ?? null, biggest ? <BigValue parts={[sizeParts(biggest.size)]} /> : null,
      biggest ? { title: 'Biggest download', rows: [['Biggest', fmtSize(biggest.size)], ['File', biggest.name], ['Finished', dayLabel(biggest.day)]], day: biggest.day } : null),
    recTile('fast', 'speed-limit', 'Quickest', quickest?.day ?? null, quickest ? <BigValue parts={[speedParts(quickest.bps)]} /> : null,
      quickest ? { title: 'Quickest download', rows: [['Average for this download', fmtSpeed(quickest.bps)], ['File', quickest.name], ['Finished', dayLabel(quickest.day)], ['Worked out from', 'its bytes ÷ its time downloading']], day: quickest.day } : null),
    recTile('long', 'clock', 'Longest', longest?.day ?? null, longest ? <BigValue parts={durationParts(longest.activeSecs)} /> : null,
      longest ? { title: 'Longest download', rows: [['Longest', fmtTook(longest.activeSecs)], ['File', longest.name], ['Finished', dayLabel(longest.day)]], day: longest.day } : null),
    recTile('busy', 'calendar', 'Busiest day', busiestDay?.day ?? null, busiestDay ? <BigValue parts={[sizeParts(busiestDay.downloaded)]} /> : null,
      busiestDay ? { title: 'Busiest day', rows: [['Busiest day', fmtSize(busiestDay.downloaded)], ['Day', dayLabel(busiestDay.day)], ['Finished that day', String(busiestDay.finished)]], day: busiestDay.day } : null),
  ];

  return (
    <View>
      {sec('Downloads', <>{finished}{time}{speed}{streak}</>)}
      {thin ? (
        <Text style={s.quiet}>Habits and records show up after a week of downloads.</Text>
      ) : (
        sec('Habits', hour)
      )}
      {sec('Data', <>{mobile}{shared}</>)}
      {thin ? null : sec('Records', records)}
      {sec('What you download', <WhatYouDownload stats={A} onOpen={onOpen} />)}
    </View>
  );
}

const COLS = 28;
const CELLS = COLS * 2;

/** The top category with its swatch, one 28 x 2 block bar by category, then the next two and Other. */
function WhatYouDownload({ stats: A, onOpen }: { stats: RangeStats; onOpen: (s: SheetSpec) => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const ink = useMemo(() => statsInk(colors), [colors]);
  const cat = A.categories;
  const rows = [...cat.top.map((r, i) => ({ ...r, color: ink.categories[i] })), ...(cat.other ? [{ ...cat.other, color: ink.categories[3] }] : [])];
  const head = rows[0];
  const cells = largestRemainder(rows.map((r) => r.pct), CELLS);
  const colours: string[] = [];
  rows.forEach((r, i) => {
    for (let k = 0; k < cells[i]; k++) colours.push(r.color);
  });
  while (colours.length < CELLS) colours.push(ink.raised);
  const bar = [0, 1].map((row) => (
    <View key={row} style={s.barRow}>
      {colours.slice(row * COLS, row * COLS + COLS).map((c, i) => (
        <View key={i} style={[s.cell, { backgroundColor: c }]} />
      ))}
    </View>
  ));
  const label = rows.map((r) => `${r.label} ${r.pct}%`).join(', ') || 'Nothing yet';
  const body = (
    <>
      <Text style={s.title}>Most downloaded</Text>
      {head ? (
        <View style={s.chev} pointerEvents="none">
          <PixelIcon name="chevron-right" size={16} color={colors.textMuted} />
        </View>
      ) : null}
      <View style={s.whatHead}>
        <View style={s.whatTop}>
          {head ? <View style={[s.swatch, { backgroundColor: head.color }]} /> : null}
          <Text style={[s.big, !head && { color: colors.textFaint }]} numberOfLines={1}>
            {head ? head.label : '—'}
          </Text>
        </View>
        <Text style={s.sub}>{head ? `${head.pct}% · ${fmtSize(head.bytes)}` : 'Shows once something has finished'}</Text>
      </View>
      <View style={s.bar} accessible accessibilityRole="image" accessibilityLabel={label}>
        {bar}
      </View>
      {rows.length > 1 ? (
        <View style={s.list}>
          {rows.slice(1).map((r) => (
            <View key={r.key} style={s.krow}>
              <View style={[s.dot, { backgroundColor: r.color }]} />
              <Text style={s.kl} numberOfLines={1}>
                {r.label}
              </Text>
              <Text style={s.ks}>{fmtSize(r.bytes)}</Text>
              <Text style={s.kp}>{`${r.pct}%`}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
  if (!head) return <View style={[s.card, s.what]}>{body}</View>;
  const sheet: SheetSpec = {
    title: 'What you download',
    rows: [
      ...cat.all.map((r) => [categoryLabel(r.key), `${fmtSize(r.bytes)} · ${r.pct}%`] as [string, string]),
      ...(A.sources.length ? ([['Came from', A.sources.map((x) => `${sourceLabel(x.source)} ${x.pct}%`).join(', ')]] as [string, string][]) : []),
    ],
  };
  return (
    <PressableScale onPress={() => onOpen(sheet)} containerStyle={s.fullWrap} style={[s.card, s.what]} accessibilityRole="button" accessibilityLabel={`Most downloaded: ${label}`} accessibilityHint="Opens details">
      {body}
    </PressableScale>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    section: { marginTop: spacing.xxl },
    sectionTitle: { ...type.bodyStrong, fontSize: type.size.sm, color: c.textMuted, paddingHorizontal: spacing.xs, paddingBottom: spacing.sm },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    sub: { ...type.body, fontSize: type.size.sm, lineHeight: 16, color: c.textMuted },
    quiet: { ...type.body, fontSize: type.size.md, lineHeight: 18, color: c.textMuted, marginTop: spacing.xxl, paddingHorizontal: spacing.xs },
    notes: { flexDirection: 'row', gap: spacing.sm },
    note: { ...type.body, fontSize: type.size.xs, lineHeight: 18, height: 20, paddingHorizontal: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: c.borderStrong, color: c.textMuted, overflow: 'hidden' }, // design-exception: note pill is tuned to height 20 / lineHeight 18, side padding stays 6
    noteBad: { borderColor: c.danger, color: c.danger },
    noteLine: { ...type.body, fontSize: type.size.sm, lineHeight: 20, height: 20, color: c.textMuted },
    card: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: 14 }, // design-exception: tile padding 14 matches the chevron inset (top/right 14) and the minHeight 122 tile geometry
    fullWrap: { flexBasis: '100%' },
    what: { flexBasis: '100%', gap: spacing.md },
    title: { ...type.bodyStrong, fontSize: type.size.sm, lineHeight: 16, color: c.textMuted, paddingRight: spacing.xxl },
    chev: { position: 'absolute', top: 14, right: 14 },
    whatHead: { gap: 2 },
    whatTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    swatch: { width: 12, height: 12, borderRadius: 1 },
    big: { ...type.monoBold, fontSize: type.size.xxl, lineHeight: 28, color: c.text, flexShrink: 1 },
    bar: { gap: 2, marginTop: 2 },
    barRow: { flexDirection: 'row', gap: 2 },
    cell: { flex: 1, aspectRatio: 1, borderRadius: 1 },
    list: { gap: spacing.sm },
    krow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 18 },
    dot: { width: 8, height: 8, borderRadius: 1 },
    kl: { ...type.body, fontSize: type.size.md, color: c.text, flex: 1 },
    ks: { ...type.mono, fontSize: type.size.md, color: c.text, textAlign: 'right' },
    kp: { ...type.mono, fontSize: type.size.md, color: c.textMuted, textAlign: 'right', width: 40 },
  });
