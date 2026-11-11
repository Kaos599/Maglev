import { useMemo } from 'react';
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated } from 'react-native';
import { Tabs } from 'expo-router';
import { triggerHaptic } from '../../constants/haptics';
import {
  PixelNavTransfersIcon,
  PixelNavSearchIcon,
  PixelNavFeedsIcon,
  PixelNavConfigIcon,
} from '../../components/PixelIcons';
import { useTheme } from '../../context/ThemeContext';
import { alpha, fonts, ThemeColors } from '../../constants/theme';

interface AnimatedTabIconProps {
  focused: boolean;
  children: React.ReactNode;
}

const AnimatedTabIcon: React.FC<AnimatedTabIconProps> = ({ focused, children }) => {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
          backgroundColor: colors.bg,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          height: 60,
          paddingBottom: 8,
          paddingTop: 6,
        },
        tabBarActiveTintColor: colors.accentText,
        tabBarInactiveTintColor: alpha(colors.paused, 0.7),
        tabBarLabelStyle: {
          fontSize: 8,
          ...fonts.brand,
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
              <PixelNavTransfersIcon size={20} color={focused ? colors.accentText : color} />
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
              <PixelNavSearchIcon size={20} color={focused ? colors.accentText : color} />
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
              <PixelNavFeedsIcon size={20} color={focused ? colors.accentText : color} />
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
              <PixelNavConfigIcon size={20} color={focused ? colors.accentText : color} />
            </AnimatedTabIcon>
          ),
        }}
      />
    </Tabs>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
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
    backgroundColor: colors.accent,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
});
