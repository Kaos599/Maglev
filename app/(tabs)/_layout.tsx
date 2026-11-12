import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import type { BottomTabBarButtonProps } from 'expo-router/build/layouts/Tabs';
import { TAB_BAR_HEIGHT, useTabBarStyle } from '../../components/tabBarStyle';
import { triggerHaptic } from '../../constants/haptics';
import { PixelIconName } from '../../components/PixelIcon';
import { TabGlyph, useTabMove } from '../../components/tabs/TabGlyph';
import type { TabGlyphName } from '../../components/tabs/tabGlyphs';
import { PRESS_SINK, animateTo, duration, useReduceMotion } from '../../components/motion';
import { useTheme } from '../../context/ThemeContext';
import { useAssistantPrefs } from '../../utils/prefs/assistantApp';
import { ThemeColors, fontFamily, withAlpha } from '../../constants/theme';

const PILL_W = 56;
const PILL_H = 28;
const ICON = 20;

type TabButtonProps = BottomTabBarButtonProps & { icon: PixelIconName; title: string };

/**
 * The whole tab: pill, icon and label. It replaces the library's default button, which is a
 * PlatformPressable with a borderless Android ripple (the "pulse" on every press), and it
 * ignores `children`, because the library renders `tabBarIcon` twice and swaps the two copies
 * with a hard opacity flip, so an animation inside `tabBarIcon` never plays.
 *
 * Motion, all on the native driver and only on press or focus change:
 * - press: icon and pill sink 2 px (120 ms down, 160 ms back), instead of a ripple
 * - focus: the pill grows out from the centre while the icon and label crossfade to the
 *   active look (180 ms), and the icon plays its one signature move (components/tabs, 220 ms)
 */
function TabButton({
  icon,
  title,
  // Library props this button does not use: no ripple, no hover, no fade, own children.
  children: _children,
  href: _href,
  android_ripple: _ripple,
  pressColor: _pressColor,
  pressOpacity: _pressOpacity,
  hoverEffect: _hoverEffect,
  ref: _ref,
  style,
  onPressIn,
  onPressOut,
  ...rest
}: TabButtonProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reduce = useReduceMotion();
  const focused = rest['aria-selected'] === true;

  const focus = useRef(new Animated.Value(focused ? 1 : 0)).current;
  const sink = useRef(new Animated.Value(0)).current;
  const move = useTabMove(focused, reduce);

  const anim = useRef({
    off: focus.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
    pillScaleX: focus.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }),
    sinkY: sink.interpolate({ inputRange: [0, 1], outputRange: [0, PRESS_SINK] }),
  }).current;

  useEffect(() => {
    animateTo(focus, focused ? 1 : 0, duration.focus, reduce);
  }, [focused, reduce, focus]);

  return (
    <Pressable
      {...rest}
      style={[style, styles.button]}
      onPressIn={(e) => {
        animateTo(sink, 1, duration.press, reduce);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        animateTo(sink, 0, duration.release, reduce);
        onPressOut?.(e);
      }}
    >
      <Animated.View style={[styles.iconWrap, { transform: [{ translateY: anim.sinkY }] }]}>
        <Animated.View style={[styles.pill, { opacity: focus, transform: [{ scaleX: anim.pillScaleX }] }]} />
        <View style={styles.glyph}>
          <Animated.View style={{ opacity: anim.off }}>
            <TabGlyph name={icon as TabGlyphName} color={colors.textMuted} progress={move} />
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: focus }]}>
            <TabGlyph name={icon as TabGlyphName} color={colors.accentText} progress={move} />
          </Animated.View>
        </View>
      </Animated.View>
      {/* Bold sits in flow (it is the wider of the two) so the regular copy always fits over it. */}
      <View style={styles.labelWrap}>
        <Animated.Text numberOfLines={1} style={[styles.label, styles.labelOn, { opacity: focus }]}>
          {title}
        </Animated.Text>
        <Animated.Text numberOfLines={1} style={[styles.label, styles.labelOff, { opacity: anim.off }]}>
          {title}
        </Animated.Text>
      </View>
    </Pressable>
  );
}

export default function TabLayout() {
  const tabBarStyle = useTabBarStyle();

  const assistant = useAssistantPrefs();

  const tab = (name: string, title: string, icon: PixelIconName, hidden = false, freeze = false) => (
    <Tabs.Screen
      name={name}
      activityEnabled={freeze}
      options={
        hidden
          ? // href null removes the tab entirely (Settings > Assistant off). expo-router throws if
            // href and tabBarButton are set together (TabsClient processScreens), so a hidden tab has no button.
            { href: null, title }
          : {
              title,
              tabBarAccessibilityLabel: title,
              // TabButton draws the icon and label itself (see the note on TabButton).
              tabBarButton: (props) => <TabButton {...props} icon={icon} title={title} />,
            }
      }
    />
  );

  return (
    <Tabs
      screenListeners={{ tabPress: () => triggerHaptic('selection') }}
      screenOptions={{
        // A tab renders (and its route module loads) only when first opened. This is already the
        // default (createBottomTabNavigator passes lazyByDefault: true); set so it cannot regress.
        lazy: true,
        // freezeOnBlur is deprecated with no effect in Expo Router 58 (bottom-tabs/types.d.ts;
        // ScreenFallback passes freezeOnBlur: false). Hidden tabs are frozen with React Activity
        // instead, per tab, through `activityEnabled` below.
        headerShown: false,
        tabBarStyle,
        tabBarItemStyle: { height: TAB_BAR_HEIGHT, justifyContent: 'center' },
      }}
    >
      {/*
        React Activity (activityEnabled): a hidden tab keeps its state, its effects are cleaned up
        and its renders drop to idle priority; coming back re-runs its effects.
        Not for Transfers (its list must be current the moment it shows), Search (its search effect
        would run the search again on return) or Assistant (its AppState listener must still see
        the app go to the background while another tab is open).
      */}
      {tab('index', 'Transfers', 'tab-transfers')}
      {tab('search', 'Search', 'tab-search')}
      {tab('feeds', 'Feeds', 'tab-feeds', false, true)}
      {tab('settings', 'Settings', 'tab-settings', false, true)}
      {tab('assistant', 'Assistant', 'tab-assistant', !assistant.enabled)}
    </Tabs>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    // Overrides the library's top-aligned, padded column so the content centres in the bar.
    button: { justifyContent: 'center', alignItems: 'center', padding: 0 },
    iconWrap: { alignItems: 'center', justifyContent: 'center', width: PILL_W, height: PILL_H },
    pill: {
      position: 'absolute',
      width: PILL_W,
      height: PILL_H,
      borderRadius: 8,
      backgroundColor: withAlpha(c.accent, 0.16),
    },
    glyph: { width: ICON, height: ICON },
    labelWrap: { marginTop: 2, alignItems: 'center' },
    label: { fontSize: 11, textAlign: 'center' },
    labelOn: { fontFamily: fontFamily.bodyStrong, color: c.text },
    labelOff: { position: 'absolute', left: 0, right: 0, top: 0, fontFamily: fontFamily.body, color: c.textMuted },
  });
