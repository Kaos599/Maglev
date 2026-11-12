import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../../constants/theme';
import { Button } from '../../ui';
import { Field } from './Field';

/** Sign in with OpenRouter: the primary way to get a key (noKey, editing, invalid). */
export function OpenRouterSignInButton({ onPress, primary = true }: { onPress: () => void; primary?: boolean }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={s.wrap}>
      <Button label="Sign in with OpenRouter" onPress={onPress} variant={primary ? 'primary' : 'secondary'} fullWidth testID="assistant-sign-in" />
      <Text style={s.caption}>One key for many models. You sign in on openrouter.ai, then paste the code it shows you.</Text>
    </View>
  );
}

/** awaitingCode: paste the code. exchanging: wait. Both can be cancelled. */
export function OpenRouterCodeEntry({
  exchanging,
  error,
  onSubmit,
  onCancel,
}: {
  exchanging: boolean;
  error: string | null;
  onSubmit: (pasted: string) => void;
  onCancel: () => void;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [code, setCode] = useState('');
  return (
    <View style={s.wrap}>
      <Text style={s.title}>{exchanging ? 'Getting your key' : 'Finish on OpenRouter'}</Text>
      {exchanging ? (
        <Text style={s.caption}>Hang on a moment.</Text>
      ) : (
        <>
          <Text style={s.caption}>Sign in and allow Maglev in the page that opened. OpenRouter then shows a code. Paste it here.</Text>
          <Field label="Code from OpenRouter" value={code} onChangeText={setCode} placeholder="Paste the code" onSubmitEditing={() => onSubmit(code)} testID="assistant-code" />
          {error ? (
            <Text style={s.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
        </>
      )}
      <View style={s.actions}>
        {exchanging ? null : <Button label="Continue" onPress={() => onSubmit(code)} disabled={!code.trim()} testID="assistant-code-continue" />}
        <Button label="Cancel" variant="ghost" onPress={onCancel} testID="assistant-sign-in-cancel" />
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { gap: spacing.sm },
    title: { ...type.bodyStrong, fontSize: 15, color: c.text },
    caption: { ...type.body, fontSize: 12, lineHeight: 17, color: c.textMuted },
    error: { ...type.body, fontSize: 12, color: c.danger },
    actions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
  });
