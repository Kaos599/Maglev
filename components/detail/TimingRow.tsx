/**
 * The detail screen's timing: one full-width row, "Took" (or "Downloading for") and "Avg download",
 * that opens the Timing sheet. While no timing is known yet it reads "—" and has no chevron. The sheet adds only what the row does not
 * show: when it was added and finished, where that time went, the network split and seeding. Rows with nothing to say
 * are left out.
 */
import React, { useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { fmtSize, timingView, type TimingInput } from '../../utils/stats/format';
import { PixelIcon } from '../PixelIcon';
import { PressableScale, Sheet } from '../ui';

/**
 * `onOpen`: open the Timing sheet somewhere else (a host that is itself a sheet shows it as its own step, with
 * `TimingDetails`). Without it the row opens its own sheet.
 */
export function TimingRow({ timing, onOpen }: { timing: TimingInput; onOpen?: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);
  const ref = useRef<any>(null);
  const v = timingView(timing, Date.now());
  const cells = (
    <>
      <View style={s.cellBox}>
        <Text style={s.k}>{v.tookLabel}</Text>
        <Text style={s.v} numberOfLines={1}>
          {v.took ?? '—'}
        </Text>
      </View>
      <View style={s.cellBox}>
        <Text style={s.k}>Avg download</Text>
        <Text style={s.v} numberOfLines={1}>
          {v.avg ?? '—'}
        </Text>
      </View>
    </>
  );
  const label = `Timing: ${v.tookLabel.toLowerCase()} ${v.took ?? 'unknown'}, average download ${v.avg ?? 'unknown'}`;
  if (!v.known) {
    return (
      <View style={[s.row, s.box]} accessible accessibilityLabel={label}>
        {cells}
        <View style={s.chev} />
      </View>
    );
  }
  return (
    <>
      <PressableScale
        pressableRef={ref}
        onPress={() => (onOpen ? onOpen() : setOpen(true))}
        style={[s.row, s.box]}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Opens details"
      >
        {cells}
        <View style={s.chev}>
          <PixelIcon name="chevron-right" size={20} color={colors.textMuted} />
        </View>
      </PressableScale>
      {onOpen ? null : (
        <Sheet visible={open} onClose={() => setOpen(false)} title="Timing" returnFocusRef={ref}>
          <TimingDetails timing={timing} />
        </Sheet>
      )}
    </>
  );
}

/** The Timing sheet's rows. Rows with nothing to say are left out. */
function TimingDetails({ timing }: { timing: TimingInput }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const v = timingView(timing, Date.now());
  return (
    <>
      {v.added ? <Row k="Added" v={v.added} s={s} first /> : null}
      {v.finished ? <Row k="Finished" v={v.finished} s={s} /> : null}
      {v.span ? (
        <Strip
          s={s}
          title="From added to finished"
          total={v.span.totalLabel}
          parts={[
            { label: 'Downloading', value: v.span.downloadingLabel, n: v.span.total === 0 ? 1 : v.span.downloading, color: colors.download },
            { label: 'Queued, paused or waiting', value: v.span.waitingLabel, n: v.span.waiting, color: colors.borderStrong },
          ]}
        />
      ) : null}
      {v.network ? (
        <Strip
          s={s}
          title="Network"
          total={fmtSize(v.network.wifi + v.network.mobile)}
          parts={[
            { label: 'Wi-Fi', value: fmtSize(v.network.wifi), n: v.network.wifi, color: colors.download },
            { label: 'Mobile', value: fmtSize(v.network.mobile), n: v.network.mobile, color: colors.borderStrong },
          ]}
        />
      ) : null}
      {v.seeding ? <Row k="Seeding for" v={v.seeding} s={s} /> : null}
      {v.uploaded ? <Row k="Uploaded" v={v.uploaded} s={s} /> : null}
    </>
  );
}

type S = ReturnType<typeof makeStyles>;

function Row({ k, v, s, first }: { k: string; v: string; s: S; first?: boolean }) {
  return (
    <View style={[s.trow, first && s.first]} accessible accessibilityLabel={`${k} ${v}`}>
      <Text style={s.tl}>{k}</Text>
      <Text style={s.tv}>{v}</Text>
    </View>
  );
}

function Strip({ s, title, total, parts }: { s: S; title: string; total: string; parts: { label: string; value: string; n: number; color: string }[] }) {
  return (
    <View style={s.strip} accessible accessibilityLabel={`${title} ${total}: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}`}>
      <View style={s.hd}>
        <Text style={s.tl}>{title}</Text>
        <Text style={s.hv}>{total}</Text>
      </View>
      <View style={s.lane}>
        {parts.map((p) => (p.n > 0 ? <View key={p.label} style={[s.seg, { flex: p.n, backgroundColor: p.color }]} /> : null))}
      </View>
      <View style={s.keys}>
        {parts.map((p) => (
          <View key={p.label} style={s.key}>
            <View style={[s.sw, { backgroundColor: p.color }]} />
            <Text style={s.kt}>{p.label}</Text>
            <Text style={s.kv}>{p.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    box: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 56, paddingVertical: spacing.md, paddingHorizontal: spacing.md },
    cellBox: { flex: 1, minWidth: 0 },
    chev: { width: 20 },
    k: { ...type.body, fontSize: type.size.xs, color: c.textMuted, marginBottom: 2 },
    v: { ...type.monoBold, fontSize: type.size.md, color: c.text },
    trow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingVertical: spacing.md, borderTopWidth: 1, borderTopColor: c.border },
    first: { borderTopWidth: 0 },
    tl: { ...type.body, fontSize: type.size.md, color: c.textMuted },
    tv: { ...type.mono, fontSize: type.size.base, color: c.text, flexShrink: 1, textAlign: 'right' },
    strip: { paddingVertical: spacing.md, gap: spacing.md, borderTopWidth: 1, borderTopColor: c.border },
    hd: { flexDirection: 'row', justifyContent: 'space-between' },
    hv: { ...type.mono, fontSize: type.size.md, color: c.text },
    lane: { height: 10, flexDirection: 'row', gap: 2 },
    seg: { height: 10, borderRadius: 2 },
    keys: { flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.lg, rowGap: spacing.sm },
    key: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    sw: { width: 8, height: 8, borderRadius: 2 },
    kt: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    kv: { ...type.mono, fontSize: type.size.sm, color: c.text },
  });
