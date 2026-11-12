import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../../constants/theme';
import type { TokenKey } from '../../utils/assistant/glossary';
import type { ChatItem } from '../../utils/assistant/runtime';
import { Button } from '../ui';
import { PixelIcon } from '../PixelIcon';
import { LightText } from './LightText';

type TextItem = Extract<ChatItem, { kind: 'user' | 'assistant' | 'note' | 'error' }>;

export interface MessageProps {
  item: TextItem;
  onTerm: (key: TokenKey) => void;
  onOpenSettings: () => void;
  onRetry: () => void;
}

/**
 * One turn of text, after AI Elements' Message: the user's words in an accent-outlined bubble on the right, the
 * assistant's on the left with light formatting, plus one-line app notes and SM-31 errors.
 */
export const Message = memo(function Message({ item, onTerm, onOpenSettings, onRetry }: MessageProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  switch (item.kind) {
    case 'user':
      return (
        <View style={[styles.bubble, styles.user]}>
          <Text style={styles.text} selectable>
            {item.text}
          </Text>
        </View>
      );
    case 'assistant':
      // An empty streaming message is the steps' job; draw nothing until text arrives.
      if (!item.text) return null;
      return (
        <View style={[styles.bubble, styles.assistant]}>
          <LightText text={item.text} onTerm={onTerm} />
        </View>
      );
    case 'note':
      return <Text style={styles.note}>{item.text}</Text>;
    case 'error':
      return (
        <View style={styles.error}>
          <View style={styles.errorRow}>
            <PixelIcon name="warning" size={20} color={colors.danger} />
            <Text style={styles.errorText}>{item.message}</Text>
          </View>
          {item.action === 'settings' ? (
            <View style={styles.errorAction}>
              <Button label="Open settings" variant="secondary" onPress={onOpenSettings} />
            </View>
          ) : null}
          {item.action === 'retry' ? (
            <View style={styles.errorAction}>
              <Button label="Retry" variant="secondary" onPress={onRetry} />
            </View>
          ) : null}
        </View>
      );
  }
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    bubble: { maxWidth: '92%', paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2, borderRadius: radius.md, borderWidth: 1 },
    user: { alignSelf: 'flex-end', borderColor: c.accent, backgroundColor: 'transparent' },
    assistant: { alignSelf: 'flex-start', borderColor: c.border, backgroundColor: c.surface },
    text: { ...type.body, fontSize: 15, lineHeight: 21, color: c.text },
    note: { ...type.body, fontSize: type.size.md, color: c.textMuted, alignSelf: 'flex-start', paddingHorizontal: spacing.xs },
    error: {
      alignSelf: 'stretch',
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: alpha(c.danger, 0.4),
      backgroundColor: alpha(c.danger, 0.1),
    },
    errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    errorText: { ...type.body, flex: 1, fontSize: 14, lineHeight: 20, color: c.text },
    errorAction: { marginTop: spacing.md, alignSelf: 'flex-start' },
  });
