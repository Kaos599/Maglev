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
import { TOKENS } from '../../constants/tokens';
import { triggerHaptic } from '../../constants/haptics';
import { useMaglevEngine } from '../../context/EngineContext';
import { checkMaglevPermissions, requestMaglevPermissions } from '../../utils/permissions';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function TransfersScreen() {
  const insets = useSafeAreaInsets();
  const { filteredTorrents } = useMaglevEngine();

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [hasStoragePerm, setHasStoragePerm] = useState(true);

  React.useEffect(() => {
    checkMaglevPermissions().then((status) => {
      setHasStoragePerm(status.hasStoragePermission);
    });
  }, []);

  const handleGrantPermission = useCallback(async () => {
    triggerHaptic('medium');
    const status = await requestMaglevPermissions();
    setHasStoragePerm(status.hasStoragePermission);
  }, []);

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
            <PixelSearchIcon size={14} color={TOKENS.colors.accentCyan} />
            <TextInput
              style={styles.searchInput}
              placeholder="Filter transfers by name..."
              placeholderTextColor="#6B7280"
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
                <Ionicons name="close" size={16} color="#9CA3AF" />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      <FilterPills />

      {!hasStoragePerm && (
        <View style={styles.permissionCard}>
          <View style={styles.permissionContent}>
            <Ionicons name="folder-outline" size={20} color={TOKENS.colors.accentLime} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.permissionTitle}>STORAGE PERMISSION REQUIRED</Text>
              <Text style={styles.permissionDesc}>
                Storage access is needed to save torrent downloads and monitor free disk space.
              </Text>
            </View>
          </View>
          <TouchableOpacity
            style={styles.permissionBtn}
            onPress={handleGrantPermission}
            accessibilityRole="button"
            accessibilityLabel="Grant storage permission"
          >
            <Text style={styles.permissionBtnText}>GRANT ACCESS</Text>
          </TouchableOpacity>
        </View>
      )}

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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: TOKENS.colors.bgOled,
  },
  searchContainer: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  searchInputWrapper: {
    height: 44,
    backgroundColor: '#0D1117',
    borderWidth: 1,
    borderColor: '#1F2937',
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 12,
    paddingRight: 4,
  },
  searchInput: {
    flex: 1,
    height: '100%',
    fontFamily: 'SpaceMono',
    fontSize: 12,
    color: '#FFFFFF',
    marginLeft: 8,
    paddingVertical: 0,
  },
  clearSearchTouch: {
    minWidth: TOKENS.touchTarget.minWidth,
    minHeight: TOKENS.touchTarget.minHeight,
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
    fontFamily: 'Silkscreen',
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
    marginBottom: 8,
    textAlign: 'center',
  },
  noResultsSubtitle: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: '#8B949E',
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 18,
  },
  clearFilterButton: {
    minHeight: TOKENS.touchTarget.minHeight,
    minWidth: 120,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#161B22',
    borderWidth: 1,
    borderColor: '#30363D',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearFilterButtonText: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '700',
    color: TOKENS.colors.accentLime,
  },
  listContent: {
    paddingBottom: 90,
  },
  permissionCard: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 12,
    backgroundColor: '#0D1117',
    borderWidth: 1,
    borderColor: '#1F2937',
    borderRadius: 8,
  },
  permissionContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  permissionTitle: {
    fontFamily: 'SpaceMono',
    fontSize: 10,
    fontWeight: '700',
    color: TOKENS.colors.accentLime,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  permissionDesc: {
    fontFamily: 'SpaceMono',
    fontSize: 10,
    color: '#8B949E',
    lineHeight: 14,
  },
  permissionBtn: {
    marginTop: 10,
    minHeight: 44,
    backgroundColor: TOKENS.colors.accentLime,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionBtnText: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '700',
    color: '#05070A',
    letterSpacing: 0.5,
  },
});
