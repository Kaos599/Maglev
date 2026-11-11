import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  LayoutAnimation,
  Platform,
  UIManager,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { HeaderBar } from '../../components/HeaderBar';
import { FilterPills } from '../../components/FilterPills';
import { TransferCard } from '../../components/TransferCard';
import { EmptyState } from '../../components/EmptyState';
import { FloatingActionButton } from '../../components/FloatingActionButton';
import { PixelSearchIcon } from '../../components/PixelIcons';
import { triggerHaptic } from '../../constants/haptics';
import { useMaglevEngine } from '../../context/EngineContext';
import { useTheme } from '../../context/ThemeContext';
import { fonts, touch, ThemeColors } from '../../constants/theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function TransfersScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { filteredTorrents } = useMaglevEngine();

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleToggleSearch = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setIsSearchOpen((prev) => {
      if (prev) {
        setSearchQuery('');
      }
      return !prev;
    });
  }, []);

  const displayedTorrents = useMemo(() => {
    if (!searchQuery.trim()) {
      return filteredTorrents;
    }
    const query = searchQuery.trim().toLowerCase();
    return filteredTorrents.filter((t) => t.name.toLowerCase().includes(query));
  }, [filteredTorrents, searchQuery]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <HeaderBar
        onSearchPress={handleToggleSearch}
        isSearchActive={isSearchOpen || searchQuery.length > 0}
      />

      {isSearchOpen && (
        <View style={styles.searchContainer}>
          <View style={styles.searchInputWrapper}>
            <PixelSearchIcon size={14} color={colors.download} />
            <TextInput
              style={styles.searchInput}
              placeholder="Filter transfers by name..."
              placeholderTextColor={colors.textFaint}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
              returnKeyType="search"
              accessibilityLabel="Filter transfers by name"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity
                style={styles.clearSearchTouch}
                onPress={() => {
                  triggerHaptic('light');
                  setSearchQuery('');
                }}
                accessibilityRole="button"
                accessibilityLabel="Clear search input"
              >
                <Ionicons name="close" size={16} color={colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      <FilterPills />

      {displayedTorrents.length === 0 ? (
        searchQuery.trim() ? (
          <View style={styles.noResultsContainer}>
            <Text style={styles.noResultsTitle}>No matching transfers</Text>
            <Text style={styles.noResultsSubtitle}>
              No transfers match &quot;{searchQuery}&quot;
            </Text>
            <TouchableOpacity
              style={styles.clearFilterButton}
              onPress={() => {
                triggerHaptic('light');
                setSearchQuery('');
              }}
              accessibilityRole="button"
              accessibilityLabel="Clear search filter"
            >
              <Text style={styles.clearFilterButtonText}>Clear Filter</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <EmptyState />
        )
      ) : (
        <FlatList
          data={displayedTorrents}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <TransferCard torrent={item} />}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}

      <FloatingActionButton />
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  searchInputWrapper: {
    height: 44,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 12,
    paddingRight: 4,
  },
  searchInput: {
    flex: 1,
    height: '100%',
    ...fonts.mono,
    fontSize: 12,
    color: colors.text,
    marginLeft: 8,
    paddingVertical: 0,
  },
  clearSearchTouch: {
    minWidth: touch.min,
    minHeight: touch.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noResultsContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingBottom: 64,
  },
  noResultsTitle: {
    ...fonts.brand,
    fontSize: 14,
    color: colors.text,
    marginBottom: 8,
    textAlign: 'center',
  },
  noResultsSubtitle: {
    ...fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 18,
  },
  clearFilterButton: {
    minHeight: touch.min,
    minWidth: 120,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearFilterButtonText: {
    ...fonts.monoBold,
    fontSize: 11,
    color: colors.accentText,
  },
  listContent: {
    paddingBottom: 90,
  },
});
