import React from 'react';
import { TextField } from '../../ui';

export interface FieldProps {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  caption?: string;
  secure?: boolean;
  editable?: boolean;
  keyboardType?: 'default' | 'url';
  onSubmitEditing?: () => void;
  testID?: string;
}

/** Labelled single-line field. Values are filenames, keys and addresses, so they use the mono face. */
export function Field({ label, value, onChangeText, placeholder, caption, secure, editable = true, keyboardType = 'default', onSubmitEditing, testID }: FieldProps) {
  return (
    <TextField
      onSurface
      label={label}
      help={caption}
      value={value}
      onChangeText={onChangeText}
      editable={editable}
      secureTextEntry={secure}
      mono
      keyboardType={keyboardType}
      placeholder={placeholder}
      onSubmitEditing={onSubmitEditing}
      returnKeyType="done"
      accessibilityLabel={label}
      testID={testID}
    />
  );
}
