#!/usr/bin/env node
// 0.15 accessibility and polish: source checks for TalkBack focus, announcements, roles, tokens and motion.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

const sheet = strip(read('components/ui/Sheet.tsx'));
const search = strip(read('app/(tabs)/search.tsx'));
const tabs = strip(read('components/tabs/TabsSection.tsx'));
const detail = strip(read('app/torrent/[id].tsx'));
const ticket = strip(read('components/settings/StarTicket.tsx'));
const chip = strip(read('components/ui/Chip.tsx'));
const theme = read('constants/theme.ts');
const press = read('components/ui/PressableScale.tsx');
const row = strip(read('components/search/ResultRow.tsx'));
const icons = strip(read('components/settings/AppIconSection.tsx'));

console.log('Sheet');
check('Sheet calls setAccessibilityFocus', /setAccessibilityFocus/.test(sheet));
check('Sheet takes returnFocusRef', /returnFocusRef/.test(sheet));
check('Sheet moves focus to its title', /ref=\{titleRef\}/.test(sheet));
check('Sort sheet returns focus to its button', /returnFocusRef=\{sortBtnRef\}/.test(search));

console.log('Search announcements');
check('announces Removed', /`Removed \$\{text\}`/.test(search));
check('announces Recent searches cleared', /Recent searches cleared/.test(search));
check('announces Added', /`Added \$\{r\.name\}`/.test(search));
check('announces Searching N sources', /Searching \$\{plural\(eligible\.length/.test(search));
check('announces results and No results', /'No results'/.test(search) && /plural\(shown\.length, 'result', 'results'\)/.test(search));
check('announces Hidden for a day', /Hidden for a day/.test(search));
check('recents card is labelled', /accessibilityLabel="Recent searches"/.test(search));
check('fix line is one element', /accessible accessibilityLabel=\{fixLine\}/.test(search));
check('no live region left in search', !/accessibilityLiveRegion/.test(search));
check('category group is a radiogroup', /accessibilityRole="radiogroup" accessibilityLabel="Category"/.test(search));
check('category chips are radios', /role="radio" label=\{CATEGORY_LABEL/.test(search));
check('recents and fix banner use Reveal', /<Reveal visible=\{showRecents\}>/.test(search) && /<Reveal visible animate=/.test(search));

console.log('Tabs, detail, ticket, chip');
check('TabsSection announces "moved to position"', /moved to position/.test(tabs));
check('peer and tracker keys do not use the render index', !/keyExtractor=\{\(item, i\)/.test(detail) && !/\}-\$\{i\}`/.test(detail));
check('StarTicket burst hidden from a11y', /s\.burst\}[^>]*accessibilityElementsHidden[^>]*no-hide-descendants/.test(ticket));
check('StarTicket text is full strength on light', /dark \? 0\.7 : 1/.test(ticket) && /dark \? 0\.8 : 1/.test(ticket));
check('Chip has a radio role with checked state', /role\?: 'button' \| 'radio'/.test(chip) && /checked: selected/.test(chip));

console.log('Tokens and motion');
check('every palette has an outline token', (theme.match(/outline: 'rgba\((255, 255, 255|0, 0, 0), 0\.1\)'/g) || []).length === 3);
check('light outline is black 10%', /border: '#DAD9CF'[^\n]*outline: 'rgba\(0, 0, 0, 0\.1\)'/.test(theme));
check('app icon preview uses the outline token', /borderColor: c\.outline/.test(icons));
const scale = Number((theme.match(/pressScale:\s*([0-9.]+)/) || [])[1]);
check(`press scale ${scale} is within 0.95-0.97`, scale >= 0.95 && scale <= 0.97);
check('PressableScale defaults to the token', /scaleTo = motion\.pressScale/.test(press));
check('progress and count text use tabular-nums', /summary: \{[^}]*tabular-nums/.test(search) && /age: \{[^}]*tabular-nums/.test(row));

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall passed');
