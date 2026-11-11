import { useMemo } from 'react';
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { triggerHaptic } from '../constants/haptics';
import { PixelSearchIcon } from './PixelIcons';
import { useTheme } from '../context/ThemeContext';
import { alpha, fonts, touch, ThemeColors } from '../constants/theme';

interface HeaderBarProps {
  onSearchPress?: () => void;
  isSearchActive?: boolean;
}

export const HeaderBar: React.FC<HeaderBarProps> = ({ onSearchPress, isSearchActive }) => {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();

  const handlePress = () => {
    triggerHaptic('light');
    if (onSearchPress) {
      onSearchPress();
    } else {
      router.push('/search');
    }
  };

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
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel="Search torrents"
        activeOpacity={0.7}
      >
        <View style={[styles.searchButton, isSearchActive && styles.searchButtonActive]}>
          <PixelSearchIcon
            size={16}
            color={isSearchActive ? colors.download : colors.text}
          />
        </View>
      </TouchableOpacity>
    </View>
  );
};

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    height: 52,
    backgroundColor: colors.bg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  logoTile: {
    width: 28,
    height: 28,
    backgroundColor: colors.accent,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: {
    color: colors.onAccent,
    fontSize: 13,
    ...fonts.brand,
    lineHeight: 14,
  },
  brandTitle: {
    color: colors.text,
    fontSize: 14,
    ...fonts.brand,
    letterSpacing: -0.28,
  },
  searchTouchArea: {
    minWidth: touch.min,
    minHeight: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchButton: {
    width: 32,
    height: 32,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchButtonActive: {
    borderColor: colors.download,
    backgroundColor: alpha(colors.download, 0.12),
  },
});
