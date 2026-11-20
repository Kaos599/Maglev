import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { Button } from '../ui';
import { StatGrid } from './StatGrid';
import { whyCopy, type WhyModel } from '../../utils/downloadCopy';

export interface WhyStuckProps {
  model: WhyModel;
  /** "Ask trackers again" (torrent page): the page's own handler, the same one the menu item uses. */
  onAskTrackers?: () => void;
  /** Whole seconds until asking again is allowed, or 0. */
  retryInSecs?: number;
  /** The reannounce call is possible at all (the torrent is not checking, moving or paused). */
  canAsk?: boolean;
}

/**
 * NATIVE_CONTRACT 43.4 / 43.5: why a download is not moving, with the numbers and, for a torrent, one thing to try.
 * A surface card like the page's others: 1 px hairline border, no coloured edge. The caller decides when it shows;
 * it goes away as soon as data flows.
 */
export function WhyStuck({ model, onAskTrackers, retryInSecs = 0, canAsk = true }: WhyStuckProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const waiting = retryInSecs > 0;
  return (
    <View style={styles.card} testID="why-stuck">
      <Text style={styles.title} accessibilityRole="header">
        {model.title}
      </Text>
      <Text style={styles.body}>{model.sentence}</Text>
      {model.note ? <Text style={styles.note}>{model.note}</Text> : null}
      <StatGrid stats={model.stats} columns={2} />
      {model.askTrackers && onAskTrackers ? (
        <Button
          label={waiting ? whyCopy.askedWait(retryInSecs) : whyCopy.askTrackers}
          icon="reannounce"
          variant="secondary"
          fullWidth
          disabled={waiting || !canAsk}
          onPress={onAskTrackers}
          testID="why-ask-trackers"
        />
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      padding: spacing.lg,
      marginBottom: spacing.md,
      gap: spacing.md,
    },
    title: { ...type.heading, fontSize: type.size.md, color: c.text },
    body: { ...type.body, fontSize: type.size.base, color: c.text },
    note: { ...type.body, fontSize: type.size.md, color: c.textMuted },
  });
