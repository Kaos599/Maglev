import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { TOKENS } from '../../constants/tokens';
import { HeaderBar } from '../../components/HeaderBar';

export default function FeedsScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <HeaderBar />

      <View style={styles.content}>
        <View style={styles.iconCircle}>
          <Ionicons name="radio-outline" size={40} color={TOKENS.colors.accentLime} />
        </View>

        <Text style={styles.title}>Automated Feeds</Text>
        <Text style={styles.subtitle}>
          Subscribe to RSS and Atom feeds for periodic episode downloads and smart regex-filtered releases.
        </Text>

        <TouchableOpacity
          style={styles.addFeedButton}
          accessibilityRole="button"
          accessibilityLabel="Add Feed"
        >
          <Text style={styles.addFeedButtonText}>+ Add RSS Feed</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: TOKENS.colors.bgOled,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 16,
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: {
    color: TOKENS.colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginBottom: 8,
  },
  subtitle: {
    color: TOKENS.colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 24,
  },
  addFeedButton: {
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.accentLime,
    borderRadius: 10,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addFeedButtonText: {
    color: TOKENS.colors.accentLime,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
});
