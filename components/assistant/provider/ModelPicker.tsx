import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../../constants/theme';
import { ListRow, SegmentedControl, Sheet } from '../../ui';
import { kvGet, kvSet } from '../../../utils/prefs/kv';
import {
  AUTO_MODEL,
  contextLabel,
  loadModels,
  shortModelName,
  type ModelEntry,
  type ModelList,
  type ModelsFetch,
} from '../../../utils/assistant/models';
import { Field } from './Field';

type Tab = 'free' | 'paid';

interface Row {
  id: string;
  name: string;
  detail: string;
}

/**
 * OpenRouter's model picker: a row with the current model, opening a sheet with search, Free / Paid and one row
 * per model (name, memory size, "Uses tools"). The list is OpenRouter's live list, cached for a day (utils/assistant/models.ts).
 */
export function ModelPicker({
  value,
  displayName,
  onChange,
  editable = true,
}: {
  value: string;
  displayName: string;
  onChange: (id: string, name: string | null) => void;
  editable?: boolean;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { height } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('free');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<ModelList | null>(null);

  useEffect(() => {
    if (!open || list) return;
    let alive = true;
    loadModels({ fetch: fetch as unknown as ModelsFetch, kv: { getItem: kvGet, setItem: kvSet } }).then((l) => {
      if (alive) setList(l);
    });
    return () => {
      alive = false;
    };
  }, [open, list]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const toRow = (m: ModelEntry): Row => ({
      id: m.id,
      name: shortModelName(m.name),
      detail: [contextLabel(m.contextLength), 'Uses tools'].filter(Boolean).join(' · '),
    });
    const source = list ? (tab === 'free' ? list.free : list.paid) : [];
    const out: Row[] = [];
    if (tab === 'free') out.push({ id: AUTO_MODEL.id, name: AUTO_MODEL.name, detail: 'Maglev lets OpenRouter pick a free model · Uses tools' });
    for (const m of source) out.push(toRow(m));
    const found = q ? out.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)) : out;
    // A typed model id that is not on the list can still be used.
    if (q && /^[^\s/]+\/[^\s]+$/.test(query.trim()) && !out.some((r) => r.id.toLowerCase() === q)) {
      found.push({ id: query.trim(), name: query.trim(), detail: 'Use this model name' });
    }
    return found;
  }, [list, tab, query]);

  const pick = useCallback(
    (r: Row) => {
      const custom = r.detail === 'Use this model name';
      onChange(r.id, r.id === AUTO_MODEL.id || custom ? null : r.name);
      setOpen(false);
      setQuery('');
    },
    [onChange],
  );

  return (
    <View style={s.wrap}>
      <ListRow
        title="Model"
        value={displayName}
        onPress={() => setOpen(true)}
        disabled={!editable}
        accessibilityLabel={`Model, ${displayName}`}
        accessibilityHint="Opens the list of models"
        testID="assistant-model-picker"
      />
      <Sheet visible={open} onClose={() => setOpen(false)} title="Choose a model" subtitle="Free models may be slower and have daily limits.">
        <View style={s.sheetBody}>
          <Field label="Search" value={query} onChangeText={setQuery} placeholder="Name or provider/name" testID="assistant-model-search" />
          <SegmentedControl
            options={[
              { value: 'free', label: 'Free' },
              { value: 'paid', label: 'Paid' },
            ]}
            value={tab}
            onChange={setTab}
            accessibilityLabel="Free or paid models"
            testID="assistant-model-tabs"
          />
          <FlatList
            style={{ maxHeight: height * 0.4 }}
            data={rows}
            keyExtractor={(r) => r.id}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<Text style={s.empty}>{list ? 'No models match.' : 'Loading models.'}</Text>}
            renderItem={({ item }) => (
              <ListRow
                title={item.name}
                subtitle={item.detail}
                selected={item.id === value}
                onPress={() => pick(item)}
                testID={`assistant-model-${item.id}`}
              />
            )}
          />
        </View>
      </Sheet>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { gap: spacing.sm },
    sheetBody: { gap: spacing.md },
    empty: { ...type.body, fontSize: 13, color: c.textMuted, paddingVertical: spacing.lg },
  });
