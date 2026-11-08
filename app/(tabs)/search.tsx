import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { formatBytes, TOKENS } from '../../constants/tokens';
import { HeaderBar } from '../../components/HeaderBar';
import { useMaglevEngine } from '../../context/EngineContext';
import { triggerHaptic } from '../../constants/haptics';

interface SwarmSearchResult {
  id: string;
  title: string;
  category: string;
  sizeBytes: number;
  seeds: number;
  peers: number;
  magnet: string;
}

const PUBLIC_SWARMS: SwarmSearchResult[] = [
  {
    id: 'sw_ubuntu_24',
    title: 'Ubuntu-24.04-desktop-amd64.iso',
    category: 'Apps',
    sizeBytes: 4_294_967_296,
    seeds: 1842,
    peers: 142,
    magnet: 'magnet:?xt=urn:btih:ubuntu2404desktop&dn=Ubuntu-24.04-desktop-amd64.iso',
  },
  {
    id: 'sw_arch_linux',
    title: 'ArchLinux-2026.11.01-x86_64.iso',
    category: 'Apps',
    sizeBytes: 1_288_490_188,
    seeds: 924,
    peers: 78,
    magnet: 'magnet:?xt=urn:btih:arch2026linux&dn=ArchLinux-2026.11.01-x86_64.iso',
  },
  {
    id: 'sw_debian_12',
    title: 'Debian-12.8.0-netinst.iso',
    category: 'Apps',
    sizeBytes: 671_088_640,
    seeds: 612,
    peers: 34,
    magnet: 'magnet:?xt=urn:btih:debian128netinst&dn=Debian-12.8.0-netinst.iso',
  },
  {
    id: 'sw_bbb_4k',
    title: 'Big-Buck-Bunny-4K-Surround.mkv',
    category: 'Movies',
    sizeBytes: 891_289_600,
    seeds: 412,
    peers: 28,
    magnet: 'magnet:?xt=urn:btih:bigbuckbunny4k&dn=Big-Buck-Bunny-4K-Surround.mkv',
  },
  {
    id: 'sw_tears_of_steel',
    title: 'Tears-Of-Steel-UHD-Master.mkv',
    category: 'Movies',
    sizeBytes: 1_503_238_553,
    seeds: 350,
    peers: 19,
    magnet: 'magnet:?xt=urn:btih:tearsofsteeluhd&dn=Tears-Of-Steel-UHD-Master.mkv',
  },
  {
    id: 'sw_blender_demo',
    title: 'Blender-Studio-Wing-It-Anime.mkv',
    category: 'Anime',
    sizeBytes: 566_231_040,
    seeds: 280,
    peers: 14,
    magnet: 'magnet:?xt=urn:btih:blenderswingit&dn=Blender-Studio-Wing-It-Anime.mkv',
  },
  {
    id: 'sw_nin_ghosts',
    title: 'Nine-Inch-Nails-Ghosts-I-IV-FLAC',
    category: 'Music',
    sizeBytes: 1_932_735_283,
    seeds: 512,
    peers: 42,
    magnet: 'magnet:?xt=urn:btih:ninghostsiivflac&dn=Nine-Inch-Nails-Ghosts-I-IV-FLAC',
  },
  {
    id: 'sw_ebooks_master',
    title: 'Standard-Ebooks-Anthology-2026.epub',
    category: 'Books',
    sizeBytes: 125_829_120,
    seeds: 180,
    peers: 8,
    magnet: 'magnet:?xt=urn:btih:standardebooks2026&dn=Standard-Ebooks-Anthology-2026.epub',
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

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { startTorrent } = useMaglevEngine();

  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [addedIds, setAddedIds] = useState<string[]>([]);

  const handleAddSwarm = async (item: SwarmSearchResult) => {
    triggerHaptic('medium');
    await startTorrent(item.magnet);
    setAddedIds((prev) => [...prev, item.id]);
  };

  const filteredResults = PUBLIC_SWARMS.filter((item) => {
    const matchesCategory =
      selectedCategory === 'All' || item.category === selectedCategory;
    const matchesQuery =
      query.trim().length === 0 ||
      item.title.toLowerCase().includes(query.trim().toLowerCase());
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
            placeholder="Search torrent swarms..."
            placeholderTextColor={TOKENS.colors.textMuted}
            value={query}
            onChangeText={setQuery}
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')} style={styles.clearBtn}>
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
                onPress={() => {
                  triggerHaptic('light');
                  setSelectedCategory(cat);
                }}
                accessibilityRole="button"
                accessibilityLabel={`Category ${cat}`}
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

      {/* Search Results List or Empty State */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.resultsScroll}
      >
        {filteredResults.length > 0 ? (
          <View style={styles.resultsList}>
            {filteredResults.map((item) => {
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
                      <Text style={styles.metaHealth}>HEALTHY</Text>
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
            <Text style={styles.emptyTitle}>No Matching Swarms</Text>
            <Text style={styles.emptySubtitle}>
              Try searching for a different keyword or selecting another category filter.
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
