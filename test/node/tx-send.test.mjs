/**
 * tx-send.test.mjs — the send gate, and what a refusal says.
 *
 *   npm run test:node          (npm --test "test/node/*.test.mjs")
 *
 * Sending is the one irreversible, money-costing step in the pipeline, so the tests
 * here are about the two ways a batch goes wrong: a page that was never marked ready
 * getting sent anyway, and a page getting sent twice. Both are silent — the money is
 * spent before anybody looks — which is why the gate is an explicit column and not a
 * derived default.
 *
 * `selectBatch`/`refusalFor` are imported from the TOOL. Safe because the tool guards
 * its CLI entry with `fileURLToPath(import.meta.url) === argv[1]`; without that guard,
 * importing them would start creating DA translation projects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBatch, refusalFor } from '../../tools/tracker/tx-send.mjs';
import { selectDocuments } from '../../tools/tracker/tx-preview.mjs';
import {
  groupDoc, blankDataRow, blankLocaleRow, parseWhere,
} from '../../tools/tracker/lib/group-sheet.mjs';

const page = (path, over = {}) => blankDataRow({
  'page-path': path, title: path, template: 'meetup', pagetype: 'meetup', ...over,
});

const localeRow = (path, code, over = {}) => blankLocaleRow(code, path, over);

const doc = () => groupDoc([
  page('/en/meetups/ready', { 'en-status': 'en-published' }),
  page('/en/meetups/draft', { 'en-status': 'draft' }),
  page('/en/meetups/unassessed'),
  page('/en/meetups/gone', { 'en-status': 'en-published', translate: 'no' }),
  blankDataRow(), // the scaffold placeholder: not a page
], {
  de: [
    localeRow('/en/meetups/ready', 'de'),
    localeRow('/en/meetups/gone', 'de'),
  ],
  fr: [
    localeRow('/en/meetups/ready', 'fr', { 'translation-status': 'sent', 'sent-at': '2026-08-01T00:00:00.000Z' }),
  ],
});

const opts = (over = {}) => ({
  paths: [], limit: 0, ...over,
});

test('the gate needs an explicit en-published and a blank translation-status', () => {
  const batch = selectBatch(doc(), ['de', 'fr'], opts(), null);
  const keys = batch.pairs.map((p) => `${p.path} ${p.code}`).sort();
  assert.deepEqual(keys, ['/en/meetups/ready de']);
  // `ready fr` is excluded because it was already sent; the drafts because nobody has
  // marked them; the blank placeholder because it is not a page; and `gone` because a
  // human set translate=no — which `isSendable` does not look at, so paying to translate
  // a deliberately excluded page is a hole this tool has to close itself.
  const reasons = batch.refused.map((r) => `${r.path} ${r.code}: ${r.why}`).join('\n');
  assert.match(reasons, /ready fr: already has translation-status "sent" \(sent 2026-08-01/);
  assert.match(reasons, /draft de: en-status is "draft"/);
  assert.match(reasons, /unassessed de: en-status is "\(not assessed\)"/);
  assert.match(reasons, /gone de: curated translate="no"/);
});

test('refusalFor never disagrees with the gate', () => {
  assert.equal(refusalFor(page('/en/x', { 'en-status': 'en-published' }), {}), null);
  // Case is folded everywhere else in the model, so it is folded here too.
  assert.equal(refusalFor(page('/en/x', { 'en-status': 'EN-Published' }), {}), null);
  assert.match(refusalFor(page('/en/x'), {}), /not "en-published"/);
});

test('an unmatched --path= is reported so the run can refuse', () => {
  const batch = selectBatch(doc(), ['de'], opts({ paths: ['/en/meetups/typo'] }), null);
  assert.equal(batch.pairs.length, 0);
  assert.equal(batch.refusedExplicit.length, 1);
  assert.match(batch.refusedExplicit[0].why, /not a real page row/);
});

test('a named path that fails the gate refuses; a filter only reports', () => {
  const named = selectBatch(doc(), ['de'], opts({ paths: ['/en/meetups/draft'] }), null);
  assert.equal(named.refusedExplicit.length, 1, 'you asked for this page by name');

  const filtered = selectBatch(doc(), ['de'], opts(), null);
  assert.equal(filtered.refusedExplicit.length, 0, 'a bulk selection is a filter, not a claim');
  assert.ok(filtered.refused.length > 0, 'and it still says what it left out');
});

test('--limit caps PAGES, so no page is sent in half its locales', () => {
  const one = selectBatch(doc(), ['de', 'fr'], opts({ limit: 1 }), null);
  assert.equal(one.pages.length, 1);
  assert.deepEqual([...new Set(one.pairs.map((p) => p.path))], one.pages);

  // The page kept above happens to be sendable in one locale only. This one is sendable
  // in both, and the limit must not slice it in half: a batch is a set of documents
  // handed over, and half a page's locales is not a smaller batch, it is a stranger one.
  const whole = selectBatch(
    groupDoc([page('/en/meetups/both', { 'en-status': 'en-published' })], {}),
    ['de', 'fr'],
    opts({ limit: 1 }),
    null,
  );
  assert.deepEqual(whole.pages, ['/en/meetups/both']);
  assert.deepEqual(whole.pairs.map((p) => p.code), ['de', 'fr']);
});

test('--where= composes with the gate', () => {
  const d = doc();
  const parsed = parseWhere('stage:enPublished', { rows: [] });
  assert.deepEqual(parsed.errors, []);
  const batch = selectBatch(d, ['de'], opts(), parsed);
  assert.deepEqual(batch.pairs.map((p) => p.path), ['/en/meetups/ready']);
  // `gone` matches stage:enPublished — the stage model does not know about translate=no
  // either — and is still refused, by the curated check.
  assert.ok(batch.refused.some((r) => r.path === '/en/meetups/gone'));
});

test('tx:preview selects the TREE, not the status column — but honours translate=no', () => {
  const docs = selectDocuments(doc(), ['de'], null);
  const paths = docs.map((d) => d.path);
  // `draft` and `unassessed` are included: a document DA holds is previewable whether
  // or not our sheet knows it was sent. `gone` is not: translate=no excludes it from
  // every locale, so previewing it would publish a page nobody agreed to translate.
  assert.ok(paths.includes('/en/meetups/draft'));
  assert.ok(paths.includes('/en/meetups/ready'));
  assert.ok(!paths.includes('/en/meetups/gone'));
  // The DA document path is not the URL path: a locale home is a directory index.
  assert.equal(selectDocuments(groupDoc([page('/en')], {}), ['de'], null)[0].docPath, '/de/index');
});
