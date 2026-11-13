import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';

export interface ComposerProps {
  /** A turn is in flight: Send becomes Stop. */
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** The model in use, or the provider when the model is unknown. Opens Settings → Assistant. */
  modelText: string;
  onOpenModel: () => void;
  /** Plain-words token count, e.g. "12.4k tokens used". */
  contextText: string;
}

/**
 * Prompt input, after AI Elements: a field that grows up to a few lines, a text-only Send that becomes Stop while a
 * turn runs, a model chip (display only, opens settings) and a Context line with the tokens used.
 */
export function Composer({ busy, onSend, onStop, modelText, onOpenModel, contextText }: ComposerProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [text, setText] = useState('');
  const { fontScale } = useWindowDimensions();
  const trimmed = text.trim();
  const canSend = !busy && trimmed.length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <View style={styles.outer}>
    <View style={styles.meta}>
      <Pressable
        onPress={onOpenModel}
        style={({ pressed }) => [styles.model, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`Model: ${modelText}. Open Assistant settings`}
      >
        <PixelIcon name="assistant" size={16} color={colors.textMuted} />
        <Text style={styles.modelText} numberOfLines={1}>
          {modelText}
        </Text>
      </Pressable>
      <Text style={styles.context} accessibilityLabel={contextText}>
        {contextText}
      </Text>
    </View>
    <View style={styles.bar}>
      <TextInput
        style={[styles.input, { maxHeight: 120 * Math.max(1, Math.min(fontScale, 2)) }]}
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
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    outer: { borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.bg },
    meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingHorizontal: spacing.lg },
    model: { flexShrink: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    modelText: { ...type.mono, flexShrink: 1, fontSize: type.size.sm, color: c.textMuted },
    context: { ...type.mono, flexShrink: 0, fontSize: type.size.sm, color: c.textFaint },
    bar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
    },
    input: {
      ...type.body,
      flex: 1,
      minHeight: 44,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: 15,
      color: c.text,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
    },
    action: { minWidth: 56, minHeight: 44, paddingHorizontal: spacing.xs, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    actionText: { ...type.heading, fontSize: 13 },
    pressed: { backgroundColor: c.surfaceRaised },
    off: { opacity: 0.4 },
  });
