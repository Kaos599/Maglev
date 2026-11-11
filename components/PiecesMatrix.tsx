import { useMemo } from 'react';
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { fonts, ThemeColors } from '../constants/theme';

interface PiecesMatrixProps {
  matrix: Uint8Array;
  totalPieces: number;
}

export const PiecesMatrix: React.FC<PiecesMatrixProps> = ({ matrix, totalPieces }) => {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  let verifiedCount = 0;
  let inFlightCount = 0;
  let unavailableCount = 0;

  for (let i = 0; i < 256; i++) {
    const val = matrix[i] || 0;
    // Engine contract: 0 missing, 1 have, 2 partial
    if (val === 1) verifiedCount++;
    else if (val === 2) inFlightCount++;
    else unavailableCount++;
  }

  const getBlockColor = (val: number) => {
    switch (val) {
      case 1:
        return colors.download;
      case 2:
        return colors.accent;
      case 3:
        return colors.danger;
      case 0:
      default:
        return colors.surfaceRaised;
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Pieces Map (16×16)</Text>
        <Text style={styles.totalPiecesText}>{totalPieces} pieces</Text>
      </View>

      {/* 16x16 Grid */}
      <View style={styles.grid}>
        {Array.from({ length: 256 }).map((_, index) => {
          const state = matrix[index] || 0;
          return (
            <View
              key={index}
              style={[
                styles.block,
                { backgroundColor: getBlockColor(state) },
              ]}
            />
          );
        })}
      </View>

      {/* Legend */}
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: colors.download }]} />
          <Text style={styles.legendText}>Verified ({verifiedCount})</Text>
        </View>

        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: colors.accent }]} />
          <Text style={styles.legendText}>In Flight ({inFlightCount})</Text>
        </View>

        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: colors.surfaceRaised }]} />
          <Text style={styles.legendText}>Missing ({unavailableCount})</Text>
        </View>
      </View>
    </View>
  );
};

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    marginVertical: 8,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    color: colors.text,
    fontSize: 12,
    ...fonts.monoBold,
  },
  totalPiecesText: {
    color: colors.textMuted,
    fontSize: 11,
    ...fonts.mono,
  },
  grid: {
    width: '100%',
    aspectRatio: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    padding: 4,
    borderRadius: 8,
  },
  block: {
    width: '5.8%',
    aspectRatio: 1,
    borderRadius: 1,
  },
  legendRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  legendText: {
    color: colors.textMuted,
    fontSize: 10,
    ...fonts.mono,
  },
});
