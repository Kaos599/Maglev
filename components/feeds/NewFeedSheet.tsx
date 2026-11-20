import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing } from '../../constants/theme';
import { Button, Sheet, TextField } from '../ui';

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
      <TextField
        onSurface
        value={url}
        onChangeText={(t) => {
          setUrl(t);
          if (error) setError(null);
        }}
        placeholder="https://example.com/feed.xml"
        mono
        size="lg"
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={submit}
        editable={!busy}
        error={error ?? undefined}
        accessibilityLabel="Feed address"
        autoFocus
      />
      <View style={styles.actions}>
        <Button label="Cancel" variant="ghost" onPress={onClose} />
        <Button label={busy ? 'Checking' : 'Add feed'} onPress={submit} loading={busy} disabled={url.trim().length === 0} />
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.lg },
  });
