import React, { useMemo } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { explain, type TokenKey } from '../../utils/assistant/glossary';
import { Button } from '../ui';

export interface JargonSheetProps {
  /** The glossary key to explain, or null when closed. */
  termKey: TokenKey | null;
  onClose: () => void;
}

/**
 * Bottom sheet for one glossary term: the term in Space Mono, other names, plain sentences, the phone advice.
 * Reads the static glossary only. It never calls the model.
 * Built on Modal like components/ui/Sheet.tsx, because Sheet cannot set the title in Space Mono.
 */
export function JargonSheet({ termKey, onClose }: JargonSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const entry = termKey ? explain(termKey) : undefined;

  return (
    <Modal visible={!!entry} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <View style={styles.fill}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        {entry ? (
          <View
            accessibilityViewIsModal
            style={[styles.sheet, { maxHeight: height * 0.85, paddingBottom: Math.max(insets.bottom, spacing.lg) }]}
          >
            <View style={styles.grabber} />
            <Text style={styles.term} accessibilityRole="header">
              {entry.label}
            </Text>
            {entry.aka && entry.aka.length > 0 ? <Text style={styles.aka}>Also called {entry.aka.join(', ')}</Text> : null}
            <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
              <Text style={styles.copy}>{entry.plain}</Text>
              {entry.tradeoff ? <Text style={styles.copy}>{entry.tradeoff}</Text> : null}
              {entry.phoneNote ? (
                <Text style={styles.copy}>
                  <Text style={styles.phoneLabel}>On your phone: </Text>
                  {entry.phoneNote}
                </Text>
              ) : null}
            </ScrollView>
            <Button label="Close" variant="secondary" fullWidth onPress={onClose} />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFill, backgroundColor: c.overlay },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: c.border,
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.sm,
    },
    grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: c.borderStrong, marginBottom: spacing.lg },
    term: { ...type.monoBold, fontSize: 20, color: c.text },
    aka: { ...type.mono, fontSize: type.size.sm, color: c.textMuted, marginTop: spacing.xs },
    scroll: { flexGrow: 0, marginTop: spacing.lg },
    body: { gap: spacing.md, paddingBottom: spacing.lg },
    copy: { ...type.body, fontSize: 14, lineHeight: 20, color: c.text },
    phoneLabel: { ...type.bodyStrong, color: c.accentText },
  });
