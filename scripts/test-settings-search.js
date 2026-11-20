#!/usr/bin/env node
// Settings search (Settings tab): every settings page has index entries, ids are unique, and
// searchSettings finds Wi-Fi and Appearance rows. Also checks the Settings tab wiring.
// Needs Node 22.18+ (imports the TypeScript index directly via type stripping).

process.removeAllListeners("warning");

const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ""}`);
  }
}

async function main() {
  console.log("Settings search");
  const indexPath = path.join(root, "utils/settingsIndex.ts");
  if (!exists("utils/settingsIndex.ts")) {
    check("utils/settingsIndex.ts exists", false);
    process.exit(1);
  }
  const { SETTINGS_INDEX, searchSettings, SYNONYM_GROUPS } = await import(indexPath);

  // Pages: every app/settings/*.tsx except redirects must have at least one entry.
  const settingsDir = path.join(root, "app/settings");
  const pages = fs
    .readdirSync(settingsDir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => f.replace(/\.tsx$/, ""));
  const redirects = pages.filter((p) =>
    /<Redirect\b/.test(read(`app/settings/${p}.tsx`)),
  );
  const indexedPages = new Set(SETTINGS_INDEX.map((e) => e.page));

  for (const e of SETTINGS_INDEX) {
    const file = `app/settings/${e.page}.tsx`;
    check(
      `entry "${e.id}" page file ${file} exists`,
      exists(file),
      exists(file) ? "" : "missing; updates.tsx may still be in progress",
    );
  }

  const ids = SETTINGS_INDEX.map((e) => e.id);
  check(
    "ids are unique",
    new Set(ids).size === ids.length,
    ids.filter((id, i) => ids.indexOf(id) !== i).join(", "),
  );

  for (const p of pages) {
    if (redirects.includes(p)) {
      check(`${p} is a redirect (no entries needed)`, true);
      continue;
    }
    check(`page "${p}" has at least one entry`, indexedPages.has(p));
  }

  const ids1 = searchSettings("wifi").map((e) => e.id);
  const ids2 = searchSettings("Wi-Fi").map((e) => e.id);
  const ids3 = searchSettings("wi fi").map((e) => e.id);
  check(
    "'wifi' and 'Wi-Fi' return the same ids",
    JSON.stringify(ids1) === JSON.stringify(ids2),
    `${ids1} vs ${ids2}`,
  );
  check(
    "'wi fi' returns the same ids",
    JSON.stringify(ids1) === JSON.stringify(ids3),
  );
  check(
    "'wifi' returns at least 2 results",
    ids1.length >= 2,
    `got ${ids1.length}`,
  );

  const dark = searchSettings("dark");
  check(
    "'dark' finds the Appearance mode entry",
    dark.some((e) => e.page === "interface" && /mode/i.test(e.title)),
    dark.map((e) => e.title).join(", "),
  );

  check("'' returns []", searchSettings("").length === 0);
  check("'   ' returns []", searchSettings("   ").length === 0);
  check("'zzzz' returns []", searchSettings("zzzz").length === 0);
  check("results are capped at 30", searchSettings("e").length <= 30);

  // Words need not sit side by side (review finding, 0.25).
  check(
    "'mobile wifi' finds a setting",
    searchSettings("mobile wifi").length >= 1,
  );
  check(
    "'pause battery' finds a setting",
    searchSettings("pause battery").length >= 1,
  );
  check("'wi fi' still finds Wi-Fi rows", searchSettings("wi fi").length >= 2);
  check("'dark zzzz' finds nothing", searchSettings("dark zzzz").length === 0);

  // Stop words: filler words are dropped before matching; an all-filler query falls back to its words.
  const top = (q, n = 1) =>
    searchSettings(q)
      .slice(0, n)
      .map((e) => e.id);
  check(
    "stop words: 'make it dark' finds Mode (second to Dark pages, whose title says dark)",
    top("make it dark", 2).includes("appearance-mode"),
    top("make it dark").join(","),
  );
  check(
    "stop words: 'stop when battery low' finds Pause below",
    top("stop when battery low")[0] === "power-pause-below",
    top("stop when battery low").join(","),
  );
  check(
    "stop words: 'how many downloads at once' finds Active downloads",
    top("how many downloads at once")[0] === "speed-active-downloads",
    top("how many downloads at once").join(","),
  );
  check(
    "stop words: 'download over wifi only' finds Wi-Fi only",
    top("download over wifi only")[0] === "network-wifi-only",
    top("download over wifi only").join(","),
  );
  check(
    "stop words: 'stop using my data' finds a data setting",
    searchSettings("stop using my data").length >= 1,
  );
  check(
    "stop words: all-filler query 'on' still returns results",
    searchSettings("on").length > 0,
  );
  check(
    "stop words: all-filler query 'the' does not throw",
    Array.isArray(searchSettings("the")),
  );

  // Short words: 1-2 letter words are ignored for word matching unless they are the whole query.
  check(
    "short words: 'dark xq' still finds Mode (second to Dark pages, whose title says dark)",
    top("dark xq", 2).includes("appearance-mode"),
    top("dark xq").join(","),
  );
  check(
    "short words: 'xq zzzz' finds nothing",
    searchSettings("xq zzzz").length === 0,
  );
  check(
    "short words: 'ai' alone finds Assistant",
    searchSettings("ai").some((e) => e.id === "assistant-enable"),
  );
  check(
    "short words: 'ai chat' finds Assistant first",
    top("ai chat")[0] === "assistant-enable",
    top("ai chat").join(","),
  );
  check(
    "short words: 'wi fi' joined form finds Wi-Fi only first",
    top("wi fi")[0] === "network-wifi-only",
    top("wi fi").join(","),
  );
  check(
    "short words: 'share on 4g' finds Share on mobile data",
    top("share on 4g")[0] === "network-share-mobile",
    top("share on 4g").join(","),
  );
  check(
    "short words: 'ads' finds Ad blocking in top 3, and no Downloads row (3 letters match word starts only)",
    top("ads", 3).includes("browser-ad-blocking") &&
      !searchSettings("ads").some((e) => e.id === "speed-active-downloads"),
    top("ads", 3).join(","),
  );
  check(
    "short words: 'wif' finds Wi-Fi (3 letters match word starts)",
    top("wif", 3).includes("network-wifi-only"),
    top("wif", 3).join(","),
  );

  // Typos: 4+ letter words match one edit away; 3-letter words match by one deletion.
  check(
    "typo: 'bandwith' finds Download limit in top 3",
    top("bandwith", 3).includes("speed-download-limit"),
    top("bandwith", 3).join(","),
  );
  check(
    "typo: 'notifs' finds finished-download alerts",
    top("notifs", 3).includes("notifications-finished"),
    top("notifs", 3).join(","),
  );
  check(
    "typo: 'wfi' finds Wi-Fi only in top 3",
    top("wfi", 3).includes("network-wifi-only"),
    top("wfi", 3).join(","),
  );
  check(
    "typo: 'wfi' does not match a 3-letter word one edit away",
    searchSettings("wfi", [
      { id: "x", title: "Wsi", page: "p", pageTitle: "P", keywords: [] },
    ]).length === 0,
  );
  const typoIndex = [
    {
      id: "typo",
      title: "Zebra",
      page: "p",
      pageTitle: "P",
      keywords: ["wifo"],
    },
    {
      id: "exact",
      title: "Other",
      page: "p",
      pageTitle: "P",
      keywords: ["wifi"],
    },
  ];
  check(
    "typo: exact keyword ranks above typo match",
    searchSettings("wifi", typoIndex)[0].id === "exact",
  );
  check(
    "typo: 4-letter word with one substitution matches",
    searchSettings("nafe", [
      { id: "x", title: "Name", page: "p", pageTitle: "P", keywords: [] },
    ]).length === 1,
  );
  check(
    "typo: transposed letters match (adjacent swap)",
    searchSettings("nmae", [
      { id: "x", title: "Name", page: "p", pageTitle: "P", keywords: [] },
    ]).length === 1,
  );
  check(
    "typo: two edits do not match",
    searchSettings("nxxe", [
      { id: "x", title: "Name", page: "p", pageTitle: "P", keywords: [] },
    ]).length === 0,
  );

  // Ranking: more query words in the title first, then title-start > title-contains > keyword > section/page.
  const rankIndex = [
    {
      id: "kw",
      title: "Alpha",
      page: "p",
      pageTitle: "P",
      keywords: ["wifi", "network"],
    },
    {
      id: "title2",
      title: "Network wifi",
      page: "p",
      pageTitle: "P",
      keywords: [],
    },
  ];
  check(
    "rank: entry with two title hits beats entry with keyword hits",
    searchSettings("wifi network", rankIndex)[0].id === "title2",
  );
  const tierIndex = [
    { id: "place", title: "Zed", page: "p", pageTitle: "Speed", keywords: [] },
    { id: "kw", title: "Zed", page: "p", pageTitle: "P", keywords: ["speed"] },
    {
      id: "contains",
      title: "The speed",
      page: "p",
      pageTitle: "P",
      keywords: [],
    },
    {
      id: "start",
      title: "Speed limit",
      page: "p",
      pageTitle: "P",
      keywords: [],
    },
  ];
  check(
    "rank: title start > title contains > keyword > section/page",
    JSON.stringify(searchSettings("speed", tierIndex).map((e) => e.id)) ===
      JSON.stringify(["start", "contains", "kw", "place"]),
    searchSettings("speed", tierIndex)
      .map((e) => e.id)
      .join(","),
  );
  check(
    "rank: 'clear history' puts the shorter exact title first",
    top("clear history")[0] === "browser-clear-history",
    top("clear history", 2).join(","),
  );
  check(
    "rank: 'upload speed' puts Upload limit first",
    top("upload speed")[0] === "speed-upload-limit",
    top("upload speed", 2).join(","),
  );
  check(
    "rank: 'limit speed' puts a speed limit row first",
    ["speed-download-limit", "speed-upload-limit"].includes(
      top("limit speed")[0],
    ),
    top("limit speed", 2).join(","),
  );

  // Synonyms from the search eval (keywords must be plausible for the setting).
  check(
    "synonym: 'sd card' finds the download folder",
    top("sd card", 2).includes("storage-folder"),
    top("sd card", 2).join(","),
  );
  check(
    "synonym: 'port forwarding' finds UPnP",
    top("port forwarding", 3).includes("network-upnp"),
    top("port forwarding", 3).join(","),
  );
  check(
    "synonym: 'start on boot' finds resume after restart",
    top("start on boot", 3).includes("power-resume-restart"),
    top("start on boot", 3).join(","),
  );
  check(
    "synonym: 'porn sites' finds adult sources",
    top("porn sites", 3).includes("search-adult"),
    top("porn sites", 3).join(","),
  );
  check(
    "synonym: 'only at night' finds night downloads",
    top("only at night")[0] === "scheduling-night",
    top("only at night").join(","),
  );
  check(
    "synonym: 'notify me when done' finds finished alerts",
    top("notify me when done", 3).includes("notifications-finished"),
    top("notify me when done", 3).join(","),
  );
  check(
    "synonym: 'change font' finds Font",
    top("change font")[0] === "appearance-font",
    top("change font").join(","),
  );
  check(
    "synonym: 'stop using data' finds Wi-Fi only or Share on mobile data",
    top("stop using data", 3).some((id) =>
      ["network-wifi-only", "network-share-mobile"].includes(id),
    ),
    top("stop using data", 3).join(","),
  );
  check(
    "negative: 'keep screen on' finds nothing",
    searchSettings("keep screen on").length === 0,
  );
  check(
    "negative: 'bitcoin wallet' finds nothing",
    searchSettings("bitcoin wallet").length === 0,
  );
  check(
    "'App version' entry is not on About (it is a footer there)",
    !SETTINGS_INDEX.some(
      (e) => e.page === "about" && e.title === "App version",
    ),
  );
  const ssid = searchSettings("wifi");
  check(
    "'wifi' top result is a Wi-Fi row on the network page",
    ssid[0] && ssid[0].page === "network",
    ssid[0] && ssid[0].title,
  );

  const settingsTab = read("app/(tabs)/settings.tsx");
  check(
    "settings.tsx has no persistentScrollbar",
    !settingsTab.includes("persistentScrollbar"),
  );
  check(
    "settings.tsx contains 'Search sources'",
    settingsTab.includes("Search sources"),
  );
  check(
    "settings.tsx routes to 'updates'",
    /route:\s*'updates'/.test(settingsTab),
  );
  check(
    'settings.tsx sets keyboardShouldPersistTaps="handled"',
    settingsTab.includes('keyboardShouldPersistTaps="handled"'),
  );

  // Generalisation rules (0.25 wave): soft AND, light stemming, synonym groups, typo range, new rows.
  check(
    "soft AND: 3 words, 2 match: 'plugged charging zzzz' finds Charging only",
    top("plugged charging zzzz")[0] === "power-charging-only",
    top("plugged charging zzzz").join(","),
  );
  check(
    "soft AND: 2 words need both: 'plugged zzzz' finds nothing",
    searchSettings("plugged zzzz").length === 0,
  );
  check(
    "soft AND: 3 meaningful words need 2 matches ('mobile zzzz qqqq' finds nothing)",
    searchSettings("mobile zzzz qqqq").length === 0,
  );
  check(
    "single word must match: 'plugged' alone finds Charging only",
    top("plugged")[0] === "power-charging-only",
  );
  check(
    "stem: 'opening' finds Open Feeds",
    top("opening", 3).includes("feeds-open"),
    top("opening", 3).join(","),
  );
  check(
    "stem: 'websites' finds a Browser setting in top 3",
    top("websites", 3).some((id) => id.startsWith("browser-")),
    top("websites", 3).join(","),
  );
  check(
    "typo: 'baterry' (two edits, 7 letters) finds Charging only in top 3",
    top("baterry", 3).includes("power-charging-only"),
    top("baterry", 3).join(","),
  );
  check(
    "typo: fuzzy does not match a section or page name",
    searchSettings("speeeding", [
      { id: "x", title: "Zed", page: "p", pageTitle: "P", section: "Speeding", keywords: [] },
    ]).length === 0,
  );
  check(
    "synonym: 'cellular' finds Share on mobile data in top 3",
    top("cellular", 3).includes("network-share-mobile"),
    top("cellular", 3).join(","),
  );
  check(
    "synonym: 'bigger' finds Text size in top 3",
    top("bigger", 3).includes("browser-text-size"),
    top("bigger", 3).join(","),
  );
  check(
    "synonym: 'hot' finds a power setting in top 3",
    top("hot", 3).some((id) => id.startsWith("power-")),
    top("hot", 3).join(","),
  );
  check(
    "synonym: 'violet' finds Accent",
    top("violet")[0] === "appearance-accent",
    top("violet").join(","),
  );
  check(
    "synonym table: exported, 1 to 25 groups",
    Array.isArray(SYNONYM_GROUPS) &&
      SYNONYM_GROUPS.length >= 1 &&
      SYNONYM_GROUPS.length <= 25,
  );
  const accentEntry = SETTINGS_INDEX.find((e) => e.id === "appearance-accent");
  check(
    "accent entry lists violet, blue, amber, mint",
    ["violet", "blue", "amber", "mint"].every((k) =>
      accentEntry?.keywords.includes(k),
    ),
  );
  for (const t of [
    "Hide from gallery",
    "Offer to download copied links",
    "Parts per download",
    "Retry failed downloads",
    "Keep trying",
    "Read the licence",
    "Built with",
    "Open-source licence",
    "Release notes",
    "Source code on GitHub",
  ]) {
    check(`index has "${t}"`, SETTINGS_INDEX.some((e) => e.title === t));
  }

  // Rows added with swipe, file icons, tab swipe and stats backup are searchable.
  for (const [q, id] of [
    ["swipe", "appearance-swipe-actions"],
    ["swipe to remove a download", "appearance-swipe-actions"],
    ["file icon", "appearance-file-icons"],
    ["file type icons", "appearance-file-icons"],
    ["address bar", "browser-swipe-tabs"],
    ["swipe address bar", "browser-swipe-tabs"],
    ["url bar tabs", "browser-swipe-tabs"],
    ["backup stats", "backup-include-stats"],
    ["export statistics", "backup-include-stats"],
  ]) {
    check(
      `search: '${q}' finds ${id} in top 3`,
      top(q, 3).includes(id),
      top(q, 3).join(","),
    );
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
