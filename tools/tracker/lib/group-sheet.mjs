/**
 * group-sheet.mjs — the shape of a group tracking sheet, and the ownership bands
 * that decide who may write which column.
 *
 * One DA multi-sheet document per group: a `data` tab (one row per English page) plus
 * one tab per target locale (one row per (page, locale)). Every column, in both
 * shapes, is specified in docs/tracker/data-contract.md section 1 — this file is that
 * section as code, and the two change in the same commit.
 *
 * ─── The band boundary IS the contract ──────────────────────────────────────
 *
 * A sync driven by the query index may overwrite band 1 and must NEVER touch bands 2
 * or 3. That rule cannot live in the callers' discipline, because it only has to be
 * forgotten once: `subgroup` is the one column in the sheet with no derivation to
 * fall back on — a human types it, nothing can rebuild it — and a refresh that
 * dropped it would destroy work no re-run could recover. So the bands are an explicit
 * structure here, `syncDataRow()` makes "overwrite band 1, preserve bands 2-3" the
 * only easy path, and writing a band-2 column requires calling `setCurated()` by
 * name.
 *
 * ─── Additive only ─────────────────────────────────────────────────────────
 *
 * Adding a column is safe; removing one is data loss that `git revert` cannot undo,
 * because the data was never in git. `readGroupDoc` therefore carries unrecognised
 * columns through verbatim rather than projecting rows onto the schema — an
 * unrecognised column is somebody's data until proven otherwise.
 */
import { TARGET_LOCALES, normalizePath, pathForLocale } from '../../../scripts/tracker/locales.js';
import {
  sheetRows,
  sheetTabs,
  countsAsPage,
  classifyTranslation,
  isSendable,
  isStage,
  isQueue,
  PAGE_STAGES,
  QUEUES,
} from '../../../scripts/tracker/stages.js';
import { daSheetUrl } from '../../../scripts/tracker/paths.js';
import {
  multiSheetDoc,
  fetchStatusDocVersioned,
  updateStatusDoc,
  sheet,
} from './status-sheet.mjs';

/* --------------------------------------------------------------- the three bands */

/**
 * Band 1 — index-derived. `group:sync` regenerates these every run.
 *
 * `pagetype` is derived from the path prefix and NOT from `template`, which is why it
 * is a stored column at all: `template` is authored metadata that can go missing (it
 * is blank on all four landing pages today), and a group's judge brief needs a kind
 * it can rely on.
 *
 * `last-modified` is the one band-1 column the query index cannot supply on this
 * site: the deployed `aemdev-en` index defines no `lastModified` property (verified
 * against config/sites/aemdev/query.yaml and the live feed's `columns` array). The
 * sync takes it from the same unauthenticated `admin.hlx.page/status` probe that
 * observes `en-live`, which is the only place the value actually exists. Recording it
 * from anywhere else would be inventing a timestamp.
 */
export const BAND1_COLUMNS = ['page-path', 'title', 'template', 'pagetype', 'en-live', 'last-modified'];

/**
 * Band 2 — curated by a human. A sync NEVER writes these.
 *
 * `translate: 'no'` excludes the page from every locale, so it gates row CREATION on
 * the locale tabs as well as counting. Blank means "not decided", which is not the
 * same as 'yes' and must not be treated as it.
 */
export const BAND2_COLUMNS = ['subgroup', 'translate', 'notes'];

/**
 * Band 3 — pipeline and human status.
 *
 * `en-status` is the send gate (`EN_STATUSES` in scripts/tracker/stages.js) and
 * `content-escalation` is a flag that coexists with any stage. Both are written by
 * their own single-purpose tools, never by a sync: an observed 200 on the live host
 * is not the same claim as a human marking a page published, and conflating them is
 * how a page gets sent for translation on the strength of a crawl.
 */
export const BAND3_COLUMNS = ['en-status', 'content-escalation'];

/**
 * The bands as data, so a tool can state which band it is allowed to write and be
 * checked against it rather than trusted.
 */
export const BANDS = [
  {
    band: 1,
    owner: 'index',
    columns: BAND1_COLUMNS,
    overwritable: true,
    why: 'regenerated from the query index and the status API on every sync',
  },
  {
    band: 2,
    owner: 'human',
    columns: BAND2_COLUMNS,
    overwritable: false,
    why: 'curated; subgroup in particular has no derivation to rebuild it from',
  },
  {
    band: 3,
    owner: 'pipeline+human',
    columns: BAND3_COLUMNS,
    overwritable: false,
    why: 'status and testimony; written by set-en-status and the drivers, never by a sync',
  },
];

/** `data` tab columns, in sheet order. */
export const DATA_COLUMNS = [...BAND1_COLUMNS, ...BAND2_COLUMNS, ...BAND3_COLUMNS];

/** Which band owns a column? `null` for a column not in the schema. */
export function bandOf(column) {
  const hit = BANDS.find((b) => b.columns.includes(column));
  return hit ? hit.band : null;
}

/** Columns a sync may write. Exported so a caller can assert rather than remember. */
export const SYNCABLE_COLUMNS = [...BAND1_COLUMNS];

/** Columns a sync must never write: everything a human or the pipeline owns. */
export const PRESERVED_COLUMNS = [...BAND2_COLUMNS, ...BAND3_COLUMNS];

/* ------------------------------------------------------------------ locale tabs */

/** Locale tab columns, in sheet order. */
export const LOCALE_COLUMNS = [
  'page-path', 'locale', 'locale-path', 'sent-at', 'previewed', 'online',
  'translation-status', 'review-status', 'review-updated',
];

/**
 * Columns a rebuild carries over VERBATIM and never regenerates.
 *
 * These are testimony, not cache. `sent-at` in particular is the one fact in the
 * whole model that is observable nowhere else — "we handed this to the translation
 * service" exists only because we wrote it down — so a rebuild that regenerated it
 * would erase the only record that a page was ever sent.
 */
export const LOCALE_PRESERVED = ['sent-at', 'translation-status', 'review-status', 'review-updated'];

/**
 * Crawl output: re-observed on every `tx:scan` and deliberately NOT preserved.
 *
 * This is the opposite of `LOCALE_PRESERVED` and it is what makes the stale-status
 * clamp in `classifyTranslation()` able to correct a wrong row instead of trusting
 * it. A rebuild that preserved these would freeze a page at whatever the last scan
 * happened to see.
 */
export const LOCALE_OBSERVED = ['previewed', 'online'];

/** Derived from (page-path, locale). Regenerated every rebuild, cheap and exact. */
export const LOCALE_DERIVED = ['page-path', 'locale', 'locale-path'];

/* ----------------------------------------------------------------- blank rows */

const text = (v) => (v == null ? '' : String(v).trim());
const val = (row, key) => text(row?.[key]);

const blankRow = (columns, overrides = {}) => Object.fromEntries(
  columns.map((c) => [c, text(overrides[c])]),
);

/**
 * A blank `data` row.
 *
 * A row with no `page-path` is a scaffold placeholder: `countsAsPage()` returns false
 * and nothing counts it. That is why a brand-new sheet can carry one — the columns
 * are visible and editable in da.live without the sheet claiming to track a page.
 */
export const blankDataRow = (overrides = {}) => blankRow(DATA_COLUMNS, overrides);

/**
 * A blank locale row for one (page, locale).
 *
 * `locale` and `locale-path` are denormalized on purpose: a reviewer reading the raw
 * sheet can see which locale a row is for and click through to the page, without
 * joining anything.
 */
export function blankLocaleRow(code, pagePath = '', overrides = {}) {
  const path = normalizePath(pagePath);
  return blankRow(LOCALE_COLUMNS, {
    'page-path': path,
    locale: code,
    'locale-path': path ? (pathForLocale(path, code) || '') : '',
    ...overrides,
  });
}

/* ----------------------------------------------------------------- the merges */

/**
 * Refresh ONE data row from index-derived values, preserving everything else.
 *
 * This is the easy path, and it is the only one a sync should ever need: band 1 is
 * overwritten, bands 2 and 3 come across verbatim, and any column the schema does not
 * know about is carried through untouched.
 *
 * @param {object|null} existing the row already in the sheet, or null for a new page
 * @param {object} indexValues band-1 values only. A key outside band 1 THROWS —
 *   silently ignoring it would let a caller believe it had written a status.
 * @returns {{ row: object, changes: Array<{column, from, to}>, created: boolean }}
 *   `changes` lists only real band-1 differences, so a plan can print what is
 *   actually landing on which row rather than a count of rows visited.
 */
export function syncDataRow(existing, indexValues = {}) {
  const stray = Object.keys(indexValues).filter((k) => !BAND1_COLUMNS.includes(k));
  if (stray.length) {
    throw new Error(`syncDataRow: ${stray.join(', ')} are not band-1 columns — a sync may only `
      + `write ${BAND1_COLUMNS.join(', ')}. Use setCurated() to write a curated or status column.`);
  }

  const row = blankDataRow();
  const changes = [];

  // Bands 2 and 3, verbatim. Done first so a band-1 key can never reach them.
  for (const c of PRESERVED_COLUMNS) row[c] = val(existing, c);

  for (const c of BAND1_COLUMNS) {
    const from = val(existing, c);
    const to = c in indexValues ? text(indexValues[c]) : from;
    row[c] = to;
    if (existing && from !== to) changes.push({ column: c, from, to });
  }

  /*
   * Unrecognised columns survive. A sheet mid-upgrade, or one carrying a column added
   * by a tool written after this one, must not lose it to a reconcile — the schema is
   * additive-only precisely because a removal cannot be reverted.
   */
  for (const [k, v] of Object.entries(existing || {})) {
    if (!(k in row)) row[k] = v;
  }

  return { row, changes, created: !existing };
}

/**
 * Write a curated (band 2) or status (band 3) column. The explicit act.
 *
 * Separate from `syncDataRow` so that touching a human's column is a different
 * function call with a different name, visible in a diff and in a stack trace. A
 * band-1 key here throws for the mirror reason: band 1 is regenerated every sync, so
 * a value written through this door would be silently overwritten within the day and
 * the tool that wrote it would look like it had worked.
 */
export function setCurated(row, values = {}) {
  const stray = Object.keys(values).filter((k) => !PRESERVED_COLUMNS.includes(k));
  if (stray.length) {
    throw new Error(`setCurated: ${stray.join(', ')} are not curated or status columns — `
      + `${PRESERVED_COLUMNS.join(', ')} are. Band 1 is regenerated by group:sync, so a value `
      + 'written there would be overwritten on the next run.');
  }
  const next = { ...row };
  const changes = [];
  for (const [c, v] of Object.entries(values)) {
    const from = val(row, c);
    const to = text(v);
    next[c] = to;
    if (from !== to) changes.push({ column: c, from, to });
  }
  return { row: next, changes };
}

/**
 * Write a preserved (testimony) column on a LOCALE row. The explicit act.
 *
 * The counterpart of `setCurated` for the locale tabs, and it exists for the same
 * reason: `syncLocaleRow` carries `LOCALE_PRESERVED` across verbatim, so any tool that
 * legitimately needs to CHANGE one — `tx:send` stamping `sent`/`sent-at`, `tx:scan`
 * applying the SLA rule — has to say so by name, in a call that is visible in a diff
 * and in a stack trace.
 *
 * A key outside `LOCALE_PRESERVED` throws. `previewed`/`online` in particular are
 * crawl output and belong in `syncLocaleRow`'s `observed`; writing them through this
 * door would make an observation look like testimony, which is exactly the distinction
 * the two column groups exist to keep.
 */
export function setLocaleStatus(row, values = {}) {
  const stray = Object.keys(values).filter((k) => !LOCALE_PRESERVED.includes(k));
  if (stray.length) {
    throw new Error(`setLocaleStatus: ${stray.join(', ')} are not preserved locale columns — `
      + `${LOCALE_PRESERVED.join(', ')} are. previewed/online are crawl output: pass them as `
      + 'syncLocaleRow({ observed }) so an observation is never recorded as testimony.');
  }
  const next = { ...row };
  const changes = [];
  for (const [c, v] of Object.entries(values)) {
    const from = val(row, c);
    const to = text(v);
    next[c] = to;
    if (from !== to) changes.push({ column: c, from, to });
  }
  return { row: next, changes };
}

/**
 * Rebuild ONE locale row: derived columns regenerated, observations refreshed,
 * `LOCALE_PRESERVED` carried over verbatim.
 *
 * @param {object|null} existing the locale row already in the tab, or null
 * @param {{ pagePath: string, code: string, observed?: object }} spec
 *   `observed` may carry `previewed`/`online`; omit it and the existing values stand,
 *   because "we did not scan" must not read as "the page is not there".
 */
export function syncLocaleRow(existing, { pagePath, code, observed = null }) {
  const row = blankLocaleRow(code, pagePath);
  for (const c of LOCALE_PRESERVED) row[c] = val(existing, c);
  for (const c of LOCALE_OBSERVED) {
    row[c] = observed && c in observed ? text(observed[c]) : val(existing, c);
  }
  for (const [k, v] of Object.entries(existing || {})) {
    if (!(k in row)) row[k] = v;
  }
  return { row, created: !existing };
}

/* ------------------------------------------------------------- the whole doc */

/**
 * Build a group document from row sets.
 *
 * The envelope comes from `multiSheetDoc` in lib/status-sheet.mjs, never hand-rolled:
 * a one-tab doc written as `:type: 'sheet'` is ACCEPTED by admin.da.live and then
 * refused at preview with `400 error from content-bus`, leaving DA holding a file
 * every reader 404s while the tool prints success. `multiSheetDoc` asserts the shape
 * before it can leave the process.
 *
 * Tabs are `data` then every TARGET_LOCALE in registry order — always all ten, even
 * when a locale has no rows. da.live's sheet editor collapses a one-tab multi-sheet
 * doc to single-sheet on save, so the locale tabs have to exist from creation or a
 * human opening the sheet destroys the envelope.
 */
export function groupDoc(dataRows, localeRows = {}) {
  const tabs = [['data', dataRows]];
  for (const code of TARGET_LOCALES) tabs.push([code, localeRows[code] || []]);
  return multiSheetDoc(tabs);
}

/**
 * An empty shell for a new group: headers only, or one blank placeholder row per tab.
 *
 * `seed: false` writes zero rows. DA stores the tab and the columns are recoverable
 * from this module, but da.live shows an empty grid with no column names, which is
 * unpleasant to hand-edit. `seed: true` (the default) writes one blank row per tab so
 * the column headers are visible; a blank `page-path` is a placeholder and
 * `countsAsPage()` refuses to count it.
 */
export function emptyGroupDoc({ seed = true } = {}) {
  if (!seed) return groupDoc([], {});
  const localeRows = Object.fromEntries(TARGET_LOCALES.map((c) => [c, [blankLocaleRow(c)]]));
  return groupDoc([blankDataRow()], localeRows);
}

/**
 * The da.live sheet URL a human clicks, from a registry entry.
 *
 * The registry stores the path WITH `.json` because that is how DA addresses a sheet
 * as a source; the editor deep link takes it without. Stripping it here means no tool
 * has to remember which side of that asymmetry it is on.
 */
export const groupSheetLink = (sheetCfg) => daSheetUrl(String(sheetCfg.path).replace(/\.json$/, ''));

/** The `data` tab rows of a group doc, tolerant of both DA sheet shapes. */
export const dataRowsOf = (doc) => sheetRows(doc, 'data');

/** The rows of one locale tab. */
export const localeRowsOf = (doc, code) => sheetRows(doc, code);

/** Rows that represent a real, countable page. Placeholders and drafts drop out. */
export const realDataRows = (doc) => dataRowsOf(doc).filter((r) => countsAsPage(r));

/** Locale tabs the doc is MISSING, in registry order. Empty means the doc is whole. */
export const missingLocaleTabs = (doc) => {
  const present = new Set(sheetTabs(doc));
  return TARGET_LOCALES.filter((c) => !present.has(c));
};

/**
 * Index a doc's `data` rows by normalized page path.
 *
 * Normalized, because `/en/` out of the live index and `/en` out of the sheet are the
 * same page and the slashed form 404s on this site. An un-normalized join makes them
 * two rows, which double-counts the page in every rollup for good.
 */
export function indexDataRows(doc) {
  const map = new Map();
  for (const r of dataRowsOf(doc)) {
    const p = normalizePath(val(r, 'page-path'));
    if (p) map.set(p, r);
  }
  return map;
}

/** Same, for one locale tab. */
export function indexLocaleTab(doc, code) {
  const map = new Map();
  for (const r of localeRowsOf(doc, code)) {
    const p = normalizePath(val(r, 'page-path'));
    if (p) map.set(p, r);
  }
  return map;
}

/* ------------------------------------------------------------------ row selection */

/**
 * The `--where=` grammar, defined ONCE for every tool that filters group rows.
 *
 *   <term>[,<term>…]      every term must match. There is no OR, deliberately: a
 *                         selector you cannot read at a glance is a selector nobody
 *                         trusts, and every real filter so far has been a conjunction.
 *
 *   stage:<id>            derived funnel stage — a PAGE_STAGES id
 *   queue:<id>            the pair sits in this work queue
 *   blocked               blocked out of the funnel entirely
 *   sendable              passes the send gate and has not been sent yet
 *   <column>=<value>      exact match after trim and case-fold. An EMPTY value is a
 *                         REAL selector meaning "this cell is blank" — the most
 *                         common bulk case there is.
 *   <column>!=<value>
 *
 * A value cannot contain a comma. That is the price of a grammar a human can type
 * without quoting rules, and no column in this schema holds a comma-separated list.
 *
 * UNKNOWN NAMES REFUSE THE WHOLE RUN — see `parseWhere`. This is the single most
 * important property of the grammar: a missing column reads as `''`, so
 * `subgroup=x` would quietly select NOTHING and `subgroup!=x` would quietly select
 * EVERY ROW on a sheet that has not been upgraded yet. Failing closed on the name is
 * the only safe reading, and it is why the parser needs the sheet's own rows.
 */
export function parseWhere(expr, { rows = [] } = {}) {
  const known = new Set([
    ...DATA_COLUMNS,
    ...LOCALE_COLUMNS,
    ...rows.flatMap((r) => Object.keys(r || {})),
  ]);
  const terms = [];
  const errors = [];

  for (const raw of String(expr || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (raw === 'blocked' || raw === 'sendable') {
      terms.push({ kind: raw });
    } else if (raw.startsWith('stage:')) {
      const id = raw.slice(6).trim();
      if (!isStage(id)) errors.push(`unknown stage "${id}" — known: ${PAGE_STAGES.map((s) => s.id).join(', ')}`);
      else terms.push({ kind: 'stage', id });
    } else if (raw.startsWith('queue:')) {
      const id = raw.slice(6).trim();
      if (!isQueue(id)) errors.push(`unknown queue "${id}" — known: ${QUEUES.map((q) => q.id).join(', ')}`);
      else terms.push({ kind: 'queue', id });
    } else {
      const m = /^([a-z0-9-]+)\s*(!?=)\s*(.*)$/i.exec(raw);
      if (!m) {
        errors.push(`cannot parse "${raw}" — expected column=value, column!=value, stage:<id>, queue:<id>, blocked or sendable`);
      } else if (!known.has(m[1])) {
        errors.push(`unknown column "${m[1]}" — known: ${[...known].sort().join(', ')}`);
      } else {
        terms.push({
          kind: 'column', column: m[1], negate: m[2] === '!=', value: m[3].trim().toLowerCase(),
        });
      }
    }
  }
  return { terms, errors, describe: String(expr || '').trim() };
}

/**
 * Does one row (optionally paired with its locale row) match a parsed selector?
 *
 * `localeRow` defaults to `{}`, which is exactly what `classifyTranslation` expects
 * for a page with no row in that locale — it falls through to `classifyEnglish`, so
 * `stage:enPublished` means the same thing on the master tab as it does on a locale
 * tab that has not been populated. Passing `undefined` and hoping is what makes a
 * filter mean two different things in two tools.
 */
export function matchWhere(parsed, row, localeRow = {}) {
  if (!parsed.terms.length) return true;
  let verdict = null;
  const classify = () => {
    if (!verdict) verdict = classifyTranslation(row, localeRow);
    return verdict;
  };
  return parsed.terms.every((t) => {
    if (t.kind === 'blocked') return classify().blocked;
    if (t.kind === 'sendable') return isSendable(row, localeRow);
    if (t.kind === 'stage') return classify().stage === t.id;
    if (t.kind === 'queue') return classify().queues.includes(t.id);
    // A column present on the master row wins; otherwise the locale row answers. The
    // two schemas share only `page-path`, so there is nothing ambiguous to resolve.
    const cell = val(row?.[t.column] != null ? row : localeRow, t.column).toLowerCase();
    return t.negate ? cell !== t.value : cell === t.value;
  });
}

/* ------------------------------------------------------------------- read / write */

/**
 * Read a group sheet, with its ETag and its rows already indexed.
 *
 * `exists: false` rather than a throw on 404 — a group that has not been scaffolded
 * yet is a state the scaffold path handles, not an error.
 */
export async function readGroupDoc(sheetCfg, token) {
  const { exists, doc, version } = await fetchStatusDocVersioned(sheetCfg, token);
  return {
    exists,
    doc,
    version,
    dataRows: exists ? dataRowsOf(doc) : [],
    byPath: exists ? indexDataRows(doc) : new Map(),
    missingTabs: exists ? missingLocaleTabs(doc) : [...TARGET_LOCALES],
  };
}

/**
 * Replace the `data` tab of an existing doc, leaving every other tab untouched.
 *
 * Returned as a NEW object rather than mutated, so a caller can print a plan built
 * from the old doc and the new one side by side.
 */
export const withDataRows = (doc, rows) => ({ ...doc, data: sheet(rows) });

/** Replace one locale tab. */
export const withLocaleRows = (doc, code, rows) => ({ ...doc, [code]: sheet(rows) });

/**
 * Read-modify-write a group sheet under its ETag, then confirm the change landed.
 *
 * A thin pass-through to `updateStatusDoc` so every group tool gets the same
 * conditional write, the same single 412 retry and the same read-back confirmation
 * without restating them. Do not replace it with a bare `writeStatusDoc`: a
 * whole-doc write with no precondition is exactly the operation that loses a
 * concurrent writer's rows, and a sheet write is always a whole-doc write.
 */
export const updateGroupDoc = (sheetCfg, token, mutate, opts) => updateStatusDoc(
  sheetCfg,
  token,
  mutate,
  opts,
);
