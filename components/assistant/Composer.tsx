import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';

export interface ComposerProps {
  /** A turn is in flight: Send becomes Stop. */
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

/** Single-line field that grows up to a few lines, with a text-only Send that becomes Stop while a turn runs. */
export function Composer({ busy, onSend, onStop }: ComposerProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const canSend = !busy && trimmed.length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <View style={styles.bar}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="Ask about a download"
        placeholderTextColor={colors.textFaint}
        multiline
        maxLength={4000}
        accessibilityLabel="Message"
        textAlignVertical="center"
        selectionColor={colors.accent}
      />
      {busy ? (
        <Pressable
          onPress={onStop}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Stop"
        >
          <Text style={[styles.actionText, { color: colors.danger }]}>Stop</Text>
        </Pressable>
      ) : (
        <Pressable
          onPress={submit}
          disabled={!canSend}
          style={({ pressed }) => [styles.action, pressed && styles.pressed, !canSend && styles.off]}
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !canSend }}
        >
          <Text style={[styles.actionText, { color: colors.accentText }]}>Send</Text>
        </Pressable>
      )}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.bg,
    },
    input: {
      ...type.body,
      flex: 1,
      minHeight: 44,
      maxHeight: 120,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: 15,
      color: c.text,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
    },
    action: { minWidth: 56, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    actionText: { ...type.brand, fontSize: 13 },
    pressed: { backgroundColor: c.surfaceRaised },
    off: { opacity: 0.4 },
  });
