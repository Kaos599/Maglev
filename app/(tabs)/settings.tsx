import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
  TextInput,
  Modal,
  Platform,
  Alert,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { TOKENS, formatSpeed, formatBytes } from '../../constants/tokens';
import { triggerHaptic } from '../../constants/haptics';
import { HeaderBar } from '../../components/HeaderBar';
import { useSettings } from '../../context/SettingsContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { checkMaglevPermissions, requestMaglevPermissions } from '../../utils/permissions';
import {
  BatteryCutoffThreshold,
  EncryptionMode,
  ProxyScope,
  ProxyType,
  SeedingDurationLimit,
  SeedingRatioLimit,
  SpeedPreset,
  StorageMode,
  ThemeMode,
  DEFAULT_TRACKERS,
} from 'maglev-engine';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { isNative, telemetry, takePersistableSafPermission, requestAllFilesAccess } = useMaglevEngine();
  const {
    settings,
    isOledBlack,
    backgroundColor,
    cardBackgroundColor,
    updateSettings,
    setSpeedPreset,
    loadIpFilter,
  } = useSettings();

  const [hasStoragePerm, setHasStoragePerm] = useState(true);

  React.useEffect(() => {
    checkMaglevPermissions().then((status) => {
      setHasStoragePerm(status.hasStoragePermission);
    });
  }, []);

  const totalTransferred = telemetry?.torrents?.reduce(
    (acc, t) => acc + (t.downloadedBytes || 0) + (t.uploadedBytes || 0),
    0
  ) || 0;

  // Local state for modals & inputs
  const [customSpeedModal, setCustomSpeedModal] = useState<'download' | 'upload' | null>(null);
  const [customSpeedInput, setCustomSpeedInput] = useState('');
  const [newSsidInput, setNewSsidInput] = useState('');
  const [showAddSsid, setShowAddSsid] = useState(false);
  const [filterMessage, setFilterMessage] = useState<string | null>(null);

  // Custom folder state
  const [customFolderModalVisible, setCustomFolderModalVisible] = useState(false);
  const [customFolderPathInput, setCustomFolderPathInput] = useState(
    settings.storage.customSafPath || '/storage/emulated/0/Download/Torrents'
  );

  // Known trackers state
  const [newTrackerInput, setNewTrackerInput] = useState('');

  /* Folder selection logic */
  const handleChooseCustomFolder = useCallback(async () => {
    triggerHaptic('medium');
    const saf = FileSystem.StorageAccessFramework;
    if (Platform.OS === 'android' && saf) {
      try {
        const permissions = await saf.requestDirectoryPermissionsAsync();
        if (permissions && permissions.granted) {
          const uri = permissions.directoryUri;
          let displayPath = uri;
          try {
            const decoded = decodeURIComponent(uri);
            if (decoded.includes('primary:')) {
              displayPath = '/storage/emulated/0/' + decoded.split('primary:')[1];
            } else if (decoded.includes('document/')) {
              displayPath = decoded.split('document/')[1];
            } else {
              displayPath = decoded;
            }
          } catch {
            displayPath = uri;
          }

          if (takePersistableSafPermission) {
            await takePersistableSafPermission(uri);
          }

          updateSettings({
            storage: {
              ...settings.storage,
              storageMode: 'SAF',
              customSafUri: uri,
              customSafPath: displayPath,
            },
          });
          return;
        } else {
          // User cancelled file manager, do not open text modal
          return;
        }
      } catch {
        // Fallback to manual folder path input modal if SAF threw
      }
    }
    setCustomFolderPathInput(settings.storage.customSafPath || '/storage/emulated/0/Download/Torrents');
    setCustomFolderModalVisible(true);
  }, [settings.storage, updateSettings, takePersistableSafPermission]);

  const handleSaveCustomFolderPath = useCallback(() => {
    const trimmed = customFolderPathInput.trim();
    if (trimmed) {
      updateSettings({
        storage: {
          ...settings.storage,
          storageMode: 'SAF',
          customSafPath: trimmed,
        },
      });
    }
    setCustomFolderModalVisible(false);
  }, [customFolderPathInput, settings.storage, updateSettings]);

  // Known Trackers Handlers
  const handleAddTracker = useCallback(() => {
    const trimmed = newTrackerInput.trim();
    if (!trimmed) return;
    triggerHaptic('medium');
    const current = settings.network.defaultTrackers || DEFAULT_TRACKERS;
    if (!current.includes(trimmed)) {
      updateSettings({
        network: {
          ...settings.network,
          defaultTrackers: [...current, trimmed],
        },
      });
    }
    setNewTrackerInput('');
  }, [newTrackerInput, settings.network, updateSettings]);

  const handleRemoveTracker = useCallback(
    (trackerToRemove: string) => {
      triggerHaptic('light');
      const current = settings.network.defaultTrackers || DEFAULT_TRACKERS;
      updateSettings({
        network: {
          ...settings.network,
          defaultTrackers: current.filter((t) => t !== trackerToRemove),
        },
      });
    },
    [settings.network, updateSettings]
  );

  const handleResetTrackers = useCallback(() => {
    triggerHaptic('medium');
    updateSettings({
      network: {
        ...settings.network,
        defaultTrackers: DEFAULT_TRACKERS,
      },
    });
  }, [settings.network, updateSettings]);

  // Speed Limit Helpers
  const handleSelectPreset = useCallback(
    (type: 'download' | 'upload', preset: SpeedPreset) => {
      triggerHaptic('selection');
      if (preset === 'CUSTOM') {
        setCustomSpeedModal(type);
        setCustomSpeedInput('');
      } else {
        setSpeedPreset(type, preset);
      }
    },
    [setSpeedPreset]
  );

  const applyCustomSpeed = useCallback(() => {
    if (!customSpeedModal) return;
    const kbps = parseInt(customSpeedInput, 10);
    if (!isNaN(kbps) && kbps > 0) {
      triggerHaptic('medium');
      setSpeedPreset(customSpeedModal, 'CUSTOM', kbps * 1024);
    }
    setCustomSpeedModal(null);
  }, [customSpeedModal, customSpeedInput, setSpeedPreset]);

  // SSID Helpers
  const handleAddSsid = useCallback(() => {
    const trimmed = newSsidInput.trim();
    if (trimmed && !settings.network.allowedSsids.includes(trimmed)) {
      updateSettings((prev) => ({
        network: {
          ...prev.network,
          allowedSsids: [...prev.network.allowedSsids, trimmed],
        },
      }));
      setNewSsidInput('');
      setShowAddSsid(false);
    }
  }, [newSsidInput, settings.network.allowedSsids, updateSettings]);

  const handleRemoveSsid = useCallback(
    (ssidToRemove: string) => {
      updateSettings((prev) => ({
        network: {
          ...prev.network,
          allowedSsids: prev.network.allowedSsids.filter((s) => s !== ssidToRemove),
        },
      }));
    },
    [updateSettings]
  );

  // Quick-load default IP filter sample
  const handleLoadSampleIpFilter = useCallback(async () => {
    const sample = `
# Sample PeerGuardian / eMule Blocklist
Bad Peers:10.0.0.0-10.0.0.255
Malicious Range:198.51.100.0-198.51.100.255
Untrusted Scanners:203.0.113.0-203.0.113.255
`;
    const count = await loadIpFilter(sample);
    setFilterMessage(`Loaded ${count} blocked IP ranges`);
    setTimeout(() => setFilterMessage(null), 3000);
  }, [loadIpFilter]);

  const speedPresets: SpeedPreset[] = ['UNLIMITED', '1MB', '2MB', '5MB', '10MB', 'CUSTOM'];
  const ratioPresets: SeedingRatioLimit[] = [0, 1.0, 1.5, 2.0, 3.0];
  const durationPresets: { label: string; value: SeedingDurationLimit }[] = [
    { label: 'Off', value: 0 },
    { label: '1h', value: 3600 },
    { label: '6h', value: 21600 },
    { label: '24h', value: 86400 },
  ];
  const batteryThresholds: BatteryCutoffThreshold[] = [0, 15, 20, 30];

  return (
    <View style={[styles.container, { backgroundColor, paddingTop: insets.top }]}>
      <HeaderBar />

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* 1. APPEARANCE SECTION */}
        <Text style={styles.sectionHeader}>APPEARANCE</Text>
        <View style={[styles.settingsGroup, { backgroundColor: cardBackgroundColor }]}>
          <View style={styles.settingBlock}>
            <Text style={styles.settingTitle}>Theme</Text>
            <View style={styles.chipRow}>
              <TouchableOpacity
                style={[
                  styles.chip,
                  settings.appearance.theme === 'TACTICAL_DARK' ? styles.chipActive : styles.chipInactive,
                ]}
                onPress={() => updateSettings({ appearance: { ...settings.appearance, theme: 'TACTICAL_DARK' } })}
                accessibilityRole="button"
                accessibilityLabel="Dark Theme"
              >
                <Text
                  style={[
                    styles.chipText,
                    settings.appearance.theme === 'TACTICAL_DARK' ? styles.chipTextActive : styles.chipTextInactive,
                  ]}
                >
                  Dark
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.chip,
                  settings.appearance.theme === 'PURE_OLED' ? styles.chipActive : styles.chipInactive,
                ]}
                onPress={() => updateSettings({ appearance: { ...settings.appearance, theme: 'PURE_OLED' } })}
                accessibilityRole="button"
                accessibilityLabel="True Black OLED Theme"
              >
                <Text
                  style={[
                    styles.chipText,
                    settings.appearance.theme === 'PURE_OLED' ? styles.chipTextActive : styles.chipTextInactive,
                  ]}
                >
                  True Black (OLED)
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.settingBlock}>
            <Text style={styles.settingTitle}>Display Detail</Text>
            <View style={styles.chipRow}>
              {(['COMPACT', 'VERBOSE'] as const).map((density) => (
                <TouchableOpacity
                  key={density}
                  style={[
                    styles.chip,
                    settings.appearance.telemetryDensity === density ? styles.chipActive : styles.chipInactive,
                  ]}
                  onPress={() => updateSettings({ appearance: { ...settings.appearance, telemetryDensity: density } })}
                  accessibilityRole="button"
                >
                  <Text
                    style={[
                      styles.chipText,
                      settings.appearance.telemetryDensity === density ? styles.chipTextActive : styles.chipTextInactive,
                    ]}
                  >
                    {density === 'COMPACT' ? 'Compact' : 'Detailed'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* 2. DOWNLOADS & STORAGE SECTION */}
        <Text style={styles.sectionHeader}>DOWNLOADS & STORAGE</Text>
        <View style={[styles.settingsGroup, { backgroundColor: cardBackgroundColor }]}>
          <View style={styles.settingBlock}>
            <Text style={styles.settingTitle}>Storage Location</Text>
            <Text style={styles.settingPathText}>
              {settings.storage.storageMode === 'SAF'
                ? settings.storage.customSafPath || 'No custom folder selected'
                : settings.storage.defaultPath}
            </Text>

            <View style={styles.chipRow}>
              <TouchableOpacity
                style={[
                  styles.chip,
                  settings.storage.storageMode === 'POSIX' ? styles.chipActive : styles.chipInactive,
                ]}
                onPress={() => updateSettings({ storage: { ...settings.storage, storageMode: 'POSIX' } })}
                accessibilityRole="button"
                accessibilityLabel="Default App Storage"
              >
                <Text
                  style={[
                    styles.chipText,
                    settings.storage.storageMode === 'POSIX' ? styles.chipTextActive : styles.chipTextInactive,
                  ]}
                >
                  Default App Storage
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.chip,
                  settings.storage.storageMode === 'SAF' ? styles.chipActive : styles.chipInactive,
                ]}
                onPress={handleChooseCustomFolder}
                accessibilityRole="button"
                accessibilityLabel="Choose Custom Folder"
              >
                <Text
                  style={[
                    styles.chipText,
                    settings.storage.storageMode === 'SAF' ? styles.chipTextActive : styles.chipTextInactive,
                  ]}
                >
                  Choose Custom Folder
                </Text>
              </TouchableOpacity>
            </View>

            {settings.storage.storageMode === 'SAF' && (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <TouchableOpacity
                  style={[styles.changeFolderButton, { flex: 1, marginTop: 0 }]}
                  onPress={handleChooseCustomFolder}
                  accessibilityRole="button"
                  accessibilityLabel="Browse custom folder in file manager"
                >
                  <Ionicons name="folder-open-outline" size={16} color={TOKENS.colors.accentLime} style={{ marginRight: 6 }} />
                  <Text style={styles.changeFolderButtonText}>
                    {settings.storage.customSafPath ? 'BROWSE FOLDER' : 'SELECT FOLDER'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.changeFolderButton, { flex: 1, marginTop: 0, backgroundColor: '#161B22', borderColor: '#30363D' }]}
                  onPress={() => {
                    triggerHaptic('light');
                    setCustomFolderPathInput(settings.storage.customSafPath || '/storage/emulated/0/Download/Torrents');
                    setCustomFolderModalVisible(true);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Enter custom folder path manually"
                >
                  <Ionicons name="create-outline" size={16} color={TOKENS.colors.accentCyan} style={{ marginRight: 6 }} />
                  <Text style={[styles.changeFolderButtonText, { color: TOKENS.colors.accentCyan }]}>
                    MANUAL PATH
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Storage Permission</Text>
              <Text style={styles.settingSubtitle}>
                {hasStoragePerm ? 'Full access granted to device storage' : 'Storage permission is required to save downloads'}
              </Text>
            </View>
            <TouchableOpacity
              style={[
                styles.chip,
                hasStoragePerm ? styles.chipActive : { borderColor: TOKENS.colors.statusDanger, backgroundColor: 'rgba(255, 51, 102, 0.1)' },
              ]}
              onPress={async () => {
                triggerHaptic('medium');
                const res = await requestMaglevPermissions();
                setHasStoragePerm(res.hasStoragePermission);
                if (!res.hasStoragePermission && requestAllFilesAccess) {
                  await requestAllFilesAccess();
                }
              }}
              accessibilityRole="button"
              accessibilityLabel="Storage Permission Status"
            >
              <Text
                style={[
                  styles.chipText,
                  hasStoragePerm ? styles.chipTextActive : { color: TOKENS.colors.statusDanger },
                ]}
              >
                {hasStoragePerm ? 'GRANTED ✓' : 'GRANT'}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Auto-Move Completed</Text>
              <Text style={styles.settingSubtitle}>
                Move finished files to a separate folder
              </Text>
              {settings.storage.autoMoveCompleted && (
                <Text style={styles.destinationPathText}>
                  Target: {settings.storage.autoMoveDestinationPath}
                </Text>
              )}
            </View>
            <Switch
              value={settings.storage.autoMoveCompleted}
              onValueChange={(val) =>
                updateSettings({ storage: { ...settings.storage, autoMoveCompleted: val } })
              }
              trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
              thumbColor={settings.storage.autoMoveCompleted ? '#000000' : TOKENS.colors.textMuted}
            />
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Pre-allocate Disk Space</Text>
            </View>
            <Switch
              value={settings.storage.preAllocateDisk}
              onValueChange={(val) =>
                updateSettings({ storage: { ...settings.storage, preAllocateDisk: val } })
              }
              trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
              thumbColor={settings.storage.preAllocateDisk ? '#000000' : TOKENS.colors.textMuted}
            />
          </View>
        </View>

        {/* 3. BANDWIDTH & LIMITS SECTION */}
        <Text style={styles.sectionHeader}>BANDWIDTH & LIMITS</Text>
        <View style={[styles.settingsGroup, { backgroundColor: cardBackgroundColor }]}>
          {/* Download Speed Presets */}
          <View style={styles.settingBlock}>
            <View style={styles.rowBetween}>
              <Text style={styles.settingTitle}>Download Limit</Text>
              <Text style={styles.telemetryValue}>
                {settings.bandwidth.downloadLimitBytesPerSec > 0
                  ? formatSpeed(settings.bandwidth.downloadLimitBytesPerSec)
                  : 'Unlimited'}
              </Text>
            </View>
            <View style={styles.chipRowWrap}>
              {speedPresets.map((preset) => {
                const isActive = settings.bandwidth.downloadPreset === preset;
                const label = preset === 'UNLIMITED' ? 'Unlimited' : preset === 'CUSTOM' ? 'Custom' : `${preset}/s`;
                return (
                  <TouchableOpacity
                    key={`down_${preset}`}
                    style={[styles.chipSmall, isActive ? styles.chipActive : styles.chipInactive]}
                    onPress={() => handleSelectPreset('download', preset)}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.chipText, isActive ? styles.chipTextActive : styles.chipTextInactive]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Upload Speed Presets */}
          <View style={styles.settingBlock}>
            <View style={styles.rowBetween}>
              <Text style={styles.settingTitle}>Upload Limit</Text>
              <Text style={styles.telemetryValue}>
                {settings.bandwidth.uploadLimitBytesPerSec > 0
                  ? formatSpeed(settings.bandwidth.uploadLimitBytesPerSec)
                  : 'Unlimited'}
              </Text>
            </View>
            <View style={styles.chipRowWrap}>
              {speedPresets.map((preset) => {
                const isActive = settings.bandwidth.uploadPreset === preset;
                const label = preset === 'UNLIMITED' ? 'Unlimited' : preset === 'CUSTOM' ? 'Custom' : `${preset}/s`;
                return (
                  <TouchableOpacity
                    key={`up_${preset}`}
                    style={[styles.chipSmall, isActive ? styles.chipActive : styles.chipInactive]}
                    onPress={() => handleSelectPreset('upload', preset)}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.chipText, isActive ? styles.chipTextActive : styles.chipTextInactive]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {/* Active Torrent Caps */}
          <View style={styles.settingBlock}>
            <Text style={styles.settingTitle}>Active Queue Caps</Text>
            <View style={styles.capsRow}>
              <View style={styles.capItem}>
                <Text style={styles.capLabel}>Downloads</Text>
                <View style={styles.chipRow}>
                  {[1, 3, 5, 10].map((num) => (
                    <TouchableOpacity
                      key={`max_down_${num}`}
                      style={[
                        styles.chipMini,
                        settings.bandwidth.maxActiveDownloads === num ? styles.chipActive : styles.chipInactive,
                      ]}
                      onPress={() =>
                        updateSettings({ bandwidth: { ...settings.bandwidth, maxActiveDownloads: num } })
                      }
                      accessibilityRole="button"
                    >
                      <Text
                        style={[
                          styles.chipText,
                          settings.bandwidth.maxActiveDownloads === num ? styles.chipTextActive : styles.chipTextInactive,
                        ]}
                      >
                        {num}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <View style={styles.capItem}>
                <Text style={styles.capLabel}>Uploads</Text>
                <View style={styles.chipRow}>
                  {[1, 3, 5, 10].map((num) => (
                    <TouchableOpacity
                      key={`max_up_${num}`}
                      style={[
                        styles.chipMini,
                        settings.bandwidth.maxActiveUploads === num ? styles.chipActive : styles.chipInactive,
                      ]}
                      onPress={() =>
                        updateSettings({ bandwidth: { ...settings.bandwidth, maxActiveUploads: num } })
                      }
                      accessibilityRole="button"
                    >
                      <Text
                        style={[
                          styles.chipText,
                          settings.bandwidth.maxActiveUploads === num ? styles.chipTextActive : styles.chipTextInactive,
                        ]}
                      >
                        {num}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>
          </View>

          {/* Seeding Governance Limits */}
          <View style={styles.settingBlock}>
            <Text style={styles.settingTitle}>Seeding Ratio Limit</Text>
            <View style={styles.chipRowWrap}>
              {ratioPresets.map((r) => {
                const isActive = settings.bandwidth.seedingRatioLimit === r;
                return (
                  <TouchableOpacity
                    key={`ratio_${r}`}
                    style={[styles.chipSmall, isActive ? styles.chipActive : styles.chipInactive]}
                    onPress={() =>
                      updateSettings({ bandwidth: { ...settings.bandwidth, seedingRatioLimit: r } })
                    }
                    accessibilityRole="button"
                  >
                    <Text style={[styles.chipText, isActive ? styles.chipTextActive : styles.chipTextInactive]}>
                      {r === 0 ? 'Off' : `${r.toFixed(1)}x`}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={styles.settingBlock}>
            <Text style={styles.settingTitle}>Seeding Time Limit</Text>
            <View style={styles.chipRowWrap}>
              {durationPresets.map(({ label, value }) => {
                const isActive = settings.bandwidth.seedingDurationLimitSeconds === value;
                return (
                  <TouchableOpacity
                    key={`dur_${value}`}
                    style={[styles.chipSmall, isActive ? styles.chipActive : styles.chipInactive]}
                    onPress={() =>
                      updateSettings({ bandwidth: { ...settings.bandwidth, seedingDurationLimitSeconds: value } })
                    }
                    accessibilityRole="button"
                  >
                    <Text style={[styles.chipText, isActive ? styles.chipTextActive : styles.chipTextInactive]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </View>

        {/* 4. NETWORK & PROXY SECTION */}
        <Text style={styles.sectionHeader}>NETWORK & PROXY</Text>
        <View style={[styles.settingsGroup, { backgroundColor: cardBackgroundColor }]}>
          {/* Network Safety & Data Tracker Card */}
          <View style={styles.networkSafetyCard}>
            <View style={styles.safetyHeaderRow}>
              <View style={styles.safetyStatusDot} />
              <Text style={styles.safetyHeaderTitle}>NETWORK SAFETY & DATA USAGE</Text>
              <Text style={styles.safetyHeaderBadge}>SECURE</Text>
            </View>

            <View style={styles.safetyStatsGrid}>
              <View style={styles.safetyStatCol}>
                <Text style={styles.safetyStatLabel}>WI-FI TRANSFERRED</Text>
                <Text style={styles.safetyStatValLime}>{formatBytes(totalTransferred)}</Text>
              </View>
              <View style={styles.safetyStatDivider} />
              <View style={styles.safetyStatCol}>
                <Text style={styles.safetyStatLabel}>CELLULAR DATA</Text>
                <Text style={styles.safetyStatValCyan}>0 B (LOCKED)</Text>
              </View>
            </View>

            <View style={styles.safetyFooterRow}>
              <Ionicons name="shield-checkmark" size={13} color={TOKENS.colors.accentLime} />
              <Text style={styles.safetyFooterText}>
                Zero cellular leaks • RFC 1928 remote DNS active
              </Text>
            </View>
          </View>

          {/* Wi-Fi Only Switch */}
          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Download on Wi-Fi Only</Text>
            </View>
            <Switch
              value={settings.network.wifiOnly}
              onValueChange={(val) =>
                updateSettings({ network: { ...settings.network, wifiOnly: val } })
              }
              trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
              thumbColor={settings.network.wifiOnly ? '#000000' : TOKENS.colors.textMuted}
            />
          </View>

          {/* SSID Whitelist */}
          <View style={styles.settingBlock}>
            <View style={styles.rowBetween}>
              <View style={styles.settingTextContainer}>
                <Text style={styles.settingTitle}>Wi-Fi Network Whitelist</Text>
                <Text style={styles.settingSubtitle}>
                  Restrict downloads strictly to approved Wi-Fi networks
                </Text>
              </View>
              <Switch
                value={settings.network.ssidWhitelistEnabled}
                onValueChange={(val) =>
                  updateSettings({ network: { ...settings.network, ssidWhitelistEnabled: val } })
                }
                trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
                thumbColor={settings.network.ssidWhitelistEnabled ? '#000000' : TOKENS.colors.textMuted}
              />
            </View>

            {settings.network.ssidWhitelistEnabled && (
              <View style={styles.ssidContainer}>
                <Text style={styles.currentSsidBadge}>
                  Current: {settings.network.currentSsid || 'None'}
                </Text>
                <View style={styles.ssidTagsRow}>
                  {settings.network.allowedSsids.map((ssid) => (
                    <View key={ssid} style={styles.ssidTag}>
                      <Text style={styles.ssidTagText}>{ssid}</Text>
                      <TouchableOpacity
                        style={styles.ssidTagRemove}
                        onPress={() => handleRemoveSsid(ssid)}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${ssid}`}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      >
                        <Ionicons name="close" size={14} color="#000000" />
                      </TouchableOpacity>
                    </View>
                  ))}
                  <TouchableOpacity
                    style={styles.addSsidButton}
                    onPress={() => setShowAddSsid(!showAddSsid)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.addSsidButtonText}>+ Add SSID</Text>
                  </TouchableOpacity>
                </View>

                {showAddSsid && (
                  <View style={styles.addSsidRow}>
                    <TextInput
                      style={styles.ssidTextInput}
                      placeholder="Enter network SSID"
                      placeholderTextColor={TOKENS.colors.textMuted}
                      value={newSsidInput}
                      onChangeText={setNewSsidInput}
                    />
                    <TouchableOpacity style={styles.confirmSsidButton} onPress={handleAddSsid}>
                      <Text style={styles.confirmSsidButtonText}>Add</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            )}
          </View>

          {/* UPnP Port Forwarding */}
          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <View style={styles.rowAlign}>
                <Text style={styles.settingTitle}>Port Forwarding (UPnP)</Text>
                <View style={styles.portBadge}>
                  <Text style={styles.portBadgeText}>
                    {settings.network.upnpEnabled ? 'Mapped: 6881' : 'Disabled'}
                  </Text>
                </View>
              </View>
              <Text style={styles.settingSubtitle}>
                Automatically forward router ports for faster peer connections
              </Text>
            </View>
            <Switch
              value={settings.network.upnpEnabled}
              onValueChange={(val) =>
                updateSettings({ network: { ...settings.network, upnpEnabled: val } })
              }
              trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
              thumbColor={settings.network.upnpEnabled ? '#000000' : TOKENS.colors.textMuted}
            />
          </View>

          {/* Protocol Encryption */}
          <View style={styles.settingBlock}>
            <Text style={styles.settingTitle}>Require Encrypted Connections</Text>
            <View style={styles.chipRow}>
              {(['REQUIRED', 'PREFERRED', 'DISABLED'] as const).map((enc) => (
                <TouchableOpacity
                  key={enc}
                  style={[
                    styles.chip,
                    settings.network.encryption === enc ? styles.chipActive : styles.chipInactive,
                  ]}
                  onPress={() => updateSettings({ network: { ...settings.network, encryption: enc } })}
                  accessibilityRole="button"
                >
                  <Text
                    style={[
                      styles.chipText,
                      settings.network.encryption === enc ? styles.chipTextActive : styles.chipTextInactive,
                    ]}
                  >
                    {enc === 'REQUIRED' ? 'Required' : enc === 'PREFERRED' ? 'Allow Both' : 'Off'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Peer Discovery */}
          <View style={styles.settingBlock}>
            <Text style={styles.settingTitle}>Peer Discovery</Text>

            <View style={styles.subRow}>
              <Text style={styles.subRowLabel}>DHT (Kademlia)</Text>
              <Switch
                value={settings.network.dhtEnabled}
                onValueChange={(val) =>
                  updateSettings({ network: { ...settings.network, dhtEnabled: val } })
                }
                trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
                thumbColor={settings.network.dhtEnabled ? '#000000' : TOKENS.colors.textMuted}
              />
            </View>

            <View style={styles.subRow}>
              <Text style={styles.subRowLabel}>PeX (Peer Exchange)</Text>
              <Switch
                value={settings.network.pexEnabled}
                onValueChange={(val) =>
                  updateSettings({ network: { ...settings.network, pexEnabled: val } })
                }
                trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
                thumbColor={settings.network.pexEnabled ? '#000000' : TOKENS.colors.textMuted}
              />
            </View>

            <View style={styles.subRow}>
              <Text style={styles.subRowLabel}>LSD (Local Peer Discovery)</Text>
              <Switch
                value={settings.network.lsdEnabled}
                onValueChange={(val) =>
                  updateSettings({ network: { ...settings.network, lsdEnabled: val } })
                }
                trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
                thumbColor={settings.network.lsdEnabled ? '#000000' : TOKENS.colors.textMuted}
              />
            </View>
          </View>

          {/* Default Known Trackers */}
          <View style={styles.settingBlock}>
            <View style={styles.rowBetween}>
              <View style={styles.settingTextContainer}>
                <Text style={styles.settingTitle}>Default Known Trackers</Text>
                <Text style={styles.settingSubtitle}>
                  Trackers automatically injected into all downloads
                </Text>
              </View>
              <TouchableOpacity
                style={styles.resetTrackersButton}
                onPress={handleResetTrackers}
                accessibilityRole="button"
                accessibilityLabel="Reset trackers to defaults"
              >
                <Text style={styles.resetTrackersText}>RESET</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.trackersListContainer}>
              {(settings.network.defaultTrackers || DEFAULT_TRACKERS).map((tracker, idx) => (
                <View key={`${tracker}-${idx}`} style={styles.trackerItemRow}>
                  <Ionicons name="radio-outline" size={13} color={TOKENS.colors.accentLime} style={{ marginRight: 8 }} />
                  <Text style={styles.trackerItemText} numberOfLines={1} ellipsizeMode="middle">
                    {tracker}
                  </Text>
                  <TouchableOpacity
                    style={styles.removeTrackerTouch}
                    onPress={() => handleRemoveTracker(tracker)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove tracker ${tracker}`}
                  >
                    <Ionicons name="trash-outline" size={15} color={TOKENS.colors.statusDanger} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>

            <View style={styles.addTrackerRow}>
              <TextInput
                style={styles.trackerTextInput}
                placeholder="udp://tracker.example.com:1337/announce"
                placeholderTextColor={TOKENS.colors.textMuted}
                value={newTrackerInput}
                onChangeText={setNewTrackerInput}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={styles.confirmTrackerButton}
                onPress={handleAddTracker}
                accessibilityRole="button"
                accessibilityLabel="Add Tracker"
              >
                <Text style={styles.confirmTrackerButtonText}>+ ADD</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* SOCKS5 / HTTP Proxy Tunneling */}
          <View style={styles.settingBlock}>
            <View style={styles.rowBetween}>
              <View style={styles.settingTextContainer}>
                <Text style={styles.settingTitle}>Proxy Tunnel</Text>
                <Text style={styles.settingSubtitle}>
                  Route BitTorrent traffic through a private proxy server
                </Text>
              </View>
              <Switch
                value={settings.network.proxy.enabled}
                onValueChange={(val) =>
                  updateSettings({
                    network: {
                      ...settings.network,
                      proxy: { ...settings.network.proxy, enabled: val },
                    },
                  })
                }
                trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
                thumbColor={settings.network.proxy.enabled ? '#000000' : TOKENS.colors.textMuted}
              />
            </View>

            {settings.network.proxy.enabled && (
              <View style={styles.proxyDetailsBox}>
                <View style={styles.chipRow}>
                  {(['SOCKS5', 'HTTP'] as const).map((type) => (
                    <TouchableOpacity
                      key={type}
                      style={[
                        styles.chipSmall,
                        settings.network.proxy.type === type ? styles.chipActive : styles.chipInactive,
                      ]}
                      onPress={() =>
                        updateSettings({
                          network: {
                            ...settings.network,
                            proxy: { ...settings.network.proxy, type },
                          },
                        })
                      }
                      accessibilityRole="button"
                    >
                      <Text
                        style={[
                          styles.chipText,
                          settings.network.proxy.type === type ? styles.chipTextActive : styles.chipTextInactive,
                        ]}
                      >
                        {type}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={styles.inputPairRow}>
                  <TextInput
                    style={[styles.proxyInput, { flex: 2 }]}
                    placeholder="Proxy Host (e.g. 127.0.0.1)"
                    placeholderTextColor={TOKENS.colors.textMuted}
                    value={settings.network.proxy.host}
                    onChangeText={(val) =>
                      updateSettings({
                        network: {
                          ...settings.network,
                          proxy: { ...settings.network.proxy, host: val },
                        },
                      })
                    }
                  />
                  <TextInput
                    style={[styles.proxyInput, { flex: 1 }]}
                    placeholder="Port"
                    placeholderTextColor={TOKENS.colors.textMuted}
                    keyboardType="numeric"
                    value={settings.network.proxy.port.toString()}
                    onChangeText={(val) =>
                      updateSettings({
                        network: {
                          ...settings.network,
                          proxy: { ...settings.network.proxy, port: parseInt(val, 10) || 1080 },
                        },
                      })
                    }
                  />
                </View>

                {/* Proxy Scoping */}
                <Text style={styles.proxySublabel}>Proxy Scope</Text>
                <View style={styles.chipRow}>
                  {(['ALL', 'TRACKERS_ONLY', 'PEERS_ONLY'] as const).map((scope) => (
                    <TouchableOpacity
                      key={scope}
                      style={[
                        styles.chipSmall,
                        settings.network.proxy.scope === scope ? styles.chipActive : styles.chipInactive,
                      ]}
                      onPress={() =>
                        updateSettings({
                          network: {
                            ...settings.network,
                            proxy: { ...settings.network.proxy, scope },
                          },
                        })
                      }
                      accessibilityRole="button"
                    >
                      <Text
                        style={[
                          styles.chipText,
                          settings.network.proxy.scope === scope ? styles.chipTextActive : styles.chipTextInactive,
                        ]}
                      >
                        {scope === 'ALL' ? 'All Traffic' : scope === 'TRACKERS_ONLY' ? 'Trackers' : 'Peers'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Remote DNS Toggle */}
                <View style={styles.subRow}>
                  <View style={styles.settingTextContainer}>
                    <Text style={styles.subRowLabel}>Remote DNS Resolution</Text>
                    <Text style={styles.settingSubtitle}>
                      Resolve hostnames via proxy to prevent DNS leaks
                    </Text>
                  </View>
                  <Switch
                    value={settings.network.proxy.remoteDns}
                    onValueChange={(val) =>
                      updateSettings({
                        network: {
                          ...settings.network,
                          proxy: { ...settings.network.proxy, remoteDns: val },
                        },
                      })
                    }
                    trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
                    thumbColor={settings.network.proxy.remoteDns ? '#000000' : TOKENS.colors.textMuted}
                  />
                </View>
              </View>
            )}
          </View>

          {/* IP Filtering / Blocklist */}
          <View style={styles.settingBlock}>
            <View style={styles.rowBetween}>
              <View style={styles.settingTextContainer}>
                <Text style={styles.settingTitle}>IP Blocklist</Text>
                <Text style={styles.settingSubtitle}>
                  Filter out known untrusted peer IP ranges
                </Text>
              </View>
              <Switch
                value={settings.network.ipFilterEnabled}
                onValueChange={(val) =>
                  updateSettings({ network: { ...settings.network, ipFilterEnabled: val } })
                }
                trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
                thumbColor={settings.network.ipFilterEnabled ? '#000000' : TOKENS.colors.textMuted}
              />
            </View>

            <View style={styles.ipFilterInfoRow}>
              <View style={styles.badgeLime}>
                <Text style={styles.badgeLimeText}>
                  {settings.network.ipFilterRulesCount > 0
                    ? `${settings.network.ipFilterRulesCount} ranges active`
                    : 'No rules loaded'}
                </Text>
              </View>

              <TouchableOpacity
                style={styles.loadBlocklistBtn}
                onPress={handleLoadSampleIpFilter}
                accessibilityRole="button"
              >
                <Text style={styles.loadBlocklistBtnText}>Load Default Blocklist</Text>
              </TouchableOpacity>
            </View>

            {filterMessage && <Text style={styles.filterSuccessMsg}>{filterMessage}</Text>}
          </View>
        </View>

        {/* 5. POWER & BATTERY SECTION */}
        <Text style={styles.sectionHeader}>POWER & BATTERY</Text>
        <View style={[styles.settingsGroup, { backgroundColor: cardBackgroundColor }]}>
          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Only download while charging</Text>
            </View>
            <Switch
              value={settings.power.downloadOnlyWhileCharging}
              onValueChange={(val) =>
                updateSettings({ power: { ...settings.power, downloadOnlyWhileCharging: val } })
              }
              trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
              thumbColor={settings.power.downloadOnlyWhileCharging ? '#000000' : TOKENS.colors.textMuted}
            />
          </View>

          <View style={styles.settingBlock}>
            <Text style={styles.settingTitle}>Pause when battery drops below 20%</Text>
            <View style={styles.chipRow}>
              {batteryThresholds.map((threshold) => {
                const isActive = settings.power.batteryCutoffThreshold === threshold;
                return (
                  <TouchableOpacity
                    key={`cutoff_${threshold}`}
                    style={[styles.chip, isActive ? styles.chipActive : styles.chipInactive]}
                    onPress={() =>
                      updateSettings({ power: { ...settings.power, batteryCutoffThreshold: threshold } })
                    }
                    accessibilityRole="button"
                  >
                    <Text style={[styles.chipText, isActive ? styles.chipTextActive : styles.chipTextInactive]}>
                      {threshold === 0 ? 'Off' : `${threshold}%`}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Auto-Exit on Complete</Text>
              <Text style={styles.settingSubtitle}>
                Close app when all downloads finish
              </Text>
            </View>
            <Switch
              value={settings.power.autoExitOnComplete}
              onValueChange={(val) =>
                updateSettings({ power: { ...settings.power, autoExitOnComplete: val } })
              }
              trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
              thumbColor={settings.power.autoExitOnComplete ? '#000000' : TOKENS.colors.textMuted}
            />
          </View>
        </View>

        {/* 6. ABOUT SECTION */}
        <Text style={styles.sectionHeader}>ABOUT</Text>
        <View style={[styles.settingsGroup, { backgroundColor: cardBackgroundColor }]}>
          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Maglev Engine</Text>
              <Text style={styles.settingSubtitle}>
                {isNative ? 'Native Rust librqbit 0.1.0 (.so JNI)' : 'High-Fidelity Telemetry Simulator'}
              </Text>
            </View>
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>License</Text>
              <Text style={styles.settingSubtitle}>MIT / Apache-2.0 (Zero Bloat, Zero Jargon)</Text>
            </View>
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Repository</Text>
              <Text style={styles.settingSubtitle}>github.com/Kaos599/Maglev</Text>
            </View>
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Version</Text>
              <Text style={styles.settingSubtitle}>Maglev 0.1.0 (Phase 2 Governance)</Text>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* Custom Speed Numeric Modal */}
      <Modal visible={customSpeedModal !== null} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: cardBackgroundColor }]}>
            <Text style={styles.modalTitle}>
              Custom {customSpeedModal === 'download' ? 'Download' : 'Upload'} Limit
            </Text>
            <Text style={styles.modalSubtitle}>Enter maximum transfer ceiling in KB/s</Text>

            <TextInput
              style={styles.modalInput}
              placeholder="e.g. 2500 for 2.5 MB/s"
              placeholderTextColor={TOKENS.colors.textMuted}
              keyboardType="numeric"
              value={customSpeedInput}
              onChangeText={setCustomSpeedInput}
              autoFocus
            />

            <View style={styles.modalActionsRow}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setCustomSpeedModal(null)}
                accessibilityRole="button"
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalApplyBtn}
                onPress={applyCustomSpeed}
                accessibilityRole="button"
              >
                <Text style={styles.modalApplyText}>Apply Limit</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Custom Folder Path Modal */}
      <Modal visible={customFolderModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: cardBackgroundColor }]}>
            <Text style={styles.modalTitle}>Custom Download Folder</Text>
            <Text style={styles.modalSubtitle}>Enter target directory path for completed files</Text>

            <TextInput
              style={styles.modalInput}
              placeholder="/storage/emulated/0/Download/Torrents"
              placeholderTextColor={TOKENS.colors.textMuted}
              value={customFolderPathInput}
              onChangeText={setCustomFolderPathInput}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />

            <View style={styles.modalActionsRow}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setCustomFolderModalVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Cancel folder change"
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.modalApplyBtn}
                onPress={handleSaveCustomFolderPath}
                accessibilityRole="button"
                accessibilityLabel="Save custom folder path"
              >
                <Text style={styles.modalApplyText}>Save Folder</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  networkSafetyCard: {
    backgroundColor: '#0D1117',
    borderWidth: 1,
    borderColor: '#1F2937',
    borderRadius: 8,
    padding: 12,
    margin: 12,
    marginBottom: 6,
  },
  safetyHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 6,
  },
  safetyStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: TOKENS.colors.accentLime,
  },
  safetyHeaderTitle: {
    flex: 1,
    color: '#D1D5DB',
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 0.5,
  },
  safetyHeaderBadge: {
    color: TOKENS.colors.accentLime,
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
    backgroundColor: 'rgba(204, 255, 0, 0.1)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  safetyStatsGrid: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  safetyStatCol: {
    flex: 1,
  },
  safetyStatLabel: {
    color: TOKENS.colors.textMuted,
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    marginBottom: 2,
  },
  safetyStatValLime: {
    color: TOKENS.colors.accentLime,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  safetyStatValCyan: {
    color: TOKENS.colors.accentCyan,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  safetyStatDivider: {
    width: 1,
    height: 24,
    backgroundColor: '#1F2937',
    marginHorizontal: 10,
  },
  safetyFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#161B22',
  },
  safetyFooterText: {
    color: TOKENS.colors.textMuted,
    fontSize: 9,
    fontFamily: 'monospace',
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 48,
  },
  sectionHeader: {
    color: TOKENS.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginTop: 20,
    marginBottom: 8,
    letterSpacing: 0.8,
  },
  settingsGroup: {
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 4,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: TOKENS.colors.surfaceBorder,
    minHeight: TOKENS.touchTarget.minHeight,
  },
  settingBlock: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: TOKENS.colors.surfaceBorder,
  },
  settingTextContainer: {
    flex: 1,
    marginRight: 12,
  },
  settingTitle: {
    color: TOKENS.colors.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  settingSubtitle: {
    color: TOKENS.colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  settingPathText: {
    color: TOKENS.colors.accentCyan,
    fontSize: 11,
    fontFamily: 'monospace',
    marginVertical: 6,
  },
  destinationPathText: {
    color: TOKENS.colors.accentLime,
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 4,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowAlign: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  telemetryValue: {
    color: TOKENS.colors.accentLime,
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  chipRowWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 10,
  },
  chip: {
    flex: 1,
    minHeight: TOKENS.touchTarget.minHeight,
    minWidth: 120,
    borderRadius: 8,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  chipSmall: {
    minHeight: TOKENS.touchTarget.minHeight,
    minWidth: 64,
    paddingHorizontal: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  chipMini: {
    minHeight: TOKENS.touchTarget.minHeight,
    minWidth: TOKENS.touchTarget.minWidth,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  chipActive: {
    backgroundColor: TOKENS.colors.accentLime,
    borderColor: TOKENS.colors.accentLime,
  },
  chipInactive: {
    backgroundColor: '#11161F',
    borderColor: TOKENS.colors.surfaceBorder,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '700',
  },
  chipTextActive: {
    color: '#000000',
  },
  chipTextInactive: {
    color: TOKENS.colors.textPrimary,
  },
  capsRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 10,
  },
  capItem: {
    flex: 1,
  },
  capLabel: {
    color: TOKENS.colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 4,
  },
  badgeLime: {
    backgroundColor: '#223300',
    borderColor: TOKENS.colors.accentLime,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  badgeLimeText: {
    color: TOKENS.colors.accentLime,
    fontSize: 10,
    fontWeight: '700',
  },
  portBadge: {
    backgroundColor: '#002B33',
    borderColor: TOKENS.colors.accentCyan,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  portBadgeText: {
    color: TOKENS.colors.accentCyan,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  ssidContainer: {
    marginTop: 8,
  },
  currentSsidBadge: {
    color: TOKENS.colors.accentCyan,
    fontSize: 11,
    fontFamily: 'monospace',
    marginBottom: 6,
  },
  ssidTagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
  },
  ssidTag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 6,
    paddingLeft: 8,
    paddingRight: 4,
    height: 32,
  },
  ssidTagText: {
    color: '#000000',
    fontSize: 11,
    fontWeight: '700',
  },
  ssidTagRemove: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  addSsidButton: {
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#11161F',
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addSsidButtonText: {
    color: TOKENS.colors.accentCyan,
    fontSize: 11,
    fontWeight: '700',
  },
  addSsidRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  ssidTextInput: {
    flex: 1,
    height: TOKENS.touchTarget.minHeight,
    backgroundColor: '#11161F',
    borderColor: TOKENS.colors.surfaceBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
  },
  confirmSsidButton: {
    height: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 16,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmSsidButtonText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#161B22',
    marginTop: 8,
    minHeight: TOKENS.touchTarget.minHeight,
  },
  subRowLabel: {
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
  },
  proxyDetailsBox: {
    backgroundColor: '#07090D',
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
  },
  inputPairRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
  },
  proxyInput: {
    height: TOKENS.touchTarget.minHeight,
    backgroundColor: '#11161F',
    borderColor: TOKENS.colors.surfaceBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
  },
  proxySublabel: {
    color: TOKENS.colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginTop: 10,
  },
  ipFilterInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  loadBlocklistBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 14,
    backgroundColor: '#11161F',
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadBlocklistBtnText: {
    color: TOKENS.colors.accentCyan,
    fontSize: 11,
    fontWeight: '700',
  },
  filterSuccessMsg: {
    color: TOKENS.colors.accentLime,
    fontSize: 11,
    marginTop: 6,
    fontFamily: 'monospace',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    padding: 20,
  },
  modalTitle: {
    color: TOKENS.colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  modalSubtitle: {
    color: TOKENS.colors.textMuted,
    fontSize: 12,
    marginBottom: 16,
  },
  modalInput: {
    height: 48,
    backgroundColor: '#11161F',
    borderColor: TOKENS.colors.surfaceBorder,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    color: TOKENS.colors.textPrimary,
    fontSize: 14,
    marginBottom: 20,
  },
  modalActionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  modalCancelBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCancelText: {
    color: TOKENS.colors.textMuted,
    fontSize: 13,
  },
  modalApplyBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 20,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalApplyText: {
    color: '#000000',
    fontSize: 13,
    fontWeight: '700',
  },
  changeFolderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#161B22',
    borderWidth: 1,
    borderColor: '#30363D',
    borderRadius: 8,
    marginTop: 12,
  },
  changeFolderButtonText: {
    fontFamily: 'SpaceMono',
    fontSize: 12,
    fontWeight: '700',
    color: TOKENS.colors.accentLime,
    letterSpacing: 0.5,
  },
  resetTrackersButton: {
    minHeight: TOKENS.touchTarget.minHeight,
    minWidth: 50,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#161B22',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#30363D',
  },
  resetTrackersText: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '700',
    color: TOKENS.colors.textMuted,
  },
  trackersListContainer: {
    marginTop: 10,
    marginBottom: 10,
    gap: 6,
  },
  trackerItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#11161F',
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 6,
    paddingLeft: 10,
    paddingRight: 4,
    minHeight: TOKENS.touchTarget.minHeight,
  },
  trackerItemText: {
    flex: 1,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: TOKENS.colors.textPrimary,
  },
  removeTrackerTouch: {
    minWidth: TOKENS.touchTarget.minWidth,
    minHeight: TOKENS.touchTarget.minHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addTrackerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
  },
  trackerTextInput: {
    flex: 1,
    height: 44,
    backgroundColor: '#11161F',
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: TOKENS.colors.textPrimary,
  },
  confirmTrackerButton: {
    minHeight: TOKENS.touchTarget.minHeight,
    minWidth: 64,
    paddingHorizontal: 14,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmTrackerButtonText: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '700',
    color: '#000000',
  },
});
