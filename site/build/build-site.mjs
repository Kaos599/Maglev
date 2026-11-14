#!/usr/bin/env node
// Builds the static site in site/ from site/build/content.json, site/build/compare.json and app.json.
//   node site/build/build-site.mjs
// The output (index.html, compare/index.html, 404.html, sitemap.xml, robots.txt, llms.txt) is committed;
// GitHub Pages serves it as is. site/assets/site.css and site/assets/site.js are hand-written.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const ROOT = path.resolve(SITE, '..');

// ---------------------------------------------------------------- constants

/** The one public base URL, without a trailing slash: canonical, og:url, sitemap and JSON-LD. */
export const SITE_URL = 'https://harshdayal.dev/maglev';
/**
 * The site is served under this path (a Next.js rewrite on harshdayal.dev, which strips trailing
 * slashes). Every internal link and asset is root-absolute under it, never relative, because
 * /maglev without a slash would resolve relative paths against "/".
 */
const BASE_PATH = new URL(SITE_URL).pathname.replace(/\/$/, ''); // "/maglev"
const A = `${BASE_PATH}/`; // asset prefix
const HOME = BASE_PATH;
const COMPARE = `${BASE_PATH}/compare`;
const abs = (p = '') => (p ? `${SITE_URL}/${p}` : SITE_URL);
const REPO = 'https://github.com/Kaos599/Maglev';
const RELEASES = `${REPO}/releases/latest`;
const ISSUES = `${REPO}/issues`;
const LICENSE_URL = `${REPO}/blob/main/LICENSE`;
const OBTAINIUM = 'https://apps.obtainium.imranr.dev/redirect?r=obtainium://add/https://github.com/Kaos599/Maglev';
const OBTAINIUM_REPO = 'https://github.com/ImranR98/Obtainium';
const MAKER = { name: 'Harsh Dayal', url: 'https://harshdayal.dev', github: 'https://github.com/Kaos599' };
/** SHA-256 of the release signing certificate (apksigner verify --print-certs). */
const FINGERPRINT = 'c8e15bd47fb39fb2248d8b501a677e61be564d52ba535e31a1608564e35df3c4';
const PUBLISHED = '2026-11-12';

const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).expo;
const VERSION = app.version; // "<major>.<minor>"
const UPDATED = process.env.SITE_DATE || new Date().toISOString().slice(0, 10);
const human = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const UPDATED_HUMAN = human(UPDATED);

const C = JSON.parse(fs.readFileSync(path.join(HERE, 'content.json'), 'utf8'));

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fill = (s) => String(s).replaceAll('{{FINGERPRINT}}', FINGERPRINT);

function relFor(url) {
  if (url.startsWith(MAKER.url)) return 'author';
  if (url === MAKER.github) return 'me';
  return 'noopener';
}
/** "[text](url)" to links; everything else escaped. A relative target like "compare/" becomes /maglev/compare. */
const md = (s) =>
  fill(s)
    .split(/(\[[^\]]+\]\([^)]+\))/)
    .map((part) => {
      const m = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (!m) return esc(part);
      const href = /^(https?:|#|mailto:)/.test(m[2]) ? m[2] : `${BASE_PATH}/${m[2].replace(/^\.?\//, '').replace(/\/$/, '')}`;
      return `<a href="${esc(href)}" rel="${relFor(m[2])}">${esc(m[1])}</a>`;
    })
    .join('');
/** The same words as md(), as plain text (JSON-LD, llms.txt). */
const plain = (s) => fill(s).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

const iconSrc = fs.readFileSync(path.join(ROOT, 'components/icons.generated.ts'), 'utf8');
const ICONS = JSON.parse(iconSrc.match(/ICON_PATHS = (\{[\s\S]*?\n\})/)[1].replace(/,\s*\}$/, '}'));
const icon = (name, cls = 'px') => {
  if (!ICONS[name]) throw new Error(`no icon ${name}`);
  return `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="${ICONS[name]}"/></svg>`;
};

const TITLE = 'Maglev: free Android downloader for videos, links and torrents';
const DESC =
  'Maglev is a free, open source Android downloader with no ads. Save videos from web pages, HLS streams, ordinary links and torrents. Android 7 and up.';
const OG_ALT = 'The Maglev pixel train logo next to the words: Videos, links and torrents. One small app.';
const ldBlock = (o) => `<script type="application/ld+json">\n${JSON.stringify(o, null, 2).replace(/</g, '\\u003c')}\n</script>`;
// Same @id as the Person on harshdayal.dev, so the two graphs join.
const PERSON = { '@type': 'Person', '@id': 'https://harshdayal.dev/#person', name: MAKER.name, url: MAKER.url, sameAs: [MAKER.url, MAKER.github] };
const PERSON_REF = { '@id': PERSON['@id'] };

// ---------------------------------------------------------------- comparison data

const CELL = { yes: 'Yes', no: 'No', partial: 'Partial', 'not yet': 'Not yet' };
const VERSION_ROW = 'min-android';

/** Reads and checks compare.json. Returns null when it doesn't exist yet. */
function loadCompare() {
  const file = path.join(HERE, 'compare.json');
  if (!fs.existsSync(file)) return null;
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const need = (cond, msg) => { if (!cond) throw new Error(`compare.json: ${msg}`); };
  need(typeof d.checkedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.checkedOn), 'checkedOn must be YYYY-MM-DD');
  need(typeof d.method === 'string', 'method missing');
  need(Array.isArray(d.apps) && d.apps.length >= 2, 'apps missing');
  const ids = new Set();
  for (const a of d.apps) {
    need(a.id && a.name && a.url, `app without id/name/url: ${JSON.stringify(a).slice(0, 80)}`);
    need(!ids.has(a.id), `duplicate app id ${a.id}`);
    ids.add(a.id);
  }
  need(ids.has('maglev'), 'no app with id "maglev"');
  need(Array.isArray(d.rows) && d.rows.length, 'rows missing');
  for (const r of d.rows) {
    need(r.id && r.label && r.values, `row without id/label/values: ${JSON.stringify(r).slice(0, 80)}`);
    for (const id of Object.keys(r.values)) need(ids.has(id), `row ${r.id}: unknown app ${id}`);
  }
  need(d.page && d.page.title && d.page.description, 'page.title / page.description missing');
  return d;
}

/** One cell: Yes / No / Partial get an icon and the word; anything else is shown as text. Missing = No (user rule). */
function cellValue(row, appId) {
  let v = row.values[appId];
  // A version row keeps its text ("Not listed" there can't mean No); everywhere else unlisted means No.
  if (v == null || v === '' || (row.id !== VERSION_ROW && /^not listed$/i.test(String(v).trim()))) v = 'No';
  const key = String(v).trim().toLowerCase();
  if (!CELL[key]) return { kind: 'text', text: String(v) };
  return { kind: key === 'not yet' ? 'soon' : key, text: CELL[key] };
}
const MARK = {
  yes: icon('check', 'px s'),
  no: icon('close', 'px s'),
  soon: icon('clock', 'px s'),
  partial: '<svg class="px s" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M5 5h14v14H5zm2 2v10h5V7z"/></svg>',
};
const renderCell = (c) => (c.kind === 'text' ? `<span class="cv t">${esc(c.text)}</span>` : `<span class="cv ${c.kind}">${MARK[c.kind]}${c.text}</span>`);

/** The table, used in full on compare/ and trimmed on the home page. */
function compareTable(d, apps, rows, { notes = false, grouped = false, caption } = {}) {
  const foot = [];
  const noteRef = (row, a) => {
    const n = row.notes && row.notes[a.id];
    if (!notes || !n) return '';
    foot.push({ n: foot.length + 1, app: a.name, row: row.label, text: n });
    return `<sup><a href="#note-${foot.length}" id="ref-${foot.length}" aria-label="Note ${foot.length}">${foot.length}</a></sup>`;
  };
  let lastGroup = null;
  const body = rows
    .map((r) => {
      let g = '';
      if (grouped && r.group && r.group !== lastGroup) {
        lastGroup = r.group;
        g = `          <tr class="grp"><th scope="colgroup" colspan="${apps.length + 1}">${esc(r.group)}</th></tr>\n`;
      }
      const help = grouped && r.help ? `<span class="help">${esc(r.help)}</span>` : '';
      return `${g}          <tr><th scope="row"><span class="rl">${esc(r.label)}</span>${help}</th>${apps
        .map((a) => `<td${a.id === 'maglev' ? ' class="me"' : ''}>${renderCell(cellValue(r, a.id))}${noteRef(r, a)}</td>`)
        .join('')}</tr>`;
    })
    .join('\n');
  const html = `<div class="table-scroll" role="region" aria-label="${esc(caption)}" tabindex="0">
      <table class="cmp">
        <caption class="vh">${esc(caption)}</caption>
        <thead><tr><th scope="col"><span class="vh">Feature</span></th>${apps.map((a) => `<th scope="col"${a.id === 'maglev' ? ' class="me"' : ''}><a href="${esc(a.url)}" rel="noopener">${esc(a.name).replace(/([a-z])([A-Z])/g, '$1&shy;$2')}</a>${a.kind ? `<span class="kind">${esc(a.kind)}</span>` : ''}</th>`).join('')}</tr></thead>
        <tbody>
${body}
        </tbody>
      </table>
    </div>`;
  return { html, foot };
}

// ---------------------------------------------------------------- shared chrome

const head = ({ title, desc, base, canonical, noindex }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${canonical}">`}
<meta name="theme-color" content="#05070A">
<meta name="color-scheme" content="dark">
<meta name="author" content="${MAKER.name}">
<link rel="author" href="${MAKER.url}">
<link rel="icon" href="${base}favicon.ico" sizes="48x48">
<link rel="icon" href="${base}favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${base}apple-touch-icon.png">
<link rel="preload" href="${base}assets/fonts/inter-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${base}assets/fonts/inter-700.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${base}assets/fonts/silkscreen-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${base}assets/site.css">`;

const ogTags = ({ title, desc, url }) => `<meta property="og:type" content="website">
<meta property="og:site_name" content="Maglev">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${abs('assets/og.png')}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(OG_ALT)}">
<meta property="og:locale" content="en_US">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${abs('assets/og.png')}">
<meta name="twitter:image:alt" content="${esc(OG_ALT)}">`;

const header = (base, home, { compare = true, current = '' } = {}) => {
  const links = [
    ['Features', `${home}#features`],
    ...(compare ? [['Compare', COMPARE, current === 'compare']] : []),
    ['Install', `${home}#install`],
    ['FAQ', `${home}#faq`],
  ];
  const a = ([label, href, cur]) => `<a href="${href}"${cur ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="${home}"><img src="${base}assets/mark.svg" width="46" height="19" alt=""><span class="word">Maglev</span></a>
    <nav class="links" aria-label="Main">
      ${links.map(a).join('\n      ')}
    </nav>
    <details class="menu">
      <summary aria-label="Menu">${icon('more')}<span>Menu</span></summary>
      <nav aria-label="Main">
        ${links.map(a).join('\n        ')}
      </nav>
    </details>
    <a class="gh" href="${REPO}" rel="noopener" aria-label="GitHub">${icon('github')}<span>GitHub</span></a>
    <a class="btn primary dl" href="${RELEASES}" rel="noopener">${icon('download')}<span>Download</span></a>
  </div>
</header>`;
};

const footer = (home, { compare = true } = {}) => `<footer class="foot">
  <div class="wrap foot-in">
    <p class="made">Made by <a href="${MAKER.url}" rel="author">${MAKER.name}</a></p>
    <ul class="foot-links">
      <li><a href="${RELEASES}" rel="noopener">Download</a></li>
      <li><a href="${REPO}" rel="noopener">Source code</a></li>${compare ? `\n      <li><a href="${COMPARE}">Compare apps</a></li>` : ''}
      <li><a href="${home}#faq">FAQ</a></li>
      <li><a href="${ISSUES}" rel="noopener">Report a bug</a></li>
      <li><a href="${BASE_PATH}/privacy">Privacy</a></li>
      <li><a href="${LICENSE_URL}" rel="noopener">GPL-3.0 licence</a></li>
    </ul>
    <p class="fine">Icons are <a href="https://github.com/halfmage/pixelarticons" rel="noopener">Pixelarticons</a> by Gerrit Halfmann (MIT). Fonts are Inter and Silkscreen (SIL Open Font License), served from this site. Maglev v${esc(VERSION)}, page updated ${esc(UPDATED_HUMAN)}.</p>
  </div>
</footer>`;

const faqList = (items) =>
  items
    .map(([q, a]) => `    <details>
      <summary><span class="q">${esc(q)}</span>${icon('chevron-down', 'px chev')}</summary>
      <div class="a"><p>${md(a)}</p></div>
    </details>`)
    .join('\n');
const faqLd = (items) => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: items.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: plain(a) } })),
});

// ---------------------------------------------------------------- index.html

function indexLd() {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${SITE_URL}#website`, url: SITE_URL, name: 'Maglev', inLanguage: 'en', publisher: PERSON_REF },
      {
        '@type': 'WebPage',
        '@id': `${SITE_URL}#webpage`,
        url: SITE_URL,
        name: TITLE,
        description: DESC,
        isPartOf: { '@id': `${SITE_URL}#website` },
        about: { '@id': `${SITE_URL}#app` },
        primaryImageOfPage: { '@type': 'ImageObject', url: abs('assets/og.png'), width: 1200, height: 630 },
        datePublished: PUBLISHED,
        dateModified: UPDATED,
        author: PERSON_REF,
        inLanguage: 'en',
      },
      PERSON,
      {
        '@type': ['SoftwareApplication', 'MobileApplication'],
        '@id': `${SITE_URL}#app`,
        name: 'Maglev',
        description:
          'A small, fast Android downloader for videos on web pages, HLS and DASH streams, ordinary links and torrents. Free, open source and without ads.',
        url: SITE_URL,
        applicationCategory: 'UtilitiesApplication',
        applicationSubCategory: 'Download manager',
        operatingSystem: 'Android 7.0 or later',
        softwareVersion: VERSION,
        datePublished: PUBLISHED,
        dateModified: UPDATED,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        isAccessibleForFree: true,
        license: LICENSE_URL,
        downloadUrl: RELEASES,
        sameAs: [REPO],
        image: abs('assets/icon-512.png'),
        screenshot: C.screens.map((s) => ({ '@type': 'ImageObject', url: abs(`assets/screens/${s.id}-1080.webp`), width: 1080, height: 2400, caption: s.title, description: s.description })),
        author: PERSON_REF,
      },
    ],
  };
}

const SCREENS = Object.fromEntries(C.screens.map((x) => [x.id, x]));
/** One real app screen (store/images/canon/screens) in a slim hairline frame. */
const phone = (id) => {
  const sc = SCREENS[id];
  if (!sc) throw new Error(`no screen ${id} in content.json`);
  const set = (ext) => `${A}assets/screens/${id}-540.${ext} 540w, ${A}assets/screens/${id}-1080.${ext} 1080w`;
  const sizes = '(min-width: 900px) 320px, 260px';
  return `<figure class="phone">
        <picture>
          <source type="image/avif" srcset="${set('avif')}" sizes="${sizes}">
          <source type="image/webp" srcset="${set('webp')}" sizes="${sizes}">
          <img src="${A}assets/screens/${id}-540.webp" srcset="${set('webp')}" sizes="${sizes}" width="1080" height="2400" alt="${esc(sc.description)}" loading="lazy" decoding="async">
        </picture>
      </figure>`;
};

const featureRow = (f, i) => {
  if (!f.screen) {
    // No canon screen for this one: a plain text section with the full list.
    return `    <article class="ft plain" id="${f.id}">
      <div class="ft-text">
        <h3>${esc(f.title)}</h3>
        <p>${md(f.text)}</p>
      </div>
      <ul class="specs cols">
${f.specs.map((x) => `        <li>${md(x)}</li>`).join('\n')}
      </ul>
    </article>`;
  }
  const text = `<div class="ft-text">
        <h3>${esc(f.title)}</h3>
        <p>${md(f.text)}</p>
        <ul class="specs">
${f.specs.map((x) => `          <li>${md(x)}</li>`).join('\n')}
        </ul>
      </div>`;
  // Text first in the source, so phones read the heading before the picture; CSS alternates sides on wide screens.
  return `    <article class="ft${i % 2 ? ' flip' : ''}" id="${f.id}">\n      ${text}\n      ${phone(f.screen)}\n    </article>`;
};

/** Home-page teaser: Maglev and up to four well-known apps on up to nine key rows. */
function teaser(d) {
  const prefer = ['flud', 'libretorrent', '1dm', 'seal', 'ytdlnis', 'adm', 'newpipe'];
  const others = d.apps.filter((a) => a.id !== 'maglev');
  const picked = [...prefer.map((id) => others.find((a) => a.id === id)).filter(Boolean), ...others].filter((a, i, all) => all.indexOf(a) === i).slice(0, 4);
  const apps = [d.apps.find((a) => a.id === 'maglev'), ...picked];
  const want = ['torrents', 'plain-links', 'torrent-search', 'browser', 'hls', 'rss', 'ai', 'no-ads', 'open-source'];
  const rows = want.map((id) => d.rows.find((x) => x.id === id)).filter(Boolean);
  for (const r of d.rows) if (rows.length < 9 && !rows.includes(r)) rows.push(r);
  return compareTable(d, apps, rows, { caption: `Maglev compared with ${picked.map((a) => a.name).join(', ')}` }).html;
}

function index(cmp) {
  return `${head({ title: TITLE, desc: DESC, base: A, canonical: SITE_URL })}
${ogTags({ title: TITLE, desc: DESC, url: SITE_URL })}
<script src="${A}assets/site.js" defer></script>
${ldBlock(indexLd())}
${ldBlock(faqLd(C.faq))}
</head>
<body>
${header(A, HOME, { compare: !!cmp })}
<main id="main">
<section class="hero" aria-labelledby="hero-title">
  <div class="grid-bg" aria-hidden="true"></div>
  <div class="wrap hero-in">
    <div class="hero-copy">
      <p class="wordmark"><img src="${A}assets/wordmark.svg" width="280" height="56" alt="Maglev"></p>
      <h1 id="hero-title">Download videos, links and torrents on Android</h1>
      <p class="lede">A free, open source Android downloader. Save videos from web pages through an ad-free browser, download any link with pause and resume, and run torrents, in one small app with no ads.</p>
      <div class="ctas">
        <a class="btn primary" href="${RELEASES}" rel="noopener">${icon('download')}<span>Download for most phones (arm64)</span></a>
        <a class="btn" href="${OBTAINIUM}" rel="noopener">${icon('retry')}<span>Get updates with Obtainium</span></a>
      </div>
      <p class="cta-note">On the release page, tap the file ending in <span class="file">arm64-v8a.apk</span>. Not sure? <a href="#install">See which file to pick</a>.</p>
      <p class="meta">v${esc(VERSION)} · updated <time datetime="${UPDATED}">${esc(UPDATED_HUMAN)}</time> · by <a href="${MAKER.url}" rel="author">${MAKER.name}</a></p>
      <ul class="facts" aria-label="At a glance">
        <li>Free</li><li>No ads</li><li>Open source, GPL-3.0</li><li>Android 7 and up</li>
      </ul>
    </div>
    <div class="hero-art" aria-hidden="true">
      <img class="mark" src="${A}assets/mark.svg" width="428" height="176" alt="">
      <div class="rails"><i></i><i></i><i></i></div>
    </div>
  </div>
</section>

<section id="features" class="features" aria-labelledby="features-title">
  <div class="wrap">
    <h2 id="features-title" class="h2">An Android downloader for videos, links and torrents</h2>
    <p class="section-lede">A video saver, a download manager and a torrent client in one app, so you don't need three. Here is what each part does.</p>
    <div class="ft-list">
${C.features.map(featureRow).join('\n')}
    </div>
  </div>
</section>

<section class="how" aria-labelledby="how-title">
  <div class="wrap">
    <h2 id="how-title" class="h2">How it works</h2>
    <p class="section-lede">For the curious. Every engine build is compiled by GitHub Actions, which checks it for librqbit symbols and 16 KB page alignment.</p>
    <div class="how-grid">
${C.howItWorks.map((h) => `      <div class="how-item"><h3>${esc(h.title)}</h3><p>${md(h.text)}</p></div>`).join('\n')}
    </div>
  </div>
</section>
${cmp ? `
<section id="compare" class="compare" aria-labelledby="compare-title">
  <div class="wrap">
    <h2 id="compare-title" class="h2">How Maglev compares</h2>
    <p class="section-lede">As listed on each app's own pages, checked ${esc(human(cmp.checkedOn))}. Anything an app's pages don't list counts as No.</p>
    ${teaser(cmp)}
    <p class="more-link"><a class="btn" href="${COMPARE}">${icon('chevron-right')}<span>See the full comparison</span></a></p>
  </div>
</section>
` : ''}
<section id="install" class="install" aria-labelledby="install-title">
  <div class="wrap">
    <h2 id="install-title" class="h2">How to install Maglev</h2>
    <p class="section-lede">Maglev isn't on Google Play yet, so you install it from its GitHub page.</p>
    <ol class="steps">
      <li class="card">
        <span class="n">1</span>
        <h3>Download the APK</h3>
        <p>Open the <a href="${RELEASES}" rel="noopener">latest release</a> on your phone and tap the file ending in <span class="file">arm64-v8a.apk</span>. Most phones from the last six years want this one. Pick <span class="file">armeabi-v7a</span> for an older 32-bit phone, <span class="file">x86_64</span> for a Chromebook or emulator, or <span class="file">universal</span> if you aren't sure.</p>
      </li>
      <li class="card">
        <span class="n">2</span>
        <h3>Allow the install</h3>
        <p>Tap the downloaded file. Android warns about apps from outside the Play Store; that's normal for apps installed from GitHub. If it asks, tap Settings, turn on "Allow from this source", then go back and tap Install. On Android 7, turn on Unknown sources in Settings instead.</p>
      </li>
      <li class="card">
        <span class="n">3</span>
        <h3>Open Maglev</h3>
        <p>Open the app and follow the short setup. Your downloads go to the Download/Maglev folder unless you pick another one.</p>
      </li>
    </ol>
    <div class="install-more">
      <div class="card verify" id="verify">
        <h3>Check it's the real Maglev</h3>
        <p>Official APKs are built by GitHub Actions from the public source and signed with one key. Its SHA-256 fingerprint is:</p>
        <div class="fp"><code id="fingerprint">${FINGERPRINT}</code><button type="button" class="btn small copy" data-copy="fingerprint" hidden>${icon('copy')}<span>Copy</span></button></div>
        <p>To check a file on a computer with the Android SDK, run <code>apksigner verify --print-certs</code> on the APK and compare the line "Signer #1 certificate SHA-256 digest" with the fingerprint above. If it doesn't match, don't install it.</p>
      </div>
      <div class="card obtainium">
        <h3>Get updates without checking</h3>
        <p><a href="${OBTAINIUM_REPO}" rel="noopener">Obtainium</a> is a free, open source app that installs new versions from GitHub as they come out. Add Maglev to it in one tap.</p>
        <a class="btn" href="${OBTAINIUM}" rel="noopener">${icon('retry')}<span>Add to Obtainium</span></a>
      </div>
    </div>
  </div>
</section>

<section id="faq" class="faq" aria-labelledby="faq-title">
  <div class="wrap narrow">
    <h2 id="faq-title" class="h2">Questions people ask</h2>
${faqList(C.faq)}
  </div>
</section>

<section id="maker" class="maker" aria-labelledby="maker-title">
  <div class="wrap narrow">
    <div class="card maker-card">
      <h2 id="maker-title" class="h3">About the maker</h2>
      <p>Maglev is made by ${MAKER.name}.</p>
      <p class="maker-links"><a class="btn" href="${MAKER.url}" rel="author">${icon('external')}<span>harshdayal.dev</span></a> <a class="btn" href="${MAKER.github}" rel="me">${icon('github')}<span>Kaos599 on GitHub</span></a></p>
    </div>
  </div>
</section>
</main>
${footer(HOME, { compare: !!cmp })}
</body>
</html>
`;
}

// ---------------------------------------------------------------- compare/index.html

function comparePage(d) {
  const url = abs('compare');
  const p = d.page;
  const faq = (p.faq || []).map((x) => [x.q, x.a]);
  const { html: table, foot } = compareTable(d, d.apps, d.rows, { notes: true, grouped: true, caption: 'Maglev compared with other Android download apps' });
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name: p.title,
        description: p.description,
        isPartOf: { '@id': `${SITE_URL}#website` },
        about: { '@id': `${SITE_URL}#app` },
        datePublished: PUBLISHED,
        dateModified: d.checkedOn > UPDATED ? d.checkedOn : UPDATED,
        author: PERSON_REF,
        breadcrumb: { '@id': `${url}#breadcrumb` },
        inLanguage: 'en',
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Maglev', item: SITE_URL },
          { '@type': 'ListItem', position: 2, name: p.title, item: url },
        ],
      },
      PERSON,
    ],
  };
  const sources = d.apps
    .map((a) => `      <li><b>${esc(a.name)}</b>${a.kind ? ` <span class="kind">${esc(a.kind)}</span>` : ''}: ${(a.sources && a.sources.length ? a.sources : [a.url]).map((s, i) => `<a href="${esc(s)}" rel="noopener">${i ? `source ${i + 1}` : new URL(s).hostname.replace(/^www\./, '')}</a>`).join(', ')}${a.summary ? `. ${esc(a.summary)}` : ''}</li>`)
    .join('\n');

  return `${head({ title: p.title, desc: p.description, base: A, canonical: url })}
${ogTags({ title: p.title, desc: p.description, url })}
${ldBlock(ld)}
${faq.length ? ldBlock(faqLd(faq)) : ''}
</head>
<body>
${header(A, HOME, { current: 'compare' })}
<script src="${A}assets/site.js" defer></script>
<main id="main">
<section class="page-head" aria-labelledby="page-title">
  <div class="grid-bg" aria-hidden="true"></div>
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="${HOME}">Maglev</a></li><li aria-current="page">${esc(p.title)}</li></ol></nav>
    <h1 id="page-title">${esc(p.title)}</h1>
    ${p.intro ? `<p class="lede">${md(p.intro)}</p>` : ''}
    <p class="meta">Checked ${esc(human(d.checkedOn))} · ${esc(d.method)}</p>
  </div>
</section>

<section class="cmp-full" aria-labelledby="table-title">
  <div class="wrap">
    <h2 id="table-title" class="h2">Feature by feature</h2>
    <p class="section-lede">${MARK.yes.replace('class="px s"', 'class="px s inl"')} Yes, ${MARK.partial.replace('class="px s"', 'class="px s inl"')} Partial, ${MARK.no.replace('class="px s"', 'class="px s inl"')} No, ${MARK.soon.replace('class="px s"', 'class="px s inl"')} Not yet (Maglev doesn't do this today; it may come in a later version). Anything an app's own pages don't list counts as No. The table scrolls sideways on small screens.</p>
    ${table}
${foot.length ? `    <ol class="notes">\n${foot.map((f) => `      <li id="note-${f.n}"><b>${esc(f.app)}, ${esc(f.row)}:</b> ${md(f.text)} <a href="#ref-${f.n}" aria-label="Back to the table">↩</a></li>`).join('\n')}\n    </ol>` : ''}
    <h3 class="src-h">Where each answer comes from</h3>
    <ul class="sources">
${sources}
    </ul>
  </div>
</section>
${(p.sections || []).length ? `
<section class="prose-sec" aria-label="More about the differences">
  <div class="wrap narrow prose">
${p.sections.map((s) => `    <h2 class="h2">${esc(s.heading)}</h2>\n${(s.body || []).map((b) => `    <p>${md(b)}</p>`).join('\n')}`).join('\n')}
  </div>
</section>` : ''}
${faq.length ? `
<section id="faq" class="faq" aria-labelledby="faq-title">
  <div class="wrap narrow">
    <h2 id="faq-title" class="h2">Questions about the comparison</h2>
${faqList(faq)}
  </div>
</section>` : ''}

<section class="maker">
  <div class="wrap narrow">
    <div class="card cta-card">
      <h2 class="h3">Try Maglev</h2>
      <p>Free, open source and without ads. Android 7 and up.</p>
      <div class="ctas"><a class="btn primary" href="${RELEASES}" rel="noopener">${icon('download')}<span>Download for most phones (arm64)</span></a><a class="btn" href="${HOME}#install">How to install</a></div>
    </div>
  </div>
</section>
</main>
${footer(HOME)}
</body>
</html>
`;
}

// ---------------------------------------------------------------- privacy/index.html

function privacyPage(p, cmp) {
  const url = abs('privacy');
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name: p.title,
        description: p.description,
        isPartOf: { '@id': `${SITE_URL}#website` },
        about: { '@id': `${SITE_URL}#app` },
        dateModified: p.updated,
        author: PERSON_REF,
        inLanguage: 'en',
      },
      PERSON,
    ],
  };
  return `${head({ title: `${p.title} | Maglev`, desc: p.description, base: A, canonical: url })}
${ogTags({ title: `${p.title} | Maglev`, desc: p.description, url })}
${ldBlock(ld)}
</head>
<body>
${header(A, HOME, { compare: !!cmp })}
<script src="${A}assets/site.js" defer></script>
<main id="main">
<section class="page-head" aria-labelledby="page-title">
  <div class="grid-bg" aria-hidden="true"></div>
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="${HOME}">Maglev</a></li><li aria-current="page">${esc(p.title)}</li></ol></nav>
    <h1 id="page-title">${esc(p.title)}</h1>
    <p class="lede">${md(p.intro)}</p>
    <p class="meta">Updated ${esc(human(p.updated))}</p>
  </div>
</section>
<section class="prose-sec" aria-label="${esc(p.title)}">
  <div class="wrap narrow prose">
${p.sections.map((x) => `    <h2 class="h2">${esc(x.heading)}</h2>\n${x.body.map((b) => `    <p>${md(b)}</p>`).join('\n')}`).join('\n')}
  </div>
</section>
</main>
${footer(HOME, { compare: !!cmp })}
</body>
</html>
`;
}

// ---------------------------------------------------------------- 404.html

// GitHub Pages serves 404.html at whatever path was asked for, so relative paths would break:
// its assets and links are root-absolute under BASE_PATH like every other page.
const notFound = (cmp) => `${head({ title: 'Page not found | Maglev', desc: 'This page does not exist. Go to the Maglev home page to download the app.', base: A, noindex: true })}
</head>
<body class="nf-body">
${header(A, HOME, { compare: !!cmp })}
<main id="main" class="nf">
  <div class="grid-bg" aria-hidden="true"></div>
  <div class="wrap nf-in">
    <img class="mark" src="${A}assets/mark.svg" width="180" height="74" alt="">
    <h1>This page isn't here.</h1>
    <p class="lede">The link may be old, or the address has a typo.</p>
    <div class="ctas">
      <a class="btn primary" href="${HOME}">${icon('back')}<span>Go to the home page</span></a>
      <a class="btn" href="${HOME}#faq">Read the FAQ</a>
    </div>
  </div>
</main>
${footer(HOME, { compare: !!cmp })}
</body>
</html>
`;

// ---------------------------------------------------------------- small files

const sitemap = (cmp) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}</loc>
    <lastmod>${UPDATED}</lastmod>
  </url>${cmp ? `
  <url>
    <loc>${abs('compare')}</loc>
    <lastmod>${cmp.checkedOn > UPDATED ? cmp.checkedOn : UPDATED}</lastmod>
  </url>` : ''}${C.privacy ? `
  <url>
    <loc>${abs('privacy')}</loc>
    <lastmod>${C.privacy.updated}</lastmod>
  </url>` : ''}
</urlset>
`;

const robots = () => `User-agent: *
Allow: /

Sitemap: ${abs('sitemap.xml')}
`;

const llms = (cmp) => `# Maglev

> Maglev is a free, open source Android downloader with no ads. It saves videos from web pages (including on-demand HLS and DASH streams), downloads ordinary links with pause and resume, and runs torrents, in one app. Android 7 and later. Version ${VERSION}.

Made by ${MAKER.name} (${MAKER.url}, GitHub: ${MAKER.github}). License: GPL-3.0.

## Key facts

${C.features.map((x) => `- ${x.title}: ${plain(x.text)} ${x.specs.map(plain).join('. ')}.`).join('\n')}
- Maglev never gets around DRM. Protected video, live streams and YouTube-style players can't be saved.
- Release signing certificate SHA-256: ${FINGERPRINT}

## How it works

${C.howItWorks.map((h) => `- ${h.title}: ${plain(h.text)}`).join('\n')}

## Links

- [Website](${SITE_URL})${cmp ? `\n- [${cmp.page.title} (comparison with ${cmp.apps.filter((a) => a.id !== 'maglev').map((a) => a.name).join(', ')})](${abs('compare')})` : ''}
- [Download (latest release)](${RELEASES})
- [Source code](${REPO})
- [Report a bug](${ISSUES})
- [Get updates with Obtainium](${OBTAINIUM})
- [License](${LICENSE_URL})
${cmp ? `
## Comparison (checked ${cmp.checkedOn}; anything not listed on an app's own pages counts as No)

${cmp.rows.map((r) => `- ${r.label}: ${cmp.apps.map((a) => `${a.name} ${cellValue(r, a.id).text}`).join('; ')}`).join('\n')}
` : ''}
## FAQ

${C.faq.map(([q, a]) => `### ${q}\n\n${plain(a)}`).join('\n\n')}
`;

// ---------------------------------------------------------------- write

const cmp = loadCompare();
if (!cmp) console.warn('compare.json not found: building without the comparison');
// Output from earlier versions of this build that no longer exists.
fs.rmSync(path.join(SITE, 'app-screens'), { recursive: true, force: true });

const files = {
  'index.html': index(cmp),
  '404.html': notFound(cmp),
  'sitemap.xml': sitemap(cmp),
  'robots.txt': robots(),
  'llms.txt': llms(cmp),
};
if (cmp) files['compare/index.html'] = comparePage(cmp);
if (C.privacy) files['privacy/index.html'] = privacyPage(C.privacy, cmp);
else fs.rmSync(path.join(SITE, 'compare'), { recursive: true, force: true });
for (const [name, body] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(SITE, name)), { recursive: true });
  fs.writeFileSync(path.join(SITE, name), body);
}
console.log(`built site/ for ${SITE_URL}: v${VERSION}, updated ${UPDATED}, ${C.faq.length} FAQ items${cmp ? `, compare: ${cmp.apps.length} apps x ${cmp.rows.length} rows` : ''}`);
