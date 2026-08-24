/*
 * data.js — the browser's data layer for the published tracker feeds. Every block
 * reads through here.
 *
 * Browser + Node. Zero dependencies, no DOM. See ./README.md.
 *
 * Two access modes:
 *   loadRollup() / loadTxRollup()   one small pre-aggregated doc — KPIs and bars.
 *   loadGroup(group)                one live group sheet — drill-downs and queues.
 *
 * Feed paths come from `FEEDS` in `paths.js`; not one is spelled out here. The tree
 * has already moved once in this port, and a second copy of a feed path is a board
 * that 404s in silence.
 *
 * Stage and queue logic is NOT duplicated here either — it is imported from
 * `stages.js`, the same module the rollup generator uses. This file fetches,
 * memoises and shapes. Nothing else.
 *
 * ─── Absent is not empty ────────────────────────────────────────────────────
 *
 * No loader throws for a missing feed. A feed that has never been built is the NORMAL
 * state of a group nobody has run the pipeline over yet, and a block whose first act
 * is to throw takes the whole board down with it.
 *
 * But absent and empty are different facts, and a reader that cannot tell them apart
 * reports "0 escalations — clear queue" for a pipeline that has never run. So every
 * loader returns `missing` (the feed could not be read) and `error` (why) alongside
 * the zeroed shape, and a block is required to say which one it is looking at.
 *
 * Fetches are RELATIVE, so a branch build reads the feeds published on the host that
 * served it — no cross-origin fetch, no CORS preflight, and `?branch=` changes the
 * code without silently changing the data behind it.
 */

import { FEEDS } from './paths.js';
import { TARGET_LOCALES, locale as localeFor, normalizePath } from './locales.js';
import {
  classifyTranslation, indexLocaleRows, localeRowFor, sheetRows, sheetTabs,
} from './stages.js';

/*
 * One in-flight/resolved promise per path. Six blocks read the rollup on a single page
 * load, so this turns six fetches into one — that is its whole job, and it is why it
 * is keyed by path and never invalidated during a page's life.
 *
 * A FAILED read is memoised too. Early on the feeds legitimately 404, and six blocks
 * each retrying a 404 is the stampede the cache exists to prevent; every one of them
 * shows the same honest empty state from one answer. `clearDataCache()` is the way
 * back to the network.
 */
const cache = new Map();

/** The `data`-tab join key. Blank means "scaffold placeholder", never "page at /". */
const PATH_COLUMN = 'page-path';

/**
 * Drop memoised responses, so the next read goes to the network.
 *
 * Needed because the cache is module-scoped: it outlives any single block, and a
 * cache-busting import of a *block* does not give it a fresh data layer (the block's
 * static import of this module resolves to the same instance). Without a seam there is
 * no way to render a block twice against different data — which is exactly what a test
 * of a board needs, and in the tracker this is ported from three such tests passed for
 * the wrong reason before the seam existed.
 *
 * Pass a path to drop one entry, or nothing to drop them all.
 *
 * @param {string} [path]
 */
export function clearDataCache(path) {
  if (path) cache.delete(path);
  else cache.clear();
}

/**
 * Fetch and parse one feed, memoised, never rejecting.
 *
 * @returns {Promise<{ doc: object, missing: boolean, error: string|null }>}
 */
function readFeed(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(path)
      .then(async (res) => {
        if (!res.ok) return { doc: {}, missing: true, error: `${path} → ${res.status}` };
        return { doc: await res.json(), missing: false, error: null };
      })
      // Covers a network failure AND unparseable JSON — DA has served a truncated
      // sheet before, and to a reader that is the same fact as no sheet at all.
      .catch((e) => ({ doc: {}, missing: true, error: `${path} → ${e.message}` })));
  }
  return cache.get(path);
}

/** The `meta` tab's single row. Every feed carries one; a DA sheet cannot hold a bare key. */
const metaRow = (doc) => sheetRows(doc, 'meta')[0] ?? {};

/**
 * A named tab, falling back to a single-sheet doc's top-level rows.
 *
 * The fallback is tolerance for a hand-made or locally-served fixture, not a blessing:
 * a published multi-row feed MUST be `:type: 'multi-sheet'` with `:names`, because the
 * single-sheet form is accepted by `admin.da.live` and then refused at PREVIEW with
 * `400 error from content-bus`, leaving a file in DA that every reader 404s.
 */
const rowsOf = (doc, tab) => {
  const named = sheetRows(doc, tab);
  return named.length ? named : sheetRows(doc);
};

/** Pre-aggregated EN + group totals — one fetch, any number of groups. */
export async function loadRollup() {
  const { doc, missing, error } = await readFeed(FEEDS.rollup);
  return {
    totals: sheetRows(doc, 'totals')[0] ?? {},
    groups: sheetRows(doc, 'groups'),
    /*
     * One row per (group, subgroup), joined on `group` by whoever renders a breakdown.
     * Defaults to [] rather than undefined so a board keeps working against a rollup
     * built before the tab existed — the group row's own `subgroups` count, which
     * gates the disclosure, is likewise absent-and-falsy on an old rollup.
     */
    subgroups: sheetRows(doc, 'subgroups'),
    /*
     * The WHOLE meta row, not just its timestamp.
     *
     * `expected`/`listed`/`withheld` and `subgroups-complete` are the fields that let a
     * SHORT feed read as explained rather than as progress, and `incomplete` +
     * `groups-failed` are the separate fact that a sheet could not be read at all —
     * which the contract forbids folding into `withheld`. A board cannot report any of
     * that if the data layer drops it, and a board fetching the feed a second time to
     * get it would defeat the memoisation above. `{}` when the feed is missing, so a
     * caller reads absent fields rather than crashing on the empty state.
     */
    meta: metaRow(doc),
    generatedAt: metaRow(doc).generatedAt ?? null,
    missing,
    error,
  };
}

/**
 * The per-locale translation rollup — the `/tracker/translations` hub's only fetch.
 *
 * Separate doc from `rollup.json` rather than extra tabs on it, because the two have
 * different denominators and different build cadences: the EN rollup is rebuilt at the
 * end of every `qa:batch`, and the locale numbers only change when `tx:scan` re-crawls
 * both hosts. Sharing a doc would tie a 30-second rebuild to a much longer one.
 *
 * `stages` and `queues` carry the vocabulary WITH the data, so a board cannot drift
 * out of step with `stages.js` — the labels it renders came from the same build that
 * counted the rows.
 */
export async function loadTxRollup() {
  const { doc, missing, error } = await readFeed(FEEDS.txRollup);
  return {
    locales: sheetRows(doc, 'locales'),
    groups: sheetRows(doc, 'groups'),
    stages: sheetRows(doc, 'stages'),
    queues: sheetRows(doc, 'queues'),
    // See `loadRollup` — same reason, different unit. Here `expected`/`listed` count
    // (page, locale) PAIRS, and `cells-withheld` records the first detail tab dropped.
    meta: metaRow(doc),
    generatedAt: metaRow(doc).generatedAt ?? null,
    missing,
    error,
  };
}

/**
 * One group's live sheet: the `data` tab, its ten locale tabs, and every
 * (page, locale) pair they make.
 *
 * The pairs are built here rather than in six blocks because the fan-out is a
 * one-line rule in this model — every page in a tracked group is expected in all ten
 * locales — and that rule is also the DENOMINATOR every percentage on every board
 * divides by. One copy of it.
 *
 * @param {string} group the sheet basename, which is also the group name
 */
export async function loadGroup(group) {
  const { doc, missing, error } = await readFeed(FEEDS.group(group));
  const tabs = sheetTabs(doc);

  /*
   * Scaffold placeholder rows carry no `page-path`. `emptyGroupDoc()` writes one
   * because da.live collapses a single-tab sheet on save, so every freshly scaffolded
   * group has a blank row that is not a page and must not reach a count.
   */
  const rows = sheetRows(doc, 'data').filter((r) => normalizePath(r?.[PATH_COLUMN]));

  /*
   * Locale rows are read per REGISTERED locale, not per tab found, so a group is
   * always ten locales wide and a missing tab reads as ten blank rows rather than
   * shortening the matrix. `unknownTabs` is the other half of that: a misspelled tab
   * name would otherwise make a whole locale silently read as untranslated.
   */
  const locales = Object.fromEntries(TARGET_LOCALES.map((code) => [code, sheetRows(doc, code)]));
  const known = new Set(['data', ...TARGET_LOCALES]);
  const unknownTabs = tabs.filter((t) => !known.has(t));

  const localeIndex = indexLocaleRows(doc);
  const pairs = rows.flatMap((row) => TARGET_LOCALES.map((code) => ({
    row,
    localeRow: localeRowFor(localeIndex, row[PATH_COLUMN], code),
    path: normalizePath(row[PATH_COLUMN]),
    locale: code,
  })));

  return {
    name: group,
    rows,
    locales,
    pairs,
    localeIndex,
    tabs,
    unknownTabs,
    missing,
    error,
  };
}

/**
 * An escalation feed: per-page defects a tier or a judge could not resolve.
 *
 * @returns {Promise<{ rows: object[], generatedAt: string|null,
 *                     missing: boolean, error: string|null }>}
 */
async function loadEscalationFeed(path) {
  const { doc, missing, error } = await readFeed(path);
  return {
    rows: rowsOf(doc, 'escalations'),
    generatedAt: metaRow(doc).generatedAt ?? null,
    missing,
    error,
  };
}

/** The EN-side QA escalation feed. */
export const loadEscalations = () => loadEscalationFeed(FEEDS.escalations);

/** The translation escalation feed — the same shape, one per (page, locale). */
export const loadTxEscalations = () => loadEscalationFeed(FEEDS.txEscalations);

/**
 * One locale's page index: the pages PRESENT in that locale's tree.
 *
 * `meta` is the field a caller must not ignore. The index lists present pages only —
 * the published index has a hard size ceiling and listing every expected page hit it —
 * so `meta.withheld` is the expected-but-not-yet-translated remainder. Without it a
 * short index reads as lost data instead of as a rollout in progress.
 *
 * An unknown locale code returns the empty shape with an error rather than throwing:
 * the code usually arrives from a block's authored key/value row, so a typo there is
 * bad DATA and must render an honest message, not take the page down.
 */
export async function loadTxIndex(code) {
  const known = localeFor(code);
  if (!known) {
    return {
      pages: [], meta: {}, missing: true, error: `unknown locale "${code}"`,
    };
  }
  const { doc, missing, error } = await readFeed(FEEDS.txIndex(known.code));
  return {
    pages: rowsOf(doc, 'pages'),
    meta: metaRow(doc),
    missing,
    error,
  };
}

/*
 * The two selectors every queue view needs.
 *
 * The unit is a (page, locale) PAIR, not a row — `loadGroup().pairs` is what these
 * take. Names kept from the tracker this is ported from, where the unit was a page,
 * because the callers are the same views and renaming them would have hidden that
 * the model underneath changed.
 */

/** Pairs belonging to a given work queue (`escalations`, `layout-issues`, …). */
export const rowsForQueue = (pairs, queueId) => (pairs || [])
  .filter(({ row, localeRow }) => classifyTranslation(row, localeRow).queues.includes(queueId));

/** Pairs blocked out of the funnel entirely (any failure or rejection). */
export const rowsBlocked = (pairs) => (pairs || [])
  .filter(({ row, localeRow }) => classifyTranslation(row, localeRow).blocked);
