import React from 'react';
import { StyleSheet, TouchableOpacity, View, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { TOKENS } from '../constants/tokens';

export const FloatingActionButton: React.FC = () => {
  const router = useRouter();

  return (
    <TouchableOpacity
      style={styles.fab}
      activeOpacity={0.85}
      onPress={() => router.push('/add-torrent')}
      accessibilityRole="button"
      accessibilityLabel="Add Torrent"
    >
      <Text style={styles.fabGlyph}>+</Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 80,
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: TOKENS.colors.accentLime,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
    shadowColor: TOKENS.colors.accentLime,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    zIndex: 99,
  },
  fabGlyph: {
    color: '#000000',
    fontSize: 28,
    fontWeight: '900',
    lineHeight: 30,
    textAlign: 'center',
    fontFamily: 'monospace',
  },
});
