import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { EmptyBlock, IconButton, TextField } from '../ui';
import { PixelIconName } from '../PixelIcon';
import { Card } from '../settings/SettingsParts';

/** The hosts that contain the query, ignoring case and surrounding spaces. An empty query keeps every host. */
export function filterHosts(hosts: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  return q ? hosts.filter((h) => h.toLowerCase().includes(q)) : [...hosts];
}

export interface HostListProps {
  hosts: string[];
  /** Shown instead of the list (and the search field) when there are no hosts. */
  empty: { icon: PixelIconName; title: string; body?: string };
  /** Accessibility label of one host's remove button. */
  removeLabel: (host: string) => string;
  onRemove: (host: string) => void;
}

/** A site list with a search field on top. Filters by host as you type; "No sites match" when nothing fits. */
export function HostList({ hosts, empty, removeLabel, onRemove }: HostListProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterHosts(hosts, query), [hosts, query]);

  if (hosts.length === 0) return <EmptyBlock icon={empty.icon} title={empty.title} body={empty.body} />;

  return (
    <>
      <TextField
        leadingIcon="search"
        clearable
        clearLabel="Clear search"
        size="lg"
        value={query}
        onChangeText={setQuery}
        placeholder={browserSettingsCopy.sites.search}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={browserSettingsCopy.sites.search}
      />
      {shown.length === 0 ? (
        <EmptyBlock icon="search" title={browserSettingsCopy.sites.noMatch} body={browserSettingsCopy.sites.noMatchBody} />
      ) : (
        <Card>
          {shown.map((h) => (
            <View key={h} style={s.row}>
              <Text style={s.host} numberOfLines={1}>
                {h}
              </Text>
              <IconButton
                icon="close"
                accessibilityLabel={removeLabel(h)}
                onPress={() => {
                  haptic('tap');
                  onRemove(h);
                }}
              />
            </View>
          ))}
        </Card>
      )}
    </>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.xs, minHeight: 56 },
    host: { ...type.mono, flex: 1, fontSize: type.size.sm, color: c.text },
  });
