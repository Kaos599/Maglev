import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { Button, Sheet } from '../ui';

export interface NewFeedSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Resolves with null on success (sheet closes) or a plain error message. */
  onSubmit: (url: string) => Promise<string | null>;
}

export function NewFeedSheet({ visible, onClose, onSubmit }: NewFeedSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) {
      setUrl('');
      setError(null);
      setBusy(false);
    }
  }, [visible]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const err = await onSubmit(url);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="New feed" subtitle="Paste the address of an RSS or Atom feed." testID="new-feed-sheet">
      <TextInput
        style={[styles.input, error ? styles.inputError : null]}
        value={url}
        onChangeText={(t) => {
          setUrl(t);
          if (error) setError(null);
        }}
        placeholder="https://example.com/feed.xml"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={submit}
        editable={!busy}
        accessibilityLabel="Feed address"
        autoFocus
      />
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button label="Cancel" variant="ghost" onPress={onClose} />
        <Button label={busy ? 'Checking' : 'Add feed'} onPress={submit} loading={busy} disabled={url.trim().length === 0} />
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    input: {
      ...type.mono,
      fontSize: 14,
      minHeight: 48,
      paddingHorizontal: spacing.lg,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.bg,
      color: c.text,
    },
    inputError: { borderColor: c.danger },
    error: { ...type.body, fontSize: 13, color: c.danger, marginTop: spacing.sm },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.lg },
  });
