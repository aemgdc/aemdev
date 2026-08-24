/**
 * group-lifecycle.test.mjs — the additive-only column upgrade, and the sign-off gate.
 *
 *   npm run test:node          (node --test "test/node/*.test.mjs")
 *
 * Two tools, one theme: neither may lose a value. `upgrade-columns` has no `--remove` by
 * construction, and `finalize-group`'s repair rebuilds the ENVELOPE and nothing else —
 * so both are tested by handing them data the schema does not know and asserting it
 * comes back out.
 *
 * The gate itself is tested by breaking each check independently. A gate whose checks
 * have never been seen failing is a gate that passes everything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TARGET_LOCALES } from '../../scripts/tracker/locales.js';
import { DATA_COLUMNS, LOCALE_COLUMNS, groupDoc } from '../../tools/tracker/lib/group-sheet.mjs';
import { upgradeRows } from '../../tools/tracker/upgrade-columns.mjs';
import { runGate, repairDoc } from '../../tools/tracker/finalize-group.mjs';

/* -------------------------------------------------------------------- fixtures */

const dataRow = (path, over = {}) => ({
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

const localeRow = (path, code, over = {}) => ({
  'page-path': path,
  locale: code,
  'locale-path': `/${code}${path.slice(3)}`,
  'sent-at': '',
  previewed: '',
  online: '',
  'translation-status': '',
  'review-status': '',
  'review-updated': '',
  ...over,
});

/** A whole, healthy meetups doc: two pages, present in every locale tab. */
function healthy(over = {}) {
  const rows = over.rows || [dataRow('/en/meetups/a'), dataRow('/en/meetups/b')];
  const locales = Object.fromEntries(TARGET_LOCALES.map((code) => [
    code, (over.localeRows ? over.localeRows(code) : rows.map((r) => localeRow(r['page-path'], code))),
  ]));
  return groupDoc(rows, locales);
}

const READY_BRIEF = {
  state: 'ready', counts: { rows: 12, unresolved: 0 }, unresolved: [], marker: 'READY',
};
const BLOCKED_BRIEF = {
  state: 'blocked',
  counts: { rows: 12, unresolved: 2 },
  unresolved: [{ ref: 'Q7' }, { ref: 'QC1' }],
  marker: 'DRAFT',
};

const check = (gate, id) => gate.checks.find((c) => c.id === id);

/* ------------------------------------------------------------- upgrade-columns */

test('a missing column is filled on the rows that lack it, and only those', () => {
  const rows = [dataRow('/en/meetups/a'), { 'page-path': '/en/meetups/b', title: 'B' }];
  const out = upgradeRows(rows, DATA_COLUMNS, DATA_COLUMNS, false);
  assert.equal(out.changed, 1, 'only the short row changed');
  assert.equal(out.filled.subgroup, 1);
  assert.equal(out.filled['en-status'], 1);
  for (const c of DATA_COLUMNS) assert.ok(c in out.rows[1], `${c} missing`);
});

test('a filled column is blank, never invented', () => {
  const out = upgradeRows([{ 'page-path': '/en/x' }], DATA_COLUMNS, DATA_COLUMNS, false);
  assert.equal(out.rows[0].subgroup, '');
  assert.equal(out.rows[0]['en-status'], '');
});

test('an OFF-SCHEMA column is counted, named and preserved — never removed', () => {
  const rows = [dataRow('/en/meetups/a', { owner: 'tad', 'legacy-col': 'keep me' })];
  const out = upgradeRows(rows, DATA_COLUMNS, DATA_COLUMNS, false);
  assert.deepEqual(out.extras, { owner: 1, 'legacy-col': 1 });
  assert.equal(out.rows[0].owner, 'tad');
  assert.equal(out.rows[0]['legacy-col'], 'keep me');
});

test('without --reorder, a new column is APPENDED and existing order is untouched', () => {
  const rows = [{ title: 'T', 'page-path': '/en/x' }];
  const out = upgradeRows(rows, DATA_COLUMNS, ['subgroup'], false);
  assert.deepEqual(Object.keys(out.rows[0]), ['title', 'page-path', 'subgroup']);
  assert.equal(out.reordered, 0);
});

test('with --reorder, the schema order wins and unknown columns follow, values intact', () => {
  const rows = [{
    notes: 'N', 'legacy-col': 'keep me', 'page-path': '/en/x', owner: 'tad', title: 'T',
  }];
  const out = upgradeRows(rows, DATA_COLUMNS, DATA_COLUMNS, true);
  const keys = Object.keys(out.rows[0]);
  assert.deepEqual(keys.slice(0, DATA_COLUMNS.length), DATA_COLUMNS);
  // Unknown columns keep their RELATIVE order: their arrangement may mean something to
  // whoever added them.
  assert.deepEqual(keys.slice(DATA_COLUMNS.length), ['legacy-col', 'owner']);
  assert.equal(out.rows[0]['legacy-col'], 'keep me');
  assert.equal(out.rows[0].notes, 'N');
  assert.equal(out.reordered, 1);
});

test('--reorder on a row already in canonical order is a real no-op', () => {
  const out = upgradeRows([dataRow('/en/x')], DATA_COLUMNS, DATA_COLUMNS, true);
  assert.equal(out.reordered, 0, 'nothing moved, so nothing should be written');
  assert.equal(out.changed, 0);
});

test('the locale schema is upgraded independently of the data schema', () => {
  const out = upgradeRows([{ 'page-path': '/en/x', locale: 'de' }], LOCALE_COLUMNS, LOCALE_COLUMNS, false);
  assert.ok('sent-at' in out.rows[0]);
  assert.ok(!('subgroup' in out.rows[0]), 'a data column must not leak onto a locale row');
});

/* ------------------------------------------------------------ the sign-off gate */

test('a whole doc with a ready brief passes every check', () => {
  const gate = runGate('meetups', healthy(), READY_BRIEF);
  assert.equal(gate.failed, 0, gate.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join('; '));
  assert.equal(gate.counts.real, 2);
  assert.equal(gate.counts.localeRows, 20);
});

test('envelope: a collapsed single-sheet doc FAILS', () => {
  const collapsed = { data: { total: 1, limit: 1, offset: 0, data: [dataRow('/en/meetups/a')] } };
  const gate = runGate('meetups', collapsed, READY_BRIEF);
  assert.equal(check(gate, 'envelope').ok, false);
  assert.match(check(gate, 'envelope').detail, /MISSING de, fr/);
});

test('tabs: a MISSPELLED locale tab FAILS — that locale would read as untranslated', () => {
  const doc = healthy();
  doc.dee = doc.de;
  doc[':names'] = [...doc[':names'], 'dee'];
  const gate = runGate('meetups', doc, READY_BRIEF);
  assert.equal(check(gate, 'tabs').ok, false);
  assert.match(check(gate, 'tabs').detail, /unknown tab\(s\): dee/);
});

test('duplicates: one path twice on the data tab FAILS and is named', () => {
  const doc = healthy({ rows: [dataRow('/en/meetups/a'), dataRow('/en/meetups/a')] });
  const gate = runGate('meetups', doc, READY_BRIEF);
  assert.equal(check(gate, 'duplicates').ok, false);
  assert.match(check(gate, 'duplicates').detail, /\/en\/meetups\/a/);
});

test('duplicates: a slashed and an unslashed spelling are ONE page, so they collide', () => {
  const doc = healthy({ rows: [dataRow('/en/meetups/a'), dataRow('/en/meetups/a/')] });
  assert.equal(check(runGate('meetups', doc, READY_BRIEF), 'duplicates').ok, false);
});

test('duplicates: one path twice in a LOCALE tab FAILS too', () => {
  const doc = healthy({
    localeRows: (code) => [localeRow('/en/meetups/a', code), localeRow('/en/meetups/a', code), localeRow('/en/meetups/b', code)],
  });
  const gate = runGate('meetups', doc, READY_BRIEF);
  assert.equal(check(gate, 'duplicates').ok, false);
  assert.match(check(gate, 'duplicates').detail, /\[de\]/);
});

test('ownership: a row that belongs to another group FAILS and says where it goes', () => {
  const doc = healthy({ rows: [dataRow('/en/meetups/a'), dataRow('/en/articles/x')] });
  const gate = runGate('meetups', doc, READY_BRIEF);
  assert.equal(check(gate, 'ownership').ok, false);
  assert.match(check(gate, 'ownership').detail, /\/en\/articles\/x → technical-articles/);
});

test('gate: a blank en-status FAILS — "not assessed" is honest, not finished', () => {
  const doc = healthy({ rows: [dataRow('/en/meetups/a', { 'en-status': '' })] });
  const gate = runGate('meetups', doc, READY_BRIEF);
  assert.equal(check(gate, 'gate').ok, false);
  assert.match(check(gate, 'gate').detail, /1 row\(s\) have no en-status/);
});

test('coverage: a missing locale row FAILS, per locale', () => {
  const doc = healthy();
  doc.ja = { total: 0, limit: 0, offset: 0, data: [] };
  const gate = runGate('meetups', doc, READY_BRIEF);
  assert.equal(check(gate, 'coverage').ok, false);
  assert.match(check(gate, 'coverage').detail, /ja:2/);
});

test('coverage: `translate: no` legitimately has no locale row', () => {
  const rows = [dataRow('/en/meetups/a'), dataRow('/en/meetups/b', { translate: 'no' })];
  const doc = groupDoc(rows, Object.fromEntries(
    TARGET_LOCALES.map((code) => [code, [localeRow('/en/meetups/a', code)]]),
  ));
  assert.equal(check(runGate('meetups', doc, READY_BRIEF), 'coverage').ok, true);
});

test('testimony: an orphan locale row carrying `sent-at` FAILS', () => {
  const doc = healthy({
    localeRows: (code) => [
      localeRow('/en/meetups/a', code),
      localeRow('/en/meetups/b', code),
      localeRow('/en/meetups/gone', code, { 'sent-at': '2026-08-01T00:00:00.000Z' }),
    ],
  });
  const gate = runGate('meetups', doc, READY_BRIEF);
  assert.equal(check(gate, 'testimony').ok, false);
  assert.match(check(gate, 'testimony').detail, /\/en\/meetups\/gone \[de\]/);
});

test('testimony: an EMPTY orphan row is debris, not testimony, and does not fail', () => {
  const doc = healthy({
    localeRows: (code) => [
      localeRow('/en/meetups/a', code),
      localeRow('/en/meetups/b', code),
      localeRow('/en/meetups/gone', code),
    ],
  });
  assert.equal(check(runGate('meetups', doc, READY_BRIEF), 'testimony').ok, true);
});

test('contract: a brief with a `?` row FAILS the gate and names the rows', () => {
  const gate = runGate('meetups', healthy(), BLOCKED_BRIEF);
  assert.equal(check(gate, 'contract').ok, false);
  assert.match(check(gate, 'contract').detail, /brief is blocked — 2 "\?" row\(s\): Q7, QC1/);
});

/* ---------------------------------------------------------------- the repair */

test('repair rebuilds the envelope and NOTHING else', () => {
  const collapsed = {
    data: { total: 1, limit: 1, offset: 0, data: [dataRow('/en/meetups/a', { subgroup: 'europe', notes: 'watch the embed', 'legacy-col': 'keep me' })] },
  };
  const fixed = repairDoc(collapsed);
  assert.equal(fixed[':type'], 'multi-sheet');
  assert.deepEqual(fixed[':names'], ['data', ...TARGET_LOCALES]);
  const row = fixed.data.data[0];
  assert.equal(row.subgroup, 'europe');
  assert.equal(row.notes, 'watch the embed');
  assert.equal(row['legacy-col'], 'keep me', 'a repair that lost a column is worse than the envelope it fixed');
});

test('repair preserves locale testimony verbatim', () => {
  const doc = healthy({
    localeRows: (code) => [localeRow('/en/meetups/a', code, {
      'sent-at': '2026-08-01T00:00:00.000Z', 'translation-status': 'sent', 'review-status': 'TRANSLATION OK',
    })],
  });
  const fixed = repairDoc(doc);
  assert.equal(fixed.de.data[0]['sent-at'], '2026-08-01T00:00:00.000Z');
  assert.equal(fixed.de.data[0]['review-status'], 'TRANSLATION OK');
});

test('repair is idempotent', () => {
  const once = repairDoc(healthy());
  assert.equal(JSON.stringify(repairDoc(once)), JSON.stringify(once));
});

test('a repaired doc passes the envelope and tabs checks it was failing', () => {
  const collapsed = { data: { total: 1, limit: 1, offset: 0, data: [dataRow('/en/meetups/a')] } };
  const before = runGate('meetups', collapsed, READY_BRIEF);
  assert.equal(check(before, 'envelope').ok, false);
  const after = runGate('meetups', repairDoc(collapsed), READY_BRIEF);
  assert.equal(check(after, 'envelope').ok, true);
  assert.equal(check(after, 'tabs').ok, true);
  // The message must describe what it FOUND: a check that says "data + ten locales" on a
  // one-tab doc contradicts the envelope check sitting next to it.
  assert.match(check(after, 'tabs').detail, /11 present: data de/);
  // Coverage still fails: the repair created the TABS, not the rows. A repair that
  // invented locale rows would be manufacturing testimony.
  assert.equal(check(after, 'coverage').ok, false);
});
