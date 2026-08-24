/**
 * rollup.test.mjs — the two invariants, WATCHED GOING RED.
 *
 *   npm run test:node          (node --test "test/node/*.test.mjs")
 *
 * A guard nobody has seen fail is not a guard. Every case below either satisfies an
 * invariant or breaks exactly one of them on purpose and asserts the message names the
 * column that stopped adding up — because a violation report that does not name the
 * column cannot be acted on.
 *
 * `checkInvariants`, `stageSumViolation`, `subgroupSumViolations` and `fitToCeiling` are
 * imported from the rollup TOOL. That is safe because the tool guards its CLI entry with
 * `fileURLToPath(import.meta.url) === argv[1]`; without that guard, importing them would
 * start publishing feeds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tally, PAGE_STAGES, PROGRESS_BUCKETS } from '../../scripts/tracker/stages.js';
import { bySubgroup } from '../../scripts/tracker/subgroups.js';
import {
  checkInvariants,
  stageSumViolation,
  subgroupSumViolations,
  fitToCeiling,
} from '../../tools/tracker/build-rollup.mjs';
import {
  feedDoc, metaRow, publishable, fingerprint, docBytes, assertScalarRows,
} from '../../tools/tracker/lib/feed.mjs';

/* ------------------------------------------------------------------- fixtures */

const row = (path, over = {}) => ({
  'page-path': path,
  title: path,
  template: 'meetup',
  pagetype: 'meetup',
  'en-live': 'yes',
  'last-modified': '',
  subgroup: '',
  translate: '',
  notes: '',
  'en-status': 'en-published',
  'content-escalation': '',
  ...over,
});

const localeRow = (path, over = {}) => ({
  'page-path': path,
  locale: 'de',
  'locale-path': `/de${path.slice(3)}`,
  'sent-at': '',
  previewed: '',
  online: '',
  'translation-status': '',
  'review-status': '',
  'review-updated': '',
  ...over,
});

/** Pairs for a small group: three pages, one of them in a subgroup. */
const pairs = () => [
  { row: row('/en/meetups/a', { subgroup: 'europe' }), localeRow: localeRow('/en/meetups/a', { previewed: 'yes' }) },
  { row: row('/en/meetups/b', { subgroup: 'europe' }), localeRow: localeRow('/en/meetups/b') },
  { row: row('/en/meetups/c'), localeRow: localeRow('/en/meetups/c', { previewed: 'yes', 'translation-status': 'auto-qa-fail' }) },
];

const scopeFor = (list) => ({
  label: 'meetups / de',
  tally: tally(list),
  subgroups: bySubgroup(list, (p) => p.row).map((b) => ({ name: b.name, tally: tally(b.rows) })),
});

/* ------------------------------------------------------- the honest case first */

test('a well-formed scope satisfies both invariants', () => {
  const scope = scopeFor(pairs());
  assert.deepEqual(checkInvariants([scope]), []);
  // And the numbers are the ones the model says they should be: one previewed, one
  // enPublished (not on preview), one blocked by auto-qa-fail.
  assert.equal(scope.tally.counted, 3);
  assert.equal(scope.tally.stages.previewed, 1);
  assert.equal(scope.tally.stages.enPublished, 1);
  assert.equal(scope.tally.stages.blocked, 1);
  assert.equal(scope.tally.queues['auto-qa-issues'], 1);
});

test('`(unassigned)` is a real bucket, which is what makes invariant (b) checkable', () => {
  const scope = scopeFor(pairs());
  const names = scope.subgroups.map((s) => s.name);
  assert.deepEqual(names, ['europe', '(unassigned)']);
  // Residue LAST regardless of size — two rows in `europe`, one unassigned here, but the
  // order is a rule and not an accident of the counts.
  assert.equal(names.at(-1), '(unassigned)');
});

/* ------------------------------------------- invariant (a), watched going red */

test('invariant (a) FAILS when a stage count is short of `counted`', () => {
  const broken = tally(pairs());
  broken.stages.previewed -= 1; // a stage bucket that lost a pair
  const v = stageSumViolation('meetups / de', broken);
  assert.ok(v, 'the guard must fire');
  assert.match(v, /stage counts \+ blocked = 2 but counted = 3/);
});

test('invariant (a) FAILS when `blocked` is double-counted', () => {
  const broken = tally(pairs());
  broken.stages.blocked += 1;
  const v = stageSumViolation('meetups / de', broken);
  assert.match(v, /= 4 but counted = 3/);
});

test('invariant (a) is checked on every subgroup bucket too, not just the group', () => {
  const scope = scopeFor(pairs());
  scope.subgroups[0].tally.stages.previewed -= 1;
  const found = checkInvariants([scope]);
  assert.ok(found.some((v) => v.startsWith('meetups / de / europe:')), found.join('\n'));
});

/* ------------------------------------------- invariant (b), watched going red */

test('invariant (b) FAILS when a subgroup bucket loses a row', () => {
  const scope = scopeFor(pairs());
  scope.subgroups[0].tally.total -= 1;
  scope.subgroups[0].tally.counted -= 1;
  const found = subgroupSumViolations(scope.label, scope.tally, scope.subgroups);
  assert.ok(found.length >= 2, 'total AND counted must both be reported');
  assert.match(found.join('\n'), /do not re-add on total/);
  assert.match(found.join('\n'), /do not re-add on counted/);
});

test('invariant (b) FAILS on a COLUMN even when the totals still add up', () => {
  /*
   * The case the per-column check exists for. A bucket that dropped only its blocked
   * rows keeps `total` and `counted` honest and every stage column wrong — so a check
   * on the totals alone would pass and the board's accordion would disagree with the
   * row it opens from.
   */
  const scope = scopeFor(pairs());
  const residue = scope.subgroups.find((s) => s.name === '(unassigned)');
  residue.tally.stages.blocked -= 1;
  residue.tally.stages.previewed += 1;
  const found = subgroupSumViolations(scope.label, scope.tally, scope.subgroups);
  assert.equal(found.filter((v) => /on total|on counted/.test(v)).length, 0, 'the totals still add up');
  assert.match(found.join('\n'), /do not re-add on stage:blocked/);
  assert.match(found.join('\n'), /do not re-add on stage:previewed/);
});

test('invariant (b) covers queues and progress buckets, not only stages', () => {
  const scope = scopeFor(pairs());
  scope.subgroups[0].tally.queues['auto-qa-issues'] += 1;
  scope.subgroups[0].tally.buckets.previewed += 1;
  const found = subgroupSumViolations(scope.label, scope.tally, scope.subgroups).join('\n');
  assert.match(found, /on queue:auto-qa-issues/);
  assert.match(found, /on bucket:previewed/);
});

test('dropping a whole subgroup bucket is caught (the empty-parts case)', () => {
  const scope = scopeFor(pairs());
  scope.subgroups = [];
  const found = subgroupSumViolations(scope.label, scope.tally, scope.subgroups);
  assert.ok(found.length >= 2);
  assert.match(found.join('\n'), /\(no buckets\)/);
});

test('every stage, queue and bucket the model defines is covered by the sum check', () => {
  // A hand-maintained column list is how a check comes to pass on the columns that were
  // interesting when it was written. This asserts the list is derived.
  const scope = scopeFor(pairs());
  for (const s of PAGE_STAGES) {
    const bad = scopeFor(pairs());
    bad.subgroups[0].tally.stages[s.id] += 1;
    const found = subgroupSumViolations(bad.label, scope.tally, bad.subgroups).join('\n');
    assert.match(found, new RegExp(`on stage:${s.id}\\b`), `stage ${s.id} is not covered`);
  }
  for (const b of PROGRESS_BUCKETS) {
    const bad = scopeFor(pairs());
    bad.subgroups[0].tally.buckets[b.id] += 1;
    const found = subgroupSumViolations(bad.label, scope.tally, bad.subgroups).join('\n');
    assert.match(found, new RegExp(`on bucket:${b.id}\\b`), `bucket ${b.id} is not covered`);
  }
});

/* --------------------------------------------------------------- the envelope */

test('feedDoc refuses a doc with no meta tab — a bare timestamp key is refused by the bus', () => {
  assert.throws(() => feedDoc([['groups', []]]), /carries a `meta` tab/);
});

test('feedDoc always produces multi-sheet with :names matching the tabs', () => {
  const doc = feedDoc([
    ['groups', [{ group: 'meetups', total: 1 }]],
    ['meta', [metaRow({ branch: 'main', expected: 1, listed: 1 })]],
  ]);
  assert.equal(doc[':type'], 'multi-sheet');
  // meta is forced FIRST: the provenance stamp before the numbers.
  assert.deepEqual(doc[':names'], ['meta', 'groups']);
  assert.equal(doc.meta.data[0].withheld, 0);
});

test('meta records an unread group as `incomplete`, never as `withheld`', () => {
  const m = metaRow({
    branch: 'main', expected: 19, listed: 19, groupsFailed: ['bios'],
  });
  assert.equal(m.withheld, 0, 'withheld is a KNOWN quantity; an unread sheet is not');
  assert.equal(m.incomplete, 'yes');
  assert.equal(m['groups-failed'], 'bios');
});

test('withheld is expected minus listed, and never negative', () => {
  assert.equal(metaRow({ expected: 21, listed: 19 }).withheld, 2);
  assert.equal(metaRow({ expected: 5, listed: 9 }).withheld, 0);
});

test('a non-scalar cell is refused before the write, not by the content bus', () => {
  assert.throws(() => assertScalarRows('groups', [{ group: 'x', checks: [1, 2] }]), /must be a scalar/);
  assert.throws(() => feedDoc([['meta', [{ a: { b: 1 } }]]]), /must be a scalar/);
});

/* ----------------------------------------------------------- publishable() */

test('publishable projects onto an allow-list and drops everything else', () => {
  const out = publishable({
    'page-path': '/en/meetups/a',
    summary: 'a defect',
    checks: [{ huge: true }],
    textSample: { pairs: ['source sentence', 'target sentence'] },
    evidence: 'the verbatim quoted source text',
  }, ['page-path', 'summary']);
  assert.deepEqual(Object.keys(out), ['page-path', 'summary']);
});

test('publishable REFUSES to be asked for a prose or working-set column', () => {
  for (const col of ['checks', 'issues', 'evidence', 'textSample', 'findings']) {
    assert.throws(
      () => publishable({ [col]: 'x' }, [col]),
      /must never reach a published feed/,
      `${col} must be refused by name`,
    );
  }
});

test('publishable refuses a non-scalar value under an allowed column name', () => {
  assert.throws(() => publishable({ detail: ['a', 'b'] }, ['detail']), /is an array/);
  assert.throws(() => publishable({ detail: { a: 1 } }, ['detail']), /is object/);
});

test('publishable bounds a long cell instead of refusing it', () => {
  const long = 'x'.repeat(900);
  const out = publishable({ summary: long, detail: long }, ['summary', 'detail']);
  assert.equal(out.summary.length, 200);
  assert.equal(out.detail.length, 500);
  assert.ok(out.summary.endsWith('…'));
});

test('publishable collapses whitespace, so a multi-line blob cannot become a tall cell', () => {
  assert.equal(publishable({ detail: '  a\n\n  b\t c ' }, ['detail']).detail, 'a b c');
});

test('an absent column becomes blank, never undefined', () => {
  assert.equal(publishable({}, ['tier']).tier, '');
});

/* ------------------------------------------------------------- the fingerprint */

test('the fingerprint ignores the timestamp, so an unchanged build is not republished', () => {
  const build = () => feedDoc([
    ['meta', [metaRow({ branch: 'main', expected: 1, listed: 1 })]],
    ['groups', [{ group: 'meetups', total: 1 }]],
  ]);
  const a = build();
  const b = { ...build() };
  // Force the one difference two real builds a second apart would have.
  b.meta = { ...b.meta, data: [{ ...b.meta.data[0], generated: '2099-01-01T00:00:00.000Z', generatedAt: '2099-01-01T00:00:00.000Z' }] };
  assert.notEqual(a.meta.data[0].generated, b.meta.data[0].generated);
  assert.equal(fingerprint(a), fingerprint(b), 'two builds of the same state must compare equal');
});

test('the fingerprint DOES change when a number changes', () => {
  const a = feedDoc([['meta', [metaRow({ expected: 1, listed: 1 })]], ['groups', [{ group: 'm', total: 1 }]]]);
  const b = feedDoc([['meta', [metaRow({ expected: 1, listed: 1 })]], ['groups', [{ group: 'm', total: 2 }]]]);
  assert.notEqual(fingerprint(a), fingerprint(b));
});

/* ------------------------------------------------------------- the size ladder */

const bigDoc = (rows) => feedDoc([
  ['meta', [metaRow({
    branch: 'main', expected: rows, listed: rows, extra: { 'cells-nonzero': rows, 'cells-listed': rows, 'cells-withheld': 0 },
  })]],
  ['locales', [{ locale: 'de', total: rows }]],
  ['cells', Array.from({ length: rows }, (_, i) => ({
    locale: 'de', group: 'meetups', counted: rows, stage: 'previewed', count: i,
  }))],
]);

test('a doc under the ceiling is left alone and withholds nothing', () => {
  const fit = fitToCeiling(bigDoc(5), 1_000_000, ['cells']);
  assert.equal(fit.refused, null);
  assert.deepEqual(fit.notes, []);
  assert.equal(fit.doc.cells.data.length, 5);
  assert.equal(fit.doc.meta.data[0]['cells-withheld'], 0);
});

test('over the ceiling, a detail tab is dropped WHOLE and the loss is recorded in meta', () => {
  const doc = bigDoc(400);
  assert.ok(docBytes(doc) > 4000);
  const fit = fitToCeiling(doc, 4000, ['cells']);
  assert.equal(fit.refused, null);
  assert.equal(fit.doc.cells.data.length, 0, 'partial is the dangerous state; whole or nothing');
  assert.equal(fit.doc.meta.data[0]['cells-withheld'], 400);
  assert.equal(fit.doc.meta.data[0]['cells-listed'], 0);
  assert.match(fit.notes.join(' '), /dropped the whole "cells" tab \(400 row\(s\)\)/);
});

test('the smallest honest form still over the ceiling REFUSES rather than truncating', () => {
  const fit = fitToCeiling(bigDoc(400), 10, ['cells']);
  assert.ok(fit.refused, 'must refuse');
  assert.match(fit.refused, /every detail tab already dropped/);
});

test('the ladder keeps the envelope valid at every step', () => {
  const fit = fitToCeiling(bigDoc(400), 4000, ['cells']);
  assert.equal(fit.doc[':type'], 'multi-sheet');
  assert.deepEqual(fit.doc[':names'], ['meta', 'locales', 'cells']);
});
