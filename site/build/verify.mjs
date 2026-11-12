#!/usr/bin/env node
// Checks the built site (index.html, compare/index.html, 404.html). Exits 1 on any problem.
//   node site/build/verify.mjs                 static checks only (no browser)
//   node site/build/verify.mjs --shots <dir> [--prefix v4]   also renders index and 404 at 390x844 and 1440x900 with
//                                              Playwright, checks layout, and writes screenshots to <dir>
// Playwright is found the way store/render.js finds it (node_modules, then the npx cache, or
// PLAYWRIGHT_CORE). Nothing is added to package.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, '..');
const ROOT = path.resolve(SITE, '..');
const require = createRequire(import.meta.url);
const problems = [];
const pi = process.argv.indexOf('--prefix');
const PREFIX = pi > 0 ? process.argv[pi + 1] : 'site';
const fail = (m) => problems.push(m);

// ---------------------------------------------------------------- static checks

const decode = (s) =>
  s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

function checkFaq(name, html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const parsed = [];
  for (const b of blocks) {
    try { parsed.push(JSON.parse(b)); } catch (e) { fail(`${name}: JSON-LD does not parse: ${e.message}`); }
  }
  const faqLd = parsed.find((o) => o['@type'] === 'FAQPage');
  // The visible FAQ text equals the JSON-LD text, item by item.
  const visible = [...html.matchAll(/<details>\s*<summary><span class="q">([\s\S]*?)<\/span>[\s\S]*?<div class="a">([\s\S]*?)<\/div>\s*<\/details>/g)].map((m) => [norm(decode(m[1])), norm(decode(m[2]))]);
  if (visible.length && !faqLd) fail(`${name}: FAQ without FAQPage JSON-LD`);
  if (faqLd) {
    if (visible.length !== faqLd.mainEntity.length) fail(`${name}: FAQ ${visible.length} visible, ${faqLd.mainEntity.length} in JSON-LD`);
    faqLd.mainEntity.forEach((q, i) => {
      if (!visible[i]) return;
      if (norm(q.name) !== visible[i][0]) fail(`${name}: FAQ question ${i + 1} differs: "${q.name}"`);
      if (norm(q.acceptedAnswer.text) !== visible[i][1]) fail(`${name}: FAQ answer ${i + 1} differs: "${q.name}"`);
    });
  }
  return { blocks: blocks.length, faq: visible.length };
}

const BASE_PATH = '/maglev';
/** Maps a root-absolute site URL (/maglev, /maglev/compare, /maglev/assets/x) to a file in site/. */
function fileFor(urlPath) {
  const rest = decodeURIComponent(urlPath.split('#')[0].split('?')[0]).slice(BASE_PATH.length).replace(/^\//, '');
  let f = path.join(SITE, rest);
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  return f;
}

/** Every internal href/src/srcset is root-absolute under /maglev and points at a real file. Nothing is relative. */
function checkLinks(name, html) {
  const refs = [...html.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  for (const m of html.matchAll(/\ssrcset="([^"]+)"/g)) refs.push(...m[1].split(',').map((c) => c.trim().split(/\s+/)[0]));
  for (const r of refs) {
    if (/^(https?:|mailto:|data:|#)/.test(r)) continue;
    if (r !== BASE_PATH && !r.startsWith(`${BASE_PATH}/`) && !r.startsWith(`${BASE_PATH}#`)) { fail(`${name}: not root-absolute under ${BASE_PATH}: ${r}`); continue; }
    if (/^\/maglev\/?(#|$)/.test(r) || r.startsWith(`${BASE_PATH}#`)) { if (!fs.existsSync(path.join(SITE, 'index.html'))) fail(`${name}: ${r}: no index.html`); continue; }
    if (/\/$/.test(r.split('#')[0])) fail(`${name}: trailing slash in ${r}`);
    const target = fileFor(r);
    if (!fs.existsSync(target)) fail(`${name}: ${r} does not exist`);
    else if (!target.startsWith(SITE)) fail(`${name}: ${r} points outside site/`);
  }
  // In-page anchors exist.
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/\shref="#([^"]+)"/g)) if (!ids.has(m[1])) fail(`${name}: #${m[1]} has no target`);
  // Links to the home page's sections point at ids that exist there.
  const home = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  for (const m of html.matchAll(/\shref="\/maglev#([^"]+)"/g)) if (!home.includes(`id="${m[1]}"`)) fail(`${name}: /maglev#${m[1]} has no target on the home page`);
  return refs.length;
}

function staticChecks() {
  const pages = ['index.html', 'compare/index.html'].filter((p) => fs.existsSync(path.join(SITE, p)));
  if (!pages.includes('compare/index.html')) fail('compare/index.html missing (is site/build/compare.json there?)');
  for (const name of pages) {
    const html = fs.readFileSync(path.join(SITE, name), 'utf8');
    const f = checkFaq(name, html);
    const n = checkLinks(name, html);
    const canon = (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
    if (!canon || canon.endsWith('/')) fail(`${name}: canonical missing or ends with a slash: ${canon}`);
    console.log(`static: ${name}: ${f.blocks} JSON-LD blocks, ${f.faq} FAQ items, ${n} links and sources`);
  }
  checkLinks('404.html', fs.readFileSync(path.join(SITE, '404.html'), 'utf8'));
  // One h1 each, and every <img> has alt, width and height.
  for (const name of [...pages, '404.html']) {
    const html = fs.readFileSync(path.join(SITE, name), 'utf8');
    const h1 = (html.match(/<h1[\s>]/g) || []).length;
    if (h1 !== 1) fail(`${name}: ${h1} h1`);
    for (const img of html.match(/<img\b[^>]*>/g) || []) {
      for (const a of ['alt=', 'width=', 'height=']) if (!img.includes(a)) fail(`${name}: <img> without ${a} ${img.slice(0, 80)}`);
    }
  }
  // The sitemap lists every indexable page.
  const sm = fs.readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8');
  if (pages.includes('compare/index.html') && !sm.includes('/maglev/compare</loc>')) fail('sitemap.xml lacks /maglev/compare');
  if (/<loc>[^<]*\/<\/loc>/.test(sm)) fail('sitemap.xml has a URL with a trailing slash');
}

// ---------------------------------------------------------------- browser checks

function loadPlaywright() {
  if (process.env.PLAYWRIGHT_CORE) return require(process.env.PLAYWRIGHT_CORE);
  for (const name of ['playwright-core', 'playwright']) {
    try { return require(require.resolve(name, { paths: [ROOT] })); } catch { /* next */ }
  }
  const base = path.join(os.homedir(), '.npm', '_npx');
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const dir = path.join(base, d, 'node_modules', 'playwright-core');
      try { if (require(path.join(dir, 'package.json')).version === '1.58.2') return require(dir); } catch { /* next */ }
    }
  }
  throw new Error('playwright-core not found. Run `npx --yes playwright-core@1.58.2 --version` once, or set PLAYWRIGHT_CORE.');
}

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain', '.ico': 'image/x-icon' };

/** Serves site/ under /maglev, slashless like the real host (/maglev, /maglev/compare). Unknown paths get 404.html with status 404. */
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      const f = u === BASE_PATH || u.startsWith(`${BASE_PATH}/`) ? fileFor(u) : null;
      if (!f || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end(fs.readFileSync(path.join(SITE, '404.html')));
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      res.end(fs.readFileSync(f));
    });
    srv.listen(0, () => resolve(srv));
  });
}

async function browserChecks(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const srv = await serve();
  const base = `http://localhost:${srv.address().port}${BASE_PATH}`;

  for (const [name, url] of [['index', base], ['compare', `${base}/compare`], ['404', `${base}/no/such/page`]]) {
    for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const ctx = await browser.newContext({ viewport: vp });
      const p = await ctx.newPage();
      const tag = `${name}-${vp.width}`;
      const errs = [];
      p.on('pageerror', (e) => errs.push(`pageerror ${e}`));
      p.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/no/such/')) errs.push(`${r.status()} ${r.url()}`); });
      await p.goto(url, { waitUntil: 'networkidle' });
      // Load lazy images so the full-page shot shows them, then check none is broken.
      await p.evaluate(async () => {
        document.querySelectorAll('img[loading=lazy]').forEach((i) => (i.loading = 'eager'));
        await document.fonts.ready;
        await Promise.all([...document.images].map((i) => (i.complete ? null : i.decode().catch(() => null))));
      });
      const broken = await p.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.currentSrc || i.src));
      if (broken.length) fail(`${name}-${vp.width}: broken images ${broken.join(', ')}`);
      await p.waitForTimeout(200);
      const info = await p.evaluate(() => ({
        docW: document.documentElement.scrollWidth,
        winW: window.innerWidth,
        fonts: [...document.fonts].filter((f) => f.status === 'error').map((f) => f.family),
        // .btn.dl is 40px to the eye; its ::before stretches the hit area to 44px.
        small: [...document.querySelectorAll('a.btn:not(.dl), button:not([hidden]), summary, nav a, .foot-links a, .crumbs a')]
          .filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height < 44; })
          .map((e) => `${e.textContent.trim().slice(0, 24)} ${Math.round(e.getBoundingClientRect().height)}px`),
      }));
      if (info.docW > info.winW) fail(`${tag}: page scrolls sideways (${info.docW} > ${info.winW})`);
      if (info.fonts.length) fail(`${tag}: fonts failed: ${info.fonts}`);
      if (info.small.length) fail(`${tag}: touch targets under 44px: ${info.small.join(', ')}`);
      if (errs.length) fail(`${tag}: ${errs.join(' | ')}`);
      await p.screenshot({ path: path.join(outDir, `${PREFIX}-${tag}.png`), fullPage: true });
      await p.screenshot({ path: path.join(outDir, `${PREFIX}-${tag}-top.png`) });
      console.log(`browser: ${tag} checked`);
      await ctx.close();
    }
  }
  srv.close();
  await browser.close();
}

staticChecks();
const i = process.argv.indexOf('--shots');
if (i > 0) await browserChecks(path.resolve(process.argv[i + 1] || path.join(os.tmpdir(), 'maglev-site-shots')));
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('site checks passed');
