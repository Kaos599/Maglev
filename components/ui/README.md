# components/ui

Theme-driven primitives. Import from `components/ui`.

## Which one
- Button: text actions (primary = one per screen, secondary, ghost, danger). IconButton: icon-only actions.
- ListRow: settings and menu rows; trailing value + chevron, or an accessory such as Toggle.
- Toggle: on/off. SegmentedControl: pick one of 2-5. Chip: filters and multi-select pills.
- Banner: inline status with an optional action. EmptyBlock: empty and error states.
- Sheet: bottom sheet for pickers and forms. SectionHeader: group label. ProgressBar: transfers.
- Screen: safe-area container with optional header. PressableScale: build custom pressables.

## Styling pattern
```ts
const { colors } = useTheme();
const styles = useMemo(() => makeStyles(colors), [colors]);
const makeStyles = (c: ThemeColors) => StyleSheet.create({ ... });
```
No hex or rgba literals; use `colors.*` and `alpha()`. Text uses `type.body`/`type.bodyStrong`;
numbers use `type.mono`. Icons come only from `PixelIcon`. No shadows, glows or pulsing.
Pressed = scale 0.97 + surfaceRaised.

## Accessibility
- Every interactive element is at least 44x44 (use `hitSlop` when smaller visually).
- Set `accessibilityRole`, `accessibilityLabel` and `accessibilityState` on every control.
- IconButton and Toggle require `accessibilityLabel`.
- Do not convey state by color alone; pair it with an icon or text.
