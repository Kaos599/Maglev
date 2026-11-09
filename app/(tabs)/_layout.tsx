import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { Tabs } from 'expo-router';
import { TOKENS } from '../../constants/tokens';
import { triggerHaptic } from '../../constants/haptics';
import {
  PixelNavTransfersIcon,
  PixelNavSearchIcon,
  PixelNavFeedsIcon,
  PixelNavConfigIcon,
} from '../../components/PixelIcons';

interface AnimatedTabIconProps {
  focused: boolean;
  children: React.ReactNode;
}

const AnimatedTabIcon: React.FC<AnimatedTabIconProps> = ({ focused, children }) => {
  const scaleAnim = useRef(new Animated.Value(focused ? 1.08 : 1)).current;

  useEffect(() => {
    Animated.spring(scaleAnim, {
      toValue: focused ? 1.1 : 1,
      useNativeDriver: true,
      friction: 6,
      tension: 120,
    }).start();
  }, [focused, scaleAnim]);

  return (
    <Animated.View style={[styles.iconContainer, { transform: [{ scale: scaleAnim }] }]}>
      {children}
      {focused && <View style={styles.neonDot} />}
    </Animated.View>
  );
};

export default function TabLayout() {
  return (
    <Tabs
      screenListeners={{
        tabPress: () => {
          triggerHaptic('selection');
        },
      }}
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#070A0E',
          borderTopWidth: 1,
          borderTopColor: '#161C26',
          height: 60,
          paddingBottom: 8,
          paddingTop: 6,
        },
        tabBarActiveTintColor: TOKENS.colors.accentLime,
        tabBarInactiveTintColor: 'rgba(139, 148, 158, 0.7)',
        tabBarLabelStyle: {
          fontSize: 8,
          fontWeight: '700',
          fontFamily: 'Silkscreen',
          letterSpacing: 0.3,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'TRANSFERS',
          tabBarIcon: ({ color, focused }) => (
            <AnimatedTabIcon focused={focused}>
              <PixelNavTransfersIcon size={20} color={focused ? TOKENS.colors.accentLime : color} />
            </AnimatedTabIcon>
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'SEARCH',
          tabBarIcon: ({ color, focused }) => (
            <AnimatedTabIcon focused={focused}>
              <PixelNavSearchIcon size={20} color={focused ? TOKENS.colors.accentLime : color} />
            </AnimatedTabIcon>
          ),
        }}
      />
      <Tabs.Screen
        name="feeds"
        options={{
          title: 'FEEDS',
          tabBarIcon: ({ color, focused }) => (
            <AnimatedTabIcon focused={focused}>
              <PixelNavFeedsIcon size={20} color={focused ? TOKENS.colors.accentLime : color} />
            </AnimatedTabIcon>
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'SETTINGS',
          tabBarIcon: ({ color, focused }) => (
            <AnimatedTabIcon focused={focused}>
              <PixelNavConfigIcon size={20} color={focused ? TOKENS.colors.accentLime : color} />
            </AnimatedTabIcon>
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconContainer: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
  },
  neonDot: {
    position: 'absolute',
    top: -2,
    right: -4,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: TOKENS.colors.accentLime,
    shadowColor: TOKENS.colors.accentLime,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
});
