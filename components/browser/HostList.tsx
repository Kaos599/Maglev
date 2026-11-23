import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { Button, EmptyBlock, IconButton, TextField } from '../ui';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { Card } from '../settings/SettingsParts';

/** The hosts that contain the query, ignoring case and surrounding spaces. An empty query keeps every host. */
export function filterHosts(hosts: readonly string[], query: string, matches?: (host: string, q: string) => boolean): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...hosts];
  return hosts.filter((h) => (matches ? matches(h, q) : h.toLowerCase().includes(q)));
}

export interface HostListAction {
  label: string;
  onPress: (host: string) => void;
}

export interface HostListProps {
  hosts: string[];
  /** Shown instead of the list (and the search field) when there are no hosts. */
  empty: { icon: PixelIconName; title: string; body?: string };
  /** Accessibility label of one host's remove button. Needed with `onRemove`. */
  removeLabel?: (host: string) => string;
  /** Shows the close button on each row when given. */
  onRemove?: (host: string) => void;
  /** A text button on each row, before the remove button (for example "Block instead"). */
  action?: HostListAction;
  /** A second line under the host (for example "3 blocked · last 2 h ago"). */
  subtitle?: (host: string) => string | undefined;
  /** Makes the whole host row pressable (opens the site). */
  onOpen?: (host: string) => void;
  /** Decides whether a host matches the search. Default: the host contains the text. */
  matches?: (host: string, query: string) => boolean;
}

/** A site list with a search field on top. Filters as you type; "No sites match" when nothing fits. */
export function HostList({ hosts, empty, removeLabel, onRemove, action, subtitle, onOpen, matches }: HostListProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterHosts(hosts, query, matches), [hosts, query, matches]);

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
          {shown.map((h) => {
            const sub = subtitle?.(h);
            const body = (
              <>
                <Text style={s.host} numberOfLines={1}>
                  {h}
                </Text>
                {sub ? (
                  <Text style={s.sub} numberOfLines={1}>
                    {sub}
                  </Text>
                ) : null}
              </>
            );
            return (
              <View key={h} style={s.row}>
                {onOpen ? (
                  <Pressable
                    style={s.main}
                    accessibilityRole="button"
                    accessibilityLabel={sub ? `${h}, ${sub}` : h}
                    onPress={() => onOpen(h)}
                  >
                    {body}
                  </Pressable>
                ) : (
                  <View style={s.main}>{body}</View>
                )}
                {onOpen ? <PixelIcon name="chevron-right" size={20} color={colors.textMuted} /> : null}
                {action ? <Button label={action.label} variant="ghost" onPress={() => action.onPress(h)} /> : null}
                {onRemove && removeLabel ? (
                  <IconButton
                    icon="close"
                    accessibilityLabel={removeLabel(h)}
                    onPress={() => {
                      haptic('tap');
                      onRemove(h);
                    }}
                  />
                ) : null}
              </View>
            );
          })}
        </Card>
      )}
    </>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingLeft: spacing.lg, paddingRight: spacing.xs, minHeight: 56 },
    main: { flex: 1, paddingVertical: spacing.sm, justifyContent: 'center' },
    host: { ...type.mono, fontSize: type.size.sm, color: c.text },
    sub: { ...type.body, fontSize: type.size.xs, color: c.textMuted, marginTop: 2 },
  });
