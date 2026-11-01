import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Switch, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { TOKENS } from '../../constants/tokens';
import { HeaderBar } from '../../components/HeaderBar';
import { useMaglevEngine } from '../../context/EngineContext';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { defaultStoragePath, isNative } = useMaglevEngine();

  const [pureBlackOled, setPureBlackOled] = useState(true);
  const [wifiOnly, setWifiOnly] = useState(false);
  const [upnpEnabled, setUpnpEnabled] = useState(true);
  const [chargeOnly, setChargeOnly] = useState(false);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <HeaderBar />

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Appearance Section */}
        <Text style={styles.sectionHeader}>Appearance</Text>
        <View style={styles.settingsGroup}>
          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Tactical OLED Black</Text>
              <Text style={styles.settingSubtitle}>Enforce true OLED #05070A for battery preservation</Text>
            </View>
            <Switch
              value={pureBlackOled}
              onValueChange={setPureBlackOled}
              trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
              thumbColor={pureBlackOled ? '#000000' : TOKENS.colors.textMuted}
            />
          </View>
        </View>

        {/* Transfers & Storage Section */}
        <Text style={styles.sectionHeader}>Downloads & Storage</Text>
        <View style={styles.settingsGroup}>
          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>App-Specific POSIX Storage</Text>
              <Text style={styles.settingSubtitle}>{defaultStoragePath}</Text>
            </View>
          </View>
          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Download Only While Charging</Text>
              <Text style={styles.settingSubtitle}>Automatically pause transfers when running on battery</Text>
            </View>
            <Switch
              value={chargeOnly}
              onValueChange={setChargeOnly}
              trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
              thumbColor={chargeOnly ? '#000000' : TOKENS.colors.textMuted}
            />
          </View>
        </View>

        {/* Network & Swarm Section */}
        <Text style={styles.sectionHeader}>Network & Swarm</Text>
        <View style={styles.settingsGroup}>
          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Download on Wi-Fi Only</Text>
              <Text style={styles.settingSubtitle}>Clamp transfer sockets when cellular data is active</Text>
            </View>
            <Switch
              value={wifiOnly}
              onValueChange={setWifiOnly}
              trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
              thumbColor={wifiOnly ? '#000000' : TOKENS.colors.textMuted}
            />
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>UPnP / NAT-PMP Port Forwarding</Text>
              <Text style={styles.settingSubtitle}>Automatically open router port (BEP 55)</Text>
            </View>
            <Switch
              value={upnpEnabled}
              onValueChange={setUpnpEnabled}
              trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
              thumbColor={upnpEnabled ? '#000000' : TOKENS.colors.textMuted}
            />
          </View>
        </View>

        {/* About Section */}
        <Text style={styles.sectionHeader}>About</Text>
        <View style={styles.settingsGroup}>
          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Maglev Engine</Text>
              <Text style={styles.settingSubtitle}>
                Mode: {isNative ? 'Native Rust librqbit (.so)' : 'High-Fidelity Telemetry Simulator'}
              </Text>
            </View>
          </View>

          <View style={styles.settingRow}>
            <View style={styles.settingTextContainer}>
              <Text style={styles.settingTitle}>Version</Text>
              <Text style={styles.settingSubtitle}>Maglev 0.1.0-alpha</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: TOKENS.colors.bgOled,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 40,
  },
  sectionHeader: {
    color: TOKENS.colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginTop: 18,
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  settingsGroup: {
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 12,
    overflow: 'hidden',
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
  },
});
