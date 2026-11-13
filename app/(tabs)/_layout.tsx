import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router';
import type { BottomTabBarButtonProps } from 'expo-router/build/layouts/Tabs';
import { TAB_BAR_HEIGHT, useTabBarStyle } from '../../components/tabBarStyle';
import { haptic } from '../../constants/haptics';
import { PixelIcon, PixelIconName } from '../../components/PixelIcon';
import { TabGlyph, useTabMove } from '../../components/tabs/TabGlyph';
import { TAB_GLYPHS, type TabGlyphName } from '../../components/tabs/tabGlyphs';
import { visibleTabs, type TabId } from '../../components/tabs/tabPrefs';
import { useTabPrefs } from '../../components/tabs/tabPrefsStore';
import { PRESS_SINK, animateTo, duration, useReduceMotion } from '../../components/motion';
import { useTheme } from '../../context/ThemeContext';
import { useAssistantPrefs } from '../../utils/prefs/assistantApp';
import { ThemeColors, fontFamily, withAlpha } from '../../constants/theme';
import { badgeLabel, useFeedsNewCount } from '../../utils/feeds';
import { startFeedsBadge } from '../../utils/feedsBadgeStart';

const PILL_W = 56;
const PILL_H = 28;
const ICON = 20;

type TabButtonProps = BottomTabBarButtonProps & { icon: PixelIconName; title: string; badge?: number };

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
  badge,
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
  // Tabs without a signature move (Browser) draw their plain pixel icon.
  const hasGlyph = icon in TAB_GLYPHS;
  const badgeText = badgeLabel(badge ?? 0);
  // The library sets aria-label from tabBarAccessibilityLabel; add the count for screen readers.
  const a11yLabel = badgeText ? `${rest['aria-label'] ?? title}, ${badge} new` : rest['aria-label'];

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
      aria-label={a11yLabel}
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
            {hasGlyph ? (
              <TabGlyph name={icon as TabGlyphName} color={colors.textMuted} progress={move} />
            ) : (
              <PixelIcon name={icon} size={ICON} color={colors.textMuted} />
            )}
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: focus }]}>
            {hasGlyph ? (
              <TabGlyph name={icon as TabGlyphName} color={colors.accentText} progress={move} />
            ) : (
              <PixelIcon name={icon} size={ICON} color={colors.accentText} />
            )}
          </Animated.View>
        </View>
        {badgeText ? (
          <View style={styles.badge} pointerEvents="none" importantForAccessibility="no-hide-descendants">
            <Animated.Text numberOfLines={1} style={styles.badgeText}>
              {badgeText}
            </Animated.Text>
          </View>
        ) : null}
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
  const prefs = useTabPrefs();
  const feedsNew = useFeedsNewCount();
  // Count from stored data now, and again when the app returns to the foreground.
  useEffect(() => startFeedsBadge(), []);

  const tab = (name: string, title: string, icon: PixelIconName, hidden = false, freeze = false, badge = 0) => (
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
              tabBarButton: (props) => <TabButton {...props} icon={icon} title={title} badge={badge} />,
            }
      }
    />
  );

  // One Tabs.Screen per tab, rendered in the saved order (the bar follows child order). A tab that
  // is off, or the Assistant while Settings > Assistant is off, has href null and no button.
  const shown = visibleTabs(prefs, { assistantEnabled: assistant.enabled });
  const screens: Record<TabId, React.ReactElement> = {
    index: tab('index', 'Transfers', 'tab-transfers', !shown.includes('index')),
    search: tab('search', 'Search', 'tab-search', !shown.includes('search')),
    feeds: tab('feeds', 'Feeds', 'tab-feeds', !shown.includes('feeds'), true, feedsNew),
    settings: tab('settings', 'Settings', 'tab-settings', !shown.includes('settings'), true),
    assistant: tab('assistant', 'Assistant', 'tab-assistant', !shown.includes('assistant')),
    browse: tab('browse', 'Browser', 'network', !shown.includes('browse')),
  };

  // If the tab being shown is turned off, go to Transfers. Only a change of the bar triggers this,
  // so a hidden tab opened on purpose (Search from the + menu) is left alone.
  const current = useRef<{ name: string; go: (name: string) => void } | null>(null);
  const was = useRef<TabId[]>(shown);
  useEffect(() => {
    const open = current.current;
    if (open && was.current.includes(open.name as TabId) && !shown.includes(open.name as TabId)) open.go('index');
    was.current = shown;
  }, [shown.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Tabs
      screenListeners={({ route, navigation }) => ({
        tabPress: () => haptic('select'),
        focus: () => {
          current.current = { name: route.name, go: (name) => navigation.navigate(name as never) };
        },
      })}
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
      {prefs.order.map((id) => screens[id])}
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
    // Neutral pill (text on bg) so lime stays with the active tab. Sits on the icon's top-right.
    badge: {
      position: 'absolute',
      top: -4,
      right: 2,
      minWidth: 16,
      height: 16,
      paddingHorizontal: 4,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.text,
    },
    badgeText: { fontSize: 10, lineHeight: 12, fontFamily: fontFamily.bodyStrong, color: c.bg, fontVariant: ['tabular-nums'] },
    glyph: { width: ICON, height: ICON },
    labelWrap: { marginTop: 2, alignItems: 'center' },
    label: { fontSize: 11, textAlign: 'center' },
    labelOn: { fontFamily: fontFamily.bodyStrong, color: c.text },
    labelOff: { position: 'absolute', left: 0, right: 0, top: 0, fontFamily: fontFamily.body, color: c.textMuted },
  });
