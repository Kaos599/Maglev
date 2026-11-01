import React from 'react';
import { View, StyleSheet, FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HeaderBar } from '../../components/HeaderBar';
import { FilterPills } from '../../components/FilterPills';
import { TransferCard } from '../../components/TransferCard';
import { EmptyState } from '../../components/EmptyState';
import { FloatingActionButton } from '../../components/FloatingActionButton';
import { TOKENS } from '../../constants/tokens';
import { useMaglevEngine } from '../../context/EngineContext';

export default function TransfersScreen() {
  const insets = useSafeAreaInsets();
  const { filteredTorrents } = useMaglevEngine();

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <HeaderBar />
      <FilterPills />

      {filteredTorrents.length === 0 ? (
        <EmptyState />
      ) : (
        <FlatList
          data={filteredTorrents}
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
  listContent: {
    paddingBottom: 90,
  },
});
