/*
 * locales.js — the locale registry for aemdev.org.
 *
 * Runs in BOTH the browser and Node. Zero dependencies, no DOM, no Node APIs.
 * See ./README.md for why that matters (`.mjs` is unserveable from preview.da.live).
 *
 * The list is not ours to invent: it mirrors `arbory-da/scripts/lang.js`
 * (`getSupportedLanguages()`) and `arbory-da/helix-sitemap.yaml`, which is the
 * configuration this site's translation setup is modelled on. Ten target locales
 * plus `en` as the source.
 *
 * Two codes carry a second spelling and it is the reason this file exists as a
 * registry rather than an array of strings (`pt` is listed as the control — it is the
 * near-miss case that looks like it should differ and does not):
 *
 *   ours   DA / hreflang   Google connector
 *   pt     pt              pt
 *   zh-cn  zh-cn           zh-CN
 *   zh-tw  zh-tw           zh-TW
 *
 * DA's translate config and a sitemap `hreflang` want the lowercase form; the
 * translation service wants the BCP-47 casing. They are near-misses, so a typo
 * produces a silent no-op rather than an error — the connector accepts an unknown
 * code and returns the source text untranslated. `serviceCode` exists so exactly
 * one place in the codebase knows the difference.
 */

/**
 * Every locale this site serves, source first.
 *
 * - `code`        our canonical id. Also the URL prefix segment and the sheet tab name.
 * - `name`        English display name, matching DA's `languages` sheet `name` column.
 * - `native`      what a reader of that locale calls it — used in the locale picker.
 * - `location`    the DA / EDS path prefix. Always `/<code>`; spelled out so a future
 *                 region tree (`/en/us`) can diverge without touching every caller.
 * - `serviceCode` what the translation connector is told. See the header.
 * - `script`      writing system. `detect.js` gates on this BEFORE any word scoring:
 *                 a page of Han characters is not German, whatever the word weights say.
 * - `expansion`   typical text-length multiplier vs English, from industry norms.
 *                 Used by the layout QA tier to decide whether an overflow is
 *                 expected growth or a real defect.
 */
/*
 * Written as a tuple table rather than eleven nine-key objects, so the columns line
 * up and a wrong `serviceCode` is visible by eye. Order matters: source first, then
 * the order locale tabs are created in.
 *
 *      code     English name              native        service  script   expansion
 */
const TABLE = [
  ['en', 'English', 'English', 'en', 'latin', 1.0],
  ['de', 'German', 'Deutsch', 'de', 'latin', 1.3],
  ['fr', 'French', 'Français', 'fr', 'latin', 1.25],
  ['es', 'Spanish', 'Español', 'es', 'latin', 1.25],
  ['it', 'Italian', 'Italiano', 'it', 'latin', 1.2],
  ['pt', 'Portuguese', 'Português', 'pt', 'latin', 1.25],
  ['pl', 'Polish', 'Polski', 'pl', 'latin', 1.3],
  ['ja', 'Japanese', '日本語', 'ja', 'kana', 0.6],
  ['ko', 'Korean', '한국어', 'ko', 'hangul', 0.7],
  ['zh-cn', 'Chinese (Simplified)', '简体中文', 'zh-CN', 'han', 0.5],
  ['zh-tw', 'Chinese (Traditional)', '繁體中文', 'zh-TW', 'han', 0.5],
];

export const LOCALES = TABLE.map(([code, name, native, serviceCode, script, expansion]) => ({
  code,
  name,
  native,
  location: `/${code}`,
  serviceCode,
  script,
  expansion,
  source: code === 'en',
}));

/** The source locale. Everything is translated FROM here. */
export const SOURCE_LOCALE = 'en';

/** The ten locales a page is translated INTO. Sheet tabs are created in this order. */
export const TARGET_LOCALES = LOCALES.filter((l) => !l.source).map((l) => l.code);

/** Every code including the source, in registry order. */
export const ALL_LOCALES = LOCALES.map((l) => l.code);

const BY_CODE = new Map(LOCALES.map((l) => [l.code, l]));

/**
 * Look a locale up by code.
 *
 * Returns `null` rather than throwing, and returns it for the empty string too:
 * callers routinely pass a sheet cell that may legitimately be blank, and a blank
 * is "no locale", not a bug. Callers that require a locale check for null.
 */
export function locale(code) {
  if (!code) return null;
  return BY_CODE.get(String(code).trim().toLowerCase()) || null;
}

export const isLocale = (code) => BY_CODE.has(String(code || '').trim().toLowerCase());

/*
 * Normalizes before comparing to the source. `isLocale` folds case and trims, so
 * comparing the RAW argument to `SOURCE_LOCALE` made `isTargetLocale('EN')` and
 * `isTargetLocale(' en ')` both answer true — English treated as a translation
 * target, which sends the source page into the send queue for translation into
 * itself. Sheet cells are hand-typed, so both spellings are reachable.
 */
export const isTargetLocale = (code) => isLocale(code)
  && String(code).trim().toLowerCase() !== SOURCE_LOCALE;

/**
 * Strip a trailing slash from a path, except on the bare root.
 *
 * This is not cosmetic. `docs/adaptto-2026/content-model.md` records that trailing
 * slashes 404 on this site's article paths, so `/en/articles/foo/` and
 * `/en/articles/foo` are a live 404 and a live 200. Every path entering the model
 * goes through here, so a group sync cannot record a 404 as a tracked page and the
 * two spellings cannot become two rows for one page.
 */
export function normalizePath(path) {
  if (!path) return '';
  const p = String(path).trim();
  if (p === '/') return '/';
  return p.replace(/\/+$/, '');
}

/**
 * Which locale does this path belong to?
 *
 * Longest prefix wins, so a future `/zh-cn` cannot be shadowed by a `/zh`. Returns
 * `null` for a path in no locale tree — the root home page `/` is the real case,
 * and the `indexes` group carries it as a deliberate manual row.
 */
export function localeForPath(path) {
  const p = normalizePath(path);
  const hit = LOCALES
    .filter((l) => p === l.location || p.startsWith(`${l.location}/`))
    .sort((a, b) => b.location.length - a.location.length)[0];
  return hit ? hit.code : null;
}

/**
 * The part of a path that is the same in every locale.
 *
 * `/en/meetups/berlin` -> `/meetups/berlin`, and so does `/de/meetups/berlin`.
 * This is the join key between a `data` row and its ten locale rows.
 */
export function basePath(path) {
  const p = normalizePath(path);
  const code = localeForPath(p);
  if (!code) return p;
  const { location } = locale(code);
  const rest = p.slice(location.length);
  return rest || '/';
}

/**
 * The same page in another locale.
 *
 * Accepts a path in ANY locale, so `pathForLocale('/de/x', 'ja')` works and callers
 * never have to normalize to English first.
 */
export function pathForLocale(path, code) {
  const target = locale(code);
  if (!target) return null;
  const base = basePath(path);
  return base === '/' ? target.location : `${target.location}${base}`;
}

/** The EN path a translated path came from. */
export const sourcePathFor = (path) => pathForLocale(path, SOURCE_LOCALE);

/**
 * The `locales` map `scripts/scripts.js` passes to `setConfig`.
 *
 * Exported from here so the site's link localization and the tracker can never
 * disagree about what locales exist. `ak.js` keys this map on the path prefix and
 * reads `.lang` off it to set `document.documentElement.lang`.
 *
 * The `''` entry is NOT decoration and must not be dropped as "the empty locale".
 * `ak.js`'s `getLocale()` computes `prefix` and then reads `locales[prefix].lang`
 * with no guard, and its prefix match is `pathname.startsWith(`${key}/`)` — which
 * the trailing slash makes miss on `/`, on `/en` and `/de` (the locale HOME pages),
 * and on everything under `/tracker/`. Those all fall through to `prefix = ''`, so a
 * map without a `''` key threw `Cannot read properties of undefined (reading 'lang')`
 * inside `setConfig` and killed `loadPage` before `loadArea` ran — a blank page on
 * every tracker page and every locale home page. Verified: it took out
 * `test/scripts/scripts.test.js` and `test/scripts/dapreview.test.js` at import.
 *
 * It carries no `lang` on purpose. `ak.js`'s own default parameter is `{ '': {} }`,
 * so an empty object is the fallback shape it was written against: the document keeps
 * whatever `lang` its markup declares, and `localizeUrl` takes its root-locale early
 * return. Putting `lang: 'en'` here would instead assert that `/tracker/**` is English
 * content, which is a claim about pages that are a QA surface, not site content.
 */
export function siteLocalesConfig() {
  return LOCALES.reduce((acc, l) => {
    acc[l.location] = { lang: l.code };
    return acc;
  }, { '': {} });
}
