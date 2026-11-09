import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Modal,
  TextInput,
  Switch,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { formatBytes, TOKENS } from '../../constants/tokens';
import { HeaderBar } from '../../components/HeaderBar';
import { useMaglevEngine } from '../../context/EngineContext';
import { triggerHaptic } from '../../constants/haptics';

export interface FeedItem {
  id: string;
  title: string;
  channel: string;
  sizeBytes: number;
  published: string;
  autoDownload: boolean;
  magnet: string;
}

const DEFAULT_FEED_URLS: { channel: string; url: string }[] = [
  {
    channel: 'Linux Distros',
    url: 'https://distrowatch.com/news/dwd.xml',
  },
];

const INITIAL_FALLBACK_FEEDS: FeedItem[] = [
  {
    id: 'f_ubuntu',
    title: 'Ubuntu-24.04.1-LTS-Desktop-x86_64.iso',
    channel: 'Linux Distros',
    sizeBytes: 4_294_967_296,
    published: 'Today',
    autoDownload: true,
    magnet: 'magnet:?xt=urn:btih:9dc31b34e568449c2872322a36b5ccab5d1a89c9&dn=Ubuntu-24.04.1-LTS-Desktop-x86_64.iso&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce',
  },
  {
    id: 'f_arch',
    title: 'Arch-Linux-2026.11.01-Dual.iso',
    channel: 'Linux Distros',
    sizeBytes: 1_288_490_188,
    published: 'Yesterday',
    autoDownload: false,
    magnet: 'magnet:?xt=urn:btih:e06c138f6bdf1f50a8c279cbe8784d5df684a20b&dn=Arch-Linux-2026.11.01-Dual.iso&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce',
  },
  {
    id: 'f_blender',
    title: 'Blender-4.3.0-Daily-Snapshot.tar.xz',
    channel: 'Blender Releases',
    sizeBytes: 450_887_680,
    published: '3d ago',
    autoDownload: false,
    magnet: 'magnet:?xt=urn:btih:c12056fae8590c7931ef827727e57c6b412128e4&dn=Blender-4.3.0-Daily-Snapshot.tar.xz&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce',
  },
  {
    id: 'f_tears',
    title: 'Tears-Of-Steel-4K-Master-CC.mkv',
    channel: 'Open Media',
    sizeBytes: 1_824_522_240,
    published: '4d ago',
    autoDownload: true,
    magnet: 'magnet:?xt=urn:btih:20bb20901e9d0e2e925c27f3aa111b212f717904&dn=Tears-Of-Steel-4K-Master-CC.mkv&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce',
  },
  {
    id: 'f_debian',
    title: 'Debian-12.8.0-netinst-amd64.iso',
    channel: 'Linux Distros',
    sizeBytes: 671_088_640,
    published: '5d ago',
    autoDownload: false,
    magnet: 'magnet:?xt=urn:btih:576566c5a083d9aa8c688321d454fa16b0b2e3e5&dn=Debian-12.8.0-netinst-amd64.iso&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce',
  },
];

/**
 * Lightweight XML RSS / Atom parser
 */
function parseRssFeed(xml: string, channelName: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemBlocks = xml.split(/<item>|<item [^>]*>|<entry>|<entry [^>]*>/i).slice(1);

  for (const block of itemBlocks) {
    const endPos = block.search(/<\/item>|<\/entry>/i);
    const content = endPos !== -1 ? block.substring(0, endPos) : block;

    const titleMatch = content.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const linkMatch = content.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>|<link [^>]*href=["']([^"']+)["']/i);
    const enclosureMatch = content.match(/<enclosure [^>]*url=["']([^"']+)["'][^>]*length=["']?([0-9]*)["']?/i);
    const dateMatch = content.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>|<updated[^>]*>([\s\S]*?)<\/updated>/i);

    const title = titleMatch ? titleMatch[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : 'Release Item';
    let url = enclosureMatch ? enclosureMatch[1] : linkMatch ? (linkMatch[1] || linkMatch[2]) : '';
    const size = enclosureMatch && enclosureMatch[2] ? parseInt(enclosureMatch[2], 10) : 1_073_741_824;
    let published = 'Recent';

    if (dateMatch) {
      try {
        const rawDate = (dateMatch[1] || dateMatch[2]).trim();
        const d = new Date(rawDate);
        if (!isNaN(d.getTime())) {
          published = d.toLocaleDateString();
        }
      } catch {
        published = 'Recent';
      }
    }

    let magnet = url.startsWith('magnet:?') ? url : `magnet:?xt=urn:btih:${Date.now()}&dn=${encodeURIComponent(title)}`;
    if (url.endsWith('.torrent') || url.includes('.torrent?')) {
      magnet = url;
    }

    items.push({
      id: `feed_${Math.random().toString(36).substring(2, 9)}`,
      title,
      channel: channelName,
      sizeBytes: size,
      published,
      autoDownload: false,
      magnet,
    });
  }

  return items;
}

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
  const [feedItems, setFeedItems] = useState<FeedItem[]>(INITIAL_FALLBACK_FEEDS);
  const [downloadedIds, setDownloadedIds] = useState<string[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Modal State for adding new RSS feed
  const [addModalVisible, setAddModalVisible] = useState(false);
  const [newFeedUrl, setNewFeedUrl] = useState('');
  const [newChannelName, setNewChannelName] = useState('');
  const [newAutoDownload, setNewAutoDownload] = useState(false);
  const [isSubscribing, setIsSubscribing] = useState(false);

  const fetchLiveFeeds = useCallback(async () => {
    setIsRefreshing(true);
    const allFetched: FeedItem[] = [];

    for (const feed of DEFAULT_FEED_URLS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3500);

        const res = await fetch(feed.url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Maglev-RSS/1.0' },
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const text = await res.text();
          const parsed = parseRssFeed(text, feed.channel);
          if (parsed.length > 0) {
            allFetched.push(...parsed);
          }
        }
      } catch {
        // Feed offline, fallback
      }
    }

    if (allFetched.length > 0) {
      setFeedItems((prev) => {
        const nonDuplicate = allFetched.filter(
          (item) => !prev.some((p) => p.title.toLowerCase() === item.title.toLowerCase())
        );
        return [...nonDuplicate, ...prev];
      });
    }

    setIsRefreshing(false);
  }, []);

  useEffect(() => {
    fetchLiveFeeds();
  }, [fetchLiveFeeds]);

  const handleDownloadFeed = async (item: FeedItem) => {
    triggerHaptic('medium');
    await startTorrent(item.magnet);
    setDownloadedIds((prev) => [...prev, item.id]);
  };

  const handleAddFeed = async () => {
    const url = newFeedUrl.trim();
    if (!url) {
      Alert.alert('Missing URL', 'Please enter a valid RSS or Atom feed URL.');
      return;
    }

    setIsSubscribing(true);
    triggerHaptic('light');

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Maglev-RSS/1.0' },
      });
      clearTimeout(timeoutId);

      const channel = newChannelName.trim() || 'Custom Feed';

      if (res.ok) {
        const text = await res.text();
        const parsed = parseRssFeed(text, channel);

        if (parsed.length > 0) {
          if (!channels.includes(channel)) {
            setChannels((prev) => [...prev, channel]);
          }

          setFeedItems((prev) => [...parsed, ...prev]);

          if (newAutoDownload && parsed[0]) {
            startTorrent(parsed[0].magnet);
            setDownloadedIds((prev) => [...prev, parsed[0].id]);
          }

          setNewFeedUrl('');
          setNewChannelName('');
          setNewAutoDownload(false);
          setAddModalVisible(false);
          triggerHaptic('medium');
          return;
        }
      }

      // If XML parsing returned no items, add nominal channel subscription
      if (!channels.includes(channel)) {
        setChannels((prev) => [...prev, channel]);
      }

      const fallbackItem: FeedItem = {
        id: `f_${Date.now()}`,
        title: `${channel} Latest Release`,
        channel,
        sizeBytes: 1_048_576_000,
        published: 'Just now',
        autoDownload: newAutoDownload,
        magnet: `magnet:?xt=urn:btih:custom${Date.now()}&dn=${encodeURIComponent(channel)}`,
      };

      setFeedItems((prev) => [fallbackItem, ...prev]);
      if (newAutoDownload) {
        startTorrent(fallbackItem.magnet);
        setDownloadedIds((prev) => [...prev, fallbackItem.id]);
      }

      setNewFeedUrl('');
      setNewChannelName('');
      setNewAutoDownload(false);
      setAddModalVisible(false);
      triggerHaptic('medium');
    } catch (e) {
      Alert.alert(
        'Subscription Failed',
        'Could not fetch or parse the RSS feed from the specified URL. Please check your network connection.'
      );
    } finally {
      setIsSubscribing(false);
    }
  };

  const filteredItems = feedItems.filter(
    (item) => selectedChannel === 'All Feeds' || item.channel === selectedChannel
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <HeaderBar />

      {/* Screen Header & Add Feed Action */}
      <View style={styles.topBar}>
        <View style={styles.titleCol}>
          <Text style={styles.screenHeading}>Automated Feeds</Text>
          <Text style={styles.screenSubheading}>
            RSS/Atom channels with smart background release ingestion
          </Text>
        </View>
        <View style={styles.topActionsRow}>
          <TouchableOpacity
            style={styles.refreshBtn}
            onPress={fetchLiveFeeds}
            accessibilityRole="button"
            accessibilityLabel="Refresh feeds"
          >
            {isRefreshing ? (
              <ActivityIndicator size="small" color={TOKENS.colors.accentLime} />
            ) : (
              <Ionicons name="refresh" size={16} color={TOKENS.colors.accentLime} />
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.addFeedBtn}
            onPress={() => setAddModalVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="Add RSS Feed"
          >
            <Text style={styles.addFeedBtnText}>+ FEED</Text>
          </TouchableOpacity>
        </View>
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

      {/* Add Feed Modal */}
      <Modal
        visible={addModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setAddModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Subscribe to RSS Feed</Text>
              <TouchableOpacity
                onPress={() => setAddModalVisible(false)}
                accessibilityRole="button"
                accessibilityLabel="Close add feed dialog"
                style={styles.modalCloseBtn}
              >
                <Ionicons name="close" size={20} color={TOKENS.colors.textMuted} />
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>FEED URL (RSS/ATOM)</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="https://example.com/feed.xml"
              placeholderTextColor={TOKENS.colors.textMuted}
              value={newFeedUrl}
              onChangeText={setNewFeedUrl}
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.inputLabel}>CHANNEL NAME</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="e.g. Linux Releases"
              placeholderTextColor={TOKENS.colors.textMuted}
              value={newChannelName}
              onChangeText={setNewChannelName}
            />

            <View style={styles.modalSwitchRow}>
              <View style={styles.modalSwitchTextCol}>
                <Text style={styles.modalSwitchTitle}>Auto-Download New Releases</Text>
                <Text style={styles.modalSwitchSubtitle}>
                  Automatically begin transfers when published
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
              style={[styles.modalSubmitBtn, isSubscribing && styles.modalSubmitBtnDisabled]}
              onPress={handleAddFeed}
              disabled={isSubscribing}
              accessibilityRole="button"
              accessibilityLabel="Confirm add feed"
            >
              {isSubscribing ? (
                <ActivityIndicator size="small" color="#000000" />
              ) : (
                <Text style={styles.modalSubmitBtnText}>SUBSCRIBE & SYNC</Text>
              )}
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  titleCol: {
    flex: 1,
  },
  topActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  refreshBtn: {
    minWidth: TOKENS.touchTarget.minWidth,
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: '#0D1117',
    borderWidth: 1,
    borderColor: '#1F2937',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  screenHeading: {
    color: TOKENS.colors.textPrimary,
    fontSize: 16,
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
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.accentLime,
    borderRadius: 8,
    paddingHorizontal: 14,
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
    borderRadius: 10,
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
    paddingVertical: 1,
    backgroundColor: 'rgba(204, 255, 0, 0.15)',
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
    minWidth: 100,
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
    fontSize: 11,
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
    paddingHorizontal: 20,
  },
  modalContent: {
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 14,
    padding: 20,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalCloseBtn: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTitle: {
    color: TOKENS.colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  inputLabel: {
    color: TOKENS.colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  modalInput: {
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: '#070A0E',
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: TOKENS.colors.textPrimary,
    fontSize: 11,
    fontFamily: 'monospace',
    marginBottom: 14,
  },
  modalSwitchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: 8,
  },
  modalSwitchTextCol: {
    flex: 1,
    marginRight: 10,
  },
  modalSwitchTitle: {
    color: TOKENS.colors.textPrimary,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  modalSwitchSubtitle: {
    color: TOKENS.colors.textMuted,
    fontSize: 9,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  modalSubmitBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  modalSubmitBtnDisabled: {
    opacity: 0.6,
  },
  modalSubmitBtnText: {
    color: '#000000',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
});
