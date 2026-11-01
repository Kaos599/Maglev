import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Tabs } from 'expo-router';
import { TOKENS } from '../../constants/tokens';
import {
  PixelNavTransfersIcon,
  PixelNavSearchIcon,
  PixelNavFeedsIcon,
  PixelNavConfigIcon,
} from '../../components/PixelIcons';

export default function TabLayout() {
  return (
    <Tabs
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
            <View style={styles.iconContainer}>
              <PixelNavTransfersIcon size={20} color={focused ? TOKENS.colors.accentLime : color} />
              {focused && <View style={styles.neonDot} />}
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'SEARCH',
          tabBarIcon: ({ color, focused }) => (
            <View style={styles.iconContainer}>
              <PixelNavSearchIcon size={20} color={focused ? TOKENS.colors.accentLime : color} />
              {focused && <View style={styles.neonDot} />}
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="feeds"
        options={{
          title: 'FEEDS',
          tabBarIcon: ({ color, focused }) => (
            <View style={styles.iconContainer}>
              <PixelNavFeedsIcon size={20} color={focused ? TOKENS.colors.accentLime : color} />
              {focused && <View style={styles.neonDot} />}
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'CONFIG',
          tabBarIcon: ({ color, focused }) => (
            <View style={styles.iconContainer}>
              <PixelNavConfigIcon size={20} color={focused ? TOKENS.colors.accentLime : color} />
              {focused && <View style={styles.neonDot} />}
            </View>
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
