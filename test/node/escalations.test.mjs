/**
 * escalations.test.mjs — the group-vocabulary assertion and the publishing boundary.
 *
 *   npm run test:node          (node --test "test/node/*.test.mjs")
 *
 * The upstream tracker emitted escalation `group` values that no work-queue filter could
 * match, and 21 of 23 groups were unfilterable in the UI as a result. The cases below are
 * that bug and its neighbours, each watched failing: an unresolvable path, an unregistered
 * group, and a recorded group that contradicts the resolver.
 *
 * The rest is the privacy boundary. `/tracker/**` is publicly readable once previewed, so
 * a judge's verbatim `evidence` quote reaching a published row is not a cosmetic defect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUEUES } from '../../scripts/tracker/stages.js';
import {
  ESCALATION_COLUMNS, collapseEvents, buildRows, problemLine,
} from '../../tools/tracker/build-escalations.mjs';

const REGISTERED = ['indexes', 'meetups', 'technical-articles', 'bios'];

const event = (over = {}) => ({
  at: '2026-08-20T10:00:00.000Z',
  'page-path': '/en/meetups/berlin',
  locale: 'de',
  tier: 'judge',
  queue: 'escalations',
  scope: 'page',
  status: 'auto-qa-escalate',
  summary: 'judge could not decide',
  confidence: 0.42,
  ...over,
});

const build = (events, over = {}) => buildRows(collapseEvents(events), {
  kind: 'tx',
  ledger: { pages: {} },
  registered: REGISTERED,
  readReport: () => null,
  includeResolved: false,
  ...over,
});

/* ------------------------------------------------------- the vocabulary assertion */

test('group is RESOLVED from the path, not taken from the event', () => {
  const { rows } = build([event({ group: undefined })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group, 'meetups');
  assert.ok(REGISTERED.includes(rows[0].group));
});

test('a landing page resolves to `indexes`, not to the section it heads', () => {
  const { rows } = build([event({ 'page-path': '/en/meetups' })]);
  assert.equal(rows[0].group, 'indexes');
});

test('a path in no tracked group is EXCLUDED and named, never guessed at', () => {
  const { rows, excluded } = build([event({ 'page-path': '/en/nowhere/x' })]);
  assert.equal(rows.length, 0);
  assert.equal(excluded.length, 1);
  assert.match(excluded[0].why, /no tracked group owns/);
});

test('a recorded group that CONTRADICTS the resolver is excluded, not rewritten', () => {
  const { rows, excluded } = build([event({ group: 'technical-articles' })]);
  assert.equal(rows.length, 0, 'publishing either value would be a guess');
  assert.match(excluded[0].why, /recorded group "technical-articles" but the path resolves to "meetups"/);
});

test('a group missing from the registry is excluded even when the resolver produced it', () => {
  const { rows, excluded } = build([event()], { registered: ['indexes'] });
  assert.equal(rows.length, 0);
  assert.match(excluded[0].why, /not a registered group/);
});

test('every emitted group is a registered group, across a mixed batch', () => {
  /*
   * The property the assertion in `buildRows` guards. It is unreachable through the
   * filter above — which is what a guard should be — so what is checked here is the
   * INVARIANT it protects: whatever goes in, nothing comes out that a work-queue filter
   * cannot match. That mismatch is what left 21 of 23 groups unfilterable upstream.
   */
  const { rows, excluded } = build([
    event({ 'page-path': '/en/meetups/berlin' }),
    event({ 'page-path': '/en/articles/edge-delivery' }),
    event({ 'page-path': '/en/fragments/bios/tad-reeves' }),
    event({ 'page-path': '/en/contact' }),
    event({ 'page-path': '/de/meetups/berlin' }),
    event({ 'page-path': '/en/does-not-exist' }),
  ]);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    [...new Set(rows.map((r) => r.group))].sort(),
    ['bios', 'indexes', 'meetups', 'technical-articles'],
  );
  for (const r of rows) assert.ok(REGISTERED.includes(r.group), r.group);
  // A LOCALE path resolves to nothing on purpose: the group sheets are keyed on EN
  // paths, and accepting `/de/meetups/x` would let one page be counted twice.
  assert.equal(excluded.length, 2);
});

/* ------------------------------------------------------------- queue resolution */

test('an unrecognised recorded queue falls back to the model, then to the catch-all', () => {
  const fromStatus = build([event({ queue: 'not-a-queue', status: 'visual-qa-fail' })]);
  assert.equal(fromStatus.rows[0].queue, 'layout-issues', 'the recorded status implies the queue');
  const fallback = build([event({ queue: 'nonsense', status: '' })]);
  assert.equal(fallback.rows[0].queue, 'escalations');
  assert.ok(QUEUES.some((q) => q.id === fallback.rows[0].queue));
});

test('scope falls back to `page`, which is the thing we actually know', () => {
  assert.equal(build([event({ scope: 'galaxy' })]).rows[0].scope, 'page');
  assert.equal(build([event({ scope: 'template' })]).rows[0].scope, 'template');
});

/* ------------------------------------------------------------- collapse + order */

test('first-seen is the EARLIEST event and attempts counts them all', () => {
  const { rows } = build([
    event({ at: '2026-08-20T10:00:00.000Z' }),
    event({ at: '2026-08-19T09:00:00.000Z', summary: 'first try' }),
    event({ at: '2026-08-21T11:00:00.000Z', summary: 'latest' }),
  ]);
  assert.equal(rows.length, 1, 'one row per (page, locale)');
  assert.equal(rows[0]['first-seen'], '2026-08-19T09:00:00.000Z');
  assert.equal(rows[0].attempts, 3);
  assert.equal(rows[0].summary, 'latest', 'the LAST event supplies the detail');
});

test('the ledger wins on attempts, because it is the run bookkeeping', () => {
  const { rows } = build([event()], {
    ledger: { pages: { '/en/meetups/berlin\0de': { attempts: 7 } } },
  });
  assert.equal(rows[0].attempts, 7);
});

test('rows sort by attempts descending, then oldest first', () => {
  const { rows } = build([
    event({ 'page-path': '/en/meetups/a', at: '2026-08-20T00:00:00.000Z' }),
    event({ 'page-path': '/en/meetups/b', at: '2026-08-18T00:00:00.000Z' }),
    event({ 'page-path': '/en/meetups/b', at: '2026-08-19T00:00:00.000Z' }),
  ]);
  assert.deepEqual(rows.map((r) => r['page-path']), ['/en/meetups/b', '/en/meetups/a']);
});

/* ------------------------------------------------------------------- resolution */

test('an entry the ledger says moved FORWARD is dropped and counted', () => {
  const { rows, resolved } = build([event()], {
    ledger: { pages: { '/en/meetups/berlin\0de': { 'translation-status': 'auto-qa-ok' } } },
  });
  assert.equal(rows.length, 0);
  assert.equal(resolved, 1);
});

test('a BLOCKING recorded status is not resolution — the entry stands', () => {
  const { rows, resolved } = build([event()], {
    ledger: { pages: { '/en/meetups/berlin\0de': { 'translation-status': 'auto-qa-fail' } } },
  });
  assert.equal(resolved, 0);
  assert.equal(rows.length, 1);
});

test('--include-resolved keeps it', () => {
  const { rows } = build([event()], {
    ledger: { pages: { '/en/meetups/berlin\0de': { 'translation-status': 'auto-qa-ok' } } },
    includeResolved: true,
  });
  assert.equal(rows.length, 1);
});

test('the ledger key uses a NUL separator, so a space-separated key does not match', () => {
  const { rows, resolved } = build([event()], {
    ledger: { pages: { '/en/meetups/berlin de': { 'translation-status': 'auto-qa-ok' } } },
  });
  assert.equal(resolved, 0, 'a wrong separator must MISS, not silently half-match');
  assert.equal(rows.length, 1);
});

/* ------------------------------------------------------- the publishing boundary */

test('only the thirteen contract columns are emitted', () => {
  const { rows } = build([event({ evidence: 'VERBATIM SOURCE TEXT', checks: [1, 2, 3] })]);
  assert.deepEqual(Object.keys(rows[0]), ESCALATION_COLUMNS);
});

test("a judge report's verbatim `evidence` never reaches a published cell", () => {
  const report = {
    tiers: {
      judge: {
        issues: [{
          severity: 'high',
          kind: 'dnt-violation',
          detail: 'a product name was translated',
          evidence: 'THE VERBATIM SOURCE SENTENCE THAT MUST NOT BE PUBLISHED',
        }],
      },
    },
  };
  const { rows } = build([event()], { readReport: () => report });
  const serialized = JSON.stringify(rows[0]);
  assert.ok(!serialized.includes('VERBATIM SOURCE SENTENCE'), serialized);
  assert.match(rows[0].detail, /high\/dnt-violation: a product name was translated/);
});

test('problemLine summarises a report without copying prose through', () => {
  const { summary, detail } = problemLine(event({ summary: '', status: 'auto-qa-fail' }), {
    tiers: {
      structural: { fatal: 'the page 404s on the preview host' },
      judge: { issues: [{ severity: 'high', kind: 'missing', detail: 'a code block vanished' }] },
      visual: { widths: { 390: 'fail', 1280: 'pass', 2360: 'pass' } },
    },
  });
  assert.equal(summary, 'Auto QA failed (judge)', 'the model supplies the label');
  assert.match(detail, /1 judge issue\(s\)/);
  assert.match(detail, /structural tier fatal/);
  assert.match(detail, /visual: 390px fail/);
});

test('problemLine names at most three issues and counts the rest', () => {
  const issues = Array.from({ length: 9 }, (_, i) => ({ severity: 'low', kind: `k${i}`, detail: `d${i}` }));
  const { detail } = problemLine(event(), { tiers: { judge: { issues } } });
  assert.match(detail, /9 judge issue\(s\)/);
  assert.match(detail, /\(\+6 more\)/);
});

test('confidence recorded as a percentage is normalised to 0..1', () => {
  // Live reports in the source carried `95` against a 0..1 schema, and a board rendering
  // that as a percentage showed 9500%.
  assert.equal(build([event({ confidence: 95 })]).rows[0].confidence, 0.95);
  assert.equal(build([event({ confidence: 0.42 })]).rows[0].confidence, 0.42);
  assert.equal(build([event({ confidence: 'nonsense' })]).rows[0].confidence, '');
});

test('the review doc path carries the locale exactly once', () => {
  const { rows } = build([event()]);
  assert.equal(rows[0].doc, '/tracker/tx/de/meetups/berlin');
});

test('the EN side gets a qa doc path, not a tx one', () => {
  const { rows } = build([event({ locale: '' })], { kind: 'qa' });
  assert.equal(rows[0].doc, '/tracker/qa/en/meetups/berlin');
  assert.equal(rows[0].locale, '');
});

/* ---------------------------------------------------------------- malformed input */

test('an event with no page-path is not a candidate at all', () => {
  assert.deepEqual(collapseEvents([{ at: 'x' }, { 'page-path': '' }]), []);
});

test('a slashed and an unslashed spelling of one path are ONE candidate', () => {
  const collapsed = collapseEvents([
    event({ 'page-path': '/en/meetups/berlin/' }),
    event({ 'page-path': '/en/meetups/berlin' }),
  ]);
  assert.equal(collapsed.length, 1);
});
