import React, { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useSettings } from '../../context/SettingsContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Button, Sheet } from '../ui';
import { useListsVersion } from '../../utils/lists/hooks';
import { listSubtitleEntries } from '../../utils/lists';
import { enabledProviders } from '../../utils/subtitles/providers';
import { acceptPrivacy, needsPrivacyNotice } from '../../utils/subtitles/prefs';
import { NOTICE_CONTINUE, NOTICE_NOT_NOW, SHEET_TITLE, privacyNotice } from '../../utils/subtitles/copy';

/**
 * NATIVE_CONTRACT 44.15 D10: the one-time privacy notice, shown when the user opts in (the Settings auto switch, the
 * Add screen's Auto switch, the first Get subtitles tap, or "Review" on a held request). It is the same text and the
 * same two buttons the single sheet shows. Until Continue, `require` does not call back and no request is created.
 * `more` is written together with the accept, as one functional update.
 */
export function useSubtitleConsent(): {
  needsOk: boolean;
  require: (onOk: () => void, more?: { autoNewVideos?: boolean }) => void;
  node: ReactNode;
} {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { settings, updateSettings } = useSettings();
  const listsVersion = useListsVersion();
  const [open, setOpen] = useState(false);
  const pending = useRef<{ onOk: () => void; more?: { autoNewVideos?: boolean } } | null>(null);
  const sub = settings.subtitles;
  const needsOk = needsPrivacyNotice(sub);
  const names = useMemo(
    () => enabledProviders(sub, listSubtitleEntries()).map((p) => p.name),
    // The signed list can change without the settings changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sub, listsVersion],
  );

  const require = useCallback(
    (onOk: () => void, more?: { autoNewVideos?: boolean }) => {
      if (!needsOk) {
        onOk();
        return;
      }
      pending.current = { onOk, more };
      setOpen(true);
    },
    [needsOk],
  );

  const close = () => {
    pending.current = null;
    setOpen(false);
  };
  const accept = () => {
    const p = pending.current;
    pending.current = null;
    setOpen(false);
    updateSettings(acceptPrivacy(p?.more));
    p?.onOk();
  };

  const node = (
    <Sheet visible={open} onClose={close} title={SHEET_TITLE} testID="subtitle-consent-sheet">
      <View style={styles.stack}>
        <Text style={styles.body}>{privacyNotice(names)}</Text>
        <Button label={NOTICE_CONTINUE} fullWidth onPress={accept} />
        <Button label={NOTICE_NOT_NOW} variant="ghost" fullWidth onPress={close} />
      </View>
    </Sheet>
  );
  return { needsOk, require, node };
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    stack: { gap: spacing.sm },
    body: { ...type.body, fontSize: type.size.lg, color: c.text },
  });
