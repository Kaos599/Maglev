import React, { useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useSettings } from '../../context/SettingsContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { Toggle } from '../ui';
import { useSubtitleAvailability } from '../subtitles/useSubtitleEntry';
import { useSubtitleConsent } from '../subtitles/useSubtitleConsent';

/**
 * The Subtitles row on the Add screens (docs/NATIVE_CONTRACT.md 44.5 and 44.12). Shown only for a video, with the Subtitles
 * master switch on and at least one source on. It starts at the Settings switch and changes for this add only.
 */
export function useSubtitlesAuto(isVideo: boolean): {
  show: boolean;
  on: boolean;
  setOn: (v: boolean) => void;
  /** The Settings switch is on (44.15 D4: an Add screen with its switch off then writes a "not this one" mark). */
  settingsOn: boolean;
  /** The one-time notice sheet (44.15 D10); render it once on the screen. */
  node: ReactNode;
} {
  const { settings } = useSettings();
  const avail = useSubtitleAvailability();
  const consent = useSubtitleConsent();
  const [override, setOverride] = useState<boolean | null>(null);
  const show = isVideo && avail.master && avail.sourcesOn > 0;
  const settingsOn = settings.subtitles.autoNewVideos;
  // Without the one-time OK nothing is on by default (old data with the switch on but never accepted).
  const on = override ?? (settingsOn && !consent.needsOk);
  // 44.15 D10: turning Auto on asks for the OK first; it stays off until Continue.
  const setOn = (v: boolean) => {
    if (v) consent.require(() => setOverride(true));
    else setOverride(false);
  };
  return { show, on, setOn, settingsOn, node: consent.node };
}

export function SubtitlesAutoRow({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.label}>Subtitles</Text>
        <Text style={styles.note}>In your languages, once it starts</Text>
      </View>
      <Text style={styles.value}>Auto</Text>
      <Toggle value={on} onValueChange={onChange} disabled={disabled} accessibilityLabel="Get subtitles automatically" />
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius.md, padding: spacing.md, minHeight: touch.min },
    text: { flex: 1 },
    label: { ...type.bodyStrong, fontSize: type.size.lg, color: c.text },
    note: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    value: { ...type.body, fontSize: type.size.md, color: c.textMuted },
  });
