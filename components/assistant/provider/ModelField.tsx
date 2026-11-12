import React from 'react';
import { Field } from './Field';

/** The model name lives here, not in the chat header. */
export function ModelField({ value, onChange, editable = true }: { value: string; onChange: (t: string) => void; editable?: boolean }) {
  return (
    <Field
      label="Model"
      value={value}
      onChangeText={onChange}
      editable={editable}
      placeholder="Model name"
      caption="Copy the name from your provider. Test model checks that it works."
      testID="assistant-model"
    />
  );
}
