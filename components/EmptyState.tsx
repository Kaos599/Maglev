import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { TOKENS } from '../constants/tokens';
import { useMaglevEngine } from '../context/EngineContext';

export const EmptyState: React.FC = () => {
  const router = useRouter();
  const { clipboardMagnet, startTorrent, clearClipboardMagnet } = useMaglevEngine();

  const handleAddClipboardMagnet = async () => {
    if (clipboardMagnet) {
      await startTorrent(clipboardMagnet);
      clearClipboardMagnet();
    }
  };

  return (
    <View style={styles.container}>
      {/* 8-bit Cyber-retro Tray Icon */}
      <View style={styles.iconTray}>
        <View style={styles.trayArrow}>
          <Ionicons name="arrow-down" size={32} color={TOKENS.colors.accentLime} />
        </View>
        <View style={styles.trayBase} />
      </View>

      <Text style={styles.title}>No active transfers</Text>
      <Text style={styles.subtitle}>
        Add a magnet link, open a .torrent file, or search for torrents to begin downloading.
      </Text>

      {/* Auto-detect clipboard magnet link pill */}
      {clipboardMagnet && (
        <View style={styles.clipboardPill}>
          <View style={styles.clipboardInfo}>
            <Ionicons name="link" size={14} color={TOKENS.colors.accentCyan} />
            <Text style={styles.clipboardText} numberOfLines={1}>
              Magnet Link Detected
            </Text>
          </View>
          <TouchableOpacity
            style={styles.clipboardAddBtn}
            onPress={handleAddClipboardMagnet}
            accessibilityRole="button"
            accessibilityLabel="Add detected magnet link"
          >
            <Text style={styles.clipboardAddText}>+ Add</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Direct Action Buttons (min 44px touch targets) */}
      <View style={styles.actionsContainer}>
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => router.push('/add-torrent')}
          accessibilityRole="button"
          accessibilityLabel="Add Torrent"
        >
          <Text style={styles.primaryButtonText}>+ Add Torrent</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={() => router.push('/search')}
          accessibilityRole="button"
          accessibilityLabel="Search Torrents"
        >
          <Ionicons name="search" size={16} color={TOKENS.colors.textPrimary} style={{ marginRight: 6 }} />
          <Text style={styles.secondaryButtonText}>Search Torrents</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  iconTray: {
    width: 72,
    height: 72,
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  trayArrow: {
    marginBottom: 4,
  },
  trayBase: {
    width: 32,
    height: 4,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 2,
  },
  title: {
    color: TOKENS.colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    color: TOKENS.colors.textMuted,
    fontSize: TOKENS.typography.uiCopy.fontSize,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  clipboardPill: {
    width: '100%',
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.accentCyan,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 24,
  },
  clipboardInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginRight: 8,
  },
  clipboardText: {
    color: TOKENS.colors.accentCyan,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  clipboardAddBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 14,
    backgroundColor: TOKENS.colors.accentCyan,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clipboardAddText: {
    color: '#000000',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  actionsContainer: {
    width: '100%',
    gap: 12,
  },
  primaryButton: {
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  primaryButtonText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 0.5,
  },
  secondaryButton: {
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  secondaryButtonText: {
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 0.5,
  },
});
