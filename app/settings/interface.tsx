import React, { useMemo } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { AccentName, AppearanceMode, maglevEngine } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, accents, radius, spacing, type } from '../../constants/theme';
import { PixelIcon } from '../../components/PixelIcon';
import { ListRow, PressableScale, SegmentedControl } from '../../components/ui';
import { Card, Caption, SettingsPage } from '../../components/settings/SettingsParts';
import { TelemetryDensity } from 'maglev-engine';

const MODES = [
  { value: 'oled', label: 'OLED' },
  { value: 'dim', label: 'Dim' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
] as const;
const DENSITY = [
  { value: 'COMPACT', label: 'Compact' },
  { value: 'VERBOSE', label: 'Detailed' },
] as const;
const ACCENTS: { name: AccentName; label: string }[] = [
  { name: 'lime', label: 'Lime' },
  { name: 'cyan', label: 'Cyan' },
  { name: 'pink', label: 'Pink' },
  { name: 'orange', label: 'Orange' },
];

/** Live Updates (promoted notifications) exist from Android 16 (API 36). */
const LIVE_UPDATES_API = 36;

export default function InterfaceSettings() {
  const { permissionStatus, openLiveUpdateSettings } = useMaglevEngine();
  const showLiveUpdates = Platform.OS === 'android' && Number(Platform.Version) >= LIVE_UPDATES_API;
  const liveUpdatesOn = permissionStatus?.liveUpdates === 'granted';
  const { settings, updateSettings } = useSettings();
  const { colors, dark } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const a = settings.appearance;
  const set = (patch: Partial<typeof a>) => updateSettings((prev) => ({ appearance: { ...prev.appearance, ...patch } }));

  return (
    <SettingsPage title="INTERFACE">
      <Stack.Screen options={{ headerShown: false }} />
      <Card>
        <View style={s.block}>
          <Text style={s.label}>Mode</Text>
          <SegmentedControl<AppearanceMode>
            options={MODES}
            value={a.mode}
            onChange={(mode) => set({ mode })}
            accessibilityLabel="Mode"
          />
          <Caption>System follows your phone's dark or light setting.</Caption>
        </View>
        <View style={s.block}>
          <Text style={s.label}>Accent</Text>
          <View style={s.swatches} accessibilityRole="radiogroup" accessibilityLabel="Accent">
            {ACCENTS.map(({ name, label }) => {
              const selected = a.accent === name;
              const fill = dark ? accents[name].bright : accents[name].deep;
              return (
                <PressableScale
                  key={name}
                  onPress={() => !selected && set({ accent: name })}
                  accessibilityRole="radio"
                  accessibilityLabel={label}
                  accessibilityState={{ selected, checked: selected }}
                  style={s.swatchItem}
                >
                  <View style={[s.swatchRing, selected && { borderColor: colors.text }]}>
                    <View style={[s.swatch, { backgroundColor: fill }]}>
                      {selected ? <PixelIcon name="check" size={16} color={colors.onAccent} /> : null}
                    </View>
                  </View>
                  <Text style={[s.swatchLabel, selected && { color: colors.text }]}>{label}</Text>
                </PressableScale>
              );
            })}
          </View>
        </View>
        <View style={s.block}>
          <Text style={s.label}>Transfer details</Text>
          <SegmentedControl<TelemetryDensity>
            options={DENSITY}
            value={a.telemetryDensity}
            onChange={(telemetryDensity) => set({ telemetryDensity })}
            accessibilityLabel="Transfer details"
          />
        </View>
      </Card>
      {Platform.OS === 'android' ? (
        <Card>
          <ListRow
            title="Finished-download alerts"
            subtitle="Choose sound and banners in Android settings."
            onPress={() => void maglevEngine.openNotificationSettings('completed')}
            accessibilityHint="Opens Android settings"
          />
        </Card>
      ) : null}
      {showLiveUpdates ? (
        <Card>
          <ListRow
            title="Live progress in status bar"
            subtitle="Shows download progress at the top of your screen."
            value={liveUpdatesOn ? 'On' : 'Off'}
            onPress={() => void openLiveUpdateSettings()}
            accessibilityHint="Opens Android settings"
          />
        </Card>
      ) : null}
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    block: { padding: spacing.lg, gap: spacing.sm },
    label: { ...type.bodyStrong, fontSize: 14, color: c.text },
    swatches: { flexDirection: 'row', gap: spacing.sm },
    swatchItem: { minWidth: 64, alignItems: 'center', gap: 4 },
    swatchLabel: { ...type.body, fontSize: 12, color: c.textMuted },
    // 44px outer target; the ring sits inside it so the swatch itself is 34px.
    swatchRing: {
      width: 44,
      height: 44,
      borderRadius: radius.md + 2,
      borderWidth: 2,
      borderColor: 'transparent',
      alignItems: 'center',
      justifyContent: 'center',
    },
    swatch: { width: 34, height: 34, borderRadius: radius.md - 2, alignItems: 'center', justifyContent: 'center' },
  });
