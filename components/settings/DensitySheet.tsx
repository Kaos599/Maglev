import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { TelemetryDensity } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type, radius } from '../../constants/theme';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { PressableScale, SegmentedControl, Sheet } from '../ui';
import { DensityPreview, type PreviewKind } from './DensityPreview';

const KINDS = [
  { value: 'link', label: 'Link' },
  { value: 'torrent', label: 'Torrent' },
] as const;

// NATIVE_CONTRACT 41.4: the two names, their icons and their one line each.
const OPTIONS: { value: TelemetryDensity; name: string; text: string; spoken: string; icon: PixelIconName }[] = [
  { value: 'COMPACT', name: 'Compact', text: 'Speed and time left', spoken: 'Compact, speed and time left', icon: 'card-text' },
  { value: 'VERBOSE', name: 'Detailed', text: 'Adds amounts, connections and timing', spoken: 'Detailed, adds amounts, connections and timing', icon: 'grid-3x2' },
];

export interface DensitySheetProps {
  visible: boolean;
  onClose: () => void;
  value: TelemetryDensity;
  /** Saves the setting at once; the sheet stays open. */
  onChange: (value: TelemetryDensity) => void;
}

/**
 * NATIVE_CONTRACT 41.4: choose how much the download pages show, with a live-looking preview of each. The Link | Torrent
 * switch changes only the pictures. Tapping a card saves the setting at once.
 */
export function DensitySheet({ visible, onClose, value, onChange }: DensitySheetProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [kind, setKind] = useState<PreviewKind>('link');
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Download page"
      subtitle="How much you see when you tap a download in Transfers. The buttons and files are the same in both."
      testID="density-sheet"
    >
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.content}>
        <View style={s.previewRow}>
          <Text style={s.previewLabel}>Preview</Text>
          <View style={s.kindSwitch}>
            <SegmentedControl<PreviewKind> options={KINDS} value={kind} onChange={setKind} accessibilityLabel="Preview" />
          </View>
        </View>
        <View style={s.cards} accessibilityRole="radiogroup" accessibilityLabel="Download page">
          {OPTIONS.map((o) => {
            const selected = value === o.value;
            return (
              <PressableScale
                key={o.value}
                scaleTo={0.96}
                haptic={selected ? false : 'select'}
                onPress={() => !selected && onChange(o.value)}
                accessibilityRole="radio"
                accessibilityLabel={selected ? `${o.spoken}, selected` : o.spoken}
                accessibilityState={{ selected, checked: selected }}
                style={[s.card, { borderColor: selected ? colors.accent : colors.border }]}
                containerStyle={s.cardOuter}
                testID={`density-card-${o.value}`}
              >
                <DensityPreview kind={kind} density={o.value} />
                <View style={s.titleRow}>
                  <PixelIcon name={o.icon} size={16} color={selected ? colors.accentText : colors.textMuted} />
                  <Text style={s.name} numberOfLines={1}>
                    {o.name}
                  </Text>
                  {selected ? <PixelIcon name="check" size={16} color={colors.accentText} /> : null}
                </View>
                <Text style={s.desc}>{o.text}</Text>
              </PressableScale>
            );
          })}
        </View>
        {/* The footnote keeps its height while the Link preview shows, so the sheet doesn't jump. */}
        <Text
          style={[s.note, kind === 'link' && s.noteHidden]}
          accessibilityElementsHidden={kind === 'link'}
          importantForAccessibility={kind === 'link' ? 'no-hide-descendants' : 'auto'}
        >
          Detailed torrents also show upload and ratio.
        </Text>
      </ScrollView>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    content: { gap: spacing.md, paddingBottom: spacing.sm },
    previewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    previewLabel: { ...type.body, fontSize: type.size.base, color: c.textMuted },
    kindSwitch: { width: 188 },
    cards: { flexDirection: 'row', gap: spacing.sm + 2, alignItems: 'stretch' },
    cardOuter: { flex: 1, minWidth: 0 },
    card: { borderRadius: radius.lg, padding: spacing.sm, borderWidth: 1, backgroundColor: c.surface, gap: spacing.sm },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 24 },
    name: { ...type.bodyStrong, flex: 1, fontSize: type.size.xl, color: c.text },
    desc: { ...type.body, fontSize: type.size.md, lineHeight: 18, color: c.textMuted },
    note: { ...type.body, fontSize: type.size.md, color: c.textMuted },
    noteHidden: { opacity: 0 },
  });
