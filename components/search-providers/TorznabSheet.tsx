import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Button, Sheet, TextField } from '../ui';
import { notices } from '../../constants/copy';

export interface TorznabDraft {
  name: string;
  url: string;
  apiKey: string;
}

function validUrl(raw: string): boolean {
  return /^https?:\/\/[^\s/]+\.?[^\s]*$/i.test(raw);
}

/** Add a Jackett or Prowlarr indexer. The API key goes to secure storage, never into prefs. */
export function TorznabSheet({
  visible,
  onClose,
  onAdd,
}: {
  visible: boolean;
  onClose: () => void;
  onAdd: (draft: TorznabDraft) => Promise<void>;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setName('');
      setUrl('');
      setApiKey('');
      setError(null);
      setBusy(false);
    }
  }, [visible]);

  const cleanUrl = url.trim().replace(/\/+$/, '');
  const ready = name.trim().length > 0 && validUrl(cleanUrl) && apiKey.trim().length > 0;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd({ name: name.trim(), url: cleanUrl, apiKey: apiKey.trim() });
    } catch {
      setError(notices.inline.apiKeyFailed);
      setBusy(false);
    }
  };

  const field = (label: string, value: string, set: (v: string) => void, extra: object, placeholder: string) => (
    <View style={styles.group}>
      <TextField
        onSurface
        label={label}
        value={value}
        onChangeText={set}
        placeholder={placeholder}
        mono
        accessibilityLabel={label}
        {...extra}
      />
    </View>
  );

  return (
    <Sheet visible={visible} onClose={onClose} title="Connect an indexer" subtitle="Jackett or Prowlarr, on your network or hosted.">
      {field('Name', name, setName, { returnKeyType: 'next' }, 'My Jackett')}
      {field('Address', url, setUrl, { keyboardType: 'url', returnKeyType: 'next', error: url.length > 0 && !validUrl(cleanUrl) ? 'The address must start with http:// or https://' : undefined }, 'http://192.168.1.20:9117/api/v2.0/indexers/all/results/torznab')}
      {field('API key', apiKey, setApiKey, { secureTextEntry: true, returnKeyType: 'done', onSubmitEditing: submit }, 'Paste from your server')}
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button label="Cancel" variant="ghost" onPress={onClose} />
        <Button label="Add" onPress={submit} disabled={!ready} loading={busy} />
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    group: { gap: spacing.xs, marginBottom: spacing.md },
    error: { ...type.body, fontSize: type.size.sm, color: c.danger, marginBottom: spacing.sm },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  });
