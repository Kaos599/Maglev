#!/usr/bin/env node
// Source-level contract for components/ui/TextField.tsx, the one text input.
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}
console.log('TextField');
const src = read('components/ui/TextField.tsx');
const index = read('components/ui/index.ts');
const code = src.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const styles = code.slice(code.indexOf('const makeStyles'));

check('exported from components/ui/index.ts', /export \{ TextField \} from '\.\/TextField'/.test(index) && /TextFieldProps/.test(index));
check('forwards its ref to the TextInput', /forwardRef<TextFieldRef, TextFieldProps>/.test(code) && /<TextInput\s+ref=\{inner\}/.test(code));
check('props extend TextInputProps', /interface TextFieldProps extends TextInputProps/.test(code));
check(
  'has label, help, error, leadingIcon, clearable, mono, size, minLines, maxLines',
  ['label', 'help', 'error', 'leadingIcon', 'clearable', 'mono', 'size', 'minLines', 'maxLines'].every((p) => new RegExp(`\\b${p}\\??:`).test(code)),
);
check('has trailing and bare props', /\btrailing\?:/.test(code) && /\bbare\?:/.test(code));
check('trailing renders inside the box before the clear button', /\{trailing\b[^\n]*\{trailing\}[^\n]*\n\s*\{showClear/.test(code));
check(
  'bare returns only the TextInput, with theme placeholder and selection colours, and passes selection through',
  /if \(bare\) \{\s*return \(\s*<TextInput[\s\S]*?placeholderTextColor=\{colors\.textFaint\}[\s\S]*?selectionColor=\{colors\.accent\}[\s\S]*?\{\.\.\.rest\}[\s\S]*?\/>\s*\);\s*\}/.test(code),
);
check('no hex or rgba literals', !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(code));
check('no raw spacing, radius or size numbers in styles', !/(padding\w*|margin\w*|gap|borderRadius|fontSize|minHeight|height|width):\s*\d{2,}/.test(styles));
check('no shadows, system monospace or fontWeight', !/shadow|elevation|fontFamily:\s*'monospace'|fontWeight/.test(code));
check('surface fill and 1 px hairline', /backgroundColor: c\.surface/.test(styles) && /borderWidth: 1/.test(styles));
check('focus border is colors.accent, error border colors.danger', /focused && !disabled \? colors\.accent/.test(code) && /invalid \? colors\.danger/.test(code));
check(
  'placeholder, selection and text colours come from the theme',
  /placeholderTextColor=\{colors\.textFaint\}/.test(code) &&
    /selectionColor=\{colors\.accent\}/.test(code) &&
    /color: c\.text/.test(styles) &&
    /inputDisabled: \{ color: c\.textFaint/.test(styles),
);
check('minimum height is touch.min', /touch\.min/.test(code));
check('styles built with makeStyles + useMemo on colors', /useMemo\(\(\) => makeStyles\(colors\), \[colors\]\)/.test(code));
check('mono uses type.mono, default uses type.body', /inputMono: \{ \.\.\.type\.mono/.test(styles) && /inputBody: \{ \.\.\.type\.body/.test(styles));
check(
  'mono turns off autocapitalize, autocorrect and spellcheck by default, each overridable',
  /autoCapitalize \?\? \(mono/.test(code) && /autoCorrect \?\? \(mono/.test(code) && /spellCheck \?\? \(mono/.test(code),
);
check(
  'clear button is an IconButton labelled "Clear", shown only with text',
  /<IconButton[^>]*accessibilityLabel=\{clearLabel\}/.test(code) && /clearLabel = 'Clear'/.test(code) && /showClear = clearable && editable && typeof value === 'string' && value\.length > 0/.test(code),
);
check('clear button keeps a 44x44 target (IconButton box)', /box: \{ width: (44|touch\.min), height: (44|touch\.min)/.test(read('components/ui/IconButton.tsx')));
check(
  'error renders an icon and text, as an alert',
  /<PixelIcon name="warning"[\s\S]{0,120}<Text style=\{styles\.error\}>\{error\}/.test(code) && /accessibilityRole="alert"/.test(code),
);
check('help and error are announced via accessibilityHint', /accessibilityHint=\{accessibilityHint \?\? hint\}/.test(code) && /Error: \$\{error\}/.test(code));
check('label feeds accessibilityLabel', /accessibilityLabel \?\? label \?\? placeholder/.test(code));
check('visible label uses type.bodyStrong', /label: \{ \.\.\.type\.bodyStrong/.test(styles));
check('disabled has no focus ring', /focused && !disabled/.test(code));
check('onSurface fills the box with bg', /boxOnSurface: \{ backgroundColor: c\.bg \}/.test(styles) && /onSurface && styles\.boxOnSurface/.test(code));
{
  // Fields inside sheets and cards (surface) must pass onSurface, or they vanish into the sheet.
  const onSurfaceSites = [
    'components/assistant/provider/Field.tsx', 'components/browser/FoundDownload.tsx', 'components/browser/SaveToChoice.tsx',
    'components/browser/StreamSheet.tsx', 'components/detail/TrackerSheets.tsx', 'components/feeds/NewFeedSheet.tsx',
    'components/feeds/RuleEditorSheet.tsx', 'components/search-providers/ProviderSheet.tsx', 'components/search-providers/TorznabSheet.tsx',
    'components/settings/SettingsParts.tsx', 'components/subtitles/MultiSubtitleSheet.tsx', 'components/subtitles/SubtitleSheet.tsx',
  ];
  const missing = onSurfaceSites.filter((p) => {
    const src = read(p);
    const fields = src.match(/<TextField\b[\s\S]*?\/>/g) || [];
    return fields.length === 0 || fields.some((t) => !/\bonSurface\b/.test(t));
  });
  check(`fields in sheets pass onSurface${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''}`, missing.length === 0);
}
check('mentioned in DESIGN.md and README', /TextField/.test(read('DESIGN.md')) && /TextField/.test(read('components/ui/README.md')));
console.log(failed === 0 ? '\ntextfield: all checks passed' : `\ntextfield: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
