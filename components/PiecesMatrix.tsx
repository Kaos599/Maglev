import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../constants/theme';

interface PiecesMatrixProps {
  /** 256 cells, contract values: 0 missing, 1 have, 2 partial. */
  cells: ArrayLike<number> | null;
  totalPieces: number;
}

const SIDE = 16;
const ROWS = Array.from({ length: SIDE }, (_, r) => r);

function PiecesMatrixBase({ cells, totalPieces }: PiecesMatrixProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const counts = useMemo(() => {
    let have = 0;
    let partial = 0;
    if (cells) {
      for (let i = 0; i < SIDE * SIDE; i++) {
        if (cells[i] === 1) have++;
        else if (cells[i] === 2) partial++;
      }
    }
    return { have, partial, missing: SIDE * SIDE - have - partial };
  }, [cells]);

  const fillFor = (v: number) => (v === 1 ? colors.accent : v === 2 ? alpha(colors.accent, 0.5) : colors.surfaceRaised);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Pieces</Text>
        <Text style={styles.meta}>{cells === null ? 'Loading…' : totalPieces > 0 ? `${totalPieces} total` : '—'}</Text>
      </View>

      <View
        style={styles.grid}
        accessible
        accessibilityLabel={`Pieces: ${counts.have} complete, ${counts.partial} partial, ${counts.missing} missing, shown as a 16 by 16 grid`}
      >
        {ROWS.map((r) => (
          <View key={r} style={styles.row}>
            {ROWS.map((c) => (
              <View key={c} style={[styles.cell, { backgroundColor: fillFor(cells ? cells[r * SIDE + c] : 0) }]} />
            ))}
          </View>
        ))}
      </View>

      <View style={styles.legend}>
        <LegendItem fill={colors.accent} label={`Have ${counts.have}`} styles={styles} />
        <LegendItem fill={alpha(colors.accent, 0.5)} label={`Partial ${counts.partial}`} styles={styles} />
        <LegendItem fill={colors.surfaceRaised} label={`Missing ${counts.missing}`} styles={styles} />
      </View>
    </View>
  );
}

function LegendItem({ fill, label, styles }: { fill: string; label: string; styles: ReturnType<typeof makeStyles> }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.swatch, { backgroundColor: fill }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

export const PiecesMatrix = memo(PiecesMatrixBase);

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      padding: spacing.lg,
    },
    headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
    title: { ...type.bodyStrong, fontSize: type.size.md, color: c.text },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    grid: { gap: 2, padding: spacing.xs, backgroundColor: c.bg, borderRadius: radius.md },
    row: { flexDirection: 'row', gap: 2 },
    cell: { flex: 1, aspectRatio: 1, borderRadius: 1 },
    legend: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.lg,
      marginTop: spacing.md,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    swatch: { width: 10, height: 10, borderRadius: 2, borderWidth: 1, borderColor: c.border },
    legendText: { ...type.mono, fontSize: type.size.xs, color: c.textMuted },
  });
