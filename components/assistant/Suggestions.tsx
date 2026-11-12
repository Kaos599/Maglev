import React, { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../constants/theme';
import { SUGGESTIONS } from '../../utils/assistant/chatView';
import { Chip } from '../ui';

/** One-tap prompts for the empty chat, after AI Elements' Suggestion. Tapping one sends it. */
export const Suggestions = memo(function Suggestions({ onPick }: { onPick: (text: string) => void }) {
  return (
    <View style={styles.wrap}>
      {SUGGESTIONS.map((s) => (
        <Chip key={s} label={s} onPress={() => onPick(s)} />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({ wrap: { gap: spacing.sm, alignItems: 'flex-start' } });
