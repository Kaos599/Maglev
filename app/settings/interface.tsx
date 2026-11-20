import React, { useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { AccentName, AppearanceMode } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, accents, radius, spacing, touch, type } from '../../constants/theme';
import { PixelIcon } from '../../components/PixelIcon';
import { ListRow, PressableScale, RadioCard, SegmentedControl, Toggle } from '../../components/ui';
import { Card, Caption, SettingsPage } from '../../components/settings/SettingsParts';
import { FontStyle, TelemetryDensity } from 'maglev-engine';
import { fontFamilies, resolveFontStyle } from '../../constants/fontStyles';
import { fontStyleCopy, tabsCopy } from '../../constants/copy';
import { DensityThumb } from '../../components/settings/DensityThumb';
import { DensitySheet } from '../../components/settings/DensitySheet';
import { TabsSection } from '../../components/tabs/TabsSection';
import { AppIconSection } from '../../components/settings/AppIconSection';
import type { PixelIconName } from '../../components/PixelIcon';

const MODES = [
  { value: 'oled', label: 'OLED' },
  { value: 'dim', label: 'Dim' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
] as const;
// NATIVE_CONTRACT 41.3: the row's second line and its spoken label, one pair per layout.
const DENSITY_ROW: Record<TelemetryDensity, { line: string; spoken: string }> = {
  COMPACT: { line: 'Compact: speed and time left', spoken: 'Download page, Compact, speed and time left' },
  VERBOSE: { line: 'Detailed: adds amounts, connections and timing', spoken: 'Download page, Detailed, adds amounts, connections and timing' },
};
const ACCENTS: { name: AccentName; label: string }[] = [
  { name: 'lime', label: 'Lime' },
  { name: 'cyan', label: 'Cyan' },
  { name: 'pink', label: 'Pink' },
  { name: 'orange', label: 'Orange' },
  { name: 'violet', label: 'Violet' },
  { name: 'blue', label: 'Blue' },
  { name: 'amber', label: 'Amber' },
  { name: 'mint', label: 'Mint' },
];

const FONT_ICONS: Record<FontStyle, PixelIconName> = { clean: 'interface', retro: 'grid', mono: 'file' };

export default function InterfaceSettings() {
  const { settings, updateSettings } = useSettings();
  const { colors, dark } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const a = settings.appearance;
  const fontStyle = resolveFontStyle(a.fontStyle);
  const [densityOpen, setDensityOpen] = useState(false);
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
        {/* NATIVE_CONTRACT 41.3: the "Transfers" heading, then the Download page row (the old Transfer details control is gone). */}
        <Text style={s.sectionLabel} accessibilityRole="header">
          Transfers
        </Text>
        <ListRow
          title="Download page"
          subtitle={DENSITY_ROW[a.telemetryDensity].line}
          accessory={
            <View style={s.thumbWrap}>
              <DensityThumb density={a.telemetryDensity} />
              <PixelIcon name="chevron-right" size={16} color={colors.textFaint} />
            </View>
          }
          onPress={() => setDensityOpen(true)}
          accessibilityLabel={DENSITY_ROW[a.telemetryDensity].spoken}
          accessibilityHint="Opens the choice with previews"
          testID="download-page-row"
        />
        <ListRow
          title="Speed totals"
          subtitle="Shows total download and upload speed above your transfers, with Pause all."
          accessory={
            <Toggle
              value={a.showSpeedTotals}
              onValueChange={(showSpeedTotals) => set({ showSpeedTotals })}
              accessibilityLabel="Speed totals"
            />
          }
        />
        <ListRow
          title="Swipe to pause or remove"
          subtitle="Swipe a download right to pause or resume it, or left to remove it from the list. Files are kept."
          accessory={
            <Toggle
              value={a.swipeActions}
              onValueChange={(swipeActions) => set({ swipeActions })}
              accessibilityLabel="Swipe to pause or remove"
            />
          }
        />
        <ListRow
          title="Show file type icons in Transfers"
          subtitle="Show an icon for the kind of file on each download."
          accessory={
            <Toggle
              value={a.showFileIcons}
              onValueChange={(showFileIcons) => set({ showFileIcons })}
              accessibilityLabel="Show file type icons in Transfers"
            />
          }
        />
      </Card>
      {/* NATIVE_CONTRACT 41.4: tapping a card saves at once and the sheet stays open. */}
      <DensitySheet
        visible={densityOpen}
        onClose={() => setDensityOpen(false)}
        value={a.telemetryDensity}
        onChange={(telemetryDensity) => set({ telemetryDensity })}
      />
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
    sectionLabel: { ...type.bodyStrong, fontSize: type.size.base, color: c.textMuted, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.xs },
    label: { ...type.bodyStrong, fontSize: type.size.base, color: c.text },
    // Two rows of four: each item is a quarter of the row, so 8 swatches fit a 360dp screen.
    thumbWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    swatches: { flexDirection: 'row', flexWrap: 'wrap', rowGap: spacing.md },
    swatchItem: { width: '25%', alignItems: 'center', gap: spacing.xs },
    swatchLabel: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    // 44px outer target; the ring sits inside it so the swatch itself is 34px.
    swatchRing: {
      width: touch.min,
      height: touch.min,
      borderRadius: radius.md + 2, // design-exception: concentric with the 44 px swatch ring, 2 px over radius.md
      borderWidth: 2,
      borderColor: 'transparent',
      alignItems: 'center',
      justifyContent: 'center',
    },
    swatch: { width: 34, height: 34, borderRadius: radius.md - 2, alignItems: 'center', justifyContent: 'center' }, // design-exception: swatch sits inside the 2 px ring, radius is concentric (radius.md - 2)
  });
