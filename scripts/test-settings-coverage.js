#!/usr/bin/env node
// Settings search coverage: every user-facing setting row on a Settings page has a
// utils/settingsIndex.ts entry on that page, and every entry points at a row that exists.
// Rule: anything added to Settings must be searchable (AGENTS.md section 4, rule 7).
// ListRow, ChipGroup and SectionHeader wrap themselves in FocusAnchor by title, so a matching
// entry is all a row needs. Needs Node 22.18+ (imports the TypeScript files directly).

process.removeAllListeners("warning");

const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

// Rows that are not settings. Keyed "page: title". Keep short, one reason each.
const ALLOW = {
  // Read-only values, not controls.
  "browser: Domains": "block list size, read-only",
  "browser: Status": "block list state, read-only",
  "browser: Source": "block list origin, read-only",
  "feeds: Last checked": "feed status, read-only",
  "feeds: Added so far": "feed status, read-only",
  "feeds: Waiting to be added": "feed status, read-only",
  "updates: Updates": "info line shown when another app manages updates",
  "about: Release notes": "link to the What's new page, which is indexed there",
  // Per-item or computed titles (no fixed text to look up).
  "about: updateCopy.available(version)": "status row built from the new version number",
  "updates: updateCopy.available((info?.version ?? newerManaged?.version) as string)": "status row built from the new version number",
  "about: l.title": "list of project links",
  "licenses: l.name": "one row per open-source licence",
  "subtitle-languages: phoneLanguageLabel()": "the phone's own language, a fixed first row of the list",
  "subtitle-languages: Name": "one row per language in the add list, indexed as 'All languages'",
  "network: name": "one row per saved Wi-Fi name",
  "scheduling: `${r.start}–${r.end} · ${actionLabel(r)}`": "one row per schedule rule",
  "feeds: r.name || 'Untitled rule'": "one row per feed rule",
  "watch: w.paused ? `${w.query} · ${watchCopy.paused}` : w.query": "one row per watched title",
  // Fixed choice lists whose options are each indexed (the stale check keeps them honest).
  "backup: copy.parts[part]": "restore parts, indexed as 'What to restore' entries",
  "browser: c.title": "pop-up choices, indexed as Ask, Block, Allow",
  "browser: copy.ranges[r]": "time ranges inside the Clear data sheet",
};
// Row component props that hold a user-facing label.
const LABEL_PROP = { ListRow: "title", ChipGroup: "label" };

const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Reads the JSX element starting at `start` (index of '<') and returns its attribute text. */
function elementProps(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\" && quote !== "`") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && (c === ">" || (c === "/" && src[i + 1] === ">")) && src[i - 1] !== "=") {
      return src.slice(start, i);
    }
  }
  return src.slice(start);
}

/** Value text of attribute `name` inside an element's props text, or null. */
function attrValue(props, name) {
  const m = new RegExp(`\\s${name}=`).exec(props);
  if (!m) return null;
  let i = m.index + m[0].length;
  const c = props[i];
  if (c === '"' || c === "'") return { kind: "str", text: props.slice(i + 1, props.indexOf(c, i + 1)) };
  if (c !== "{") return null;
  let depth = 0;
  let quote = null;
  for (let j = i; j < props.length; j++) {
    const d = props[j];
    if (quote) {
      if (d === "\\" && quote !== "`") j++;
      else if (d === quote) quote = null;
      continue;
    }
    if (d === '"' || d === "'" || d === "`") quote = d;
    else if (d === "{") depth++;
    else if (d === "}" && --depth === 0) return { kind: "expr", text: props.slice(i + 1, j).trim() };
  }
  return null;
}

async function main() {
  // Every constants/*.ts module a page imports copy from, by file name.
  const mods = {};
  for (const f of fs.readdirSync(path.join(root, "constants")).filter((f) => f.endsWith(".ts"))) {
    const name = f.replace(/\.ts$/, "");
    try {
      mods[name] = await import(path.join(root, "constants", f));
    } catch {
      // The module imports a component or other file Node cannot load: drop the imports, stub their names.
      let src = read(`constants/${f}`);
      let stubs = "";
      src = src.replace(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*['"];?/g, (_m, names) => {
        stubs += names.split(",").map((n) => n.trim().split(/\s+as\s+/).pop()).filter(Boolean).map((n) => `const ${n} = '';`).join("");
        return "";
      });
      try {
        const js = require("module").stripTypeScriptTypes(stubs + src);
        mods[name] = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
      } catch {} // not a copy module (for example haptics)
    }
  }
  const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*constants\/(\w+)['"]/g;
  /** Exported value `name` that `src` imports from constants/*, by local identifier. */
  const imported = (src, id) => {
    for (const im of src.matchAll(IMPORT_RE)) {
      for (const part of im[1].split(",")) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if (name && (alias || name) === id) return mods[im[2]]?.[name];
      }
    }
    return undefined;
  };
  const { SETTINGS_INDEX } = await import(path.join(root, "utils/settingsIndex.ts"));

  const pages = fs.readdirSync(path.join(root, "app/settings")).filter((f) => f.endsWith(".tsx")).map((f) => f.replace(/\.tsx$/, ""));
  const errors = [];

  /** Files that render rows for a page: the page and the components it renders (two levels of imports). */
  const SKIP = /components\/(ui\/|settings\/(SettingsParts|SettingsSearch|settingsFocus))/;
  const filesFor = (page) => {
    const files = [`app/settings/${page}.tsx`];
    const rel = (from, spec) => {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
      return ["tsx", "ts"].map((x) => `${base}.${x}`).find((f) => fs.existsSync(path.join(root, f)));
    };
    const depth = { [files[0]]: 0 };
    for (let i = 0; i < files.length; i++) {
      if (depth[files[i]] >= 2) continue;
      for (const m of read(files[i]).matchAll(/from\s+['"](\.[^'"]*components\/[^'"]+)['"]/g)) {
        const f = rel(files[i], m[1]);
        if (!f || !f.endsWith(".tsx") || SKIP.test(f) || files.includes(f)) continue;
        depth[f] = depth[files[i]] + 1;
        files.push(f);
      }
    }
    return files;
  };

  /** Resolves a title expression to a string, or null when it is dynamic. */
  const resolve = (val, src) => {
    if (!val) return null;
    if (val.kind === "str") return val.text;
    let t = val.text;
    let m = /^(["'])(.*)\1$/.exec(t) || /^`([^`$]*)`$/.exec(t);
    if (m) return m[m.length - 1];
    if (/^[A-Za-z_][\w.]*$/.test(t)) {
      const [rootId, ...rest] = t.split(".");
      let cur = imported(src, rootId);
      for (const k of rest) cur = cur == null ? cur : cur[k];
      if (typeof cur === "string") return cur;
      // A copy object defined in the same file or aliased from a sub-object: find the last key's string literal.
      const key = rest[rest.length - 1];
      if (key) {
        const srcs = [src, ...[...src.matchAll(IMPORT_RE)].map((im) => read(`constants/${im[2]}.ts`))];
        for (const text of srcs) {
          const hits = new Set([...text.matchAll(new RegExp(`\\b${key}:\\s*(['"])(.*?)\\1`, "g"))].map((h) => h[2]));
          if (hits.size === 1) return [...hits][0];
          if (hits.size > 1) break;
        }
      }
    }
    return null;
  };

  for (const page of pages) {
    const entries = SETTINGS_INDEX.filter((e) => e.page === page);
    const have = new Set(entries.map((e) => norm(e.title)));
    const known = new Set(); // every string a row, header or button on this page can show
    for (const file of filesFor(page)) {
      const src = read(file);
      for (const m of src.matchAll(/<(ListRow|ChipGroup)\b/g)) {
        const props = elementProps(src, m.index);
        const val = attrValue(props, LABEL_PROP[m[1]]);
        const title = resolve(val, src);
        if (title == null) {
          const key = `${page}: ${val ? val.text : "(no title)"}`;
          if (!ALLOW[key]) errors.push(`Row with a dynamic title '${val ? val.text : "?"}' in ${file} cannot be checked. Use a literal or a copy constant, or add "${key}" to ALLOW in scripts/test-settings-coverage.js with a reason.`);
          continue;
        }
        known.add(norm(title));
        if (have.has(norm(title)) || ALLOW[`${page}: ${title}`]) continue;
        errors.push(`Setting '${title}' on app/settings/${page}.tsx has no entry in utils/settingsIndex.ts. Add one (with keywords) and wrap the row in FocusAnchor.`);
      }
    }
    // Stale entries: the title must still be a string somewhere in the page's files or in the copy they import.
    const text = filesFor(page).map(read).join("\n");
    const copyText = [];
    const walk = (v) => (typeof v === "string" ? copyText.push(v) : v && typeof v === "object" ? Object.values(v).forEach(walk) : null);
    for (const im of text.matchAll(IMPORT_RE)) {
      for (const part of im[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0];
        if (name && typeof mods[im[2]]?.[name] !== "function") walk(mods[im[2]]?.[name]);
      }
    }
    const hay = norm(text + "\n" + copyText.join("\n"));
    for (const e of entries) {
      if (!hay.includes(norm(e.title))) {
        errors.push(`Index entry '${e.id}' (title '${e.title}') on ${page} points at no row: the text is not in app/settings/${page}.tsx or the components it renders. Update or remove the entry in utils/settingsIndex.ts.`);
      }
    }
  }

  console.log("Settings coverage");
  if (errors.length) {
    for (const e of errors) console.error(`  FAIL ${e}`);
    console.error(`\n${errors.length} problem(s)`);
    process.exit(1);
  }
  console.log(`  ok   every setting row on ${pages.length} pages has an index entry, and every entry has a row`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
