import React, { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedReaction, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import ReanimatedSwipeable, { SwipeDirection, type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import { scheduleOnRN } from 'react-native-worklets';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type, touch } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { panelOpacity, type SwipeRight } from './swipe';

/** Width of the revealed panel, margin included (rows sit inside a spacing.lg margin). */
const PANEL = spacing.lg + 96;
/** Past this drag distance a release runs the action, and the phone ticks once. */
const TRIGGER = 72;
/** Horizontal travel before the swipe claims the touch; a vertical drag scrolls the list instead. */
const ACTIVATE_X = 16;

let openRow: SwipeableMethods | null = null;
/** Closes the row that is open, if any. The list calls this when it starts to scroll. */
export function closeOpenSwipe(): void {
  try {
    openRow?.close();
  } catch {}
  openRow = null;
}

function Panel({
  translation,
  sign,
  fill,
  ink,
  icon,
  label,
  align,
}: {
  translation: SharedValue<number>;
  sign: 1 | -1;
  fill: string;
  ink: string;
  icon: PixelIconName;
  label: string;
  align: 'flex-start' | 'flex-end';
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  // One tick as the drag crosses the trigger distance, in either direction.
  useAnimatedReaction(
    () => sign * translation.value >= TRIGGER,
    (past, was) => {
      if (was !== null && past !== was) scheduleOnRN(haptic, 'select');
    },
  );
  const lit = useAnimatedStyle(() => ({ opacity: panelOpacity(sign * translation.value, TRIGGER) }));
  return (
    // Always hidden from screen readers: the card itself exposes Pause, Resume and Remove as accessibility actions.
    <View style={[s.panel, sign === 1 ? s.panelLeft : s.panelRight]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Animated.View style={[s.fill, { backgroundColor: fill, alignItems: align }, lit]}>
        <View style={s.content}>
          <PixelIcon name={icon} size={24} color={ink} />
          <Text style={[s.label, { color: ink }]} numberOfLines={1}>
            {label}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}

export interface SwipeRowProps {
  /** Row identity: a recycled row snaps shut when it shows another item. */
  id: string;
  right: SwipeRight | null;
  left: boolean;
  /** False while multi-select is on or the row has no action. */
  enabled: boolean;
  onRight: (kind: SwipeRight['kind']) => void;
  onLeft: () => void;
  children: React.ReactNode;
}

/**
 * Swipe right to Pause or Resume, left to Remove. A release past the trigger runs the action and the row
 * slides back; a short drag just springs back. Gesture API checked against react-native-gesture-handler 3.3
 * (src/components/ReanimatedSwipeable). Mounted only while the setting is on.
 */
function SwipeRowImpl({ id, right, left, enabled, onRight, onLeft, children }: SwipeRowProps) {
  const { colors } = useTheme();
  const ref = useRef<SwipeableMethods>(null);

  useEffect(() => {
    ref.current?.reset();
  }, [id]);
  useEffect(() => {
    const me = ref.current;
    return () => {
      if (openRow === me) openRow = null;
    };
  }, []);

  const renderRight = useCallback(
    (_p: SharedValue<number>, translation: SharedValue<number>) =>
      right ? (
        <Panel
          translation={translation}
          sign={1}
          fill={right.kind === 'pause' ? colors.download : colors.accent}
          ink={right.kind === 'pause' ? colors.bg : colors.onAccent}
          icon={right.kind === 'pause' ? 'pause' : 'play'}
          label={right.label}
          align="flex-start"
        />
      ) : null,
    [right, colors],
  );
  const renderLeft = useCallback(
    (_p: SharedValue<number>, translation: SharedValue<number>) => (
      <Panel translation={translation} sign={-1} fill={colors.danger} ink={colors.onDanger} icon="trash" label="Remove" align="flex-end" />
    ),
    [colors],
  );

  const onWillOpen = useCallback(
    (direction: SwipeDirection.LEFT | SwipeDirection.RIGHT) => {
      // RIGHT = the row slid right (left panel showing) = Pause or Resume.
      if (direction === SwipeDirection.RIGHT) {
        if (right) onRight(right.kind);
      } else if (left) onLeft();
      ref.current?.close();
    },
    [right, left, onRight, onLeft],
  );
  const onStartDrag = useCallback(() => {
    if (openRow && openRow !== ref.current) closeOpenSwipe();
    openRow = ref.current;
  }, []);

  return (
    <ReanimatedSwipeable
      ref={ref}
      enabled={enabled && (!!right || left)}
      friction={1.5}
      overshootLeft={false}
      overshootRight={false}
      leftThreshold={TRIGGER}
      rightThreshold={TRIGGER}
      dragOffsetFromLeft={ACTIVATE_X}
      dragOffsetFromRight={-ACTIVATE_X}
      renderLeftActions={right ? renderRight : undefined}
      renderRightActions={left ? renderLeft : undefined}
      onSwipeableOpenStartDrag={onStartDrag}
      onSwipeableWillOpen={onWillOpen}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

export const SwipeRow = memo(SwipeRowImpl);

// Rebuilt with the theme: the font style applies live and `type` reads it when the styles are made.
const makeStyles = (_c: ThemeColors) =>
  StyleSheet.create({
    panel: { width: PANEL, height: '100%' },
    panelLeft: { paddingLeft: spacing.lg },
    panelRight: { paddingRight: spacing.lg },
    fill: { flex: 1, justifyContent: 'center', borderRadius: radius.lg, paddingHorizontal: spacing.lg },
    content: { alignItems: 'center', gap: 2, minWidth: touch.min },
    label: { ...type.mono, fontSize: type.size.sm, lineHeight: 16 },
  });
