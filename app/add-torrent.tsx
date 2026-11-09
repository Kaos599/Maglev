import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Switch,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { formatBytes, TOKENS } from '../constants/tokens';
import { useMaglevEngine } from '../context/EngineContext';
import { triggerHaptic } from '../constants/haptics';
import {
  ParsedTorrentFile,
  parseTorrentData,
  resolveMagnetMetadata,
  parseMagnetUri,
} from '../utils/torrentMetadata';
import { checkMaglevPermissions, requestMaglevPermissions } from '../utils/permissions';

export default function AddTorrentSheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const searchParams = useLocalSearchParams<{ uri?: string; magnet?: string }>();
  const { defaultStoragePath, startTorrent, setFilePriority } = useMaglevEngine();

  const [magnetInput, setMagnetInput] = useState('');
  const [customPath, setCustomPath] = useState('');
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [sequential, setSequential] = useState(false);
  const [freeDiskBytes, setFreeDiskBytes] = useState<number>(51_539_607_552); // Default 48 GB fallback

  // Metadata Resolution States
  const [isResolving, setIsResolving] = useState(false);
  const [resolvedName, setResolvedName] = useState<string>('');
  const [infoHash, setInfoHash] = useState<string>('');
  const [trackerCount, setTrackerCount] = useState<number>(0);
  const [isPendingSwarm, setIsPendingSwarm] = useState(false);

  /* Payload files state */
  const [files, setFiles] = useState<ParsedTorrentFile[]>([]);
  const resolveDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Initial Disk Free Space & Incoming Magnet Detection
  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const free = await FileSystem.getFreeDiskStorageAsync();
        if (isMounted && typeof free === 'number' && free > 0) {
          setFreeDiskBytes(free);
        }
      } catch {
        // Fallback disk query
      }
    })();

    // Handle incoming search or clipboard param
    const incomingUri = searchParams.uri || searchParams.magnet;
    if (incomingUri && typeof incomingUri === 'string') {
      onMagnetChange(incomingUri);
    }

    return () => {
      isMounted = false;
      if (resolveDebounceRef.current) {
        clearTimeout(resolveDebounceRef.current);
      }
    };
  }, [searchParams]);

  const handleResolveMagnet = useCallback(async (uri: string) => {
    const trimmed = uri.trim();
    if (!trimmed.startsWith('magnet:?xt=')) return;

    setIsResolving(true);
    triggerHaptic('light');

    try {
      const parsed = parseMagnetUri(trimmed);
      setInfoHash(parsed.infoHash);
      setResolvedName(parsed.name);
      setTrackerCount(parsed.trackers.length);

      const metadata = await resolveMagnetMetadata(trimmed);
      setInfoHash(metadata.infoHash);
      setResolvedName(metadata.name);
      setTrackerCount(metadata.trackers.length);
      setIsPendingSwarm(metadata.isPendingSwarm);

      if (metadata.files && metadata.files.length > 0) {
        setFiles(metadata.files);
      } else {
        setFiles([
          {
            id: 0,
            name: metadata.name || 'Transfer Payload',
            path: metadata.name || 'Transfer Payload',
            size: metadata.totalSize || 1_073_741_824,
            selected: true,
            priority: 1,
          },
        ]);
      }
      triggerHaptic('medium');
    } catch (err) {
      // Resolution fallback
      const parsed = parseMagnetUri(trimmed);
      setFiles([
        {
          id: 0,
          name: parsed.name || 'Transfer Payload',
          path: parsed.name || 'Transfer Payload',
          size: parsed.exactLength || 1_073_741_824,
          selected: true,
          priority: 1,
        },
      ]);
    } finally {
      setIsResolving(false);
    }
  }, []);

  const onMagnetChange = (text: string) => {
    let effectiveText = text.trim();
    if (/^[a-fA-F0-9]{40}$/.test(effectiveText) || /^[2-7a-zA-Z]{32}$/.test(effectiveText)) {
      effectiveText = `magnet:?xt=urn:btih:${effectiveText}`;
    }
    setMagnetInput(effectiveText);

    if (resolveDebounceRef.current) {
      clearTimeout(resolveDebounceRef.current);
    }

    if (effectiveText.startsWith('magnet:?xt=')) {
      const quickParsed = parseMagnetUri(effectiveText);
      setInfoHash(quickParsed.infoHash);
      setResolvedName(quickParsed.name);
      setTrackerCount(quickParsed.trackers.length);

      // Debounce network probe for cache metadata
      resolveDebounceRef.current = setTimeout(() => {
        handleResolveMagnet(effectiveText);
      }, 400);
    } else {
      setFiles([]);
      setResolvedName('');
      setInfoHash('');
      setTrackerCount(0);
      setIsPendingSwarm(false);
    }
  };

  const handleBrowseTorrentFile = async () => {
    triggerHaptic('light');
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['*/*', 'application/x-bittorrent'],
        copyToCacheDirectory: true,
      });

      if (!res.canceled && res.assets && res.assets.length > 0) {
        const asset = res.assets[0];
        setIsResolving(true);

        try {
          // Read actual bytes from local file
          const base64 = await FileSystem.readAsStringAsync(asset.uri, {
            encoding: FileSystem.EncodingType.Base64,
          });

          const binaryStr = atob(base64);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }

          const parsed = parseTorrentData(bytes);
          setMagnetInput(`file://${asset.uri}`);
          setResolvedName(parsed.name);
          setFiles(parsed.files);
          setTrackerCount(parsed.trackers.length);
          setIsPendingSwarm(false);
          triggerHaptic('medium');
        } catch (readErr) {
          Alert.alert(
            'Invalid Torrent File',
            'The selected file could not be parsed as a valid BitTorrent file.'
          );
          setFiles([]);
          setResolvedName('');
          setInfoHash('');
        } finally {
          setIsResolving(false);
        }
      }
    } catch {
      // User cancelled
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
    setFiles((prev) =>
      prev.map((f) => ({ ...f, selected: true, priority: f.priority === 0 ? 1 : f.priority }))
    );
  };

  const deselectAll = () => {
    triggerHaptic('light');
    setFiles((prev) => prev.map((f) => ({ ...f, selected: false, priority: 0 })));
  };

  const filterByExt = (ext: string) => {
    triggerHaptic('light');
    setFiles((prev) =>
      prev.map((f) => {
        const matches = f.name.toLowerCase().endsWith(ext.toLowerCase());
        return {
          ...f,
          selected: matches,
          priority: matches ? 1 : 0,
        };
      })
    );
  };

  const selectedPayloadBytes = files
    .filter((f) => f.selected && f.priority > 0)
    .reduce((acc, f) => acc + f.size, 0);

  const SAFETY_BUFFER_BYTES = 250 * 1024 * 1024; // 250 MB OS headroom
  const hasEnoughSpace = freeDiskBytes >= selectedPayloadBytes + SAFETY_BUFFER_BYTES;
  const storageDeficitBytes = Math.max(0, selectedPayloadBytes + SAFETY_BUFFER_BYTES - freeDiskBytes);

  const handleStartDownload = async () => {
    triggerHaptic('medium');

    const uri = magnetInput.trim();
    if (!uri) {
      Alert.alert('Missing Magnet Link', 'Please enter a magnet link or select a .torrent file.');
      return;
    }

    // Check disk storage space before proceeding
    if (!hasEnoughSpace) {
      Alert.alert(
        'Insufficient Disk Storage',
        `This payload requires ${formatBytes(selectedPayloadBytes)}, but only ${formatBytes(
          freeDiskBytes
        )} is free on device. Deficit: ${formatBytes(storageDeficitBytes)}. Please free up disk space first.`
      );
      return;
    }

    try {
      // Check Android permissions
      const permStatus = await checkMaglevPermissions();
      if (!permStatus.isPermissionGranted) {
        const granted = await requestMaglevPermissions();
        if (!granted) {
          Alert.alert(
            'Permissions Required',
            'Maglev requires storage and notification permissions to manage torrent transfers. Please enable them in device settings.'
          );
          return;
        }
      }

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
    } catch (err: any) {
      Alert.alert('Transfer Start Failed', err?.message || 'Could not initiate torrent download.');
    }
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
              onPress={() => onMagnetChange('')}
              accessibilityRole="button"
              accessibilityLabel="Clear magnet link"
            >
              <Ionicons name="close-circle" size={16} color={TOKENS.colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {/* Browse .torrent file button */}
        <View style={styles.browseFileRow}>
          <TouchableOpacity
            style={styles.browseFileBtn}
            onPress={handleBrowseTorrentFile}
            accessibilityRole="button"
            accessibilityLabel="Browse .torrent file from local storage"
            activeOpacity={0.8}
          >
            <Ionicons name="document-attach-outline" size={16} color={TOKENS.colors.accentCyan} />
            <Text style={styles.browseFileText}>BROWSE .TORRENT FILE</Text>
          </TouchableOpacity>
        </View>

        {/* Live Swarm Metadata Resolution Banner */}
        {isResolving && (
          <View style={styles.metadataResolvingCard}>
            <ActivityIndicator size="small" color={TOKENS.colors.accentLime} />
            <View style={styles.resolvingTextCol}>
              <Text style={styles.resolvingTitle}>SCANNING SWARM METADATA...</Text>
              <Text style={styles.resolvingSubtitle}>
                {infoHash ? `Hash: ${infoHash.slice(0, 16)}... • Querying caches & DHT` : 'Reading torrent dictionary'}
              </Text>
            </View>
          </View>
        )}

        {/* Resolved Torrent HUD */}
        {resolvedName.length > 0 && !isResolving && (
          <View style={styles.resolvedHudCard}>
            <View style={styles.resolvedHeaderRow}>
              <View style={styles.resolvedDot} />
              <Text style={styles.resolvedNameText} numberOfLines={1}>
                {resolvedName}
              </Text>
            </View>
            <View style={styles.resolvedMetaRow}>
              {infoHash ? (
                <Text style={styles.resolvedHashText}>
                  HASH: {infoHash.slice(0, 12)}...
                </Text>
              ) : null}
              <Text style={styles.resolvedTrackerText}>
                {trackerCount > 0 ? `${trackerCount} TRACKERS FOUND` : 'DHT SWARM DISCOVERY'}
              </Text>
              {isPendingSwarm && (
                <Text style={styles.resolvedPendingBadge}>METADATA RESOLVING</Text>
              )}
            </View>
          </View>
        )}

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

        {/* Storage Space Allocation HUD */}
        <View style={styles.storageHudCard}>
          <View style={styles.storageHudHeader}>
            <View style={styles.storageHudItem}>
              <Text style={styles.storageHudLabel}>PAYLOAD SIZE</Text>
              <Text style={styles.storageHudValueLime}>{formatBytes(selectedPayloadBytes)}</Text>
            </View>
            <View style={styles.storageHudDivider} />
            <View style={styles.storageHudItem}>
              <Text style={styles.storageHudLabel}>FREE DISK SPACE</Text>
              <Text style={styles.storageHudValueCyan}>{formatBytes(freeDiskBytes)}</Text>
            </View>
          </View>

          <View style={styles.storageTrack}>
            <View
              style={[
                styles.storageFill,
                {
                  width: `${Math.min(100, Math.max(3, (selectedPayloadBytes / (freeDiskBytes || 1)) * 100))}%`,
                  backgroundColor: hasEnoughSpace ? TOKENS.colors.accentCyan : '#FF3366',
                },
              ]}
            />
          </View>

          {!hasEnoughSpace ? (
            <View style={styles.storageAlertBox}>
              <Ionicons name="warning-outline" size={14} color="#FF3366" />
              <Text style={styles.storageAlertText}>
                {`INSUFFICIENT STORAGE: Deficit ${formatBytes(storageDeficitBytes)}. Free up space to continue.`}
              </Text>
            </View>
          ) : (
            <Text style={styles.storageHintText}>
              {`${formatBytes(Math.max(0, freeDiskBytes - selectedPayloadBytes))} will remain available after download`}
            </Text>
          )}
        </View>

        {/* Batch File Controls */}
        {files.length > 0 && (
          <View style={styles.filesHeaderRow}>
            <Text style={styles.sectionLabel}>
              {`Files & Contents (${files.filter((f) => f.selected).length}/${files.length})`}
            </Text>
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
              <TouchableOpacity
                style={styles.batchBtnChip}
                onPress={() => filterByExt('.mkv')}
              >
                <Text style={styles.batchBtnChipText}>.mkv</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Files Checklist */}
        {files.length > 0 ? (
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
                  {file.selected && <Text style={styles.checkmark}>✓</Text>}
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
                  accessibilityLabel={`Cycle priority for ${file.name}. Current: ${
                    file.priority === 2 ? 'High' : file.priority === 1 ? 'Normal' : 'Skip'
                  }`}
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
        ) : (
          !isResolving && (
            <View style={styles.emptyFilesBox}>
              <Ionicons name="document-text-outline" size={24} color="#4B5563" />
              <Text style={styles.emptyFilesText}>
                Paste a magnet link or browse a .torrent file to load and inspect payload files.
              </Text>
            </View>
          )
        )}

        {/* Sequential Stream Toggle */}
        <View style={styles.toggleRow}>
          <View style={styles.toggleTextContainer}>
            <Text style={styles.toggleTitle}>Sequential Download</Text>
            <Text style={styles.toggleSubtitle}>
              Prioritize head pieces for immediate media streaming to VLC
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
          style={[
            styles.startBtn,
            !hasEnoughSpace && styles.startBtnDisabled,
            files.length === 0 && styles.startBtnDisabled,
          ]}
          disabled={!hasEnoughSpace || files.length === 0 || isResolving}
          onPress={handleStartDownload}
          accessibilityRole="button"
          accessibilityLabel={
            !hasEnoughSpace
              ? `Insufficient disk storage available`
              : 'Start downloading torrent'
          }
          activeOpacity={0.8}
        >
          <Text
            style={[
              styles.startBtnText,
              (!hasEnoughSpace || files.length === 0) && styles.startBtnTextDisabled,
            ]}
          >
            {!hasEnoughSpace
              ? `INSUFFICIENT DISK STORAGE (DEFICIT ${formatBytes(storageDeficitBytes)})`
              : files.length === 0
              ? 'ENTER MAGNET OR SELECT FILE'
              : 'START DOWNLOAD'}
          </Text>
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
    marginBottom: 12,
  },
  textInput: {
    flex: 1,
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
    fontFamily: 'monospace',
    minHeight: 44,
  },
  clearBtn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  browseFileRow: {
    marginBottom: 16,
  },
  browseFileBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: '#0A121A',
    borderWidth: 1,
    borderColor: 'rgba(0, 229, 255, 0.3)',
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 14,
  },
  browseFileText: {
    color: TOKENS.colors.accentCyan,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 0.5,
  },
  metadataResolvingCard: {
    backgroundColor: '#0F171E',
    borderWidth: 1,
    borderColor: 'rgba(204, 255, 0, 0.3)',
    borderRadius: 8,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  resolvingTextCol: {
    flex: 1,
  },
  resolvingTitle: {
    color: TOKENS.colors.accentLime,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  resolvingSubtitle: {
    color: TOKENS.colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  resolvedHudCard: {
    backgroundColor: '#0D1117',
    borderWidth: 1,
    borderColor: '#1F2937',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  resolvedHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  resolvedDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: TOKENS.colors.accentLime,
  },
  resolvedNameText: {
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
    flex: 1,
  },
  resolvedMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 6,
  },
  resolvedHashText: {
    color: '#6B7280',
    fontSize: 10,
    fontFamily: 'monospace',
  },
  resolvedTrackerText: {
    color: TOKENS.colors.accentCyan,
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  resolvedPendingBadge: {
    color: '#EAB308',
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    backgroundColor: 'rgba(234, 179, 8, 0.1)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
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
    marginBottom: 16,
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
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 12,
    backgroundColor: '#161B22',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  changePathText: {
    color: TOKENS.colors.accentLime,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  storageHudCard: {
    backgroundColor: '#0D1117',
    borderWidth: 1,
    borderColor: '#1F2937',
    borderRadius: 10,
    padding: 14,
    marginBottom: 20,
  },
  storageHudHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  storageHudItem: {
    flex: 1,
  },
  storageHudDivider: {
    width: 1,
    height: 24,
    backgroundColor: '#1F2937',
    marginHorizontal: 12,
  },
  storageHudLabel: {
    color: '#6B7280',
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginBottom: 2,
    letterSpacing: 0.5,
  },
  storageHudValueLime: {
    color: TOKENS.colors.accentLime,
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  storageHudValueCyan: {
    color: TOKENS.colors.accentCyan,
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  storageTrack: {
    height: 4,
    backgroundColor: '#161B22',
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 8,
  },
  storageFill: {
    height: '100%',
    borderRadius: 2,
  },
  storageAlertBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255, 51, 102, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 51, 102, 0.3)',
    borderRadius: 6,
    padding: 8,
    marginTop: 4,
  },
  storageAlertText: {
    color: '#FF3366',
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
    flex: 1,
  },
  storageHintText: {
    color: '#6B7280',
    fontSize: 10,
    fontFamily: 'monospace',
  },
  filesHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  batchControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  batchBtn: {
    minHeight: 44,
    paddingHorizontal: 10,
    backgroundColor: '#161B22',
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  batchBtnText: {
    color: TOKENS.colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  batchBtnChip: {
    minHeight: 44,
    paddingHorizontal: 10,
    backgroundColor: '#0F1B26',
    borderWidth: 1,
    borderColor: 'rgba(0, 229, 255, 0.2)',
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  batchBtnChipText: {
    color: TOKENS.colors.accentCyan,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  filesList: {
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 10,
    marginBottom: 20,
    overflow: 'hidden',
  },
  fileRow: {
    minHeight: TOKENS.touchTarget.minHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#161B22',
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  checkboxSelected: {
    backgroundColor: TOKENS.colors.accentLime,
    borderColor: TOKENS.colors.accentLime,
  },
  checkboxUnselected: {
    borderColor: '#374151',
  },
  checkmark: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
  },
  fileInfo: {
    flex: 1,
    marginRight: 10,
  },
  fileName: {
    color: TOKENS.colors.textPrimary,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  fileNameDisabled: {
    color: '#4B5563',
    textDecorationLine: 'line-through',
  },
  fileSize: {
    color: TOKENS.colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  priorityBtn: {
    minWidth: 54,
    minHeight: 44,
    paddingHorizontal: 8,
    backgroundColor: '#161B22',
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  priorityBtnHigh: {
    backgroundColor: 'rgba(204, 255, 0, 0.15)',
    borderWidth: 1,
    borderColor: TOKENS.colors.accentLime,
  },
  priorityBtnSkip: {
    backgroundColor: 'rgba(255, 51, 102, 0.15)',
    borderWidth: 1,
    borderColor: '#FF3366',
  },
  priorityBtnText: {
    color: TOKENS.colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  priorityBtnTextHigh: {
    color: TOKENS.colors.accentLime,
  },
  priorityBtnTextSkip: {
    color: '#FF3366',
  },
  emptyFilesBox: {
    backgroundColor: '#0D1117',
    borderWidth: 1,
    borderColor: '#1F2937',
    borderRadius: 10,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    gap: 8,
  },
  emptyFilesText: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
    textAlign: 'center',
    lineHeight: 18,
  },
  toggleRow: {
    minHeight: TOKENS.touchTarget.minHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
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
  },
  toggleSubtitle: {
    color: TOKENS.colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: TOKENS.colors.surfaceBorder,
  },
  startBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startBtnDisabled: {
    backgroundColor: '#1E1417',
    borderWidth: 1,
    borderColor: '#4A1D24',
  },
  startBtnText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 0.5,
  },
  startBtnTextDisabled: {
    color: '#FF3366',
  },
});
