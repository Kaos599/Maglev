import React from 'react';
import { StyleSheet, View } from 'react-native';
import { EmptyBlock } from './ui';

export interface EmptyStateProps {
  onAdd: () => void;
  onSearch: () => void;
}

export function EmptyState({ onAdd, onSearch }: EmptyStateProps) {
  return (
    <View style={styles.wrap}>
      <EmptyBlock
        icon="transfers"
        title="No transfers yet"
        body="Add a magnet link or torrent file to start downloading."
        primary={{ label: 'Add torrent', icon: 'plus', onPress: onAdd }}
        secondary={{ label: 'Search', icon: 'search', onPress: onSearch }}
      />
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { flex: 1, justifyContent: 'center' } });
