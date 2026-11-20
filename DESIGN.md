# Maglev design guide

This guide is for people designing or building a new screen in Maglev. It describes what the app looks like today and the rules the existing screens follow, so a new screen reads as part of the same app. Every value below is copied from code. When the code and this page disagree, the code is right and this page has a bug: `scripts/test-design-system.js` catches most drift, and you can open an issue for the rest.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first for the process. Open an issue before building a new screen.

Maglev is an Android app that downloads videos from web pages, ordinary links and torrents. It is meant to feel minimal, quick and a little playful, with a retro touch that stays readable for anyone.

## Principles

1. **Minimal and quick.** A screen shows what the person needs now and nothing else. Rows are one or two lines, surfaces are flat, and nothing waits on an animation. Do: one `ProgressBar` and one status line per transfer card. Don't: add a second line of stats because the data exists.
2. **Playful, not noisy.** The fun is in small pixel details and short, honest copy, not in motion or colour. Press feedback is a 0.97 scale; entrances are one 220 ms ease-out run. Do: let the finish check hold for a moment (`motion.finishHold`). Don't: add glows, pulsing dots, bounces or springs.
3. **Retro, but readable.** The look comes from pixel icons and, optionally, the Retro font style. Reading text is always Inter or Space Mono at normal sizes. The MAGLEV wordmark is the only place Silkscreen is fixed (`type.brand`, used by `HeaderBar`). Do: `...type.heading` for a title. Don't: name a font file or set `fontFamily: 'monospace'`.
4. **Plain words.** Say "Add torrent", "Resume", "Waiting for Wi-Fi", "Storage full". Raw info-hashes appear only under Detail, "Copy magnet". Do: "Couldn't pause this torrent. Try again." Don't: "Network policy gate engaged."
5. **One primary action.** Each screen or sheet has one `Button variant="primary"`. Everything else is `secondary`, `ghost` or an `IconButton`. Do: one lime button at the bottom of a sheet. Don't: two lime buttons side by side.
6. **State is never colour alone.** Pair every colour with text or an icon. A failed transfer has danger-coloured text and the word that says what failed. A selected chip has a different fill and `accessibilityState`. Do: `Banner` draws an icon per tone. Don't: mark an error with a red dot.
7. **No fake status.** Unknown is shown as unknown ("—"). No `● CORE OK` badges, no version strings in headers, no simulated values. Do: show "—" for an unknown ETA. Don't: show "0 B/s" for a speed the engine has not reported.

## Tokens

### Styling pattern

Every screen and component reads colours and fonts from the theme and builds its styles once per theme change. The pattern is documented at the top of `constants/theme.ts`:

```tsx
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../constants/theme';

export function Example() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.card}>
      <Text style={styles.name}>archive.mkv</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      padding: spacing.lg,
    },
    selected: { borderColor: c.accent, backgroundColor: alpha(c.accent, 0.08) },
    name: { ...type.mono, fontSize: type.size.md, color: c.text },
  });
```

Rules that follow from it:

- Write no hex, `rgb()` or `rgba()` outside `constants/` and `components/brand/`. Use `colors.*` and `alpha(colors.accent, 0.15)` for tints.
- Build `StyleSheet.create` inside `makeStyles(colors)`, not at module level. `type.*` is read at call time, so a module-level style would keep the font style it was created with.
- A module-level `StyleSheet` is fine only when it uses no colour and no `type.*`.
- Surfaces are flat: a 1px `colors.border` hairline, no `shadow*`, no `elevation`.

### Colour roles

Colours come from `ThemeColors` in `constants/theme.ts`. The table shows the default OLED theme with the default lime accent. The app also has `dim` and `light` themes and eight accents (lime, cyan, pink, orange, violet, blue, amber, mint), so never assume a role is a particular colour. A new role or a changed value must keep the contrast table in `constants/theme.ts` true; `scripts/test-accents.js` enforces the accent rules and the palette contrast limits.

| Role | OLED value | Use it for |
|---|---|---|
| `bg` | `#05070A` | Screen background. |
| `surface` | `#0D1117` | Cards, sheets, rows. |
| `surfaceRaised` | `#161B22` | Pressed rows and raised pieces inside a card. |
| `border` | `#1F2937` | The 1px hairline around cards and between rows. |
| `borderStrong` | `#6B7280` | Outlines of controls the user can operate (3:1 or better). |
| `outline` | `rgba(255, 255, 255, 0.1)` | The thin edge on thumbnails and other images. |
| `text` | `#F3F4F6` | Primary text. |
| `textMuted` | `#9CA3AF` | Telemetry, secondary lines, captions. |
| `textFaint` | `#7D8590` | Disabled and placeholder text only. |
| `accent` | `#CCFF00` | Primary fills, active state, done. A fill, not a text colour. |
| `onAccent` | dark on dark themes, white on light | Text and icons on an `accent` fill. |
| `accentText` | `#CCFF00` | Accent-coloured text and icons on `bg` or `surface`. |
| `download` | `#00E5FF` | Downloading and inbound speed. Becomes blue when the accent is cyan, so it never matches "active". |
| `upload` | `#CCFF00` | Uploading, seeding. |
| `paused` | `#8B949E` | Paused and idle. |
| `success` | `#3DDC84` | A confirmed good outcome in a `Banner`. |
| `warning` | `#FFB020` | Something needs attention but nothing is lost. |
| `danger` | `#FF4D79` | Errors and destructive actions. |
| `onDanger` | dark on dark themes, white on light | Text on a `danger` fill. |
| `overlay` | `rgba(0, 0, 0, 0.85)` | Scrim behind sheets and dialogs. |
| `focus` | cyan on dark, teal on light | Keyboard and screen-reader focus ring. |
| `firstBg` | accent at 10% | Background of the "First" chip. |
| `firstFg` | accent text colour | Text of the "First" chip. |
| `firstBorder` | the accent | Border of the "First" chip. |
| `selBg` | accent at 8% | Background of a selected option card. |
| `selBorder` | the accent | Border of a selected option card. |

Which role for which job:

- **Primary action, active tab, selected, finished:** `accent` for fills, `accentText` for text and icons.
- **Downloading:** `download`. Never use it for decoration.
- **Error or destructive:** `danger`. Pair it with words and, for destructive buttons, `variant="danger"`.
- **Anything quiet:** `textMuted`. Prefer it to inventing a grey.
- **Tints:** `alpha(colors.accent, 0.08)` for a selected card, never a new hex.

Contrast is enforced. Against `bg`, text, textMuted, accentText, download, upload, paused, success, warning and danger must reach 4.5:1 in every theme, and `borderStrong` must reach 3:1. `textFaint` is for hints that may be low contrast and must stay at 3:1 or better.

### Type

Screens never name a font file. They spread a slot from `type` in `constants/theme.ts`:

| Slot | Use it for |
|---|---|
| `type.heading` | Screen and sheet titles. |
| `type.body` | Copy: sentences, descriptions, button labels. |
| `type.bodyStrong` | Emphasis inside copy. |
| `type.mono` | File names, sizes, speeds, counts: anything that is telemetry. Includes `tabular-nums`. |
| `type.brand` | The MAGLEV wordmark only. Silkscreen in every style. |

`type.monoBold` also exists, for emphasised telemetry. Sizes are `type.size`: xs 11, sm 12, md 13, base 14, lg 15, xl 17, xxl 22, display 32. `base` is body copy in sheets and dialogs, `display` a hero number. Any other size needs a `// design-exception: <reason>` comment on its line.

The person picks one of three font styles in Settings, Interface (`constants/fontStyles.ts`). It applies live, to the UI only.

| Style | Headings | Filenames and telemetry | Copy |
|---|---|---|---|
| Clean (default) | Inter Bold | Inter Medium and SemiBold | Inter |
| Retro | Silkscreen | Space Mono | Inter |
| Mono | Space Mono Bold | Space Mono | Inter |

Design for all three. Clean has proportional letters with tabular digits; Space Mono is fixed-width. When a number changes length (a speed gains a digit), give it a fixed slot with `monoSlotWidth(chars, fontSize, fontScale, type.slotAdvance)` so neighbours do not shift.

Do not set `fontWeight` on text that uses a custom face. Android has no synthetic bold for them, so pick the Bold or SemiBold slot instead. The test fails on any `fontWeight` outside its allowlist.

### Spacing and radius

Use the scales, not numbers. Both live in `constants/theme.ts`.

| Spacing | dp |
|---|---|
| `spacing.xs` | 4 |
| `spacing.sm` | 8 |
| `spacing.md` | 12 |
| `spacing.lg` | 16 |
| `spacing.xl` | 20 |
| `spacing.xxl` | 24 |
| `spacing.xxxl` | 32 |
| `spacing.huge` | 40 |

| Radius | dp |
|---|---|
| `radius.sm` | 6 |
| `radius.md` | 10 |
| `radius.lg` | 14 |
| `radius.xl` | 20 |
| `radius.pill` | 999 |

Screen gutters and card margins are `spacing.lg`. Cards use `radius.lg`. The minimum touch target is `touch.min` (44).

### Motion

Motion tokens live in one place: `motion` in `constants/theme.ts`. `components/motion/tokens.ts` holds only the easing and helpers.

| Token | ms | Use |
|---|---|---|
| `motion.duration.press` | 120 | Finger down, so a press reads as immediate. |
| `motion.duration.fast` | 150 | Small fades and the toggle knob. |
| `motion.duration.release` | 160 | Finger up on an icon button. |
| `motion.duration.focus` | 180 | Tab icon, pill or selection change. |
| `motion.duration.base` | 220 | Bar fill, sheet in and out, spring back, one-shot entrance (empty states), loading dots. |
| `motion.duration.exit` | 120 | Anything leaving (dialog close, dismissed tray, fade-out). Exits are quicker than entrances. |
| `motion.duration.max` | 250 | Ceiling for any single animation. |
| `motion.loop.sweep` | 1400 | One pass of an indeterminate bar. |
| `motion.loop.shimmer` | 900 | One fade of a shimmer. |
| `motion.loop.bob` | 450 | One leg of the "more below" hint. |
| `motion.loop.dotStep` | 160 | Stagger between loading dots. |
| `motion.loop.step` | 320 | One step of the Assistant's working squares. |

The `loop` tokens are repeating animations, so they sit outside the ceiling. Holds and timeouts (`motion.finishHold`, the settings-search highlight, undo windows, debounces) are not motion and are not tokens. A one-off that must break a rule (a celebration longer than 250 ms, a linear clock) says why with `// design-exception:` on the line.

Rules: ease-out only (`easeOut`, a cubic), nothing longer than `motion.duration.max` (bar and dot loops aside), no springs or bounce, and loops only through `motion.loop`. Pressed scale is `motion.pressScale` (0.97). Bare pixel icons sink by `PRESS_SINK` (2 whole pixels) instead of scaling, because scaled pixels blur. Use `animateTo(value, to, ms, reduce)` from `components/motion/tokens.ts` so reduce motion is handled for you.

With the system's reduce-motion setting on, nothing animates: values jump to their target. Read it with `useReduceMotion()` from `components/motion/useReduceMotion.ts`, or use `useMotion()` in `components/ui/useMotion.ts`, which builds the easings for you. Gate any animation of your own on it, and never use Reanimated's `useReducedMotion`, which does not update while the app runs. Never write a bare number as an animation `duration`; `scripts/test-design-system.js` rejects it in `app/` and `components/`, and rejects a file that animates without reading reduce motion.

Which library: Reanimated for anything that follows a finger or must run on the UI thread (sheet drag, tab drag, swipe rows). React Native `Animated` with `useNativeDriver` for fire-and-forget fades and slides. Both read their durations from `motion`.

### Haptics

Call `haptic(verb)` from `constants/haptics.ts`. Say what happened, not how it should feel.

| Verb | When |
|---|---|
| `select` | A choice changed: tab, segment, toggle, chip, radio. |
| `tap` | A button where feedback helps: paste, pick a file, play or pause. |
| `commit` | The person started something: add a torrent, start a download. |
| `done` | A positive outcome they waited for: files freed, magnet copied. |
| `warn` | A destructive confirmation opens. |
| `fail` | Their action failed or was refused. |

At most one haptic per user action. Only the person's own actions buzz: nothing on mount, on scroll, from a timer or from an engine event. Call it from the handler, never from `useEffect`. Do not import `expo-haptics` outside that file.

## Components

Import primitives from `components/ui`. Each one reads the theme, meets the 44 dp target and sets its own accessibility role. The short guide is `components/ui/README.md`.

| Component | Use it for | Don't use it for | Key props |
|---|---|---|---|
| `Button` | A text action. `primary` is the one main action per screen, then `secondary`, `ghost`, `danger`. | An icon-only action. Two primaries on one screen. | `label`, `onPress`, `variant`, `size` (`md`, `lg`), `icon`, `loading`, `disabled`, `fullWidth` |
| `LoadingDots` | The loading mark: three small square dots, the one `Button` shows with `loading`. Use it for work in flight inside a row or sheet. Never `ActivityIndicator`. | A progress amount (use `ProgressBar`). | `color` |
| `IconButton` | A bare icon action in a header or row. The icon itself turns accent on press. | A text action. A button with a filled box. | `icon`, `accessibilityLabel` (required), `onPress`, `size`, `selected`, `badge`, `dot` |
| `ListRow` | A settings or menu row: title, optional subtitle, trailing value and chevron, or an accessory such as `Toggle`. | A transfer (use the transfer card). | `title`, `subtitle`, `icon`, `value`, `accessory`, `onPress`, `destructive`, `selected`, `disabled` |
| `Toggle` | On or off. | Choosing among several options. | `value`, `onValueChange`, `accessibilityLabel` (required) |
| `SegmentedControl` | Pick one of 2 to 5 short options. | More than 5 options (use a `Sheet`). | `options`, `value`, `onChange`, `accessibilityLabel` |
| `Chip` | A filter or a pill in a group. | A button with an action. | `label`, `selected`, `onPress`, `count`, `role` (`button` or `radio`) |
| `Banner` | A status that stays in the page, with at most one action. | A message that should vanish (use a notice). | `tone` (`info`, `warning`, `danger`, `success`, `neutral`), `title`, `body`, `actionLabel`, `onAction`, `onDismiss` |
| `Sheet` | A bottom sheet for a picker, a form or a destructive choice. Drag down to close. | A short message with one button (use `Dialog`). | `visible`, `onClose`, `title`, `subtitle`, `children`, `returnFocusRef` |
| `Dialog` | A short centred message above the app that goes away. | A form or a long list. | `visible`, `onClose`, `title`, `icon`, `children`, `actions` |
| `SectionHeader` | The label above a group of rows, with an optional action. | A screen title (use `Screen`). | `title`, `actionLabel`, `onAction` |
| `EmptyBlock` | An empty or error state: icon, title, one line, at most one primary action. | A loading state. | `icon`, `title`, `body`, `primary`, `secondary`, `error` |
| `ProgressBar` | Progress of a transfer. | A percentage readout on its own. | `progress` (0 to 1), `tone` (`download`, `seed`, `paused`, `error`), `indeterminate`, `resetKey` |
| `Screen` | The safe-area container with an optional header, back button and actions. | Nested inside another `Screen`. | `title`, `onBack`, `actions`, `scroll`, `edges`, `contentStyle` |
| `TextField` | Any text input: search box, link, file name, rule editor, address. Optional `label`, `help`, `error`, `leadingIcon`, a "Clear" button. | A choice among fixed options (use `SegmentedControl` or `Chip`). | `label`, `help`, `error`, `leadingIcon`, `clearable`, `clearLabel`, `mono`, `size` (`md`, `lg`), `trailing`, `bare`, `onSurface`, `multiline`, `minLines`, `maxLines`, plus every `TextInput` prop |
| `PressableScale` | Building a custom pressable with the standard press feel. | Anything a `Button`, `Chip` or `ListRow` already covers. | `style` (may take `pressed`), `scaleTo`, `feedback` (`scale` or `sink`), `haptic` |
| `RadioCard` | A single choice that needs an icon and a description, such as an onboarding option. | A plain list of choices (use `SegmentedControl` or `ListRow`). | `title`, `description`, `icon`, `selected`, `onPress`, `dashed` |
| `RangeSlider` | Choosing a low and high stop on a track. | One value (use `SegmentedControl` or a stepper row). | `steps`, `low`, `high`, `onChange`, `labelLow`, `labelHigh`, `valueText`, `minGap` |

`NoticeHost` (`components/ui/NoticeHost.tsx`) is mounted once at the app root. You do not render it; you raise a notice (see Patterns).

### PixelIcon

One icon family: [Pixelarticons](https://pixelarticons.com) (MIT), drawn by `components/PixelIcon.tsx` from `components/icons.generated.ts`.

```tsx
<PixelIcon name="check" size={24} color={colors.accentText} accessibilityLabel="Done" />
```

- `size` is 16, 20, 24 or 48. The default is 24, which is a crisp 1:1 on the 24-pixel grid. Use 16 or 20 only for inline stats.
- `color` defaults to `colors.accentText`. Pass a role from the theme.
- An icon next to text needs no label. An icon alone needs one, which is why `IconButton` requires it.
- Never import another icon library, and never use emoji as icons.

To add an icon: open `scripts/gen-icons.js`, add `ourName: 'pixelarticons-file-name'` to `MAP` (the file name must exist in `node_modules/pixelarticons/svg`), then run `node scripts/gen-icons.js`. It rewrites `components/icons.generated.ts`, and the new name becomes a valid `PixelIconName`. Do not edit the generated file by hand.

## Patterns

### The transfer card and its one status line

A transfer is a card (`components/transfers/DownloadCard.tsx`): `colors.surface`, a 1px `colors.border` hairline, `radius.lg`, `spacing.lg` margins. It holds, top to bottom:

1. The file name in `type.mono`, one line, ellipsized.
2. A `ProgressBar` whose `tone` matches the state.
3. **One status line** (`components/transfers/StatusLine.tsx`): 12 px mono on an 18 px line, always present, so rows never change height.

The status line has a left side and a right side. On the left is a short phrase that ellipsizes, then the percent as its own text so it always shows. On the right is one value (a speed or a size) in a fixed-width slot that never ellipsizes. The phrase and value share one tone: `muted`, `accent`, `danger` or `download`, mapped to `textMuted`, `accentText`, `danger` and `download`. A selected card swaps its border to `colors.accent` and its fill to `alpha(colors.accent, 0.08)`.

Do: put the reason a transfer is not moving in the phrase ("Waiting for Wi-Fi"). Don't: add a second status row, a badge or a coloured dot next to it. The action button keeps a 44 by 44 target at the right edge of the card.

### Sheet, dialog, banner, notice

| You need | Use | Example |
|---|---|---|
| The person picks or edits something | `Sheet` | Sort order, delete choices, add tracker |
| A short message above the app that goes away | `Dialog` | A one-off explanation with a single button |
| A status that stays on the page until it changes | `Banner` | "Not enough space" with a way out |
| Confirmation of something that just happened | Notice (toast) | "Link copied." |

Notices are raised through the engine context (`showNotice`) and drawn by the one `NoticeHost`, so every screen and sheet shares one place and one look. Their text lives in `constants/copy.ts` under `notices`. A notice with an action (Undo, Retry, Open settings) stays until it times out; a plain one has a dismiss button. Do not build a second toast.

Sheets close by dragging down, the backdrop, back, or their own buttons. Give a sheet a `title`, and pass `returnFocusRef` so a screen reader returns to the control that opened it. Keep one primary button in it.

### Empty and error states

Use `EmptyBlock`. An empty state says what is empty, then how to fill it, then offers at most one action. An error uses the same block with `error` set, a plain cause, and an action that recovers (Retry, Recheck, Pick folder again, Open settings).

All of the text comes from `empty` and `banners` in `constants/copy.ts`, so the voice stays the same and the copy test can check it. A new screen adds its strings there, not inline. Do not show raw error codes; each error code maps to a message and an action (see `components/detail/errorActions.ts`).

### Settings rows

Settings are `ListRow`s grouped under a `SectionHeader`. For a choice among a few values use `ChipGroup` (`components/settings/SettingsParts.tsx`), which wraps `Chip`s. For two states use a `ListRow` with a `Toggle` accessory.

Two rules apply to every user-facing setting:

- **It must do something.** The value is saved, and it reaches the engine. A toggle that is not wired up does not ship.
- **It must be searchable.** Add an entry for the row in `utils/settingsIndex.ts`. The title is the visible label, plus keywords people would type. `ListRow` and `ChipGroup` wrap themselves in a `FocusAnchor` keyed by title, so a search result scrolls to the row and highlights it. `scripts/test-settings-coverage.js` fails on a row with no entry and on an entry with no row.

### Lists

Use `FlatList` for anything that can grow. Rows keep a constant height: reserve space for numbers with `monoSlotWidth` and keep the status line present even when empty, so a row does not jump when the text changes. A recycled row must not animate from the previous item's state: pass `resetKey` to `ProgressBar`.

### Text fields

Use `TextField`, never a bare `TextInput`. It is 44 dp tall (`size="lg"`, 48 dp, for a search box), has a 1 px `borderStrong` hairline, and turns the border accent on focus and danger on error.

- **`mono`** for filenames, URLs, paths, tokens and numbers (`type.mono`). It also turns off autocapitalize, autocorrect and spellcheck. Leave it off for words people write, such as a rule name or a chat message (`type.body`).
- **`onSurface`** when the field sits inside a sheet or card (`surface` colour). The fill becomes `bg`, so the field reads as a sunken box instead of disappearing into the sheet. Fields on a screen (`bg`) leave it off and get the `surface` fill.
- **`clearable`** on a search or filter box, or any field people retype often. The "Clear" button shows only while there is text, and puts the cursor back in the field. Pass `clearLabel` when a screen needs a more specific accessibility label, such as "Clear filter text".
- **`error`** says what is wrong in plain words and what to do. It shows an icon and text, never colour alone, and is announced to screen readers. Clear it when the person edits. Use `help` for a quiet hint that is always true; an error replaces it.
- **`label`** when the field has no visible context (rule editors, sheets). A search box with a `leadingIcon` and a placeholder needs no label; the placeholder is its accessibility label.
- **`trailing`** puts a node inside the box after the input, such as a file extension next to a file name.
- **`bare`** drops the box, label, help and error and renders only the styled input. Use it when the screen owns the container, as the browser address bar and find bar do (they keep their own swipe, count and step buttons). Fonts, placeholder, selection and cursor colours still come from the field.
- **`multiline`** for a pasted link or a list. Set `minLines` and `maxLines` so it does not push the page.

### Destructive actions and Undo

Removing a transfer from the list is not destructive until the files go. Do it in two steps the person can see:

- **Removing from the list** happens at once, behind an "Removed X." notice with an Undo action. The engine delete runs after the undo window (`UNDO_BASE_MS` in `utils/undoWindow.ts`, extended when Android's accessibility timeout is longer). Use `undoRemove` from the engine context.
- **Deleting files** asks first, in a `Sheet` (`components/transfers/DeleteSheet.tsx`), with a `variant="danger"` button and the `warn` haptic when it opens.

Never delete data on a single tap with no way back. Use `danger` for the action and plain words for what it removes.

## Copy

All strings for notices, banners and empty states live in `constants/copy.ts`. `scripts/test-copy-voice.js` lints them, so the rules below are checked. Read the header of that file for the full list.

| Rule | Good | Bad |
|---|---|---|
| Plain, calm, second person, sentence case | "Your clipboard is empty." | "CLIPBOARD EMPTY" |
| Contractions, no "please" | "Couldn't pause this torrent. Try again." | "Could not pause. Please retry." |
| No "!", "Successfully", "Oops", "Error:" | "Link copied." | "Link successfully copied!" |
| No emoji, no ellipsis | "Added to Transfers." | "Added to Transfers..." |
| Notices: past tense, 12 words or fewer, end with a period | "Removed 3 transfers." | "We have removed the 3 transfers that you selected." |
| Banners: title up to 8 words, no period; body up to 16 words, with a period; one action | Title "Not enough space", body "Free up some storage, then try again." | A title that is a full sentence |
| Empty states: title up to 5 words, no period; one line saying how to fill it | "Nothing downloading" / "Add a link or a .torrent file, or find something." | "Oops! No downloads yet" |
| Errors name the cause and offer an action | "Couldn't reach the list. Check your connection." | "Error: ECONNRESET" |

One word per thing. A *transfer* is any item in the Transfers list. A *torrent* comes from a magnet link or a .torrent file. A *download* comes from a web link. Say *magnet link*, never "magnet URL"; *folder*, never "directory" or "path"; *source*, never "provider" or "indexer". The `glossary` in `constants/copy.ts` holds the patterns the test rejects.

Words to avoid on screen: pipeline jargon, "Save configuration" buttons (settings save as they change), marketing claims, and raw hashes. Write labels as the words a person would say aloud.

## Accessibility

- **Touch targets are at least 44 by 44.** When the visible element is smaller, add `hitSlop` (the `Toggle` and `SectionHeader` action do). Use `touch.min`, not a literal.
- **Every control has a role, a label and a state.** Set `accessibilityRole`, `accessibilityLabel` and `accessibilityState` (`selected`, `checked`, `disabled`). `IconButton` and `Toggle` require a label. A `Chip` in a single-choice group uses `role="radio"`.
- **Titles are headers.** Use `accessibilityRole="header"`, which `SectionHeader` and `Screen` already set.
- **State is not colour alone.** Pair colour with text or an icon.
- **Reduce motion is respected.** See Motion. Animations are short, optional and skipped when the setting is on.
- **Contrast is enforced.** Use roles from `ThemeColors` and the contrast limits hold in all three themes and all eight accents. Do not put `textFaint` on anything the person must read.
- **Text scales.** Do not clip numbers when the system font is large; use `monoSlotWidth` with `fontScale`, and let copy wrap.
- **Return focus.** A sheet or dialog gives focus back to what opened it.

## Checklist for a new screen

- [ ] I opened an issue and it was approved (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- [ ] The screen is built from `components/ui` pieces; a custom pressable uses `PressableScale`.
- [ ] Colours come from `useTheme()` and `alpha()`; no hex or rgba outside `constants/`.
- [ ] Text uses `type.heading`, `type.body` or `type.mono`; no font file names, no `fontWeight`.
- [ ] Spacing and radius come from `spacing` and `radius`.
- [ ] There is one primary action, and nothing else competes with it.
- [ ] Icons are `PixelIcon` at size 24 (16 or 20 inline), with labels where an icon stands alone.
- [ ] State is shown by text or an icon as well as colour.
- [ ] Every control is 44 by 44 or has `hitSlop`, with a role, a label and a state.
- [ ] Strings are in `constants/copy.ts`, in the voice above, and `node scripts/test-copy-voice.js` passes.
- [ ] Empty, loading and error states exist, with a way to recover.
- [ ] I checked it in OLED, dim and light, with two accents, in all three font styles, with reduce motion on.
- [ ] Any new setting does something, and has an entry in `utils/settingsIndex.ts`.
- [ ] `npm test` passes.

## Checked by

`scripts/test-design-system.js` runs as part of `npm test`. It fails when:

- a hex or `rgb()`/`rgba()` literal appears in `app/`, `components/`, `context/` or `utils/` (outside `constants/` and `components/brand/`),
- `fontFamily: 'monospace'` appears anywhere, or `fontWeight` or a `shadow*` or `elevation` key appears in `app/` or `components/`,
- an animation `duration:` is a bare number in `app/` or `components/` (no `// design-exception:`), or a file animates without reading reduce motion,
- a module-level `StyleSheet.create` or object in `app/` or `components/` reads `type.*` (it would freeze the font style from app start),
- a raw `<TextInput` appears in `app/` or `components/` outside `components/ui/` (use `TextField`),
- a numeric `fontSize: <number>` appears in `app/` or `components/` without a `// design-exception:` comment on the same line (use `type.size.*`),
- another icon library is imported,
- this file names a `colors.<role>`, `spacing.<key>`, `radius.<key>` or `type.<slot>` that is not in `constants/theme.ts`, prints a spacing, radius or OLED colour value that differs from the code, or leaves out a colour role, a spacing or radius key, a type slot, or an export of `components/ui/index.ts`.

Related checks: `scripts/test-copy-voice.js` (copy), `scripts/test-accents.js` (accent contrast), `scripts/test-haptics.js` (haptics) and `scripts/test-settings-coverage.js` (searchable settings).
