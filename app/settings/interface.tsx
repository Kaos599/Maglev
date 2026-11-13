import React, { useMemo } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { AccentName, AppearanceMode } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, accents, radius, spacing, type } from '../../constants/theme';
import { PixelIcon } from '../../components/PixelIcon';
import { PressableScale, RadioCard, SegmentedControl } from '../../components/ui';
import { Card, Caption, SettingsPage } from '../../components/settings/SettingsParts';
import { FontStyle, TelemetryDensity } from 'maglev-engine';
import { fontFamilies, resolveFontStyle } from '../../constants/fontStyles';
import { fontStyleCopy, tabsCopy } from '../../constants/copy';
import { TabsSection } from '../../components/tabs/TabsSection';
import { AppIconSection } from '../../components/settings/AppIconSection';
import type { PixelIconName } from '../../components/PixelIcon';

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

const FONT_ICONS: Record<FontStyle, PixelIconName> = { clean: 'interface', retro: 'grid', mono: 'file' };

export default function InterfaceSettings() {
  const { settings, updateSettings } = useSettings();
  const { colors, dark } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const a = settings.appearance;
  const fontStyle = resolveFontStyle(a.fontStyle);
  const set = (patch: Partial<typeof a>) => updateSettings((prev) => ({ appearance: { ...prev.appearance, ...patch } }));

  return (
    <SettingsPage title="Appearance">
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
        <View style={s.block} accessibilityRole="radiogroup" accessibilityLabel={fontStyleCopy.label}>
          <Text style={s.label}>{fontStyleCopy.label}</Text>
          {fontStyleCopy.options.map((o) => {
            const fonts = fontFamilies[o.value];
            return (
              <RadioCard
                key={o.value}
                title={o.title}
                icon={FONT_ICONS[o.value]}
                selected={fontStyle === o.value}
                onPress={() => fontStyle !== o.value && set({ fontStyle: o.value })}
                accessibilityLabel={`${o.title}. ${o.description}`}
                description={
                  <>
                    {o.description}
                    {'\n'}
                    <Text style={{ fontFamily: fonts.mono, fontVariant: ['tabular-nums'], color: colors.text }}>
                      {fontStyleCopy.sampleName} · {fontStyleCopy.sampleSize}
                    </Text>
                  </>
                }
              />
            );
          })}
          <Caption>{fontStyleCopy.hint}</Caption>
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
      <Card>
        <View style={s.block}>
          <Text style={s.label}>{tabsCopy.label}</Text>
        </View>
        <TabsSection />
      </Card>
      {Platform.OS === 'android' ? (
        <Card>
          <AppIconSection />
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
