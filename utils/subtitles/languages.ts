/**
 * Subtitle languages (docs/NATIVE_CONTRACT.md section 36.2): ISO 639-1 codes plus the regional tags pt-BR, zh-CN,
 * zh-TW and es-419. Pure. `normalizeLanguage` turns what providers return ("eng", "English", "pob",
 * "Portuguese (Brazil)", "pt_BR") into one of these codes.
 */

export interface LanguageInfo {
  code: string;
  /** English name, for search and for messages ("No German subtitles found."). */
  name: string;
  /** The language's own name, shown next to the English one in the picker. */
  native: string;
}

// [code, English name, native name, ...aliases (ISO 639-2/B, 639-2/T, 639-3 and other names, any case)]
const ROWS: [string, string, string, ...string[]][] = [
  ['en', 'English', 'English', 'eng'],
  ['es', 'Spanish', 'Español', 'spa', 'castilian', 'spanish (spain)', 'español (españa)', 'es-es'],
  ['es-419', 'Spanish (Latin America)', 'Español (Latinoamérica)', 'spl', 'spanish (latin america)', 'spanish (latinoamérica)', 'spanish (latam)', 'latin american spanish', 'spanish (mexico)', 'spanish (argentina)', 'spanish (colombia)', 'spanish (chile)', 'es-la', 'es-latam', 'esla'],
  ['pt', 'Portuguese', 'Português', 'por', 'portuguese (portugal)', 'portuguese (pt)', 'pt-pt', 'portugues'],
  ['pt-BR', 'Portuguese (Brazil)', 'Português (Brasil)', 'pob', 'ptb', 'ptbr', 'brazilian', 'brazilian portuguese', 'portuguese (br)', 'portuguese-br', 'portuguese (brazilian)', 'portugues (brasil)'],
  ['fr', 'French', 'Français', 'fre', 'fra', 'francais', 'français'],
  ['de', 'German', 'Deutsch', 'ger', 'deu'],
  ['it', 'Italian', 'Italiano', 'ita'],
  ['nl', 'Dutch', 'Nederlands', 'dut', 'nld', 'flemish'],
  ['ru', 'Russian', 'Русский', 'rus'],
  ['uk', 'Ukrainian', 'Українська', 'ukr'],
  ['pl', 'Polish', 'Polski', 'pol'],
  ['cs', 'Czech', 'Čeština', 'cze', 'ces'],
  ['sk', 'Slovak', 'Slovenčina', 'slo', 'slk'],
  ['sl', 'Slovenian', 'Slovenščina', 'slv', 'slovene'],
  ['hr', 'Croatian', 'Hrvatski', 'hrv'],
  ['sr', 'Serbian', 'Српски', 'srp'],
  ['bs', 'Bosnian', 'Bosanski', 'bos'],
  ['bg', 'Bulgarian', 'Български', 'bul'],
  ['mk', 'Macedonian', 'Македонски', 'mac', 'mkd'],
  ['ro', 'Romanian', 'Română', 'rum', 'ron', 'moldavian'],
  ['hu', 'Hungarian', 'Magyar', 'hun'],
  ['el', 'Greek', 'Ελληνικά', 'gre', 'ell'],
  ['tr', 'Turkish', 'Türkçe', 'tur'],
  ['ar', 'Arabic', 'العربية', 'ara'],
  ['fa', 'Persian', 'فارسی', 'per', 'fas', 'farsi'],
  ['he', 'Hebrew', 'עברית', 'heb'],
  ['hi', 'Hindi', 'हिन्दी', 'hin'],
  ['bn', 'Bengali', 'বাংলা', 'ben', 'bangla'],
  ['ta', 'Tamil', 'தமிழ்', 'tam'],
  ['te', 'Telugu', 'తెలుగు', 'tel'],
  ['ml', 'Malayalam', 'മലയാളം', 'mal'],
  ['kn', 'Kannada', 'ಕನ್ನಡ', 'kan'],
  ['mr', 'Marathi', 'मराठी', 'mar'],
  ['gu', 'Gujarati', 'ગુજરાતી', 'guj'],
  ['pa', 'Punjabi', 'ਪੰਜਾਬੀ', 'pan', 'panjabi'],
  ['ur', 'Urdu', 'اردو', 'urd'],
  ['ne', 'Nepali', 'नेपाली', 'nep'],
  ['si', 'Sinhala', 'සිංහල', 'sin', 'sinhalese'],
  ['ja', 'Japanese', '日本語', 'jpn'],
  ['ko', 'Korean', '한국어', 'kor'],
  ['zh', 'Chinese', '中文', 'chi', 'zho', 'chinese (any)', 'mandarin', 'cantonese', 'yue', 'cmn'],
  ['zh-CN', 'Chinese (Simplified)', '简体中文', 'chs', 'zh-hans', 'zh-hans-cn', 'zh-sg', 'zh-cn', 'chinese (simplified)', 'simplified chinese', 'chinese simplified', 'chinese (china)', 'chinese (prc)', 'chinese (mainland)'],
  ['zh-TW', 'Chinese (Traditional)', '繁體中文', 'cht', 'zh-hant', 'zh-hant-tw', 'zh-hk', 'zh-mo', 'zh-tw', 'chinese (traditional)', 'traditional chinese', 'chinese traditional', 'chinese (taiwan)', 'chinese (hong kong)', 'chinese bg code'],
  ['th', 'Thai', 'ไทย', 'tha'],
  ['vi', 'Vietnamese', 'Tiếng Việt', 'vie'],
  ['id', 'Indonesian', 'Bahasa Indonesia', 'ind', 'in'],
  ['ms', 'Malay', 'Bahasa Melayu', 'may', 'msa'],
  ['fil', 'Filipino', 'Filipino', 'tl', 'tgl', 'fil', 'tagalog'],
  ['sv', 'Swedish', 'Svenska', 'swe'],
  ['no', 'Norwegian', 'Norsk', 'nor', 'nb', 'nob', 'nn', 'nno', 'norwegian bokmal', 'norwegian nynorsk', 'bokmål'],
  ['da', 'Danish', 'Dansk', 'dan'],
  ['fi', 'Finnish', 'Suomi', 'fin'],
  ['is', 'Icelandic', 'Íslenska', 'ice', 'isl'],
  ['et', 'Estonian', 'Eesti', 'est'],
  ['lv', 'Latvian', 'Latviešu', 'lav'],
  ['lt', 'Lithuanian', 'Lietuvių', 'lit'],
  ['sq', 'Albanian', 'Shqip', 'alb', 'sqi'],
  ['hy', 'Armenian', 'Հայերեն', 'arm', 'hye'],
  ['ka', 'Georgian', 'ქართული', 'geo', 'kat'],
  ['az', 'Azerbaijani', 'Azərbaycanca', 'aze'],
  ['kk', 'Kazakh', 'Қазақша', 'kaz'],
  ['uz', 'Uzbek', 'Oʻzbekcha', 'uzb'],
  ['ca', 'Catalan', 'Català', 'cat', 'valencian'],
  ['eu', 'Basque', 'Euskara', 'baq', 'eus'],
  ['gl', 'Galician', 'Galego', 'glg'],
  ['ga', 'Irish', 'Gaeilge', 'gle'],
  ['cy', 'Welsh', 'Cymraeg', 'wel', 'cym'],
  ['af', 'Afrikaans', 'Afrikaans', 'afr'],
  ['sw', 'Swahili', 'Kiswahili', 'swa'],
  ['am', 'Amharic', 'አማርኛ', 'amh'],
  ['mn', 'Mongolian', 'Монгол', 'mon'],
  ['km', 'Khmer', 'ខ្មែរ', 'khm'],
  ['my', 'Burmese', 'မြန်မာ', 'bur', 'mya'],
  ['lo', 'Lao', 'ລາວ', 'lao'],
  ['la', 'Latin', 'Latina', 'lat'],
  ['eo', 'Esperanto', 'Esperanto', 'epo'],
  ['mt', 'Maltese', 'Malti', 'mlt'],
  ['be', 'Belarusian', 'Беларуская', 'bel'],
];

export const LANGUAGES: readonly LanguageInfo[] = ROWS.map(([code, name, native]) => ({ code, name, native }));

const clean = (s: string) => s.trim().toLowerCase().replace(/_/g, '-').replace(/\s+/g, ' ');

const ALIASES = new Map<string, string>();
for (const [code, name, native, ...aliases] of ROWS) {
  for (const key of [code, name, native, ...aliases]) {
    const k = clean(key);
    // The first row to claim a key keeps it, so a short code never moves to a regional row.
    if (!ALIASES.has(k)) ALIASES.set(k, code);
  }
}
const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function isLanguageCode(code: string): boolean {
  return BY_CODE.has(code);
}

export function languageInfo(code: string): LanguageInfo | undefined {
  return BY_CODE.get(code);
}

/** English name for messages; the code itself when unknown. */
export function languageName(code: string): string {
  return BY_CODE.get(code)?.name ?? code;
}

const ES_LATIN_REGIONS = new Set(['419', 'mx', 'ar', 'co', 'cl', 'pe', 've', 'uy', 'ec', 'bo', 'py', 'cr', 'pa', 'gt', 'hn', 'ni', 'sv', 'do', 'cu', 'pr', 'la', 'latam']);

/**
 * One of the codes in LANGUAGES, or null when the input isn't a language we know. Accepts ISO 639-1/-2/-3 codes,
 * English and native names, and BCP-47 style tags ("pt_BR", "zh-Hans-CN", "en-US" gives "en").
 */
export function normalizeLanguage(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const k = clean(input);
  if (!k) return null;
  const direct = ALIASES.get(k);
  if (direct) return direct;
  // "Name (Region)" that we have no row for: use the name alone.
  const paren = /^([^()]+?)\s*\(.*\)$/.exec(k);
  if (paren) {
    const base = ALIASES.get(paren[1].trim());
    if (base) return base;
  }
  const parts = k.split('-');
  if (parts.length > 1) {
    const base = ALIASES.get(parts[0]);
    if (!base) return null;
    if (base === 'es') return parts.slice(1).some((p) => ES_LATIN_REGIONS.has(p)) ? 'es-419' : 'es';
    if (base === 'zh') {
      const rest = parts.slice(1);
      if (rest.includes('hant') || rest.some((p) => p === 'tw' || p === 'hk' || p === 'mo')) return 'zh-TW';
      if (rest.includes('hans') || rest.some((p) => p === 'cn' || p === 'sg')) return 'zh-CN';
      return 'zh';
    }
    if (base === 'pt') return parts.slice(1).includes('br') ? 'pt-BR' : 'pt';
    return base;
  }
  return null;
}

/** The part before the region: "pt-BR" gives "pt". */
export function baseLanguage(code: string): string {
  return code.split('-')[0];
}

/** The phone's locale tag ("en-US"), or null where Intl isn't there. */
export function phoneLocale(): string | null {
  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale;
    return typeof tag === 'string' && tag ? tag : null;
  } catch {
    return null;
  }
}

/** Default languages (36.2): the phone's language, then English if that isn't English. */
export function defaultLanguages(locale: string | null | undefined = phoneLocale()): string[] {
  const own = normalizeLanguage(locale ?? '');
  if (!own) return ['en'];
  return baseLanguage(own) === 'en' ? ['en'] : [own, 'en'];
}

/**
 * How well a candidate's language fits the user's ordered choice: the index of an exact match, the index plus 0.5
 * for a same-base-language match (pt for pt-BR and back), Infinity otherwise.
 */
export function languageRank(candidate: string, wanted: readonly string[]): number {
  const exact = wanted.indexOf(candidate);
  if (exact >= 0) return exact;
  const base = baseLanguage(candidate);
  const loose = wanted.findIndex((w) => baseLanguage(w) === base);
  return loose >= 0 ? loose + 0.5 : Infinity;
}
