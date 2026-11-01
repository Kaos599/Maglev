import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { TOKENS } from '../constants/tokens';

interface PiecesMatrixProps {
  matrix: Uint8Array;
  totalPieces: number;
}

export const PiecesMatrix: React.FC<PiecesMatrixProps> = ({ matrix, totalPieces }) => {
  let verifiedCount = 0;
  let inFlightCount = 0;
  let unavailableCount = 0;

  for (let i = 0; i < 256; i++) {
    const val = matrix[i] || 0;
    if (val === 2) verifiedCount++;
    else if (val === 1) inFlightCount++;
    else unavailableCount++;
  }

  const getBlockColor = (val: number) => {
    switch (val) {
      case 2:
        return TOKENS.colors.blockVerified;
      case 1:
        return TOKENS.colors.blockInFlight;
      case 3:
        return TOKENS.colors.blockCorrupt;
      case 0:
      default:
        return TOKENS.colors.blockUnavailable;
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
          <View style={[styles.legendDot, { backgroundColor: TOKENS.colors.blockVerified }]} />
          <Text style={styles.legendText}>Verified ({verifiedCount})</Text>
        </View>

        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: TOKENS.colors.blockInFlight }]} />
          <Text style={styles.legendText}>In Flight ({inFlightCount})</Text>
        </View>

        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: TOKENS.colors.blockUnavailable }]} />
          <Text style={styles.legendText}>Missing ({unavailableCount})</Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
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
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  totalPiecesText: {
    color: TOKENS.colors.textMuted,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  grid: {
    width: '100%',
    aspectRatio: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#070A0E',
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
    borderTopColor: TOKENS.colors.surfaceBorder,
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
    color: TOKENS.colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },
});
