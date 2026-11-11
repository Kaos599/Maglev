import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { formatBytes, TOKENS } from '../../constants/tokens';
import { HeaderBar } from '../../components/HeaderBar';
import { useMaglevEngine } from '../../context/EngineContext';
import { triggerHaptic } from '../../constants/haptics';

export interface SwarmSearchResult {
  id: string;
  title: string;
  category: string;
  sizeBytes: number;
  seeds: number;
  peers: number;
  magnet: string;
}

const CURATED_SWARMS: SwarmSearchResult[] = [
  {
    id: 'sw_ubuntu_24',
    title: 'Ubuntu-24.04-desktop-amd64.iso',
    category: 'Apps',
    sizeBytes: 4_294_967_296,
    seeds: 1842,
    peers: 142,
    magnet: 'magnet:?xt=urn:btih:9dc31b34e568449c2872322a36b5ccab5d1a89c9&dn=Ubuntu-24.04-desktop-amd64.iso&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce',
  },
  {
    id: 'sw_arch_linux',
    title: 'ArchLinux-2026.11.01-x86_64.iso',
    category: 'Apps',
    sizeBytes: 1_288_490_188,
    seeds: 924,
    peers: 78,
    magnet: 'magnet:?xt=urn:btih:e06c138f6bdf1f50a8c279cbe8784d5df684a20b&dn=ArchLinux-2026.11.01-x86_64.iso&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce',
  },
  {
    id: 'sw_debian_12',
    title: 'Debian-12.8.0-netinst.iso',
    category: 'Apps',
    sizeBytes: 671_088_640,
    seeds: 612,
    peers: 34,
    magnet: 'magnet:?xt=urn:btih:576566c5a083d9aa8c688321d454fa16b0b2e3e5&dn=Debian-12.8.0-netinst.iso&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce',
  },
  {
    id: 'sw_bbb_4k',
    title: 'Big-Buck-Bunny-4K-Surround.mkv',
    category: 'Movies',
    sizeBytes: 891_289_600,
    seeds: 412,
    peers: 28,
    magnet: 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big-Buck-Bunny-4K-Surround.mkv&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce',
  },
  {
    id: 'sw_tears_of_steel',
    title: 'Tears-Of-Steel-UHD-Master.mkv',
    category: 'Movies',
    sizeBytes: 1_503_238_553,
    seeds: 350,
    peers: 19,
    magnet: 'magnet:?xt=urn:btih:20bb20901e9d0e2e925c27f3aa111b212f717904&dn=Tears-Of-Steel-UHD-Master.mkv&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce',
  },
  {
    id: 'sw_blender_demo',
    title: 'Blender-Studio-Wing-It-Anime.mkv',
    category: 'Anime',
    sizeBytes: 566_231_040,
    seeds: 280,
    peers: 14,
    magnet: 'magnet:?xt=urn:btih:c12056fae8590c7931ef827727e57c6b412128e4&dn=Blender-Studio-Wing-It-Anime.mkv&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce',
  },
  {
    id: 'sw_nin_ghosts',
    title: 'Nine-Inch-Nails-Ghosts-I-IV-FLAC',
    category: 'Music',
    sizeBytes: 1_932_735_283,
    seeds: 512,
    peers: 42,
    magnet: 'magnet:?xt=urn:btih:5a0928e086f03407e3a6efad69b8bd59cfc8135a&dn=Nine-Inch-Nails-Ghosts-I-IV-FLAC&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce',
  },
  {
    id: 'sw_ebooks_master',
    title: 'Standard-Ebooks-Anthology-2026.epub',
    category: 'Books',
    sizeBytes: 125_829_120,
    seeds: 180,
    peers: 8,
    magnet: 'magnet:?xt=urn:btih:a88fda5954e89178c372716a6a78b8180ed4dad3&dn=Standard-Ebooks-Anthology-2026.epub&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce',
  },
];

const CATEGORIES = [
  'All',
  'Anime',
  'Apps',
  'Books',
  'Games',
  'Movies',
  'Music',
  'Others',
];

function mapCategory(catNum: string | number): string {
  const n = typeof catNum === 'number' ? catNum : parseInt(catNum, 10);
  if (n >= 100 && n < 200) return 'Music';
  if (n >= 200 && n < 300) return 'Movies';
  if (n >= 300 && n < 400) return 'Apps';
  if (n >= 400 && n < 500) return 'Games';
  if (n >= 600 && n < 700) return 'Books';
  return 'Others';
}

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { startTorrent } = useMaglevEngine();

  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [addedIds, setAddedIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [onlineResults, setOnlineResults] = useState<SwarmSearchResult[] | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchLiveSwarms = useCallback(async (searchQuery: string, category: string) => {
    if (!searchQuery.trim()) {
      setOnlineResults(null);
      return;
    }

    setIsLoading(true);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000);

      // Query public BitTorrent indexer API (apibay)
      let apiUrl = `https://apibay.org/q.php?q=${encodeURIComponent(searchQuery.trim())}`;
      if (category === 'Movies') apiUrl += '&cat=200';
      else if (category === 'Music') apiUrl += '&cat=100';
      else if (category === 'Apps') apiUrl += '&cat=300';
      else if (category === 'Games') apiUrl += '&cat=400';
      else if (category === 'Books') apiUrl += '&cat=601';

      const res = await fetch(apiUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Maglev-Client/1.0' },
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0 && data[0].id !== '0' && data[0].name !== 'No results returned') {
          const mapped: SwarmSearchResult[] = data.map((item: any) => ({
            id: item.info_hash || `sw_${Math.random()}`,
            title: item.name || 'Unknown Swarm',
            category: mapCategory(item.category),
            sizeBytes: parseInt(item.size || '0', 10),
            seeds: parseInt(item.seeders || '0', 10),
            peers: parseInt(item.leechers || '0', 10),
            magnet: `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(
              item.name || ''
            )}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce`,
          }));
          setOnlineResults(mapped);
          return;
        }
      }
      setOnlineResults([]);
    } catch {
      // Offline fallback
      setOnlineResults(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleQueryChange = (text: string) => {
    setQuery(text);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (!text.trim()) {
      setOnlineResults(null);
      setIsLoading(false);
      return;
    }

    debounceRef.current = setTimeout(() => {
      fetchLiveSwarms(text, selectedCategory);
    }, 450);
  };

  const handleSelectCategory = (cat: string) => {
    triggerHaptic('light');
    setSelectedCategory(cat);
    if (query.trim()) {
      fetchLiveSwarms(query, cat);
    }
  };

  const handleAddSwarm = async (item: SwarmSearchResult) => {
    triggerHaptic('medium');
    await startTorrent(item.magnet);
    setAddedIds((prev) => [...prev, item.id]);
  };

  // Determine active display list
  const activeResults: SwarmSearchResult[] = onlineResults !== null
    ? onlineResults.filter((item) => selectedCategory === 'All' || item.category === selectedCategory)
    : CURATED_SWARMS.filter((item) => {
        const matchesCategory = selectedCategory === 'All' || item.category === selectedCategory;
        const matchesQuery = query.trim().length === 0 || item.title.toLowerCase().includes(query.trim().toLowerCase());
        return matchesCategory && matchesQuery;
      });

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <HeaderBar />

      <View style={styles.searchBarContainer}>
        <View style={styles.searchInputRow}>
          <Ionicons
            name="search"
            size={16}
            color={TOKENS.colors.accentCyan}
            style={{ marginRight: 8 }}
          />
          <TextInput
            style={styles.searchInput}
            placeholder="Search public torrent swarms..."
            placeholderTextColor={TOKENS.colors.textMuted}
            value={query}
            onChangeText={handleQueryChange}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => handleQueryChange('')} style={styles.clearBtn} accessibilityRole="button" accessibilityLabel="Clear search query">
              <Ionicons name="close-circle" size={16} color={TOKENS.colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Category Filter Pills */}
      <View style={styles.categoryScrollWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.categoryScroll}
        >
          {CATEGORIES.map((cat) => {
            const isSelected = selectedCategory === cat;
            return (
              <TouchableOpacity
                key={cat}
                style={[
                  styles.catPill,
                  isSelected ? styles.catPillActive : styles.catPillInactive,
                ]}
                onPress={() => handleSelectCategory(cat)}
                accessibilityRole="button"
                accessibilityLabel={`Filter by ${cat}`}
              >
                <Text
                  style={[
                    styles.catPillText,
                    isSelected ? styles.catPillTextActive : styles.catPillTextInactive,
                  ]}
                >
                  {cat}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Live Indexer Loading Indicator */}
      {isLoading && (
        <View style={styles.indexerLoaderRow}>
          <ActivityIndicator size="small" color={TOKENS.colors.accentCyan} />
          <Text style={styles.indexerLoaderText}>QUERYING PUBLIC SWARMS IN REAL TIME...</Text>
        </View>
      )}

      {/* Search Results List or Empty State */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.resultsScroll}
      >
        {activeResults.length > 0 ? (
          <View style={styles.resultsList}>
            {activeResults.map((item) => {
              const isAdded = addedIds.includes(item.id);
              return (
                <View key={item.id} style={styles.resultCard}>
                  <View style={styles.cardHeaderRow}>
                    <View style={styles.categoryBadge}>
                      <Text style={styles.categoryBadgeText}>{item.category}</Text>
                    </View>
                    <Text style={styles.sizeText}>{formatBytes(item.sizeBytes)}</Text>
                  </View>

                  <Text style={styles.resultTitle} numberOfLines={2}>
                    {item.title}
                  </Text>

                  <View style={styles.cardFooterRow}>
                    <View style={styles.swarmMeta}>
                      <Text style={styles.metaSeeds}>↑ {item.seeds}</Text>
                      <Text style={styles.metaPeers}>↓ {item.peers}</Text>
                      <Text style={styles.metaHealth}>
                        {item.seeds >= 50 ? 'HEALTHY' : item.seeds > 0 ? 'ACTIVE' : 'LOW PEERS'}
                      </Text>
                    </View>

                    <TouchableOpacity
                      style={[styles.addBtn, isAdded && styles.addBtnDone]}
                      onPress={() => !isAdded && handleAddSwarm(item)}
                      disabled={isAdded}
                      accessibilityRole="button"
                      accessibilityLabel={isAdded ? `Already added ${item.title}` : `Add ${item.title}`}
                    >
                      <Text style={[styles.addBtnText, isAdded && styles.addBtnTextDone]}>
                        {isAdded ? 'ADDED ✓' : '+ ADD'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </View>
        ) : (
          <View style={styles.emptyContainer}>
            <Ionicons name="compass-outline" size={48} color={TOKENS.colors.surfaceBorder} />
            <Text style={styles.emptyTitle}>No Matching Swarms Found</Text>
            <Text style={styles.emptySubtitle}>
              {query.trim().length > 0
                ? `Zero public seeds detected for "${query}". Try different terms or categories.`
                : 'Enter a search keyword to query public BitTorrent swarms.'}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: TOKENS.colors.bgOled,
  },
  searchBarContainer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  searchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: TOKENS.touchTarget.minHeight,
  },
  searchInput: {
    flex: 1,
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  clearBtn: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryScrollWrapper: {
    marginVertical: 4,
  },
  categoryScroll: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    gap: 8,
  },
  catPill: {
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catPillActive: {
    backgroundColor: TOKENS.colors.accentLime,
  },
  catPillInactive: {
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
  },
  catPillText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  catPillTextActive: {
    color: '#000000',
  },
  catPillTextInactive: {
    color: TOKENS.colors.textMuted,
  },
  indexerLoaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 8,
    backgroundColor: '#09131C',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0, 229, 255, 0.2)',
  },
  indexerLoaderText: {
    color: TOKENS.colors.accentCyan,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 0.5,
  },
  resultsScroll: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 40,
  },
  resultsList: {
    gap: 12,
  },
  resultCard: {
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
  categoryBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: TOKENS.colors.surfacePill,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
  },
  categoryBadgeText: {
    color: TOKENS.colors.accentCyan,
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  sizeText: {
    color: TOKENS.colors.textMuted,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  resultTitle: {
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
  swarmMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  metaSeeds: {
    color: TOKENS.colors.accentLime,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  metaPeers: {
    color: TOKENS.colors.accentCyan,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  metaHealth: {
    color: TOKENS.colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 0.5,
  },
  addBtn: {
    minWidth: 84,
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  addBtnDone: {
    backgroundColor: TOKENS.colors.surfacePill,
    borderWidth: 1,
    borderColor: TOKENS.colors.accentLime,
  },
  addBtnText: {
    color: '#000000',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  addBtnTextDone: {
    color: TOKENS.colors.accentLime,
  },
  emptyContainer: {
    paddingVertical: 60,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: TOKENS.colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginTop: 16,
    marginBottom: 6,
  },
  emptySubtitle: {
    color: TOKENS.colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },
});
