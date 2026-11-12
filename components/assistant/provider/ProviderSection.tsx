/**
 * Settings → Assistant provider setup, driven 1:1 by SM-40 (utils/assistant/providerMachine.ts).
 *   noKey         sign-in button, "Use another provider or paste a key"
 *   editing       provider, key (not for custom), address (custom), model, Test model, sign-in link
 *   testing       the form stays in view, Test model shows it is running
 *   ready         summary with Change and Remove key
 *   invalid       red banner with the reason, sign-in button, Fix settings
 *   awaitingCode  paste the code from OpenRouter, Cancel
 *   exchanging    "Getting your key", Cancel
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../../constants/theme';
import { Banner, Button } from '../../ui';
import { Card, Caption } from '../../settings/SettingsParts';
import { providerName } from '../../../utils/assistant/providerMachine';
import { presetById } from '../../../utils/prefs/assistant';
import { Field } from './Field';
import { KeyField } from './KeyField';
import { ModelField } from './ModelField';
import { OpenRouterCodeEntry, OpenRouterSignInButton } from './OpenRouterSignIn';
import { ProviderPicker } from './ProviderPicker';
import { TestModelRow } from './TestModelRow';
import { useProviderSetup } from './useProviderSetup';

export function ProviderSection({ onExpireCards }: { onExpireCards?: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const p = useProviderSetup({ onExpireCards });
  const { state, form } = p;
  const preset = presetById(form.preset);
  const custom = preset.local;

  const sentLine = (id: string) =>
    id === 'custom' ? 'Sent to the address you entered.' : `Your questions and the downloads you ask about are sent to ${providerName(id)}.`;

  if (state.kind === 'awaitingCode' || state.kind === 'exchanging') {
    return (
      <Card>
        <View style={s.body}>
          <OpenRouterCodeEntry exchanging={state.kind === 'exchanging'} error={p.error} onSubmit={p.submitCode} onCancel={p.cancel} />
        </View>
      </Card>
    );
  }

  if (state.kind === 'ready') {
    const saved = presetById(p.saved.preset);
    return (
      <Card>
        <View style={s.body}>
          <Text style={s.title}>{saved.local ? 'Your server' : saved.label}</Text>
          <Text style={s.mono} numberOfLines={1}>
            {p.saved.model}
          </Text>
          <Caption>{sentLine(p.saved.preset)}</Caption>
          {p.error ? <Text style={s.error}>{p.error}</Text> : null}
          <View style={s.actions}>
            <Button label="Remove key" variant="danger" onPress={p.removeKey} testID="assistant-remove-key" />
            <Button label="Change" variant="secondary" onPress={p.startEdit} testID="assistant-change" />
          </View>
        </View>
      </Card>
    );
  }

  if (state.kind === 'noKey') {
    return (
      <Card>
        <View style={s.body}>
          <Text style={s.title}>Add a key to use the Assistant</Text>
          <OpenRouterSignInButton onPress={p.signIn} />
          <Button label="Use another provider or paste a key" variant="ghost" onPress={p.startEdit} fullWidth testID="assistant-paste-key" />
        </View>
      </Card>
    );
  }

  // editing, testing and invalid share the form.
  const testing = state.kind === 'testing';
  return (
    <Card>
      <View style={s.body}>
        {state.kind === 'invalid' ? <Banner tone="danger" title={state.reason} /> : null}
        <OpenRouterSignInButton onPress={p.signIn} primary={state.kind === 'invalid' || form.preset === 'openrouter'} />
        {state.kind === 'invalid' ? (
          <Button label="Fix settings" variant="ghost" onPress={p.startEdit} fullWidth testID="assistant-fix" />
        ) : (
          <>
            <ProviderPicker presets={p.presets} value={form.preset} onChange={testing ? () => {} : p.pickPreset} />
            {custom ? (
              <Field
                label="Address"
                value={form.baseUrl}
                onChangeText={(t) => p.setForm({ baseUrl: t })}
                editable={!testing}
                keyboardType="url"
                placeholder="http://192.168.1.20:11434/v1"
                caption="The address of the computer running the server. http works on your home network."
                testID="assistant-address"
              />
            ) : null}
            {custom ? null : <KeyField value={form.key} onChange={(t) => p.setForm({ key: t })} editable={!testing} />}
            <ModelField value={form.model} onChange={(t) => p.setForm({ model: t })} editable={!testing} />
            <Caption>{sentLine(form.preset)}</Caption>
            {p.error ? (
              <Text style={s.error} accessibilityLiveRegion="polite">
                {p.error}
              </Text>
            ) : null}
            <TestModelRow testing={testing} onTest={p.save} />
          </>
        )}
      </View>
    </Card>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    body: { padding: spacing.lg, gap: spacing.lg },
    title: { ...type.bodyStrong, fontSize: 15, color: c.text },
    mono: { ...type.mono, fontSize: 13, color: c.textMuted },
    error: { ...type.body, fontSize: 12, color: c.danger },
    actions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
  });
