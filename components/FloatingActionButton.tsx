import React from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { TOKENS } from '../constants/tokens';
import { PixelPlusFabIcon } from './PixelIcons';

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
      <PixelPlusFabIcon size={24} color="#000000" />
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
    borderRadius: 14,
    backgroundColor: TOKENS.colors.accentLime,
    borderColor: '#efff80',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 8,
    shadowColor: TOKENS.colors.accentLime,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    zIndex: 99,
  },
});
