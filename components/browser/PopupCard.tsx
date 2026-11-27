import React, { useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { browserTabs } from '../../constants/copy';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { hostFrom, normalizeSiteHost, type PopupKind, type TabPrompt } from '../../utils/browser/popups';
import { Button } from '../ui';
import { FloatingSheet } from './FloatingSheet';

const TITLES: Record<PopupKind, string> = {
  window: browserTabs.popup.windowTitle,
  redirect: browserTabs.popup.redirectTitle,
  app: browserTabs.popup.appTitle,
};

/** The host the request goes to, or the scheme for an app address. */
function popupTarget(kind: PopupKind, url: string): string {
  if (kind === 'app') return `${(/^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1] ?? '').toLowerCase()}:`;
  return hostFrom(url) || url;
}

export interface PopupCardProps {
  /** The active tab's waiting request, or null. */
  prompt: TabPrompt | null;
  /** Block: this request is blocked and the source site is remembered (added to the block list). */
  onBlock: () => void;
  /** Allow once: this request opens; nothing is remembered. */
  onAllowOnce?: () => void;
  /** Always allow on {host}: the source site joins the allow list, then this request opens. */
  onAlwaysAllow: () => void;
  /** Scrim and Back: block this once, remember nothing. Falls back to `onBlock` until the screen wires it. */
  onDismiss?: () => void;
  /** @deprecated The old name of `onAllowOnce`, kept so the screen compiles until it is wired. */
  onOpen?: () => void;
}

/** T5: one card per tab. Scrim and Back dismiss (block once, remember nothing). */
export function PopupCard({ prompt, onBlock, onAllowOnce, onAlwaysAllow, onDismiss, onOpen }: PopupCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Keep the last request while the card fades out.
  const last = useRef<TabPrompt | null>(prompt);
  if (prompt) last.current = prompt;
  const p = prompt ?? last.current;
  if (!p) return null;
  const copy = browserSettingsCopy.popupCard;
  const sourceHost = normalizeSiteHost(p.first.sourceUrl);
  const allowOnce = onAllowOnce ?? onOpen;
  return (
    <FloatingSheet visible={prompt != null} onClose={onDismiss ?? onBlock} title={TITLES[p.first.kind]}>
      <View style={styles.body}>
        <Text style={styles.target} numberOfLines={2}>
          {popupTarget(p.first.kind, p.first.url)}
        </Text>
        {p.more > 0 ? <Text style={styles.more}>{browserTabs.popup.moreBlocked(p.more)}</Text> : null}
        <View style={styles.actions}>
          <View style={styles.leftGroup}>
            {sourceHost ? (
              <Button
                label={copy.alwaysAllowShort}
                variant="ghost"
                accessibilityLabel={copy.alwaysAllow(sourceHost)}
                onPress={onAlwaysAllow}
              />
            ) : null}
            {allowOnce ? <Button label={copy.allowOnce} variant="secondary" onPress={allowOnce} /> : null}
          </View>
          <Button label={copy.block} variant="dangerFilled" onPress={onBlock} />
        </View>
      </View>
    </FloatingSheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    body: { gap: spacing.sm },
    target: { ...type.mono, fontSize: type.size.md, color: c.text },
    more: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
    leftGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
  });
