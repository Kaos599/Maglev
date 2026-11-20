import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { alpha, radius } from '../../constants/theme';
import { useReduceMotion } from '../motion';
import { pickAnchor } from './settingsFocusMatch';

export { pickAnchor, rowKey, sectionKey } from './settingsFocusMatch';

type ViewNode = React.ComponentRef<typeof View>;
const FADE_MS = 1200; // design-exception: the found row glows then fades slowly so the eye can land on it; it is also the hold before the highlight clears

interface FocusContextValue {
  register: (key: string, node: ViewNode | null) => void;
  /** Key currently highlighted, or null. */
  highlighted: string | null;
  pulse: Animated.Value;
}

const FocusContext = createContext<FocusContextValue | null>(null);

interface FocusTarget {
  title: string;
  section?: string;
}

/**
 * Lets rows inside a settings page register by key, then scrolls to and highlights the one
 * a search result pointed at. `scrollTo` receives the row's y inside the content view.
 */
export function SettingsFocusProvider({
  target,
  contentRef,
  scrollTo,
  onDone,
  children,
}: {
  target: FocusTarget | null;
  contentRef: React.RefObject<ViewNode | null>;
  scrollTo: (y: number, animated: boolean) => void;
  /** Called once the target was handled (or abandoned), so the caller can clear the param. */
  onDone: () => void;
  children: React.ReactNode;
}) {
  const reduce = useReduceMotion();
  const nodes = useRef(new Map<string, ViewNode>());
  const pulse = useRef(new Animated.Value(0)).current;
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const done = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ target, scrollTo, onDone, reduce });
  latest.current = { target, scrollTo, onDone, reduce };

  const attempt = useCallback(() => {
    const { target: t } = latest.current;
    if (done.current || !t) return;
    const key = pickAnchor(t, [...nodes.current.keys()]);
    const node = key ? nodes.current.get(key) : null;
    const content = contentRef.current;
    if (!key || !node || !content) return;
    done.current = true;
    node.measureLayout(
      content as never,
      (_x: number, y: number) => {
        const { scrollTo: go, reduce: r, onDone: finish } = latest.current;
        go(Math.max(0, y - 16), !r);
        setHighlighted(key);
        pulse.setValue(1);
        if (r) {
          timer.current = setTimeout(() => setHighlighted(null), FADE_MS);
        } else {
          Animated.timing(pulse, {
            toValue: 0,
            duration: FADE_MS,
            useNativeDriver: false,
          }).start(() => setHighlighted(null));
        }
        finish();
      },
      () => latest.current.onDone(),
    );
  }, [contentRef, pulse]);

  // Rows register as they mount; try shortly after each registration, and give up after a while.
  const schedule = useCallback(() => {
    if (done.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(attempt, 50);
  }, [attempt]);

  const register = useCallback(
    (key: string, node: ViewNode | null) => {
      if (node) nodes.current.set(key, node);
      else nodes.current.delete(key);
      if (node) schedule();
    },
    [schedule],
  );

  useEffect(() => {
    if (!target) return;
    done.current = false;
    schedule();
    const giveUp = setTimeout(() => {
      if (!done.current) {
        done.current = true;
        latest.current.onDone();
      }
    }, 2000);
    return () => clearTimeout(giveUp);
  }, [target?.title, target?.section, schedule]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const value = useMemo(() => ({ register, highlighted, pulse }), [register, highlighted, pulse]);
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

/** Wraps a row or header so a search result can scroll to it. Renders children untouched outside a settings page. */
export function FocusAnchor({ anchorKey, children }: { anchorKey: string; children: React.ReactNode }) {
  const ctx = useContext(FocusContext);
  const { colors } = useTheme();
  const ref = useRef<React.ComponentRef<typeof View>>(null);
  const register = ctx?.register;
  useEffect(() => {
    if (!register) return;
    register(anchorKey, ref.current);
    return () => register(anchorKey, null);
  }, [register, anchorKey]);
  if (!ctx) return <>{children}</>;
  const on = ctx.highlighted === anchorKey;
  const bg = on
    ? ctx.pulse.interpolate({
        inputRange: [0, 1],
        outputRange: [alpha(colors.accent, 0), alpha(colors.accent, 0.18)],
      })
    : 'transparent';
  return (
    <Animated.View ref={ref as never} collapsable={false} style={{ backgroundColor: bg, borderRadius: radius.md }}>
      {children}
    </Animated.View>
  );
}
