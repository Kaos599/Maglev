import React, { useMemo } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Button, Sheet } from '../ui';
import { listsCopy, subtitleSettingsCopy } from '../../constants/copy';
import type { SourceRow } from '../../utils/subtitleSettings';

const copy = subtitleSettingsCopy.sources;

/** Details of one subtitle source: what it matches by, its languages and its website. */
export function SourceSheet({ source, onClose }: { source: SourceRow | null; onClose: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Sheet visible={!!source} onClose={onClose} title={source?.name ?? ''}>
      {source ? (
        <View style={s.body}>
          {source.turnedOff ? (
            <Text style={[s.value, { color: colors.warning }]}>
              {source.turnedOff.note ? listsCopy.providers.turnedOffWithNote(source.turnedOff.note) : listsCopy.providers.turnedOff}
            </Text>
          ) : null}
          <Text style={s.label}>{copy.matchesBy}</Text>
          <Text style={s.value}>{source.matches}</Text>
          <Text style={s.label}>{copy.spokenLanguages}</Text>
          <Text style={s.value}>{source.languages}</Text>
          <Button label={copy.website} variant="secondary" icon="external" onPress={() => void Linking.openURL(source.homepage)} />
        </View>
      ) : null}
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    body: { gap: spacing.sm },
    label: { ...type.bodyStrong, fontSize: type.size.md, color: c.textMuted },
    value: { ...type.body, fontSize: type.size.lg, color: c.text },
  });
