import { REPO_URL } from '../components/settings/StarTicket';

export const LICENCE_URL = `${REPO_URL}/blob/main/LICENSE`;

export const aboutExtrasCopy = {
  licence: { title: 'Open-source licence', value: 'GPL-3.0', hint: 'Opens the licence page' },
  whatsNew: (version: string) => `What's new in ${version}`,
  licences: {
    title: 'Licences',
    intro: 'Maglev is free software under the GNU General Public License v3.0.',
    read: 'Read the licence',
    readHint: 'Opens the licence text on GitHub',
    builtWith: 'Built with',
    rowHint: 'Opens the project page',
  },
  notes: {
    title: "What's new",
    none: 'There are no notes for this version.',
  },
} as const;
