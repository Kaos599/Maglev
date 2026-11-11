import { useMemo } from 'react';
import React, { useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native';
import { triggerHaptic } from '../constants/haptics';
import { FilterCategory, useMaglevEngine } from '../context/EngineContext';
import {
  PixelGridIcon,
  PixelArrowDownIcon,
  PixelArrowUpIcon,
  PixelPauseBarsIcon,
} from './PixelIcons';
import { useTheme } from '../context/ThemeContext';
import { fonts, touch, ThemeColors } from '../constants/theme';

interface FilterButtonProps {
  isActive: boolean;
  onPress: () => void;
  label: string;
  count: number;
  icon: React.ReactNode;
}

const FilterButton: React.FC<FilterButtonProps> = ({ isActive, onPress, label, count, icon }) => {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.93,
      useNativeDriver: true,
      friction: 7,
      tension: 180,
    }).start();
  };

  const handlePressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      friction: 5,
      tension: 180,
    }).start();
  };

  return (
    <Animated.View style={[styles.buttonWrapper, { transform: [{ scale: scaleAnim }] }]}>
      <TouchableOpacity
        style={[styles.button, isActive ? styles.buttonActive : styles.buttonInactive]}
        onPress={() => {
          triggerHaptic('selection');
          onPress();
        }}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        accessibilityRole="button"
        accessibilityLabel={`${label} filter (${count})`}
        activeOpacity={0.9}
      >
        {icon}
        <Text
          style={[
            styles.countText,
            isActive ? styles.countTextActive : styles.countTextInactive,
          ]}
        >
          {count}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
};

export const FilterPills: React.FC = () => {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { activeFilter, setActiveFilter, telemetry } = useMaglevEngine();

  const allCount = telemetry.torrents.length;
  const downCount = telemetry.torrents.filter((t) => t.state === 'DOWNLOADING').length;
  const upCount = telemetry.torrents.filter((t) => t.state === 'SEEDING').length;
  const pausedCount = telemetry.torrents.filter((t) => t.state === 'PAUSED').length;

  const filters: Array<{
    id: FilterCategory;
    icon: (isActive: boolean) => React.ReactNode;
    count: number;
    label: string;
  }> = [
    {
      id: 'ALL',
      icon: (active) => <PixelGridIcon size={14} color={active ? colors.onAccent : colors.accentText} />,
      count: allCount,
      label: 'All',
    },
    {
      id: 'DOWN',
      icon: (active) => <PixelArrowDownIcon size={14} color={active ? colors.onAccent : colors.download} />,
      count: downCount,
      label: 'Downloading',
    },
    {
      id: 'UP',
      icon: (active) => <PixelArrowUpIcon size={14} color={active ? colors.onAccent : colors.accentText} />,
      count: upCount,
      label: 'Seeding',
    },
    {
      id: 'PAUSED',
      icon: (active) => <PixelPauseBarsIcon size={14} color={active ? colors.onAccent : colors.textMuted} />,
      count: pausedCount,
      label: 'Paused',
    },
  ];

  return (
    <View style={styles.container}>
      {filters.map((f) => {
        const isActive = activeFilter === f.id;
        return (
          <FilterButton
            key={f.id}
            isActive={isActive}
            onPress={() => setActiveFilter(f.id)}
            label={f.label}
            count={f.count}
            icon={f.icon(isActive)}
          />
        );
      })}
    </View>
  );
};

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    gap: 8,
  },
  buttonWrapper: {
    flex: 1,
  },
  button: {
    width: '100%',
    minHeight: touch.min,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 8,
  },
  buttonActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    borderWidth: 1,
    elevation: 4,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
  },
  buttonInactive: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
  },
  countText: {
    ...fonts.brand,
    fontSize: 10,
    lineHeight: 12,
  },
  countTextActive: {
    color: colors.onAccent,
  },
  countTextInactive: {
    color: colors.text,
  },
});
