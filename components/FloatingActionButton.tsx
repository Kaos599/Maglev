import React, { useRef } from 'react';
import { StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { useRouter } from 'expo-router';
import { TOKENS } from '../constants/tokens';
import { triggerHaptic } from '../constants/haptics';
import { PixelPlusFabIcon } from './PixelIcons';

export const FloatingActionButton: React.FC = () => {
  const router = useRouter();
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.88,
      useNativeDriver: true,
      friction: 6,
      tension: 200,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      friction: 4,
      tension: 180,
    }).start();
  };

  return (
    <Animated.View style={[styles.fabContainer, { transform: [{ scale: scaleAnim }] }]}>
      <TouchableOpacity
        style={styles.fab}
        activeOpacity={0.9}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onPress={() => {
          triggerHaptic('medium');
          router.push('/add-torrent');
        }}
        accessibilityRole="button"
        accessibilityLabel="Add Torrent"
      >
        <PixelPlusFabIcon size={24} color="#000000" />
      </TouchableOpacity>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  fabContainer: {
    position: 'absolute',
    right: 16,
    bottom: 80,
    zIndex: 99,
  },
  fab: {
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
  },
});
