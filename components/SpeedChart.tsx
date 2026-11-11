import { useMemo } from 'react';
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { formatSpeed } from '../constants/format';
import { useTheme } from '../context/ThemeContext';
import { fonts, ThemeColors } from '../constants/theme';

interface SpeedChartProps {
  currentDownSpeed: number;
  currentUpSpeed: number;
}

export const SpeedChart: React.FC<SpeedChartProps> = ({ currentDownSpeed, currentUpSpeed }) => {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [history, setHistory] = useState<{ down: number; up: number }[]>(() =>
    Array(24).fill({ down: 0, up: 0 })
  );

  useEffect(() => {
    setHistory((prev) => {
      const next = [...prev.slice(1), { down: currentDownSpeed, up: currentUpSpeed }];
      return next;
    });
  }, [currentDownSpeed, currentUpSpeed]);

  const maxVal = Math.max(
    ...history.map((h) => Math.max(h.down, h.up)),
    1024 * 1024 // At least 1 MB/s scale ceiling
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Live Swarm Throughput</Text>
        <View style={styles.indicators}>
          <View style={styles.indicator}>
            <Text style={styles.downDot}>●</Text>
            <Text style={styles.downText}>{formatSpeed(currentDownSpeed)}</Text>
          </View>
          <View style={styles.indicator}>
            <Text style={styles.upDot}>●</Text>
            <Text style={styles.upText}>{formatSpeed(currentUpSpeed)}</Text>
          </View>
        </View>
      </View>

      <View style={styles.chartArea}>
        {history.map((item, index) => {
          const downHeight = Math.min(100, Math.max(4, (item.down / maxVal) * 60));
          const upHeight = Math.min(100, Math.max(4, (item.up / maxVal) * 60));

          return (
            <View key={index} style={styles.barCol}>
              <View style={[styles.barUp, { height: upHeight }]} />
              <View style={[styles.barDown, { height: downHeight }]} />
            </View>
          );
        })}
      </View>
    </View>
  );
};

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 14,
    marginVertical: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    color: colors.text,
    fontSize: 12,
    ...fonts.monoBold,
  },
  indicators: {
    flexDirection: 'row',
    gap: 12,
  },
  indicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  downDot: {
    color: colors.download,
    fontSize: 10,
  },
  downText: {
    color: colors.download,
    fontSize: 11,
    ...fonts.monoBold,
  },
  upDot: {
    color: colors.accentText,
    fontSize: 10,
  },
  upText: {
    color: colors.accentText,
    fontSize: 11,
    ...fonts.monoBold,
  },
  chartArea: {
    height: 70,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    backgroundColor: colors.bg,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  barCol: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
  },
  barDown: {
    width: 4,
    backgroundColor: colors.download,
    borderRadius: 1,
  },
  barUp: {
    width: 4,
    backgroundColor: colors.accent,
    borderRadius: 1,
  },
});
