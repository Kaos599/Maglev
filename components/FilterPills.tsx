import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { TOKENS } from '../constants/tokens';
import { FilterCategory, useMaglevEngine } from '../context/EngineContext';

interface FilterPillItem {
  id: FilterCategory;
  label: string;
}

const PILLS: FilterPillItem[] = [
  { id: 'ALL', label: 'All' },
  { id: 'DOWN', label: 'Down' },
  { id: 'UP', label: 'Up' },
  { id: 'PAUSED', label: 'Paused' },
];

export const FilterPills: React.FC = () => {
  const { activeFilter, setActiveFilter, telemetry } = useMaglevEngine();

  const getCount = (filter: FilterCategory): number => {
    switch (filter) {
      case 'DOWN':
        return telemetry.torrents.filter((t) => t.state === 'DOWNLOADING').length;
      case 'UP':
        return telemetry.torrents.filter((t) => t.state === 'SEEDING').length;
      case 'PAUSED':
        return telemetry.torrents.filter((t) => t.state === 'PAUSED').length;
      case 'ALL':
      default:
        return telemetry.torrents.length;
    }
  };

  return (
    <View style={styles.wrapper}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.container}
      >
        {PILLS.map((pill) => {
          const isActive = activeFilter === pill.id;
          const count = getCount(pill.id);

          return (
            <TouchableOpacity
              key={pill.id}
              style={[
                styles.pill,
                isActive ? styles.pillActive : styles.pillInactive,
              ]}
              onPress={() => setActiveFilter(pill.id)}
              accessibilityRole="button"
              accessibilityLabel={`${pill.label} transfers (${count})`}
            >
              <Text
                style={[
                  styles.pillText,
                  isActive ? styles.pillTextActive : styles.pillTextInactive,
                ]}
              >
                {pill.label}
              </Text>
              <View
                style={[
                  styles.badge,
                  isActive ? styles.badgeActive : styles.badgeInactive,
                ]}
              >
                <Text
                  style={[
                    styles.badgeText,
                    isActive ? styles.badgeTextActive : styles.badgeTextInactive,
                  ]}
                >
                  {count}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: 4,
  },
  container: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    gap: 8,
  },
  pill: {
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 16,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillActive: {
    backgroundColor: TOKENS.colors.accentLime,
  },
  pillInactive: {
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
  },
  pillText: {
    fontSize: TOKENS.typography.pillButton.fontSize,
    fontWeight: TOKENS.typography.pillButton.fontWeight,
    fontFamily: 'monospace',
    marginRight: 6,
  },
  pillTextActive: {
    color: '#000000',
  },
  pillTextInactive: {
    color: TOKENS.colors.textMuted,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  badgeActive: {
    backgroundColor: '#000000',
  },
  badgeInactive: {
    backgroundColor: TOKENS.colors.surfacePill,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  badgeTextActive: {
    color: TOKENS.colors.accentLime,
  },
  badgeTextInactive: {
    color: TOKENS.colors.textMuted,
  },
});
