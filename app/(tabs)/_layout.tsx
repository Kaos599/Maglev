import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { triggerHaptic } from '../../constants/haptics';
import { PixelIcon, PixelIconName } from '../../components/PixelIcon';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, type } from '../../constants/theme';

const TAB_BAR_HEIGHT = 56;

function TabIcon({ name, focused }: { name: PixelIconName; focused: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.iconWrap}>
      <View style={[styles.bar, focused && styles.barActive]} />
      <PixelIcon name={name} size={20} color={focused ? colors.accentText : colors.textMuted} />
    </View>
  );
}

export default function TabLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const tab = (name: string, title: string, icon: PixelIconName) => (
    <Tabs.Screen
      name={name}
      options={{
        title,
        tabBarAccessibilityLabel: title,
        tabBarIcon: ({ focused }) => <TabIcon name={icon} focused={focused} />,
      }}
    />
  );

  return (
    <Tabs
      screenListeners={{ tabPress: () => triggerHaptic('selection') }}
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bg,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          height: TAB_BAR_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom,
          paddingTop: 0,
        },
        tabBarItemStyle: { height: TAB_BAR_HEIGHT },
        tabBarActiveTintColor: colors.accentText,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { ...type.bodyStrong, fontSize: 11 },
      }}
    >
      {tab('index', 'Transfers', 'transfers')}
      {tab('search', 'Search', 'search')}
      {tab('feeds', 'Feeds', 'feeds')}
      {tab('settings', 'Settings', 'settings')}
    </Tabs>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    iconWrap: { alignItems: 'center', justifyContent: 'center', width: 44, height: 28 },
    bar: { width: 24, height: 2, backgroundColor: 'transparent', marginBottom: 4 },
    barActive: { backgroundColor: c.accent },
  });
