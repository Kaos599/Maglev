import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, PanResponder, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, motion, radius, spacing, type, touch } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { PressableScale } from '../ui';
import { easeOut, useReduceMotion } from '../motion';
import { MultiSubtitleSheet } from '../subtitles/MultiSubtitleSheet';
import { useSubtitleConsent } from '../subtitles/useSubtitleConsent';
import { askSubtitles, getRequests, skipSubtitles, useRequestPhases, type RequestPhase, type SubtitleAsk } from '../../utils/subtitles/requests';
import {
  askedAsks,
  markAsked,
  mergeAdd,
  pendingAsks,
  remainingMs,
  shiftDeadline,
  skipAsked,
  timerRuns,
  trayAction,
  trayMayMerge,
  trayAnnouncement,
  trayLine,
  trayTileMuted,
  trayTitle,
  type TrayAction,
  type TrayAdd,
  type TrayState,
} from '../../utils/addedTray';

/*
 * The "Added" message (docs/NATIVE_CONTRACT.md section 44.3). Layout from the approved page: padding 12 all round, radius 16,
 * a 40 dp tile centred on two 20-line text rows, and an action row 12 below it whose button starts at the tile's left edge.
 */
const SIDE_MARGIN = 12;
const BOTTOM_GAP = 8;
const DISMISS_DRAG = 40;
/** Before the first measure: padding, a 40 dp row, 12 dp, a 40 dp row, padding. */
const GUESS_HEIGHT = 116;

export interface TrayView {
  title: string;
  line: string;
  muted: boolean;
  action: TrayAction;
}

function trayView(s: TrayState, phases?: Record<string, RequestPhase | undefined>): TrayView {
  return { title: trayTitle(s), line: trayLine(s), muted: trayTileMuted(s), action: trayAction(s, phases) };
}

interface TrayProps {
  view: TrayView | null;
  onAsk: (count: number) => void;
  onStatus: () => void;
  onSkip: () => void;
  onView: () => void;
  onDismiss: () => void;
  /** A finger is on the message: the timer waits. */
  onHold: (held: boolean) => void;
  onHeight: (h: number) => void;
}

function AddedTrayImpl({ view, onAsk, onStatus, onSkip, onView, onDismiss, onHold, onHeight }: TrayProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reduce = useReduceMotion();
  // The last view stays on screen while the message slides away.
  const [shown, setShown] = useState<TrayView | null>(view);
  const height = useRef(GUESS_HEIGHT);
  const slide = useRef(new Animated.Value(view ? 1 : 0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const holdRef = useRef(onHold);
  holdRef.current = onHold;

  useEffect(() => {
    if (view) {
      setShown(view);
      drag.setValue(0);
      if (reduce) {
        slide.setValue(1);
        return;
      }
      Animated.timing(slide, { toValue: 1, duration: motion.duration.focus, easing: easeOut, useNativeDriver: true }).start();
      return;
    }
    if (reduce) {
      slide.setValue(0);
      setShown(null);
      return;
    }
    Animated.timing(slide, { toValue: 0, duration: motion.duration.exit, easing: easeOut, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setShown(null);
    });
    // Only whether there is a message decides the motion; its words change in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!view, reduce]);
  useEffect(() => {
    if (view) setShown(view);
  }, [view]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_e, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
        onPanResponderGrant: () => holdRef.current(true),
        onPanResponderMove: (_e, g) => drag.setValue(Math.max(0, g.dy)),
        onPanResponderRelease: (_e, g) => {
          holdRef.current(false);
          if (g.dy > DISMISS_DRAG || g.vy > 0.6) dismissRef.current();
          else Animated.timing(drag, { toValue: 0, duration: motion.duration.release, easing: easeOut, useNativeDriver: true }).start();
        },
        onPanResponderTerminate: () => {
          holdRef.current(false);
          Animated.timing(drag, { toValue: 0, duration: motion.duration.release, easing: easeOut, useNativeDriver: true }).start();
        },
      }),
    [drag],
  );

  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      height.current = e.nativeEvent.layout.height;
      onHeight(e.nativeEvent.layout.height);
    },
    [onHeight],
  );

  if (!shown) return null;
  const a = shown.action;
  const rise = slide.interpolate({ inputRange: [0, 1], outputRange: [height.current + BOTTOM_GAP, 0] });
  const viewAct = (
    <PressableScale
      onPress={onView}
      style={styles.viewAct}
      hitSlop={{ top: 2, bottom: 2 }}
      accessibilityRole="button"
      accessibilityLabel="View in Transfers"
    >
      <Text style={styles.viewText}>View</Text>
    </PressableScale>
  );
  const hasActions = !!a.main || a.skip || a.see;

  return (
    <Animated.View
      style={[styles.wrap, { opacity: slide, transform: [{ translateY: Animated.add(rise, drag) }] }]}
      pointerEvents={view ? 'box-none' : 'none'}
    >
      <View
        style={styles.tray}
        onLayout={onLayout}
        onTouchStart={() => onHold(true)}
        onTouchEnd={() => onHold(false)}
        onTouchCancel={() => onHold(false)}
        accessibilityActions={[{ name: 'dismiss', label: 'Dismiss' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'dismiss') onDismiss();
        }}
        testID="added-tray"
        {...pan.panHandlers}
      >
        <View style={styles.top}>
          <View style={[styles.tile, shown.muted && styles.tileMuted]} importantForAccessibility="no-hide-descendants">
            <PixelIcon name="check" size={24} color={shown.muted ? colors.textMuted : colors.onAccent} />
          </View>
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={1}>
              {shown.title}
            </Text>
            <Text style={styles.line} numberOfLines={1}>
              {shown.line}
            </Text>
          </View>
          {hasActions ? null : <View style={styles.viewTop}>{viewAct}</View>}
        </View>
        {hasActions ? (
          <View style={styles.actions}>
            {a.main?.kind === 'ask' ? (
              <PressableScale
                onPress={() => onAsk(a.main && a.main.kind === 'ask' ? a.main.count : 1)}
                style={styles.mainAct}
                hitSlop={{ top: 2, bottom: 2 }}
                accessibilityRole="button"
                accessibilityLabel={a.main.label}
              >
                <PixelIcon name="subtitles" size={20} color={colors.text} />
                <Text style={styles.mainText} numberOfLines={1}>
                  {a.main.label}
                </Text>
              </PressableScale>
            ) : null}
            {a.main?.kind === 'getting' ? (
              <>
                <PressableScale
                  onPress={a.main.opensStatus ? onStatus : undefined}
                  disabled={!a.main.opensStatus}
                  containerStyle={styles.stateOuter}
                  style={styles.state}
                  accessibilityRole={a.main.opensStatus ? 'button' : 'text'}
                  accessibilityLabel={a.main.opensStatus ? `${a.main.label}. See which` : a.main.label}
                >
                  <PixelIcon name="subtitles" size={20} color={colors.accentText} />
                  <Text style={styles.stateText} numberOfLines={1}>
                    {a.main.label}
                  </Text>
                  {a.main.opensStatus ? <PixelIcon name="chevron-right" size={20} color={colors.textMuted} /> : null}
                </PressableScale>
                {a.main.more ? (
                  <PressableScale
                    onPress={() => onAsk(a.main && a.main.kind === 'getting' && a.main.more ? a.main.more.count : 1)}
                    style={styles.moreAct}
                    hitSlop={{ top: 2, bottom: 2 }}
                    accessibilityRole="button"
                    accessibilityLabel={a.main.more.a11y}
                  >
                    <Text style={styles.mainText}>{a.main.more.label}</Text>
                  </PressableScale>
                ) : null}
              </>
            ) : null}
            {a.see ? (
              <PressableScale onPress={onStatus} style={styles.mainAct} hitSlop={{ top: 2, bottom: 2 }} accessibilityRole="button" accessibilityLabel="See which videos get subtitles">
                <PixelIcon name="subtitles" size={20} color={colors.text} />
                <Text style={styles.mainText}>See which</Text>
              </PressableScale>
            ) : null}
            {!a.main && !a.see ? <View style={styles.spacer} /> : null}
            {a.skip ? (
              <PressableScale onPress={onSkip} style={styles.skipAct} hitSlop={{ top: 2, bottom: 2 }} accessibilityRole="button" accessibilityLabel="Skip subtitles">
                <Text style={styles.skipText}>Skip</Text>
              </PressableScale>
            ) : null}
            {viewAct}
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

export const AddedTray = memo(AddedTrayImpl);

// ---------------------------------------------------------------- the hook the Search screen uses

export interface AddedTrayInput extends Omit<TrayAdd, 'auto'> {
  /** True when this add should ask for subtitles on its own (Settings > Subtitles, section 44.6). */
  auto: boolean;
}

/**
 * Owns the message: the merged state, the 6 second timer (paused by a finger or the sheet, off with a screen reader),
 * and the calls into the subtitle requests (section 44.1). `node` goes inside the screen; `inset` is the bottom
 * padding the result list needs while the message shows.
 */
// The one mounted message, so a link added from the Add screen can join it (44.12).
let live: { add: (i: AddedTrayInput) => void; visible: () => boolean; focused: () => boolean } | null = null;

/** Joins the message when it is on screen and the Search tab is the one in front (44.15 F9). Returns false (and does nothing) when it is not. */
export function joinTrayIfShowing(input: AddedTrayInput): boolean {
  if (!live || !live.visible() || !live.focused()) return false;
  live.add(input);
  return true;
}

export function useAddedTray({ onView, onAnnounce, focused = true }: { onView: () => void; onAnnounce?: (text: string) => void; /** The Search tab is in front (44.15 F9). */ focused?: boolean }) {
  const consent = useSubtitleConsent();
  const [state, setState] = useState<TrayState | null>(null);
  const stateRef = useRef<TrayState | null>(null);
  const [sheet, setSheet] = useState<'choose' | 'status' | null>(null);
  const [finger, setFinger] = useState(false);
  const [screenReader, setScreenReader] = useState(false);
  const [height, setHeight] = useState(0);
  const heldSince = useRef<number | null>(null);
  const screenReaderRef = useRef(false);
  screenReaderRef.current = screenReader;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  const put = useCallback((next: TrayState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isScreenReaderEnabled().then((on) => alive && setScreenReader(on)).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const held = finger || sheet !== null;
  // A hold moves the deadline out by as long as it lasted, so the message gets the time it had left.
  useEffect(() => {
    if (held) {
      heldSince.current = Date.now();
      return;
    }
    const since = heldSince.current;
    heldSince.current = null;
    if (since === null) return;
    const cur = stateRef.current;
    if (cur) put({ ...cur, deadline: shiftDeadline(cur.deadline, Date.now() - since) });
  }, [held, put]);

  const deadline = state?.deadline ?? null;
  useEffect(() => {
    if (deadline === null || !timerRuns({ screenReader, held })) return;
    const timer = setTimeout(() => put(null), remainingMs(deadline, Date.now()));
    return () => clearTimeout(timer);
  }, [deadline, screenReader, held, put]);

  const add = useCallback(
    (input: AddedTrayInput) => {
      const now = Date.now();
      // 44.15 F9: under TalkBack a message older than 60 s stops merging; the add starts a new one.
      const prev = trayMayMerge(stateRef.current, { now, screenReader: screenReaderRef.current, focused: true }) ? stateRef.current : null;
      const key = input.ask?.key;
      // 44.15 D10: nothing is asked on its own before the one-time OK.
      const auto = input.auto && !consent.needsOk;
      const next = mergeAdd(prev, { ...input, auto, phase: key ? getRequests()[key]?.phase : undefined }, now);
      // An add while a hold is on starts its 6 seconds when the hold ends.
      if (heldSince.current !== null) heldSince.current = Date.now();
      put(next);
      const isNew = !input.alreadyThere && !(prev?.items.some((x) => x.hash === input.hash.toLowerCase()) ?? false);
      const held = key ? getRequests()[key]?.phase : undefined;
      if (isNew && auto && input.ask && held !== 'skipped') askSubtitles([input.ask], { auto: true });
      onAnnounce?.(trayAnnouncement(next));
    },
    [put, onAnnounce, consent.needsOk],
  );

  const hide = useCallback(() => {
    setSheet(null);
    setFinger(false);
    put(null);
  }, [put]);

  /** 44.15 F7: a banner takes the message's slot but never closes a sheet that is open (the caller waits). */
  const sheetOpenRef = useRef(false);
  sheetOpenRef.current = sheet !== null;
  const hideMessage = useCallback(() => {
    if (sheetOpenRef.current) return;
    setFinger(false);
    put(null);
  }, [put]);

  const ask = useCallback(
    (count: number) => {
      const cur = stateRef.current;
      if (!cur) return;
      const pending = pendingAsks(cur);
      if (count >= 2 && pending.length >= 2) {
        setSheet('choose');
        return;
      }
      // 44.15 D10: the first tap on Get subtitles shows the one-time notice; nothing is asked before Continue.
      consent.require(() => {
        const now = stateRef.current;
        if (!now) return;
        const still = pendingAsks(now);
        askSubtitles(still, { auto: false });
        put(markAsked(now, still.map((x) => x.key)));
      });
    },
    [put, consent],
  );

  const confirm = useCallback(
    (keys: string[]) => {
      setSheet(null);
      if (!stateRef.current) return;
      consent.require(() => {
        const cur = stateRef.current;
        if (!cur) return;
        const picked = pendingAsks(cur).filter((x) => keys.includes(x.key));
        if (picked.length > 0) askSubtitles(picked, { auto: false });
        put(markAsked(cur, picked.map((x) => x.key)));
      });
    },
    [put, consent],
  );

  const skip = useCallback(() => {
    const cur = stateRef.current;
    if (!cur) return;
    const out = skipAsked(cur);
    out.keys.forEach(skipSubtitles);
    put(out.state);
  }, [put]);

  const sheetAsks: SubtitleAsk[] = state ? (sheet === 'status' ? askedAsks(state) : pendingAsks(state)) : [];
  // 44.15 F9: the action row follows what the asked videos are doing now.
  const phases = useRequestPhases(state ? askedAsks(state).map((a) => a.key) : []);
  const view = state && sheet === null ? trayView(state, phases) : null;
  const node = (
    <>
      <AddedTray
        view={view}
        onAsk={ask}
        onStatus={() => setSheet('status')}
        onSkip={skip}
        onView={() => {
          hide();
          onView();
        }}
        onDismiss={hide}
        onHold={setFinger}
        onHeight={setHeight}
      />
      <MultiSubtitleSheet visible={sheet !== null} asks={sheetAsks} mode={sheet ?? 'choose'} onConfirm={confirm} onClose={() => setSheet(null)} />
      {consent.node}
    </>
  );
  const visibleRef = useRef(false);
  visibleRef.current = !!state;
  useEffect(() => {
    live = { add, visible: () => visibleRef.current, focused: () => focusedRef.current };
    return () => {
      live = null;
    };
  }, [add]);
  const inset = view ? (height || GUESS_HEIGHT) + BOTTOM_GAP + spacing.sm : 0;
  return { add, hide, hideMessage, sheetOpen: sheet !== null, node, inset, visible: !!view };
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { position: 'absolute', left: SIDE_MARGIN, right: SIDE_MARGIN, bottom: BOTTOM_GAP },
    tray: { backgroundColor: c.surfaceRaised, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: spacing.md },
    top: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    tile: { width: 40, height: 40, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent },
    tileMuted: { backgroundColor: c.border },
    text: { flex: 1, minWidth: 0 },
    title: { ...type.bodyStrong, fontSize: type.size.lg, lineHeight: 20, color: c.text },
    line: { ...type.body, fontSize: type.size.md, lineHeight: 20, color: c.textMuted },
    viewTop: { marginRight: -12 },
    actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md },
    mainAct: { flex: 1, height: 40, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderWidth: 1, borderColor: c.borderStrong, borderRadius: radius.sm },
    moreAct: { height: 40, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderWidth: 1, borderColor: c.borderStrong, borderRadius: radius.sm },
    mainText: { ...type.bodyStrong, fontSize: type.size.base, color: c.text },
    stateOuter: { flex: 1, minWidth: 0 },
    state: { minHeight: touch.min, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    stateText: { ...type.body, fontSize: type.size.md, color: c.text, flexShrink: 1 },
    spacer: { flex: 1 },
    skipAct: { height: 40, minWidth: touch.min, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
    skipText: { ...type.bodyStrong, fontSize: type.size.base, color: c.textMuted },
    viewAct: { height: 40, minWidth: touch.min, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
    viewText: { ...type.bodyStrong, fontSize: type.size.base, color: c.accentText },
  });
