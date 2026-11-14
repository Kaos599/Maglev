import React, { useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { browserTabs } from '../../constants/copy';
import { hostFrom, type PopupKind, type TabPrompt } from '../../utils/browser/popups';
import { Button } from '../ui';
import { FloatingSheet } from './FloatingSheet';

const TITLES: Record<PopupKind, string> = {
  window: browserTabs.popup.windowTitle,
  redirect: browserTabs.popup.redirectTitle,
  app: browserTabs.popup.appTitle,
};

/** The host the request goes to, or the scheme for an app address. */
export function popupTarget(kind: PopupKind, url: string): string {
  if (kind === 'app') return `${(/^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1] ?? '').toLowerCase()}:`;
  return hostFrom(url) || url;
}

export interface PopupCardProps {
  /** The active tab's waiting request, or null. */
  prompt: TabPrompt | null;
  onOpen: () => void;
  onBlock: () => void;
  onAlwaysAllow: () => void;
}

/** T5: one card per tab. Scrim and Back count as Block. */
export function PopupCard({ prompt, onOpen, onBlock, onAlwaysAllow }: PopupCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Keep the last request while the card fades out.
  const last = useRef<TabPrompt | null>(prompt);
  if (prompt) last.current = prompt;
  const p = prompt ?? last.current;
  if (!p) return null;
  const sourceHost = hostFrom(p.first.sourceUrl);
  return (
    <FloatingSheet visible={prompt != null} onClose={onBlock} title={TITLES[p.first.kind]}>
      <View style={styles.body}>
        <Text style={styles.target} numberOfLines={2}>
          {popupTarget(p.first.kind, p.first.url)}
        </Text>
        {p.more > 0 ? <Text style={styles.more}>{browserTabs.popup.moreBlocked(p.more)}</Text> : null}
        <View style={styles.actions}>
          <Button label={browserTabs.popup.block} variant="secondary" onPress={onBlock} />
          <Button label={browserTabs.popup.open} onPress={onOpen} />
        </View>
        {sourceHost ? <Button label={browserTabs.popup.alwaysAllow(sourceHost)} variant="ghost" fullWidth onPress={onAlwaysAllow} /> : null}
      </View>
    </FloatingSheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    body: { gap: spacing.sm },
    target: { ...type.mono, fontSize: type.size.md, color: c.text },
    more: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.sm },
  });
