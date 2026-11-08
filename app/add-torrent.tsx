import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatBytes, TOKENS } from '../constants/tokens';
import { useMaglevEngine } from '../context/EngineContext';
import { triggerHaptic } from '../constants/haptics';

interface MockFileItem {
  id: number;
  name: string;
  size: number;
  selected: boolean;
  priority: 0 | 1 | 2; // 0 = skip, 1 = normal, 2 = high
}

export default function AddTorrentSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { defaultStoragePath, startTorrent, setFilePriority } = useMaglevEngine();

  const [magnetInput, setMagnetInput] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [sequential, setSequential] = useState(false);

  // Multi-file selection mock items
  const [files, setFiles] = useState<MockFileItem[]>([
    { id: 0, name: 'ArchLinux-2026.11.01-x86_64.iso', size: 1_288_490_188, selected: true, priority: 1 },
    { id: 1, name: 'sha256sums.txt', size: 1024, selected: true, priority: 1 },
    { id: 2, name: 'release-notes.txt', size: 4096, selected: true, priority: 1 },
  ]);

  const onMagnetChange = (text: string) => {
    setMagnetInput(text);
    const match = text.match(/dn=([^&]+)/);
    if (match && match[1]) {
      const decodedName = decodeURIComponent(match[1].replace(/\+/g, ' '));
      setFiles((prev) =>
        prev.map((f) => (f.id === 0 ? { ...f, name: decodedName } : f))
      );
    }
  };

  const toggleFile = (id: number) => {
    triggerHaptic('light');
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        const nextSelected = !f.selected;
        return {
          ...f,
          selected: nextSelected,
          priority: nextSelected ? 1 : 0,
        };
      })
    );
  };

  const cyclePriority = (id: number) => {
    triggerHaptic('medium');
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        // Cycle: Normal (1) -> High (2) -> Skip (0) -> Normal (1)
        const nextPriority: 0 | 1 | 2 = f.priority === 1 ? 2 : f.priority === 2 ? 0 : 1;
        return {
          ...f,
          priority: nextPriority,
          selected: nextPriority > 0,
        };
      })
    );
  };

  const selectAll = () => {
    triggerHaptic('light');
    setFiles((prev) => prev.map((f) => ({ ...f, selected: true, priority: f.priority === 0 ? 1 : f.priority })));
  };

  const deselectAll = () => {
    triggerHaptic('light');
    setFiles((prev) => prev.map((f) => ({ ...f, selected: false, priority: 0 })));
  };

  const filterByExt = (ext: string) => {
    triggerHaptic('light');
    setFiles((prev) =>
      prev.map((f) => {
        const matches = f.name.toLowerCase().endsWith(ext);
        return {
          ...f,
          selected: matches,
          priority: matches ? 1 : 0,
        };
      })
    );
  };

  const handleStartDownload = async () => {
    triggerHaptic('medium');
    const uri = magnetInput.trim() || 'magnet:?xt=urn:btih:arch2026linux&dn=ArchLinux-2026.11.01-x86_64.iso';
    const finalPath = customPath.trim() || defaultStoragePath;
    const selectedIndices = files.filter((f) => f.selected && f.priority > 0).map((f) => f.id);
    const newId = await startTorrent(uri, finalPath, sequential, selectedIndices);
    // Apply High priorities if configured
    for (const file of files) {
      if (file.priority === 2) {
        await setFilePriority(newId, file.id, 2);
      }
    }
    router.back();
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 10 }]}>
      {/* Modal Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Add Torrent Sheet</Text>
        <TouchableOpacity
          style={styles.closeButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close sheet"
        >
          <Ionicons name="close" size={20} color={TOKENS.colors.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {/* Magnet / Torrent Input */}
        <Text style={styles.sectionLabel}>Magnet URI or Hash</Text>
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.textInput}
            placeholder="magnet:?xt=urn:btih:..."
            placeholderTextColor={TOKENS.colors.textMuted}
            value={magnetInput}
            onChangeText={onMagnetChange}
            multiline
            numberOfLines={2}
          />
          {magnetInput.length > 0 && (
            <TouchableOpacity
              style={styles.clearBtn}
              onPress={() => setMagnetInput('')}
            >
              <Ionicons name="close-circle" size={16} color={TOKENS.colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {/* Destination Path Pill */}
        <Text style={styles.sectionLabel}>Storage Destination</Text>
        <View style={styles.pathPill}>
          <View style={styles.pathTextContainer}>
            <Ionicons name="folder-outline" size={16} color={TOKENS.colors.accentLime} />
            {isEditingPath ? (
              <TextInput
                style={styles.pathInput}
                value={customPath || defaultStoragePath}
                onChangeText={setCustomPath}
                autoFocus
                onBlur={() => setIsEditingPath(false)}
              />
            ) : (
              <Text style={styles.pathText} numberOfLines={1}>
                {customPath || defaultStoragePath}
              </Text>
            )}
          </View>
          <TouchableOpacity
            style={styles.changePathBtn}
            onPress={() => setIsEditingPath(!isEditingPath)}
            accessibilityRole="button"
            accessibilityLabel="Change destination storage path"
          >
            <Text style={styles.changePathText}>
              {isEditingPath ? 'DONE' : 'CHANGE'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* Batch File Controls */}
        <View style={styles.filesHeaderRow}>
          <Text style={styles.sectionLabel}>Files & Contents</Text>
          <View style={styles.batchControls}>
            <TouchableOpacity
              style={styles.batchBtn}
              onPress={selectAll}
              accessibilityRole="button"
              accessibilityLabel="Select all files"
            >
              <Text style={styles.batchBtnText}>Select All</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.batchBtn}
              onPress={deselectAll}
              accessibilityRole="button"
              accessibilityLabel="Deselect all files"
            >
              <Text style={styles.batchBtnText}>Deselect</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.batchBtnChip}
              onPress={() => filterByExt('.iso')}
            >
              <Text style={styles.batchBtnChipText}>.iso</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Files Checklist */}
        <View style={styles.filesList}>
          {files.map((file) => (
            <TouchableOpacity
              key={file.id}
              style={styles.fileRow}
              onPress={() => toggleFile(file.id)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: file.selected }}
            >
              <View
                style={[
                  styles.checkbox,
                  file.selected ? styles.checkboxSelected : styles.checkboxUnselected,
                ]}
              >
                {file.selected && <Text style={styles.checkmark}>✕</Text>}
              </View>
              <View style={styles.fileInfo}>
                <Text
                  style={[
                    styles.fileName,
                    (!file.selected || file.priority === 0) && styles.fileNameDisabled,
                  ]}
                  numberOfLines={1}
                >
                  {file.name}
                </Text>
                <Text style={styles.fileSize}>{formatBytes(file.size)}</Text>
              </View>
              <TouchableOpacity
                style={[
                  styles.priorityBtn,
                  file.priority === 2 && styles.priorityBtnHigh,
                  file.priority === 0 && styles.priorityBtnSkip,
                ]}
                onPress={() => cyclePriority(file.id)}
                accessibilityRole="button"
                accessibilityLabel={`Cycle priority for ${file.name}. Current: ${file.priority === 2 ? 'High' : file.priority === 1 ? 'Normal' : 'Skip'}`}
              >
                <Text
                  style={[
                    styles.priorityBtnText,
                    file.priority === 2 && styles.priorityBtnTextHigh,
                    file.priority === 0 && styles.priorityBtnTextSkip,
                  ]}
                >
                  {file.priority === 2 ? 'HIGH' : file.priority === 1 ? 'NORMAL' : 'SKIP'}
                </Text>
              </TouchableOpacity>
            </TouchableOpacity>
          ))}
        </View>

        {/* Sequential Stream Toggle */}
        <View style={styles.toggleRow}>
          <View style={styles.toggleTextContainer}>
            <Text style={styles.toggleTitle}>Sequential Download</Text>
            <Text style={styles.toggleSubtitle}>
              Prioritize head pieces for immediate video streaming
            </Text>
          </View>
          <Switch
            value={sequential}
            onValueChange={setSequential}
            trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
            thumbColor={sequential ? '#000000' : TOKENS.colors.textMuted}
          />
        </View>
      </ScrollView>

      {/* Start Action CTA Button (min-44px touch target) */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={styles.startBtn}
          onPress={handleStartDownload}
          accessibilityRole="button"
          accessibilityLabel="Start downloading torrent"
        >
          <Text style={styles.startBtnText}>START DOWNLOAD</Text>
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
  header: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: TOKENS.colors.surfaceBorder,
  },
  headerTitle: {
    color: TOKENS.colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  closeButton: {
    minWidth: TOKENS.touchTarget.minWidth,
    minHeight: TOKENS.touchTarget.minHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 24,
  },
  sectionLabel: {
    color: TOKENS.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 20,
  },
  textInput: {
    flex: 1,
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
    fontFamily: 'monospace',
    minHeight: 44,
  },
  clearBtn: {
    padding: 6,
  },
  pathPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 20,
  },
  pathTextContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginRight: 8,
  },
  pathText: {
    color: TOKENS.colors.textPrimary,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  pathInput: {
    flex: 1,
    color: TOKENS.colors.textPrimary,
    fontSize: 11,
    fontFamily: 'monospace',
    padding: 0,
  },
  changePathBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: TOKENS.colors.surfacePill,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
  },
  changePathText: {
    color: TOKENS.colors.accentLime,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  filesHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  batchControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  batchBtn: {
    minHeight: 32,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: TOKENS.colors.surfacePill,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
  },
  batchBtnText: {
    color: TOKENS.colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  batchBtnChip: {
    minHeight: 32,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(204, 255, 0, 0.1)',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(204, 255, 0, 0.4)',
  },
  batchBtnChipText: {
    color: TOKENS.colors.accentLime,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  filesList: {
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 20,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: TOKENS.colors.surfaceBorder,
    minHeight: TOKENS.touchTarget.minHeight,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  checkboxSelected: {
    backgroundColor: TOKENS.colors.accentLime,
  },
  checkboxUnselected: {
    backgroundColor: '#161B22',
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
  },
  checkmark: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '900',
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
    fontFamily: 'monospace',
    marginBottom: 2,
  },
  fileNameDisabled: {
    color: TOKENS.colors.textMuted,
    textDecorationLine: 'line-through',
    opacity: 0.6,
  },
  fileSize: {
    color: TOKENS.colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  priorityBtn: {
    minWidth: 56,
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    backgroundColor: TOKENS.colors.surfacePill,
    marginLeft: 8,
  },
  priorityBtnHigh: {
    borderColor: TOKENS.colors.accentLime,
    backgroundColor: 'rgba(204, 255, 0, 0.1)',
  },
  priorityBtnSkip: {
    borderColor: TOKENS.colors.statusDanger,
    backgroundColor: 'rgba(255, 51, 102, 0.1)',
  },
  priorityBtnText: {
    color: TOKENS.colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  priorityBtnTextHigh: {
    color: TOKENS.colors.accentLime,
  },
  priorityBtnTextSkip: {
    color: TOKENS.colors.statusDanger,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 20,
  },
  toggleTextContainer: {
    flex: 1,
    marginRight: 12,
  },
  toggleTitle: {
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginBottom: 2,
  },
  toggleSubtitle: {
    color: TOKENS.colors.textMuted,
    fontSize: 10,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  startBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startBtnText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 1,
  },
});
