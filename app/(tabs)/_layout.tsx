import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { TOKENS } from '../../constants/tokens';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: TOKENS.colors.navBg,
          borderTopWidth: 1,
          borderTopColor: TOKENS.colors.navBorder,
          height: 60,
          paddingBottom: 8,
          paddingTop: 6,
        },
        tabBarActiveTintColor: TOKENS.colors.accentLime,
        tabBarInactiveTintColor: 'rgba(139, 148, 158, 0.6)',
        tabBarLabelStyle: {
          fontSize: TOKENS.typography.navLabel.fontSize,
          fontWeight: TOKENS.typography.navLabel.fontWeight,
          letterSpacing: TOKENS.typography.navLabel.letterSpacing,
          fontFamily: 'monospace',
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'TRANSFERS',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? 'swap-vertical' : 'swap-vertical-outline'}
              size={20}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'SEARCH',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? 'search' : 'search-outline'}
              size={20}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="feeds"
        options={{
          title: 'FEEDS',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? 'radio' : 'radio-outline'}
              size={20}
              color={color}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'SETTINGS',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? 'settings' : 'settings-outline'}
              size={20}
              color={color}
            />
          ),
        }}
      />
    </Tabs>
  );
}
