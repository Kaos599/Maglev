import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import { TAB_BAR_HEIGHT, useTabBarStyle } from '../../components/tabBarStyle';
import { triggerHaptic } from '../../constants/haptics';
import { PixelIcon, PixelIconName } from '../../components/PixelIcon';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, type } from '../../constants/theme';


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
  const tabBarStyle = useTabBarStyle();

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
        tabBarStyle,
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
