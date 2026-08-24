/*
 * subgroups.js — the `subgroup` column's model, shared by the rollup generator (Node)
 * and the boards (browser).
 *
 * Browser + Node. Zero dependencies, no DOM. See ./README.md.
 *
 * WHY THIS COLUMN EXISTS. A page's group is resolved from its path prefix plus its
 * `template` metadata and nothing else (`tools/tracker/lib/group-map.mjs`), which
 * means the group cannot express two things we need to say about it:
 *
 *   - `/en/articles/**` is one group of one template, but the adaptTo 2026 talk
 *     write-ups are a different BUILD from the standing deep-dive series — their own
 *     judge brief, their own baseline, their own reviewer;
 *   - `bios` needs `speakers` separated from `contributors` long before either gets
 *     a template of its own.
 *
 * `subgroup` is that dimension, authored by us on our own sheets, never derived and
 * never refreshed away (`sync-groups-from-index.mjs` PRESERVES it).
 *
 * Values are SLUG-STYLE (`adaptto-2026`, `deep-dives`, `speakers`) and
 * `set-subgroup.mjs` refuses anything else. Not an enum — the vocabulary is open, and
 * nobody needs a code change to invent a label — but the FORM is constrained, because
 * the value is exactly what goes in `?sub-group=` on a Page Tracker link
 * (`pageTrackerUrl({ subGroup })` in `paths.js`). A label like `UK/IE` needed encoding
 * to survive a query string, which is what made the form worth pinning down.
 *
 * This module still tolerates any stored string, deliberately: it has to render
 * whatever is already in a sheet, including a value written before the rule existed.
 *
 * TWO RULES, and everything here exists to keep them:
 *
 *   1. Blank is normal, and blank is not a subgroup. A group with no subgroups at all
 *      must look exactly as it does today, so blank rolls up under UNASSIGNED rather
 *      than being dropped — and UNASSIGNED is forced LAST regardless of size, because
 *      early on most rows are unclassified and size-sorting buries the labels somebody
 *      actually authored.
 *   2. A group's subgroups always re-add to the group's own total, PER COLUMN. The
 *      board shows the group total on the closed row and the breakdown when it is
 *      opened; if those two disagreed the accordion would be worse than no accordion.
 *      That is why UNASSIGNED is a real bucket and not a filter, and why
 *      `build-rollup.mjs` asserts the sum — every column it renders, not just the
 *      total, because a bucket that dropped only its blocked rows would keep the
 *      totals honest and the columns wrong.
 *
 * Comparison is case- and whitespace-insensitive so "Deep dives", "deep dives" and
 * " Deep  Dives " are one subgroup, but the FIRST spelling seen is the one displayed —
 * an author's capitalisation is a choice, not noise to normalise away.
 */

import { normalizePath } from './locales.js';

/** The bucket blank rows roll up under. Parenthesised so it cannot collide with a real label. */
export const UNASSIGNED = '(unassigned)';

/** The `data`-tab column this module models. */
export const SUBGROUP_COLUMN = 'subgroup';

/*
 * The join key. A subgroup is authored once per PAGE on the `data` tab, while the
 * counts are per (page, locale); anything holding only a path — a locale row, an
 * escalation, an index entry — joins back through this column.
 */
const PATH_COLUMN = 'page-path';

const text = (v) => (v ?? '').toString().replace(/\s+/g, ' ').trim();

/** A row's subgroup label as authored, or UNASSIGNED when blank. */
export const subgroupOf = (row) => text(row?.[SUBGROUP_COLUMN]) || UNASSIGNED;

/** Case-insensitive identity, so two spellings of one label are one subgroup. */
export const subgroupKey = (name) => text(name).toLowerCase();

/**
 * URL/DOM-safe form of a label, for an element id or a query parameter.
 * Never empty: a label of only punctuation still needs a distinct handle.
 */
export function subgroupSlug(name) {
  const slug = text(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'unassigned';
}

/** Is this a real, human-authored subgroup rather than the blank bucket? */
export const isAssigned = (name) => subgroupKey(name) !== subgroupKey(UNASSIGNED);

/**
 * Partition items by subgroup.
 *
 * Returns entries ordered biggest-first with UNASSIGNED forced LAST regardless of
 * size — it is the residue, and on a group where most rows are still unclassified
 * (the normal state early on) sorting it to the top would bury the labels somebody
 * has actually authored.
 *
 * `pick` exists because the funnel counts (page, locale) PAIRS while the subgroup is
 * authored on the page's `data` row: `bySubgroup(pairs, (p) => p.row)` partitions
 * pairs, `bySubgroup(rows)` partitions rows. One accessor rather than a second copy
 * of the residue-last sort — that rule must not exist twice.
 *
 * @param {object[]} items
 * @param {(item: object) => object} [pick] the item's `data` row
 * @returns {Array<{ name: string, key: string, rows: object[] }>} `rows` holds the
 *          items as passed in
 */
export function bySubgroup(items, pick = (item) => item) {
  const buckets = new Map();
  for (const item of items || []) {
    const name = subgroupOf(pick(item));
    const key = subgroupKey(name);
    // First spelling seen wins as the display name.
    if (!buckets.has(key)) buckets.set(key, { name, key, rows: [] });
    buckets.get(key).rows.push(item);
  }
  return [...buckets.values()].sort((a, b) => {
    const aRes = !isAssigned(a.name);
    const bRes = !isAssigned(b.name);
    if (aRes !== bRes) return aRes ? 1 : -1;
    return b.rows.length - a.rows.length || a.name.localeCompare(b.name);
  });
}

/** The authored labels in an item set, biggest-first, excluding the blank bucket. */
export const subgroupNames = (items, pick) => bySubgroup(items, pick)
  .filter((b) => isAssigned(b.name))
  .map((b) => b.name);

/**
 * Index the `data` tab's subgroups by page path, for everything that carries a path
 * and not a row.
 *
 * Keyed on `normalizePath` output, because `/en/articles/foo/` and
 * `/en/articles/foo` are one page and two spellings — see `locales.js`. First row
 * wins on a duplicated path, matching the first-spelling-wins rule above; a duplicate
 * `page-path` is a sheet defect the data-quality board reports, not something to
 * resolve silently here.
 */
export function subgroupIndex(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const path = normalizePath(row?.[PATH_COLUMN]);
    if (path && !map.has(path)) map.set(path, subgroupOf(row));
  }
  return map;
}

/** Look one path out of the index above. An unknown path is UNASSIGNED, never undefined. */
export const subgroupForPath = (index, path) => index?.get(normalizePath(path)) || UNASSIGNED;
