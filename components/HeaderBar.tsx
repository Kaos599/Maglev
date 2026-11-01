import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { TOKENS } from '../constants/tokens';

interface HeaderBarProps {
  onSearchPress?: () => void;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({ onSearchPress }) => {
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
      >
        <View style={styles.searchButton}>
          <Ionicons name="search" size={16} color={TOKENS.colors.accentCyan} />
        </View>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    height: 52,
    backgroundColor: TOKENS.colors.bgOled,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoTile: {
    width: 28,
    height: 28,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  logoText: {
    color: '#000000',
    fontSize: 16,
    fontWeight: '900',
    fontFamily: 'monospace',
  },
  brandTitle: {
    color: TOKENS.colors.textPrimary,
    fontSize: TOKENS.typography.appTitle.fontSize,
    fontWeight: TOKENS.typography.appTitle.fontWeight,
    letterSpacing: TOKENS.typography.appTitle.letterSpacing,
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
});
