import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { TOKENS } from '../../constants/tokens';
import { HeaderBar } from '../../components/HeaderBar';

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
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <HeaderBar />

      <View style={styles.searchBarContainer}>
        <View style={styles.searchInputRow}>
          <Ionicons name="search" size={16} color={TOKENS.colors.accentCyan} style={{ marginRight: 8 }} />
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
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryScroll}>
          {CATEGORIES.map((cat) => {
            const isSelected = selectedCategory === cat;
            return (
              <TouchableOpacity
                key={cat}
                style={[styles.catPill, isSelected ? styles.catPillActive : styles.catPillInactive]}
                onPress={() => setSelectedCategory(cat)}
                accessibilityRole="button"
                accessibilityLabel={`Category ${cat}`}
              >
                <Text style={[styles.catPillText, isSelected ? styles.catPillTextActive : styles.catPillTextInactive]}>
                  {cat}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <View style={styles.emptyContainer}>
        <Ionicons name="compass-outline" size={48} color={TOKENS.colors.surfaceBorder} />
        <Text style={styles.emptyTitle}>Swarm Search</Text>
        <Text style={styles.emptySubtitle}>
          Enter a search query or select a category to discover swarms across public providers.
        </Text>
      </View>
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
    padding: 6,
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
  emptyContainer: {
    flex: 1,
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
