import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, Text, View } from 'react-native';
import { Tabs } from 'expo-router';
import { TAB_BAR_HEIGHT, useTabBarStyle } from '../../components/tabBarStyle';
import { triggerHaptic } from '../../constants/haptics';
import { PixelIcon, PixelIconName } from '../../components/PixelIcon';
import { useTheme } from '../../context/ThemeContext';
import { useAssistantPrefs } from '../../utils/prefs/assistantApp';
import { ThemeColors, fontFamily, withAlpha } from '../../constants/theme';

const PILL_W = 56;
const PILL_H = 28;
const PILL_MS = 160;

/** True when the system asks for less motion. Updates live. */
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduce(v)).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

function TabIcon({ name, focused }: { name: PixelIconName; focused: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reduce = useReduceMotion();
  const progress = useRef(new Animated.Value(focused ? 1 : 0)).current;

  useEffect(() => {
    if (reduce) {
      progress.setValue(focused ? 1 : 0);
      return;
    }
    Animated.timing(progress, { toValue: focused ? 1 : 0, duration: PILL_MS, useNativeDriver: true }).start();
  }, [focused, reduce, progress]);

  const pillStyle = {
    opacity: progress,
    transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }],
  };

  return (
    <View style={styles.iconWrap}>
      <Animated.View style={[styles.pill, pillStyle]} />
      <PixelIcon name={name} size={20} color={focused ? colors.accentText : colors.textMuted} />
    </View>
  );
}

function TabLabel({ title, focused }: { title: string; focused: boolean }) {
  const { colors } = useTheme();
  return (
    <Text
      numberOfLines={1}
      style={{
        fontFamily: focused ? fontFamily.bodyStrong : fontFamily.body,
        fontSize: 11,
        marginTop: 2,
        color: focused ? colors.text : colors.textMuted,
      }}
    >
      {title}
    </Text>
  );
}

export default function TabLayout() {
  const { colors } = useTheme();
  const tabBarStyle = useTabBarStyle();

  const assistant = useAssistantPrefs();

  const tab = (name: string, title: string, icon: PixelIconName, hidden = false) => (
    <Tabs.Screen
      name={name}
      options={{
        // href null removes the tab entirely (Settings > Assistant off).
        href: hidden ? null : undefined,
        title,
        tabBarAccessibilityLabel: title,
        tabBarIcon: ({ focused }) => <TabIcon name={icon} focused={focused} />,
        tabBarLabel: ({ focused }) => <TabLabel title={title} focused={focused} />,
      }}
    />
  );

  return (
    <Tabs
      screenListeners={{ tabPress: () => triggerHaptic('selection') }}
      screenOptions={{
        headerShown: false,
        tabBarStyle,
        tabBarItemStyle: { height: TAB_BAR_HEIGHT, justifyContent: 'center' },
        tabBarActiveTintColor: colors.accentText,
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      {tab('index', 'Transfers', 'tab-transfers')}
      {tab('search', 'Search', 'tab-search')}
      {tab('feeds', 'Feeds', 'tab-feeds')}
      {tab('settings', 'Settings', 'tab-settings')}
      {tab('assistant', 'Assistant', 'tab-assistant', !assistant.enabled)}
    </Tabs>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    iconWrap: { alignItems: 'center', justifyContent: 'center', width: PILL_W, height: PILL_H },
    pill: {
      position: 'absolute',
      width: PILL_W,
      height: PILL_H,
      borderRadius: 8,
      backgroundColor: withAlpha(c.accent, 0.16),
    },
  });
