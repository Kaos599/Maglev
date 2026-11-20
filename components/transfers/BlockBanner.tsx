import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ActiveBlock } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { moreCount, reasonForBlock, visibleBlocks } from '../../utils/blocks/reasons';
import { useMinuteTick } from '../../utils/blocks/useMinuteTick';
import { Banner, Button, Sheet } from '../ui';
import type { LowSpaceWarning } from './lowSpace';

export interface BlockBannerProps {
  blocks: readonly ActiveBlock[];
  /** Any download or link that is not finished. Rules only hold those. */
  hasUnfinished: boolean;
  /** A finished torrent that would be seeding if `seed_metered` were off. */
  hasSeedEligible: boolean;
  /** The measured low-space warning. It joins the storage entry, so there is one banner, not two. */
  lowSpace?: LowSpaceWarning | null;
  /** What the storage button does: the phone's storage screen. */
  onFreeSpace: () => void;
}

interface Entry {
  key: string;
  title: string;
  body: string;
  button: { label: string; onPress: () => void } | null;
}

/**
 * One banner above the Transfers list: why transfers are held right now (NATIVE_CONTRACT 35.3).
 * The first reason shows with its setting button; "+N more" opens a sheet with every reason.
 */
export function BlockBanner({ blocks, hasUnfinished, hasSeedEligible, lowSpace, onFreeSpace }: BlockBannerProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);
  const shownBlocks = useMemo(() => visibleBlocks(blocks, { hasUnfinished, hasSeedEligible }), [blocks, hasUnfinished, hasSeedEligible]);
  // A schedule's "Resumes at" must not show a time that has passed.
  const now = useMinuteTick(shownBlocks.some((b) => b.tag === 'schedule'));

  const entries = useMemo(() => {
    const out: Entry[] = shownBlocks.map((b) => {
      const r = reasonForBlock(b, undefined, now);
      const s = r.setting;
      return {
        key: b.tag,
        title: r.title,
        body: r.body,
        button: s ? { label: s.label, onPress: () => router.push(s.route as never) } : null,
      };
    });
    if (lowSpace && hasUnfinished) {
      const storage: Entry = { key: 'storage_full', title: lowSpace.title, body: lowSpace.body, button: { label: 'Free up space', onPress: onFreeSpace } };
      const at = out.findIndex((e) => e.key === 'storage_full');
      if (at >= 0) out[at] = storage;
      else out.unshift(storage);
    }
    return out;
  }, [shownBlocks, now, hasUnfinished, lowSpace, onFreeSpace, router]);

  // The sheet must not stay open (and pop up again) once there is nothing to show.
  const empty = entries.length === 0;
  useEffect(() => {
    if (empty) setOpen(false);
  }, [empty]);

  if (empty) return null;
  const first = entries[0];
  const more = moreCount(entries.map((e) => e.key));
  const hasExtra = entries.length > 1;

  return (
    <View style={styles.wrap} testID="block-banner">
      <Banner
        tone="warning"
        title={first.title}
        body={first.body}
        actionLabel={first.button?.label}
        onAction={first.button?.onPress}
        extraAction={
          hasExtra ? (
            <Button
              label={more > 0 ? `+${more} more` : 'See all'}
              variant="ghost"
              onPress={() => setOpen(true)}
              accessibilityLabel={more > 0 ? `Show ${more} more ${more === 1 ? 'reason' : 'reasons'} transfers are held` : 'Show everything that holds transfers'}
            />
          ) : undefined
        }
      />
      <Sheet visible={open} onClose={() => setOpen(false)} title="Why transfers are held">
        {entries.map((e) => (
          <View key={e.key} style={styles.item}>
            <Text style={styles.itemTitle}>{e.title}</Text>
            <Text style={styles.itemBody}>{e.body}</Text>
            {e.button ? (
              <View style={styles.itemAction}>
                <Button
                  label={e.button.label}
                  variant="secondary"
                  onPress={() => {
                    setOpen(false);
                    e.button?.onPress();
                  }}
                />
              </View>
            ) : null}
          </View>
        ))}
      </Sheet>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
    item: { paddingVertical: spacing.md, borderTopWidth: 1, borderColor: c.border },
    itemTitle: { ...type.bodyStrong, fontSize: type.size.base, color: c.text },
    itemBody: { ...type.body, fontSize: type.size.md, color: c.textMuted, marginTop: 2, lineHeight: 18, borderRadius: radius.sm },
    itemAction: { marginTop: spacing.md, alignSelf: 'flex-start' },
  });
