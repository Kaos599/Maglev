import React from 'react';
import { Field } from './Field';

/** API key. Hidden as you type. It is saved in the phone's secure storage only after the model test passes. */
export function KeyField({ value, onChange, editable = true }: { value: string; onChange: (t: string) => void; editable?: boolean }) {
  return (
    <Field
      label="API key"
      value={value}
      onChangeText={onChange}
      secure
      editable={editable}
      placeholder="Paste your key"
      caption="Kept in this phone's secure storage. Never sent anywhere except the provider."
      testID="assistant-key"
    />
  );
}
