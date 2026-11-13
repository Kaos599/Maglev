import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import { getCookies, hasClearanceCookie } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Button } from '../ui';
import { hostOf } from '../../utils/search/challenge';
import { setClearance } from '../../utils/search/clearance';

/** The WebView gives up after this long (SEARCH_CONTRACT section 8). */
export const SOLVE_TIMEOUT_MS = 60_000;

// Reports the WebView's own User-Agent. Cloudflare ties cf_clearance to it, so every later request to the host reuses it.
const READ_UA = 'try{window.ReactNativeWebView.postMessage(JSON.stringify({ua:navigator.userAgent}))}catch(e){}true;';

/**
 * Full-screen check for one source. The user passes the Cloudflare check themselves in a real WebView;
 * nothing here scripts or clicks it. On every page finish the cookie jar is read for the host, and once a
 * cf_clearance cookie exists the sheet stores {host, userAgent, at} and calls onSolved.
 */
export function CloudflareSolverSheet({
  visible,
  providerName,
  solverUrl,
  onClose,
  onSolved,
}: {
  visible: boolean;
  providerName: string;
  solverUrl: string;
  onClose: () => void;
  /** Called after the clearance is stored: re-run that provider's search once. */
  onSolved: () => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [timedOut, setTimedOut] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ua = useRef<string | null>(null);
  const done = useRef(false);
  const lastUrl = useRef(solverUrl);

  const check = useCallback(
    async (url: string) => {
      if (done.current) return;
      const cookies = await getCookies(url);
      if (done.current || !hasClearanceCookie(cookies)) return;
      if (!ua.current) return; // the message handler retries once the User-Agent arrives
      done.current = true;
      setClearance(hostOf(solverUrl), ua.current);
      onSolved();
    },
    [solverUrl, onSolved],
  );

  useEffect(() => {
    if (!visible) return;
    done.current = false;
    ua.current = null;
    lastUrl.current = solverUrl;
    setTimedOut(false);
    const t = setTimeout(() => {
      if (!done.current) setTimedOut(true);
    }, SOLVE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [visible, attempt, solverUrl]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      try {
        const m = JSON.parse(e.nativeEvent.data);
        if (typeof m?.ua === 'string' && m.ua) {
          ua.current = m.ua;
          void check(lastUrl.current);
        }
      } catch {
        // Not our message.
      }
    },
    [check],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, spacing.md) }]} accessibilityViewIsModal>
        <View style={styles.head}>
          <Text style={styles.title} accessibilityRole="header">
            {`Check ${providerName}`}
          </Text>
          <Text style={styles.caption}>Cloudflare is checking that you're a person. If a box appears, tick it.</Text>
        </View>
        <View style={styles.web}>
          {visible ? (
            <WebView
              key={attempt}
              source={{ uri: solverUrl }}
              injectedJavaScript={READ_UA}
              onMessage={onMessage}
              onLoadEnd={(e: { nativeEvent: { url?: string } }) => {
                lastUrl.current = e.nativeEvent.url || solverUrl;
                void check(lastUrl.current);
              }}
              javaScriptEnabled
              domStorageEnabled
              thirdPartyCookiesEnabled
              setSupportMultipleWindows={false}
              style={styles.webview}
            />
          ) : null}
        </View>
        <View style={styles.foot}>
          {timedOut ? <Text style={styles.error}>Didn't finish. Try again or close.</Text> : null}
          <View style={styles.actions}>
            {timedOut ? <Button label="Try again" variant="secondary" onPress={() => setAttempt((n) => n + 1)} /> : null}
            <Button label="Close" variant={timedOut ? 'ghost' : 'secondary'} onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    head: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.xs },
    title: { ...type.heading, fontSize: type.size.xl, color: c.text },
    caption: { ...type.body, fontSize: type.size.md, color: c.textMuted },
    web: { flex: 1, borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.border },
    webview: { flex: 1, backgroundColor: c.bg },
    foot: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.sm },
    error: { ...type.body, fontSize: type.size.md, color: c.danger },
    actions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
  });
