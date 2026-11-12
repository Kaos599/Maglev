import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, type HostInstance, type KeyboardEvent } from 'react-native';

/**
 * How much of a view the on-screen keyboard covers, in dp. Pad the view's bottom by it so the composer
 * stays above the keyboard.
 *
 * KeyboardAvoidingView doesn't work for the chat. It measures itself relative to its parent, so the
 * screen header and the tab bar under it throw the sum off. And with edge-to-edge (always on from RN 0.88)
 * Android no longer resizes the window for the keyboard. This hook measures the view in window coordinates
 * and compares its bottom with the keyboard's top.
 */
export function useKeyboardInset() {
  const ref = useRef<HostInstance>(null);
  const [inset, setInset] = useState(0);
  const keyboardTop = useRef<number | null>(null);

  const update = useCallback(() => {
    const top = keyboardTop.current;
    if (top == null) {
      setInset(0);
      return;
    }
    ref.current?.measureInWindow((_x, y, _w, h) => {
      // The view is flex: 1, so padding changes its content area, not its outer box: y + h stays put.
      setInset(Math.max(0, Math.round(y + h - top)));
    });
  }, []);

  useEffect(() => {
    const onShow = (e: KeyboardEvent) => {
      keyboardTop.current = e.endCoordinates.screenY;
      update();
    };
    const onHide = () => {
      keyboardTop.current = null;
      setInset(0);
    };
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subs = [Keyboard.addListener(showEvt, onShow), Keyboard.addListener(hideEvt, onHide)];
    return () => subs.forEach((s) => s.remove());
  }, [update]);

  return { ref, inset };
}
