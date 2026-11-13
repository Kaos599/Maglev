/**
 * Launcher icons the user can pick (Settings > Appearance > App icon). Pure data, no imports, so node tests
 * can load it. The same ids, in the same order, live in scripts/build-app-icons.py, plugins/withAppIcons.js,
 * AppIconManager.kt and assets/app-icons/previews.ts; scripts/test-app-icons.js fails when they drift.
 */
export type AppIconGroup = 'train' | 'm' | 'extra';

export interface AppIconInfo {
  id: string;
  name: string;
  group: AppIconGroup;
}

export const DEFAULT_APP_ICON = 'teal';

export const APP_ICONS: readonly AppIconInfo[] = [
  { id: 'teal', name: 'Teal', group: 'train' },
  { id: 'all-dark', name: 'All Dark', group: 'train' },
  { id: 'lime', name: 'Lime', group: 'train' },
  { id: 'cyan', name: 'Cyan', group: 'train' },
  { id: 'mono', name: 'Mono', group: 'train' },
  { id: 'mono-black', name: 'Mono Black', group: 'train' },
  { id: 'mono-white', name: 'Mono White', group: 'train' },
  { id: 'mono-gray', name: 'Mono Gray', group: 'train' },
  { id: 'm-keycap-teal', name: 'M Keycap Teal', group: 'm' },
  { id: 'm-keycap-lime', name: 'M Keycap Lime', group: 'm' },
  { id: 'm-keycap-light', name: 'M Keycap Light', group: 'm' },
  { id: 'm-keycap-mono', name: 'M Keycap Mono', group: 'm' },
  { id: 'm-keycap-cyan', name: 'M Keycap Cyan', group: 'm' },
  { id: 'm-bare-lime', name: 'M Lime', group: 'm' },
  { id: 'm-bare-teal', name: 'M Teal', group: 'm' },
  { id: 'm-bare-mono', name: 'M Mono', group: 'm' },
  { id: 'nose', name: 'Nose', group: 'extra' },
  { id: 'dash', name: 'Dash', group: 'extra' },
  { id: 'crt', name: 'CRT', group: 'extra' },
  { id: 'amber', name: 'Amber', group: 'extra' },
];
