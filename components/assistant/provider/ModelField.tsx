import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../../constants/theme';
import { Chip } from '../../ui';
import type { ProviderPreset } from '../../../utils/prefs/assistant';
import { modelDisplayName } from '../../../utils/assistant/models';
import { Field } from './Field';
import { ModelPicker } from './ModelPicker';

/**
 * The model: a short list per provider (marked Free or Paid) plus "Other…" for a typed name.
 * The custom (Ollama) preset has no list, so it keeps the text field.
 */
export function ModelField({
  preset,
  value,
  modelName,
  onChange,
  editable = true,
}: {
  preset: ProviderPreset;
  value: string;
  modelName?: string | null;
  /** `name` is the display name from the provider's list, when it has one. */
  onChange: (id: string, name?: string | null) => void;
  editable?: boolean;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const listed = preset.models.some((m) => m.id === value);
  // "Other…" opens the text field. A saved model that is not on the list also shows it.
  const [otherOpen, setOtherOpen] = useState(false);
  const other = otherOpen || (preset.models.length > 0 && !listed);

  if (preset.id === 'openrouter') {
    return (
      <ModelPicker
        value={value}
        displayName={modelDisplayName({ presetId: 'openrouter', model: value, modelName })}
        onChange={(id, name) => onChange(id, name)}
        editable={editable}
      />
    );
  }

  if (preset.models.length === 0) {
    return (
      <Field
        label="Model"
        value={value}
        onChangeText={onChange}
        editable={editable}
        placeholder="llama3.1"
        caption="The model name from your server, like llama3.1"
        testID="assistant-model"
      />
    );
  }

  return (
    <View style={s.wrap}>
      <Text style={s.label}>Model</Text>
      <View style={s.chips} accessibilityRole="radiogroup" accessibilityLabel="Model">
        {preset.models.map((m) => (
          <Chip
            key={m.id}
            label={`${m.label} · ${m.free ? 'Free' : 'Paid'}`}
            selected={!other && m.id === value}
            disabled={!editable}
            onPress={() => {
              setOtherOpen(false);
              onChange(m.id);
            }}
            testID={`assistant-model-${m.id}`}
          />
        ))}
        <Chip label="Other…" selected={other} disabled={!editable} onPress={() => setOtherOpen(true)} testID="assistant-model-other" />
      </View>
      {other ? (
        <Field label="Model name" value={value} onChangeText={onChange} editable={editable} placeholder="Model name" testID="assistant-model" />
      ) : null}
      <Text style={s.caption}>Not sure? Pick the first one.</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { gap: spacing.sm },
    label: { ...type.bodyStrong, fontSize: 14, color: c.text },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    caption: { ...type.body, fontSize: 12, lineHeight: 17, color: c.textMuted },
  });
