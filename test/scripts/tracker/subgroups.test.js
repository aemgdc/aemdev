import { expect } from '@esm-bundle/chai';
import {
  UNASSIGNED, bySubgroup, isAssigned, subgroupForPath, subgroupIndex, subgroupNames, subgroupOf,
} from '../../../scripts/tracker/subgroups.js';
import { tally } from '../../../scripts/tracker/stages.js';

/*
 * subgroups.test.js — the two invariants the `subgroup` column lives or dies by.
 *
 *   1. `(unassigned)` sorts LAST even when it is the biggest bucket. Early on most
 *      rows are unclassified, so a size sort puts the residue on top and buries the
 *      labels somebody actually authored. The fixture below is deliberately in that
 *      state: four blank pages against three classified ones.
 *   2. A group's subgroups re-add to the group's own total, PER COLUMN. The board
 *      shows the group total on the closed row and the breakdown when it is opened; if
 *      those disagreed the accordion would be worse than no accordion. Asserted over
 *      every column `tally()` produces, not just the total — a bucket that dropped
 *      only its blocked pairs would keep the totals honest and the columns wrong.
 *
 * Both are asserted in BOTH directions: the balanced fixture passes, and a breakdown
 * with one pair removed is caught. A guard nobody has seen fail is not a guard.
 */

/** Two locales is enough to make the unit a (page, locale) pair rather than a page. */
const LOCALES_UNDER_TEST = ['de', 'ja'];

/** A `data`-tab row. `en-published` unless a case needs the gate shut. */
const page = (path, over = {}, locales = {}) => ({
  row: {
    'page-path': path,
    'en-status': 'en-published',
    subgroup: '',
    'content-escalation': '',
    ...over,
  },
  locales,
});

/** A locale-tab row. Blank columns are the normal state, so blank is the default. */
const tx = (over = {}) => ({
  'translation-status': '',
  'review-status': '',
  previewed: '',
  online: '',
  ...over,
});

/*
 * One page per shape the funnel can take, so every column below is non-zero for a
 * reason: a forward stage, a human sign-off, an ungated status, a review rejection, a
 * pipeline blocker, a coexisting content escalation, and a page excluded from every
 * count. Three subgroups: two authored, and blank on four pages.
 */
const PAGES = [
  page('/en/articles/one', { subgroup: 'adaptto-2026' }, {
    de: tx({ 'translation-status': 'auto-qa-ok', previewed: 'yes' }),
    ja: tx({ 'translation-status': 'sent' }),
  }),
  page('/en/articles/two', { subgroup: 'adaptto-2026', 'content-escalation': 'yes' }, {
    de: tx({ 'review-status': 'TRANSLATION OK', previewed: 'yes', online: 'yes' }),
    // No `ja` row at all — a locale tab that has never been touched.
  }),
  // en-status never reached `en-published`, so the recorded pass is ungated: a warning
  // and an English-side stage, not progress.
  page('/en/articles/three', { subgroup: 'deep-dives', 'en-status': 'draft' }, {
    de: tx({ 'translation-status': 'auto-qa-ok', previewed: 'yes' }),
  }),
  page('/en/articles/four', {}, {
    de: tx({ 'review-status': 'needs-retranslation', previewed: 'yes' }),
    ja: tx({ 'translation-status': 'visual-qa-fail', previewed: 'yes' }),
  }),
  page('/en/articles/five', {}, {
    de: tx({ 'translation-status': 'preview-missing' }),
    ja: tx({ 'translation-status': 'send-fail' }),
  }),
  page('/en/articles/six', {}, {
    de: tx({ previewed: 'yes' }),
    ja: tx({ 'review-status': 'ready-for-review', previewed: 'yes' }),
  }),
  // Excluded from every count, and still part of a subgroup's row set: the sum has to
  // hold across the exclusion too, or the breakdown drifts by exactly the drafts.
  page('/en/drafts/seven', {}, { de: tx({ previewed: 'yes' }) }),
];

const ROWS = PAGES.map((p) => p.row);

/** The same fan-out `loadGroup()` builds: every page × every locale. */
const pairsOf = (pages) => pages.flatMap(({ row, locales }) => LOCALES_UNDER_TEST
  .map((code) => ({ row, localeRow: locales[code] || {}, locale: code })));

/*
 * Every number the boards render, flattened for comparison — and NAMESPACED, because
 * `stages` and `buckets` share six key names (`previewed`, `online`, …). Spreading
 * them flat is the bug `tally()`'s own comment warns about: the shadowed keys would
 * compare equal while the real counts disagreed.
 */
function columnsOf(t) {
  const cols = { total: t.total, counted: t.counted, warnings: t.warnings.length };
  Object.entries(t.stages).forEach(([k, v]) => { cols[`stage.${k}`] = v; });
  Object.entries(t.queues).forEach(([k, v]) => { cols[`queue.${k}`] = v; });
  Object.entries(t.buckets).forEach(([k, v]) => { cols[`bucket.${k}`] = v; });
  return cols;
}

/** Add up one column across a breakdown's buckets. */
const sumColumns = (breakdown) => breakdown.reduce((acc, t) => {
  Object.entries(columnsOf(t)).forEach(([k, v]) => { acc[k] = (acc[k] || 0) + v; });
  return acc;
}, {});

describe('subgroups.js', () => {
  describe('blank is normal, and blank is not a subgroup', () => {
    it('rolls a blank, missing or whitespace value up as the residue bucket', () => {
      expect(subgroupOf({ subgroup: '' })).to.equal(UNASSIGNED);
      expect(subgroupOf({})).to.equal(UNASSIGNED);
      expect(subgroupOf({ subgroup: '   ' })).to.equal(UNASSIGNED);
      expect(isAssigned(UNASSIGNED)).to.equal(false);
      expect(isAssigned('deep-dives')).to.equal(true);
    });

    it('sorts the residue LAST even when it is the biggest bucket', () => {
      const buckets = bySubgroup(ROWS);
      expect(buckets.map((b) => b.name)).to.deep.equal(['adaptto-2026', 'deep-dives', UNASSIGNED]);
      // The residue really is the biggest here — otherwise size-sorting would have
      // put it last anyway and this test would prove nothing.
      expect(buckets.map((b) => b.rows.length)).to.deep.equal([2, 1, 4]);
      expect(Math.max(...buckets.map((b) => b.rows.length))).to.equal(4);
    });

    it('keeps the residue out of the authored label list', () => {
      expect(subgroupNames(ROWS)).to.deep.equal(['adaptto-2026', 'deep-dives']);
    });

    it('partitions (page, locale) pairs through the same sort, not a second copy of it', () => {
      const buckets = bySubgroup(pairsOf(PAGES), (p) => p.row);
      expect(buckets.map((b) => b.name)).to.deep.equal(['adaptto-2026', 'deep-dives', UNASSIGNED]);
      expect(buckets.map((b) => b.rows.length)).to.deep.equal([4, 2, 8]);
    });
  });

  describe('the subgroups re-add to the group, per column', () => {
    const pairs = pairsOf(PAGES);
    const group = tally(pairs);
    const breakdown = bySubgroup(pairs, (p) => p.row).map((b) => tally(b.rows));

    it('counts the fan-out, and counts the excluded page as inventory only', () => {
      expect(group.total).to.equal(14); // 7 pages × 2 locales
      expect(group.counted).to.equal(12); // minus the drafts page
    });

    it('exercises enough columns for the comparison to mean something', () => {
      const cols = columnsOf(group);
      // Named individually rather than by count: this is the list a future model
      // change has to keep populating for the invariant test to stay honest.
      expect(cols['stage.blocked']).to.equal(4);
      expect(cols['stage.online']).to.equal(1);
      expect(cols['stage.autoQaPass']).to.equal(1);
      expect(cols['stage.catalogued']).to.equal(2);
      expect(cols['queue.retranslate']).to.equal(1);
      expect(cols['queue.layout-issues']).to.equal(1);
      expect(cols['queue.awaiting-preview']).to.equal(1);
      expect(cols['queue.send-issues']).to.equal(1);
      expect(cols['queue.content-escalation']).to.equal(2);
      expect(cols['bucket.autoQa']).to.equal(1);
      expect(cols.warnings).to.equal(1);
    });

    it('sums to the group total in every column', () => {
      expect(sumColumns(breakdown)).to.deep.equal(columnsOf(group));
    });

    it('catches a breakdown that loses a single pair', () => {
      const lossy = bySubgroup(pairs, (p) => p.row)
        .map((b, i) => tally(i === 0 ? b.rows.slice(1) : b.rows));
      expect(sumColumns(lossy)).to.not.deep.equal(columnsOf(group));
    });

    it('catches a breakdown that loses only one column value', () => {
      // The dangerous shape: the page counts still balance, so anything asserting the
      // total alone passes. Here one flagged pair is swapped for an unflagged one.
      const swapped = pairs.map((p) => (p.row['content-escalation'] === 'yes' && p.locale === 'de'
        ? { ...p, row: { ...p.row, 'content-escalation': '' } }
        : p));
      const lossy = bySubgroup(swapped, (p) => p.row).map((b) => tally(b.rows));
      expect(sumColumns(lossy).total).to.equal(columnsOf(group).total);
      expect(sumColumns(lossy)['queue.content-escalation']).to.equal(1);
      expect(sumColumns(lossy)).to.not.deep.equal(columnsOf(group));
    });
  });

  describe('joining a path back to its subgroup', () => {
    const index = subgroupIndex(ROWS);

    it('reads a subgroup for a locale row that carries only a path', () => {
      expect(subgroupForPath(index, '/en/articles/one')).to.equal('adaptto-2026');
      expect(subgroupForPath(index, '/en/articles/four')).to.equal(UNASSIGNED);
    });

    it('normalizes the trailing slash, so one page cannot become two keys', () => {
      expect(subgroupForPath(index, '/en/articles/one/')).to.equal('adaptto-2026');
    });

    it('reads an unknown path as the residue rather than undefined', () => {
      expect(subgroupForPath(index, '/en/articles/nope')).to.equal(UNASSIGNED);
      expect(subgroupForPath(index, '')).to.equal(UNASSIGNED);
    });
  });
});
