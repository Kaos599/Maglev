import React, { memo, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatSpeed } from '../constants/format';
import { useTheme } from '../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../constants/theme';

interface SpeedChartProps {
  downBps: number;
  upBps: number;
  /** Changes once per real telemetry sample; each change appends one bar. */
  sampleId: number;
}

const SAMPLES = 40;
const CHART_HEIGHT = 56;

interface Sample {
  down: number;
  up: number;
}

/**
 * Rolling speed history, kept in component state from real samples only.
 * Starts empty (no fabricated zeros) and grows to SAMPLES bars.
 */
function SpeedChartBase({ downBps, upBps, sampleId }: SpeedChartProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [history, setHistory] = useState<Sample[]>([]);

  useEffect(() => {
    if (sampleId <= 0) return;
    setHistory((prev) => [...prev.slice(-(SAMPLES - 1)), { down: downBps, up: upBps }]);
    // Only a new sample appends; the speeds are read from the same render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleId]);

  const peak = Math.max(1, ...history.map((s) => Math.max(s.down, s.up)));

  return (
    <View
      style={styles.card}
      accessible
      accessibilityLabel={`Speed. Download ${formatSpeed(downBps)}, upload ${formatSpeed(upBps)}`}
    >
      <View style={styles.header}>
        <Text style={styles.title}>Speed</Text>
        <Text style={styles.peak}>Peak {formatSpeed(peak === 1 ? 0 : peak)}</Text>
      </View>
      <View style={styles.plot}>
        {history.length === 0 ? (
          <Text style={styles.empty}>Collecting…</Text>
        ) : (
          history.map((s, i) => (
            <View key={i} style={styles.col}>
              <View style={[styles.barDown, { height: Math.max(2, (s.down / peak) * CHART_HEIGHT) }]} />
              <View style={[styles.barUp, { height: Math.max(2, (s.up / peak) * CHART_HEIGHT) }]} />
            </View>
          ))
        )}
      </View>
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.swatch, { backgroundColor: colors.download }]} />
          <Text style={[styles.legendText, { color: colors.download }]}>Down {formatSpeed(downBps)}</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.swatch, { backgroundColor: colors.upload }]} />
          <Text style={[styles.legendText, { color: colors.upload }]}>Up {formatSpeed(upBps)}</Text>
        </View>
      </View>
    </View>
  );
}

export const SpeedChart = memo(SpeedChartBase);

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      padding: spacing.lg,
    },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
    title: { ...type.bodyStrong, fontSize: type.size.md, color: c.text },
    peak: { ...type.mono, fontSize: type.size.xs, color: c.textMuted },
    plot: {
      height: CHART_HEIGHT + spacing.sm,
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 2,
      backgroundColor: c.bg,
      borderRadius: radius.md,
      padding: spacing.xs,
    },
    empty: { ...type.body, fontSize: type.size.sm, color: c.textMuted, alignSelf: 'center', marginLeft: spacing.sm },
    col: { flex: 1, height: '100%', flexDirection: 'row', alignItems: 'flex-end', gap: 1 },
    barDown: { flex: 1, backgroundColor: c.download, borderRadius: 1 },
    barUp: { flex: 1, backgroundColor: c.upload, borderRadius: 1 },
    legend: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.md },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    swatch: { width: 10, height: 10, borderRadius: 2 },
    legendText: { ...type.mono, fontSize: type.size.xs },
  });
