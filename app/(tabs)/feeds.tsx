import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Modal,
  TextInput,
  Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatBytes, TOKENS } from '../../constants/tokens';
import { HeaderBar } from '../../components/HeaderBar';
import { useMaglevEngine } from '../../context/EngineContext';
import { triggerHaptic } from '../../constants/haptics';

interface FeedItem {
  id: string;
  title: string;
  channel: string;
  sizeBytes: number;
  published: string;
  autoDownload: boolean;
  magnet: string;
}

const INITIAL_FEEDS: FeedItem[] = [
  {
    id: 'f_ubuntu',
    title: 'Ubuntu-24.04.1-LTS-Desktop-x86_64.iso',
    channel: 'Linux Distros',
    sizeBytes: 4_294_967_296,
    published: '2h ago',
    autoDownload: true,
    magnet: 'magnet:?xt=urn:btih:ubuntu2404desktop&dn=Ubuntu-24.04.1-LTS-Desktop-x86_64.iso',
  },
  {
    id: 'f_arch',
    title: 'Arch-Linux-2026.11.01-Dual.iso',
    channel: 'Linux Distros',
    sizeBytes: 1_288_490_188,
    published: '1d ago',
    autoDownload: false,
    magnet: 'magnet:?xt=urn:btih:arch2026linux&dn=Arch-Linux-2026.11.01-Dual.iso',
  },
  {
    id: 'f_blender',
    title: 'Blender-4.3.0-Daily-Snapshot.tar.xz',
    channel: 'Blender Releases',
    sizeBytes: 450_887_680,
    published: '5h ago',
    autoDownload: false,
    magnet: 'magnet:?xt=urn:btih:blender430daily&dn=Blender-4.3.0-Daily-Snapshot.tar.xz',
  },
  {
    id: 'f_tears',
    title: 'Tears-Of-Steel-4K-Master-CC.mkv',
    channel: 'Open Media',
    sizeBytes: 1_824_522_240,
    published: '3d ago',
    autoDownload: true,
    magnet: 'magnet:?xt=urn:btih:tearsofsteel4kmaster&dn=Tears-Of-Steel-4K-Master-CC.mkv',
  },
  {
    id: 'f_debian',
    title: 'Debian-12.8.0-netinst-amd64.iso',
    channel: 'Linux Distros',
    sizeBytes: 671_088_640,
    published: '4d ago',
    autoDownload: false,
    magnet: 'magnet:?xt=urn:btih:debian128netinst&dn=Debian-12.8.0-netinst-amd64.iso',
  },
];

export default function FeedsScreen() {
  const insets = useSafeAreaInsets();
  const { startTorrent } = useMaglevEngine();

  const [channels, setChannels] = useState<string[]>([
    'All Feeds',
    'Linux Distros',
    'Blender Releases',
    'Open Media',
  ]);
  const [selectedChannel, setSelectedChannel] = useState('All Feeds');
  const [feedItems, setFeedItems] = useState<FeedItem[]>(INITIAL_FEEDS);
  const [downloadedIds, setDownloadedIds] = useState<string[]>([]);

  // Modal State for adding new RSS feed
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [newFeedUrl, setNewFeedUrl] = useState('');
  const [newChannelName, setNewChannelName] = useState('');
  const [newAutoDownload, setNewAutoDownload] = useState(false);

  const handleDownloadFeed = async (item: FeedItem) => {
    triggerHaptic('medium');
    await startTorrent(item.magnet);
    setDownloadedIds((prev) => [...prev, item.id]);
  };

  const handleAddFeed = () => {
    const channel = newChannelName.trim() || 'Custom Feed';
    if (!channels.includes(channel)) {
      setChannels((prev) => [...prev, channel]);
    }

    const newItem: FeedItem = {
      id: `f_${Date.now()}`,
      title: `${channel} Latest Release`,
      channel,
      sizeBytes: 1_048_576_000,
      published: 'Just now',
      autoDownload: newAutoDownload,
      magnet: `magnet:?xt=urn:btih:custom${Date.now()}&dn=${encodeURIComponent(channel)}`,
    };

    setFeedItems((prev) => [newItem, ...prev]);
    if (newAutoDownload) {
      startTorrent(newItem.magnet);
      setDownloadedIds((prev) => [...prev, newItem.id]);
    }

    setNewFeedUrl('');
    setNewChannelName('');
    setNewAutoDownload(false);
    setAddModalVisible(false);
    triggerHaptic('medium');
  };

  const filteredItems = feedItems.filter(
    (item) => selectedChannel === 'All Feeds' || item.channel === selectedChannel
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <HeaderBar />

      {/* Screen Header & Add Feed Action */}
      <View style={styles.topBar}>
        <View>
          <Text style={styles.screenHeading}>Automated Feeds</Text>
          <Text style={styles.screenSubheading}>
            RSS/Atom channels with smart background release ingestion
          </Text>
        </View>
        <TouchableOpacity
          style={styles.addFeedBtn}
          onPress={() => setAddModalVisible(true)}
          accessibilityRole="button"
          accessibilityLabel="Add RSS Feed"
        >
          <Text style={styles.addFeedBtnText}>+ FEED</Text>
        </TouchableOpacity>
      </View>

      {/* Channel Filter Pills */}
      <View style={styles.channelScrollWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.channelScroll}
        >
          {channels.map((ch) => {
            const isSelected = selectedChannel === ch;
            return (
              <TouchableOpacity
                key={ch}
                style={[
                  styles.channelPill,
                  isSelected ? styles.channelPillActive : styles.channelPillInactive,
                ]}
                onPress={() => {
                  triggerHaptic('light');
                  setSelectedChannel(ch);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Channel ${ch}`}
              >
                <Text
                  style={[
                    styles.channelPillText,
                    isSelected ? styles.channelPillTextActive : styles.channelPillTextInactive,
                  ]}
                >
                  {ch}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Feed Releases List */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.feedScroll}
      >
        <View style={styles.feedList}>
          {filteredItems.map((item) => {
            const isDownloaded = downloadedIds.includes(item.id);
            return (
              <View key={item.id} style={styles.feedCard}>
                <View style={styles.cardHeaderRow}>
                  <View style={styles.channelBadge}>
                    <Text style={styles.channelBadgeText}>{item.channel}</Text>
                  </View>
                  <View style={styles.metaRight}>
                    {item.autoDownload && (
                      <View style={styles.autoBadge}>
                        <Text style={styles.autoBadgeText}>AUTO</Text>
                      </View>
                    )}
                    <Text style={styles.publishedText}>{item.published}</Text>
                  </View>
                </View>

                <Text style={styles.feedTitle} numberOfLines={2}>
                  {item.title}
                </Text>

                <View style={styles.cardFooterRow}>
                  <Text style={styles.sizeText}>{formatBytes(item.sizeBytes)}</Text>

                  <TouchableOpacity
                    style={[styles.downloadBtn, isDownloaded && styles.downloadBtnDone]}
                    onPress={() => !isDownloaded && handleDownloadFeed(item)}
                    disabled={isDownloaded}
                    accessibilityRole="button"
                    accessibilityLabel={
                      isDownloaded
                        ? `Already downloading ${item.title}`
                        : `Download ${item.title}`
                    }
                  >
                    <Text
                      style={[
                        styles.downloadBtnText,
                        isDownloaded && styles.downloadBtnTextDone,
                      ]}
                    >
                      {isDownloaded ? 'ADDED ✓' : '+ DOWNLOAD'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>

      {/* Add RSS Feed Modal */}
      <Modal
        visible={addModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setAddModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add RSS Feed</Text>
            <Text style={styles.modalSubtitle}>
              Subscribe to an RSS or Atom torrent feed for periodic release monitoring.
            </Text>

            <TextInput
              style={styles.modalInput}
              placeholder="https://example.com/releases.xml"
              placeholderTextColor={TOKENS.colors.textMuted}
              value={newFeedUrl}
              onChangeText={setNewFeedUrl}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <TextInput
              style={styles.modalInput}
              placeholder="Channel Name (e.g. Linux Kernels)"
              placeholderTextColor={TOKENS.colors.textMuted}
              value={newChannelName}
              onChangeText={setNewChannelName}
            />

            <View style={styles.modalToggleRow}>
              <View style={styles.modalToggleText}>
                <Text style={styles.modalToggleTitle}>Auto-Download Releases</Text>
                <Text style={styles.modalToggleDesc}>
                  Automatically queue new releases matching channel rules
                </Text>
              </View>
              <Switch
                value={newAutoDownload}
                onValueChange={setNewAutoDownload}
                trackColor={{ false: '#161B22', true: TOKENS.colors.accentLime }}
                thumbColor={newAutoDownload ? '#000000' : TOKENS.colors.textMuted}
              />
            </View>

            <TouchableOpacity
              style={styles.confirmBtn}
              onPress={handleAddFeed}
              accessibilityRole="button"
              accessibilityLabel="Confirm Add Feed"
            >
              <Text style={styles.confirmBtnText}>Add Feed</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => setAddModalVisible(false)}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: TOKENS.colors.bgOled,
  },
  topBar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  screenHeading: {
    color: TOKENS.colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginBottom: 2,
  },
  screenSubheading: {
    color: TOKENS.colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  addFeedBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 14,
    backgroundColor: TOKENS.colors.surfacePill,
    borderWidth: 1,
    borderColor: TOKENS.colors.accentLime,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addFeedBtnText: {
    color: TOKENS.colors.accentLime,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  channelScrollWrapper: {
    marginVertical: 4,
  },
  channelScroll: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    gap: 8,
  },
  channelPill: {
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  channelPillActive: {
    backgroundColor: TOKENS.colors.accentLime,
  },
  channelPillInactive: {
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
  },
  channelPillText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  channelPillTextActive: {
    color: '#000000',
  },
  channelPillTextInactive: {
    color: TOKENS.colors.textMuted,
  },
  feedScroll: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 40,
  },
  feedList: {
    gap: 12,
  },
  feedCard: {
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 12,
    padding: 14,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  channelBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: TOKENS.colors.surfacePill,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
  },
  channelBadgeText: {
    color: TOKENS.colors.accentCyan,
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  metaRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  autoBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(204, 255, 0, 0.1)',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: TOKENS.colors.accentLime,
  },
  autoBadgeText: {
    color: TOKENS.colors.accentLime,
    fontSize: 8,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  publishedText: {
    color: TOKENS.colors.textMuted,
    fontSize: 10,
    fontFamily: 'monospace',
  },
  feedTitle: {
    color: TOKENS.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
    lineHeight: 18,
    marginBottom: 12,
  },
  cardFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sizeText: {
    color: TOKENS.colors.textMuted,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  downloadBtn: {
    minWidth: 96,
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  downloadBtnDone: {
    backgroundColor: TOKENS.colors.surfacePill,
    borderWidth: 1,
    borderColor: TOKENS.colors.accentLime,
  },
  downloadBtnText: {
    color: '#000000',
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  downloadBtnTextDone: {
    color: TOKENS.colors.accentLime,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(5, 7, 10, 0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 14,
    padding: 20,
  },
  modalTitle: {
    color: TOKENS.colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginBottom: 6,
  },
  modalSubtitle: {
    color: TOKENS.colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 16,
  },
  modalInput: {
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: TOKENS.colors.surfacePill,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
    fontFamily: 'monospace',
    marginBottom: 12,
  },
  modalToggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    marginBottom: 16,
  },
  modalToggleText: {
    flex: 1,
    marginRight: 10,
  },
  modalToggleTitle: {
    color: TOKENS.colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginBottom: 2,
  },
  modalToggleDesc: {
    color: TOKENS.colors.textMuted,
    fontSize: 10,
  },
  confirmBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  confirmBtnText: {
    color: '#000000',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  cancelBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    color: TOKENS.colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
});
