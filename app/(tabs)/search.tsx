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

export interface SearchResult {
  id: string;
  title: string;
  category: string;
  sizeBytes: number;
  seeds: number;
  peers: number;
  magnet: string;
}

const QUICK_TOPICS = [
  'Ubuntu',
  'Arch Linux',
  'Debian',
  'Blender',
  'Big Buck Bunny',
  'Tears of Steel',
  'Alpine',
  'Open Source',
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
  const [onlineResults, setOnlineResults] = useState<SearchResult[] | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const fetchLiveResults = useCallback(async (searchQuery: string, category: string) => {
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
          const mapped: SearchResult[] = data.map((item: any) => ({
            id: item.info_hash || `tor_${Math.random()}`,
            title: item.name || 'Unknown Torrent',
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
      setOnlineResults([]);
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
      fetchLiveResults(text, selectedCategory);
    }, 450);
  };

  const handleSelectCategory = (cat: string) => {
    triggerHaptic('light');
    setSelectedCategory(cat);
    if (query.trim()) {
      fetchLiveResults(query, cat);
    }
  };

  const handleAddTorrent = async (item: SearchResult) => {
    triggerHaptic('medium');
    await startTorrent(item.magnet);
    setAddedIds((prev) => [...prev, item.id]);
    setToastMessage(`Added "${item.title}" to Downloads`);
  };

  // Determine active display list
  const activeResults: SearchResult[] = onlineResults !== null
    ? onlineResults.filter((item) => selectedCategory === 'All' || item.category === selectedCategory)
    : [];

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
            placeholder="Search torrents..."
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
          <Text style={styles.indexerLoaderText}>SEARCHING ONLINE...</Text>
        </View>
      )}

      {/* Search Results List or Empty State */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.resultsScroll}
      >
        {query.trim().length === 0 && onlineResults === null ? (
          <View style={styles.discoveryContainer}>
            <Text style={styles.discoveryHeading}>POPULAR SEARCHES</Text>
            <View style={styles.topicChipsGrid}>
              {QUICK_TOPICS.map((topic) => (
                <TouchableOpacity
                  key={topic}
                  style={styles.topicChip}
                  onPress={() => {
                    triggerHaptic('selection');
                    setQuery(topic);
                    fetchLiveResults(topic, selectedCategory);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Search topic ${topic}`}
                >
                  <Ionicons name="search" size={12} color={TOKENS.colors.accentCyan} style={{ marginRight: 6 }} />
                  <Text style={styles.topicChipText}>{topic}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.discoveryHint}>
              Select a quick search topic or enter keywords above.
            </Text>
          </View>
        ) : activeResults.length > 0 ? (
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
                    <View style={styles.resultMeta}>
                      <Text style={styles.metaSeeds}>↑ {item.seeds}</Text>
                      <Text style={styles.metaPeers}>↓ {item.peers}</Text>
                      <Text style={styles.metaHealth}>
                        {item.seeds >= 50 ? 'HEALTHY' : item.seeds > 0 ? 'ACTIVE' : 'FEW PEERS'}
                      </Text>
                    </View>

                    <TouchableOpacity
                      style={[styles.addBtn, isAdded && styles.addBtnDone]}
                      onPress={() => !isAdded && handleAddTorrent(item)}
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
            <Text style={styles.emptyTitle}>No Torrents Found</Text>
            <Text style={styles.emptySubtitle}>
              {query.trim().length > 0
                ? `Zero public seeds detected for "${query}". Try different terms or categories.`
                : 'Enter a search keyword to query public BitTorrent indexers.'}
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Added Confirmation Banner */}
      {toastMessage && (
        <View style={styles.toastBanner}>
          <View style={styles.toastLeft}>
            <Ionicons name="checkmark-circle" size={16} color={TOKENS.colors.accentLime} style={{ marginRight: 8 }} />
            <Text style={styles.toastText} numberOfLines={1}>
              {toastMessage}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.toastActionBtn}
            onPress={() => {
              triggerHaptic('light');
              router.push('/(tabs)');
            }}
            accessibilityRole="button"
            accessibilityLabel="View in Transfers"
          >
            <Text style={styles.toastActionText}>VIEW TRANSFERS</Text>
          </TouchableOpacity>
        </View>
      )}
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
  resultMeta: {
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
  discoveryContainer: {
    paddingVertical: 24,
    paddingHorizontal: 8,
  },
  discoveryHeading: {
    fontFamily: 'Silkscreen',
    fontSize: 11,
    fontWeight: '700',
    color: TOKENS.colors.textMuted,
    marginBottom: 12,
    letterSpacing: 0.8,
  },
  topicChipsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  topicChip: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: '#11161F',
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 22,
    paddingHorizontal: 14,
  },
  topicChipText: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: TOKENS.colors.textPrimary,
  },
  discoveryHint: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: TOKENS.colors.textMuted,
    lineHeight: 18,
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
  toastBanner: {
    position: 'absolute',
    bottom: 16,
    left: 16,
    right: 16,
    backgroundColor: '#161B22',
    borderWidth: 1,
    borderColor: TOKENS.colors.accentLime,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    minHeight: 52,
    elevation: 6,
    shadowColor: TOKENS.colors.accentLime,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  toastLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 10,
  },
  toastText: {
    flex: 1,
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: TOKENS.colors.textPrimary,
  },
  toastActionBtn: {
    minHeight: TOKENS.touchTarget.minHeight,
    minWidth: 80,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  toastActionText: {
    fontFamily: 'Silkscreen',
    fontSize: 9,
    fontWeight: '700',
    color: '#000000',
  },
});
