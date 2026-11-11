import { useMemo } from 'react';
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useMaglevEngine } from '../context/EngineContext';
import { useTheme } from '../context/ThemeContext';
import { fonts, touch, ThemeColors } from '../constants/theme';

export const EmptyState: React.FC = () => {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
          <Ionicons name="arrow-down" size={32} color={colors.accentText} />
        </View>
        <View style={styles.trayBase} />
      </View>

      <Text style={styles.title}>No active transfers</Text>
      <Text style={styles.subtitle}>
        Add a magnet link, open a .torrent file, or search the swarm to begin downloading.
      </Text>

      {/* Auto-detect clipboard magnet link pill */}
      {clipboardMagnet && (
        <View style={styles.clipboardPill}>
          <View style={styles.clipboardInfo}>
            <Ionicons name="link" size={14} color={colors.download} />
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
          <Ionicons name="search" size={16} color={colors.text} style={{ marginRight: 6 }} />
          <Text style={styles.secondaryButtonText}>Search Torrents</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
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
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
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
    backgroundColor: colors.accent,
    borderRadius: 2,
  },
  title: {
    color: colors.text,
    fontSize: 16,
    ...fonts.monoBold,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  clipboardPill: {
    width: '100%',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.download,
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
    color: colors.download,
    fontSize: 12,
    ...fonts.monoBold,
  },
  clipboardAddBtn: {
    minHeight: touch.min,
    paddingHorizontal: 14,
    backgroundColor: colors.download,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clipboardAddText: {
    color: colors.onAccent,
    fontSize: 11,
    ...fonts.monoBold,
  },
  actionsContainer: {
    width: '100%',
    gap: 12,
  },
  primaryButton: {
    minHeight: touch.min,
    backgroundColor: colors.accent,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  primaryButtonText: {
    color: colors.onAccent,
    fontSize: 12,
    ...fonts.monoBold,
    letterSpacing: 0.5,
  },
  secondaryButton: {
    minHeight: touch.min,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  secondaryButtonText: {
    color: colors.text,
    fontSize: 12,
    ...fonts.monoBold,
    letterSpacing: 0.5,
  },
});
