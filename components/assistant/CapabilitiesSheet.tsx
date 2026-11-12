import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import {
  CANT_DO,
  CAN_DO,
  CAPABILITIES_NOTE,
  CAPABILITIES_TITLE,
  capabilitiesFacts,
} from '../../utils/assistant/chatView';
import { PixelIcon } from '../PixelIcon';
import { Button, Sheet } from '../ui';
import { Collapsible } from './Collapsible';

export interface CapabilitiesSheetProps {
  visible: boolean;
  onClose: () => void;
  modelName?: string;
  providerName: string;
}

/** What the Assistant can and can't do, in plain words, with the technical details folded away. Static copy only. */
export function CapabilitiesSheet({ visible, onClose, modelName, providerName }: CapabilitiesSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [techOpen, setTechOpen] = useState(false);
  const facts = useMemo(() => capabilitiesFacts({ modelName, providerName }), [modelName, providerName]);

  return (
    <Sheet visible={visible} onClose={onClose} title={CAPABILITIES_TITLE}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
        <Text style={styles.label}>It can</Text>
        {CAN_DO.map((t) => (
          <View key={t} style={styles.row}>
            <View style={styles.icon}>
              <PixelIcon name="check" size={16} color={colors.accentText} />
            </View>
            <Text style={styles.copy}>{t}</Text>
          </View>
        ))}
        <Text style={[styles.label, styles.gap]}>It can't</Text>
        {CANT_DO.map((t) => (
          <View key={t} style={styles.row}>
            <View style={styles.icon}>
              <PixelIcon name="close" size={16} color={colors.textMuted} />
            </View>
            <Text style={styles.copy}>{t}</Text>
          </View>
        ))}
        <View style={[styles.row, styles.note]}>
          <View style={styles.icon}>
            <PixelIcon name="warning" size={16} color={colors.warning} />
          </View>
          <Text style={styles.copy}>{CAPABILITIES_NOTE}</Text>
        </View>
        <Collapsible
          open={techOpen}
          onToggle={() => setTechOpen((o) => !o)}
          accessibilityLabel={techOpen ? 'Hide technical details' : 'Show technical details'}
          header={<Text style={styles.techLabel}>Technical details</Text>}
        >
          <View style={styles.tech}>
            {facts.map((f) => (
              <Text key={f} style={styles.techCopy}>
                {f}
              </Text>
            ))}
          </View>
        </Collapsible>
      </ScrollView>
      <View style={styles.footer}>
        <Button label="Got it" fullWidth onPress={onClose} />
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    scroll: { flexGrow: 0, flexShrink: 1 },
    body: { gap: spacing.md, paddingBottom: spacing.md },
    label: { ...type.bodyStrong, fontSize: 14, color: c.text },
    gap: { marginTop: spacing.sm },
    row: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
    icon: { width: 20, minHeight: 20, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    copy: { ...type.body, fontSize: 14, lineHeight: 20, color: c.text, flex: 1 },
    note: { marginTop: spacing.sm },
    techLabel: { ...type.bodyStrong, fontSize: 14, color: c.textMuted },
    tech: { gap: spacing.sm, paddingBottom: spacing.sm },
    techCopy: { ...type.body, fontSize: 13, lineHeight: 18, color: c.textMuted },
    footer: { marginTop: spacing.md },
  });
