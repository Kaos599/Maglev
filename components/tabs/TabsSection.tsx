import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';
import Animated, { SharedValue, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { tabsCopy } from '../../constants/copy';
import { haptic } from '../../constants/haptics';
import { useAssistantPrefs } from '../../utils/prefs/assistantApp';
import { useReduceMotion } from '../motion';
import { Toggle } from '../ui';
import { Caption } from '../settings/SettingsParts';
import { LOCKED_TABS, moveTab, reorderTabs, setTabShown, type TabId } from './tabPrefs';
import { setTabPrefs, useTabPrefs } from './tabPrefsStore';

/** Every row has this height, so a slot is a plain multiple of it. */
const ROW_HEIGHT = 64;
const LONG_PRESS_MS = 250;
const LIFT_SCALE = 1.03;

/** Says where a tab landed after a reorder (drag drop or the Move up / Move down actions). `to` is zero-based. */
function announceMove(id: TabId | undefined, to: number, count: number) {
  if (!id) return;
  AccessibilityInfo.announceForAccessibility(`${tabsCopy.names[id]} moved to position ${to + 1} of ${count}`);
}

/** Six small squares in two columns: the grip that says "hold and drag". */
function Grip({ color }: { color: string }) {
  return (
    <View style={gripStyle.box} pointerEvents="none">
      {[0, 1, 2].map((r) => (
        <View key={r} style={gripStyle.line}>
          <View style={[gripStyle.dot, { backgroundColor: color }]} />
          <View style={[gripStyle.dot, { backgroundColor: color }]} />
        </View>
      ))}
    </View>
  );
}

interface DragState {
  /** Index of the lifted row, or -1. */
  active: SharedValue<number>;
  /** Slot the lifted row would drop into. */
  target: SharedValue<number>;
  /** Vertical finger travel since the lift. */
  dragY: SharedValue<number>;
}

interface RowProps {
  id: TabId;
  index: number;
  count: number;
  name: string;
  locked: boolean;
  shown: boolean;
  drag: DragState;
  onReorder: (from: number, to: number) => void;
  onShown: (v: boolean) => void;
  onStep: (dir: 'up' | 'down') => void;
}

function DraggableRow({ id, index, count, name, locked, shown, drag, onReorder, onShown, onStep }: RowProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const reduceMotion = useReduceMotion();
  // The pan callbacks run on the JS thread (runOnJS), so they read the latest props through a ref.
  const live = useRef({ index, count, onReorder });
  live.current = { index, count, onReorder };
  const lifted = useRef(false);

  const pan = usePanGesture({
    activateAfterLongPress: LONG_PRESS_MS,
    runOnJS: true,
    onActivate: () => {
      lifted.current = true;
      drag.dragY.value = 0;
      drag.target.value = live.current.index;
      drag.active.value = live.current.index;
      haptic('tap');
    },
    onUpdate: (e) => {
      if (!lifted.current) return;
      const { index: at, count: n } = live.current;
      const y = Math.max(-at * ROW_HEIGHT, Math.min((n - 1 - at) * ROW_HEIGHT, e.translationY));
      drag.dragY.value = y;
      const slot = Math.max(0, Math.min(n - 1, Math.round(at + y / ROW_HEIGHT)));
      if (slot !== drag.target.value) {
        drag.target.value = slot;
        haptic('select');
      }
    },
    onFinalize: () => {
      if (!lifted.current) return;
      lifted.current = false;
      const { index: at, onReorder: commit } = live.current;
      const slot = drag.target.value;
      if (slot !== at) {
        // The shared values reset once the new order has rendered (see TabsSection), so the row never jumps.
        commit(at, slot);
      } else {
        drag.active.value = -1;
        drag.dragY.value = 0;
        drag.target.value = -1;
      }
    },
  });

  const rowStyle = useAnimatedStyle(() => {
    const a = drag.active.value;
    const t = drag.target.value;
    if (a === index) {
      return {
        transform: [{ translateY: drag.dragY.value }, { scale: reduceMotion ? 1 : withTiming(LIFT_SCALE, { duration: 120 }) }],
        zIndex: 10,
        backgroundColor: colors.surfaceRaised,
        borderColor: colors.accent,
      };
    }
    let shift = 0;
    if (a >= 0) {
      if (a < t && index > a && index <= t) shift = -ROW_HEIGHT;
      else if (a > t && index >= t && index < a) shift = ROW_HEIGHT;
    }
    return {
      transform: [{ translateY: reduceMotion ? shift : withTiming(shift, { duration: 150 }) }, { scale: 1 }],
      zIndex: 0,
      backgroundColor: 'transparent',
      borderColor: 'transparent',
    };
  });

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[s.row, rowStyle]} testID={`tab-row-${id}`}>
        <View
          style={s.grip}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={`Reorder ${name}, position ${index + 1} of ${count}`}
          accessibilityHint="Swipe up or down to move"
          accessibilityActions={[
            { name: 'increment', label: 'Move down' },
            { name: 'decrement', label: 'Move up' },
          ]}
          onAccessibilityAction={(e) => {
            const dir = e.nativeEvent.actionName === 'decrement' ? 'up' : 'down';
            if ((dir === 'up' && index > 0) || (dir === 'down' && index < count - 1)) onStep(dir);
          }}
        >
          <Grip color={colors.textMuted} />
        </View>
        <View style={s.text}>
          <Text style={s.title} numberOfLines={1}>
            {name}
          </Text>
          {locked ? <Text style={s.subtitle}>{tabsCopy.alwaysShown}</Text> : null}
        </View>
        <Toggle value={locked || shown} disabled={locked} onValueChange={onShown} accessibilityLabel={`Show ${name} tab`} />
      </Animated.View>
    </GestureDetector>
  );
}

/** Settings > Interface > Tabs: which tabs show, and their order. Hold a row and drag to reorder. Applies live. */
export function TabsSection() {
  const prefs = useTabPrefs();
  const assistant = useAssistantPrefs();
  // The Assistant setting decides whether the assistant exists, so its row appears only while it is on.
  const rows = prefs.order.filter((id) => id !== 'assistant' || assistant.enabled);

  const active = useSharedValue(-1);
  const target = useSharedValue(-1);
  const dragY = useSharedValue(0);
  const drag = useMemo<DragState>(() => ({ active, target, dragY }), [active, target, dragY]);

  // Reset the drag once the saved order has rendered, so the dropped row lands without a jump.
  const orderKey = rows.join(',');
  // Layout effect: reset before paint, so the row now sitting at the old index never flashes as lifted.
  useLayoutEffect(() => {
    active.value = -1;
    target.value = -1;
    dragY.value = 0;
  }, [orderKey, active, target, dragY]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const onReorder = useCallback((from: number, to: number) => {
    const id = rowsRef.current[from];
    setTabPrefs((p) => reorderTabs(p, rowsRef.current, from, to));
    announceMove(id, to, rowsRef.current.length);
  }, []);
  const onStep = useCallback((id: TabId, dir: 'up' | 'down') => {
    const from = rowsRef.current.indexOf(id);
    const to = dir === 'up' ? from - 1 : from + 1;
    setTabPrefs((p) => moveTab(p, id, dir, rowsRef.current));
    if (from >= 0 && to >= 0 && to < rowsRef.current.length) announceMove(id, to, rowsRef.current.length);
  }, []);

  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <>
      <View style={s.list}>
        {rows.map((id: TabId, i) => (
          <DraggableRow
            key={id}
            id={id}
            index={i}
            count={rows.length}
            name={tabsCopy.names[id]}
            locked={LOCKED_TABS.includes(id)}
            shown={!prefs.hidden.includes(id)}
            drag={drag}
            onReorder={onReorder}
            onShown={(v) => setTabPrefs((p) => setTabShown(p, id, v))}
            onStep={(dir) => onStep(id, dir)}
          />
        ))}
      </View>
      <View style={s.caption}>
        <Caption>{tabsCopy.reorderHint}</Caption>
        <Caption>{assistant.enabled ? tabsCopy.hint : `${tabsCopy.hint} ${tabsCopy.assistantNote}`}</Caption>
      </View>
    </>
  );
}

const gripStyle = StyleSheet.create({
  box: { gap: 3 },
  line: { flexDirection: 'row', gap: 3 },
  dot: { width: 3, height: 3 },
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    list: { zIndex: 0 },
    row: {
      height: ROW_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingRight: spacing.lg,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    grip: { width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' },
    text: { flex: 1 },
    title: { ...type.body, fontSize: 15, color: c.text },
    subtitle: { ...type.body, fontSize: 12, color: c.textMuted, marginTop: 2 },
    caption: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.xs },
  });
