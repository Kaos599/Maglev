import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { TOKENS } from '../constants/tokens';
import { PixelSearchIcon } from './PixelIcons';

interface HeaderBarProps {
  onSearchPress?: () => void;
  isSearchActive?: boolean;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({ onSearchPress, isSearchActive }) => {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <View style={styles.brandRow}>
        <View style={styles.logoTile}>
          <Text style={styles.logoText}>M</Text>
        </View>
        <Text style={styles.brandTitle}>MAGLEV</Text>
      </View>

      <TouchableOpacity
        style={styles.searchTouchArea}
        onPress={onSearchPress || (() => router.push('/search'))}
        accessibilityRole="button"
        accessibilityLabel="Search torrents"
        activeOpacity={0.7}
      >
        <View style={[styles.searchButton, isSearchActive && styles.searchButtonActive]}>
          <PixelSearchIcon
            size={16}
            color={isSearchActive ? TOKENS.colors.accentCyan : "#D1D5DB"}
          />
        </View>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    height: 52,
    backgroundColor: '#070A0F',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#161D28',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  logoTile: {
    width: 28,
    height: 28,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'Silkscreen',
    lineHeight: 14,
  },
  brandTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'Silkscreen',
    letterSpacing: -0.28,
  },
  searchTouchArea: {
    minWidth: TOKENS.touchTarget.minWidth,
    minHeight: TOKENS.touchTarget.minHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchButton: {
    width: 32,
    height: 32,
    backgroundColor: '#11161F',
    borderColor: '#222B38',
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchButtonActive: {
    borderColor: TOKENS.colors.accentCyan,
    backgroundColor: 'rgba(0, 229, 255, 0.12)',
  },
});
