/*
 * paths.js — site identity and every URL the tracker points at.
 *
 * Browser + Node. Zero dependencies, no DOM. See ./README.md.
 *
 * The tracker this is ported from ran on TWO DA sites: a private one for the tracker
 * and a separate one for the content. Here there is one — `aemgdc/aemdev` is both.
 * That collapse is why the tracker's own pages need the `/tracker/` noindex tree: they
 * live inside a public site rather than behind another site's auth.
 *
 * One consequence worth stating plainly, because it is a decision and not an
 * accident: everything under `/tracker/` is PUBLICLY READABLE once previewed.
 * noindex keeps it out of search results; it is not access control. Anything written
 * into a tracker doc should be assumed world-visible.
 */

import { locale, normalizePath, pathForLocale } from './locales.js';

/** DA / AEM identity. One site, unlike the two-site original. */
export const ORG = 'aemgdc';
export const SITE = 'aemdev';
export const DEFAULT_BRANCH = 'main';

/** The public production host, for links a human is meant to share. */
export const PROD_HOST = 'www.aemdev.org';

/** DA service origins. */
export const DA_ADMIN = 'https://admin.da.live';
export const DA_LIVE = 'https://da.live';
export const AEM_ADMIN = 'https://admin.hlx.page';

/*
 * The tracker's own tree. Every path here is deliberately WITHOUT a leading
 * underscore: Helix excludes `_`-prefixed paths from publishing, and these feeds
 * have to be served.
 */
export const TRACKER_ROOT = '/tracker';
export const TRACKER_DATA = '/tracker/data';
export const TRACKER_GROUPS = '/tracker/data/groups';
export const TRACKER_QA = '/tracker/qa';
export const TRACKER_TX = '/tracker/tx';
export const TRACKER_REQUIREMENTS = '/tracker/requirements';

/** Published feed paths, read by the blocks. */
export const FEEDS = {
  rollup: `${TRACKER_DATA}/rollup.json`,
  txRollup: `${TRACKER_DATA}/tx-rollup.json`,
  escalations: `${TRACKER_DATA}/escalations.json`,
  txEscalations: `${TRACKER_DATA}/tx-escalations.json`,
  txIndex: (code) => `${TRACKER_DATA}/tx-index/${code}.json`,
  txReport: (code, slug) => `${TRACKER_DATA}/tx-reports/${code}--${slug}.json`,
  group: (group) => `${TRACKER_GROUPS}/${group}.json`,
};

/**
 * Lower-case a branch name.
 *
 * AEM's hostname scheme is case-sensitive in practice: `EDGE-153--aemdev--aemgdc`
 * does not resolve while `edge-153--aemdev--aemgdc` does. Branch names with capitals
 * are common, so every host builder goes through here rather than trusting callers.
 */
const branchHost = (branch) => String(branch || DEFAULT_BRANCH).toLowerCase();

/** `https://<branch>--aemdev--aemgdc.aem.page` — the preview host. */
export const previewOrigin = (branch = DEFAULT_BRANCH) => `https://${branchHost(branch)}--${SITE}--${ORG}.aem.page`;

/** `https://<branch>--aemdev--aemgdc.aem.live` — the live host. */
export const liveOrigin = (branch = DEFAULT_BRANCH) => `https://${branchHost(branch)}--${SITE}--${ORG}.aem.live`;

export const previewUrl = (path, branch) => `${previewOrigin(branch)}${normalizePath(path)}`;
export const liveUrl = (path, branch) => `${liveOrigin(branch)}${normalizePath(path)}`;
export const prodUrl = (path) => `https://${PROD_HOST}${normalizePath(path)}`;

/**
 * Recover the branch from a preview or live URL.
 *
 * Used when a report carries a URL but not the branch it was produced against —
 * judging a stale branch produces confident nonsense, so the branch has to be
 * recoverable from the evidence rather than assumed.
 */
export function branchFromUrl(url) {
  const m = /^https?:\/\/([^.]+)--([^-]+(?:-[^-]+)*)--([^.]+)\.aem\.(page|live)/.exec(String(url || ''));
  return m ? m[1] : null;
}

/**
 * The `.plain.html` form EDS serves for a page's body, used by the structural tier.
 *
 * Only the bare root needs `index` appended. `normalizePath` has already stripped
 * every other trailing slash (it has to — the slashed form 404s on this site), so a
 * second `endsWith('/')` test here was unreachable and only suggested that some other
 * path could arrive slashed.
 */
export function plainPath(path) {
  const p = normalizePath(path);
  return `${p === '/' ? '/index' : p}.plain.html`;
}

export const plainUrl = (path, branch) => `${previewOrigin(branch)}${plainPath(path)}`;

/** AEM admin status endpoint. Answers unauthenticated for this site. */
export const statusApiUrl = (path, branch = DEFAULT_BRANCH) => `${AEM_ADMIN}/status/${ORG}/${SITE}/${branchHost(branch)}${normalizePath(path)}`;

export const previewApiUrl = (path, branch = DEFAULT_BRANCH) => `${AEM_ADMIN}/preview/${ORG}/${SITE}/${branchHost(branch)}${normalizePath(path)}`;

export const publishApiUrl = (path, branch = DEFAULT_BRANCH) => `${AEM_ADMIN}/live/${ORG}/${SITE}/${branchHost(branch)}${normalizePath(path)}`;

/* ------------------------------------------------------------------ DA source */

/**
 * The DA source URL for a document or sheet.
 *
 * DA is asymmetric and it catches everyone once: a **sheet** is addressed with a
 * `.json` extension, a **document** with `.html`, and the path you GET is the path
 * you POST. `ext` is explicit for that reason — there is no safe default.
 */
export function daSourceUrl(path, ext) {
  if (!ext) throw new Error('daSourceUrl needs an explicit ext ("html" or "json") — DA addresses docs and sheets differently');
  return `${DA_ADMIN}/source/${ORG}/${SITE}${normalizePath(path)}.${ext}`;
}

/** The DA editor deep link for a document — what a reviewer clicks. */
export const daEditUrl = (path) => `${DA_LIVE}/edit#/${ORG}/${SITE}${normalizePath(path)}`;

/** The DA sheet UI deep link. */
export const daSheetUrl = (path) => `${DA_LIVE}/sheet#/${ORG}/${SITE}${normalizePath(path)}`;

/** Where DA's own Translate app keeps its projects. The tracker reads these. */
export const DA_TRANSLATE_CONFIG = '/.da/translate';
export const DA_TRANSLATION_ACTIVE = '/.da/translation/active';

/* ---------------------------------------------------------- tracker documents */

/**
 * Slug form of a path, for a flat filename.
 *
 * `/en/meetups/berlin` -> `en--meetups--berlin`. Reversible enough to read in a
 * directory listing, which is the point — these land in report filenames a human
 * greps.
 */
export function slugOf(path) {
  const p = normalizePath(path).replace(/^\//, '');
  return (p || 'index').replace(/\//g, '--');
}

/** The EN QA-notes document for a page. One doc per EN page. */
export const qaDocPath = (enPath) => `${TRACKER_QA}${normalizePath(enPath)}`;

/**
 * The translation review document for one (page, locale).
 *
 * Keyed on the LOCALE path, so the locale appears exactly once. The original doubled
 * it (`/<tree>/de/de/...`) and the duplicate segment then had to be special-cased in
 * three readers.
 */
export function txDocPath(path, code) {
  const localePath = pathForLocale(path, code);
  if (!localePath) throw new Error(`txDocPath: unknown locale "${code}"`);
  return `${TRACKER_TX}${localePath}`;
}

/** The judge's contract for a group. */
export const requirementsPath = (group) => `${TRACKER_REQUIREMENTS}/${group}/production-requirements`;

/* --------------------------------------------------------------- app deep links */

/**
 * A Page Tracker deep link.
 *
 * `readonly=1` is how you hand someone a branch build safely: a branch changes the
 * code and never the data, and every ref reads and writes the same live sheets.
 */
export function pageTrackerUrl({
  group, subGroup, filter, locale: code, branch, readonly, ref,
} = {}) {
  const params = new URLSearchParams();
  if (group) params.set('group', group);
  if (subGroup) params.set('sub-group', subGroup);
  if (filter) params.set('filter', filter);
  if (code) params.set('locale', code);
  if (branch && branch !== DEFAULT_BRANCH) params.set('branch', branch);
  if (readonly) params.set('readonly', '1');
  if (ref) params.set('ref', ref);
  const qs = params.toString();
  return `${DA_LIVE}/app/${ORG}/${SITE}/tools/page-tracker${qs ? `?${qs}` : ''}`;
}

/**
 * Every link a tracker row needs, for one page in one locale.
 *
 * Built in one place so a row in a block, a row in the DA app and a line in a
 * report cannot drift apart.
 */
export function links(path, code, branch = DEFAULT_BRANCH) {
  const enPath = pathForLocale(path, 'en') || normalizePath(path);
  const target = code ? pathForLocale(path, code) : enPath;
  const known = code ? locale(code) : null;
  return {
    enPreview: previewUrl(enPath, branch),
    enLive: liveUrl(enPath, branch),
    enEdit: daEditUrl(enPath),
    localePreview: known ? previewUrl(target, branch) : null,
    localeLive: known ? liveUrl(target, branch) : null,
    localeEdit: known ? daEditUrl(target) : null,
    qaDoc: daEditUrl(qaDocPath(enPath)),
    txDoc: known ? daEditUrl(txDocPath(enPath, code)) : null,
  };
}
