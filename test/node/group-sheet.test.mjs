/**
 * group-sheet.test.mjs — the band boundary, which is the contract.
 *
 *   npm run test:node          (node --test "test/node/*.test.mjs")
 *
 * Every case here is a way to lose data that a human typed. `subgroup` is the column
 * that matters most: it has no derivation to rebuild it from, so a sync that dropped
 * it would destroy work no re-run could recover. The other cases are the same shape —
 * `sent-at` is testimony that exists nowhere else, and an off-index row is a page
 * somebody decided to keep.
 *
 * `reconcileData`/`reconcileLocale` are imported from the sync TOOL. That is safe
 * because the tool guards its CLI entry with `fileURLToPath(import.meta.url) ===
 * argv[1]`; without that guard, importing them would start writing DA sheets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAND1_COLUMNS,
  BAND2_COLUMNS,
  BAND3_COLUMNS,
  DATA_COLUMNS,
  LOCALE_COLUMNS,
  LOCALE_PRESERVED,
  bandOf,
  syncDataRow,
  setCurated,
  syncLocaleRow,
  emptyGroupDoc,
  parseWhere,
  matchWhere,
} from '../../tools/tracker/lib/group-sheet.mjs';
import { reconcileData, reconcileLocale } from '../../tools/tracker/sync-groups-from-index.mjs';

const curated = () => ({
  'page-path': '/en/meetups/miami',
  title: 'OLD',
  template: 'meetup',
  pagetype: 'meetup',
  'en-live': '',
  'last-modified': '',
  subgroup: 'usa',
  translate: 'yes',
  notes: 'watch the video embed',
  'en-status': 'en-published',
  'content-escalation': 'yes',
});

const page = (path, title = 'T') => ({
  path, group: 'meetups', title, template: 'meetup', source: 'index',
});

test('the schema matches docs/tracker/data-contract.md section 1, in order', () => {
  assert.deepEqual(BAND1_COLUMNS, ['page-path', 'title', 'template', 'pagetype', 'en-live', 'last-modified']);
  assert.deepEqual(BAND2_COLUMNS, ['subgroup', 'translate', 'notes']);
  assert.deepEqual(BAND3_COLUMNS, ['en-status', 'content-escalation']);
  assert.deepEqual(DATA_COLUMNS, [...BAND1_COLUMNS, ...BAND2_COLUMNS, ...BAND3_COLUMNS]);
  assert.deepEqual(LOCALE_COLUMNS, [
    'page-path', 'locale', 'locale-path', 'sent-at', 'previewed', 'online',
    'translation-status', 'review-status', 'review-updated',
  ]);
  assert.deepEqual(LOCALE_PRESERVED, ['sent-at', 'translation-status', 'review-status', 'review-updated']);
  assert.equal(bandOf('subgroup'), 2);
  assert.equal(bandOf('page-path'), 1);
  assert.equal(bandOf('en-status'), 3);
  assert.equal(bandOf('nonsense'), null);
});

test('syncDataRow overwrites band 1 and preserves bands 2 and 3', () => {
  const { row, changes } = syncDataRow(curated(), {
    'page-path': '/en/meetups/miami', title: 'NEW', 'en-live': 'yes',
  });
  assert.equal(row.title, 'NEW');
  assert.equal(row['en-live'], 'yes');
  assert.equal(row.subgroup, 'usa');
  assert.equal(row.notes, 'watch the video embed');
  assert.equal(row['en-status'], 'en-published');
  assert.equal(row['content-escalation'], 'yes');
  assert.deepEqual(changes, [
    { column: 'title', from: 'OLD', to: 'NEW' },
    { column: 'en-live', from: '', to: 'yes' },
  ]);
});

test('syncDataRow REFUSES a band-2 or band-3 key rather than ignoring it', () => {
  // Silently ignoring it would let a caller believe it had recorded a status.
  assert.throws(() => syncDataRow(null, { subgroup: 'usa' }), /not band-1 columns/);
  assert.throws(() => syncDataRow(null, { 'en-status': 'en-published' }), /not band-1 columns/);
});

test('setCurated is the explicit door, and band 1 is closed to it', () => {
  const { row, changes } = setCurated(curated(), { subgroup: 'usa-east' });
  assert.equal(row.subgroup, 'usa-east');
  assert.deepEqual(changes, [{ column: 'subgroup', from: 'usa', to: 'usa-east' }]);
  // Band 1 is regenerated every sync, so a value written here would be overwritten
  // within the day while the tool that wrote it looked like it had worked.
  assert.throws(() => setCurated({}, { title: 'x' }), /not curated or status columns/);
});

test('an unrecognised column survives a sync — the schema is additive-only', () => {
  const { row } = syncDataRow({ ...curated(), 'future-column': 'keep me' }, { title: 'NEW' });
  assert.equal(row['future-column'], 'keep me');
});

test('syncLocaleRow carries testimony verbatim and heals the derived columns', () => {
  const existing = {
    'page-path': '/en/meetups/miami',
    locale: 'de',
    'locale-path': '/WRONG',
    'sent-at': '2026-06-01T00:00:00.000Z',
    previewed: 'yes',
    online: '',
    'translation-status': 'preview-ok',
    'review-status': 'ready-for-review',
    'review-updated': '2026-06-02T00:00:00.000Z',
  };
  const { row } = syncLocaleRow(existing, { pagePath: '/en/meetups/miami', code: 'de' });
  assert.equal(row['locale-path'], '/de/meetups/miami', 'derived, so it is regenerated');
  assert.equal(row['sent-at'], '2026-06-01T00:00:00.000Z', 'observable nowhere else');
  assert.equal(row['translation-status'], 'preview-ok');
  assert.equal(row['review-status'], 'ready-for-review');
  // Crawl output belongs to tx:scan. Not preserved as a rule, but not blanked by a
  // rebuild that did not scan: "we did not look" must not read as "it is not there".
  assert.equal(row.previewed, 'yes');
  const scanned = syncLocaleRow(existing, {
    pagePath: '/en/meetups/miami', code: 'de', observed: { previewed: '', online: '' },
  });
  assert.equal(scanned.row.previewed, '', 'an actual scan does overwrite it');
});

test('a new group doc is a valid multi-sheet envelope with all ten locale tabs', () => {
  const doc = emptyGroupDoc();
  assert.equal(doc[':type'], 'multi-sheet');
  assert.deepEqual(doc[':names'], ['data', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'ja', 'ko', 'zh-cn', 'zh-tw']);
  assert.equal(doc.data.data.length, 1);
  assert.equal(doc.data.data[0]['page-path'], '', 'a blank path is a placeholder, not a page');
  assert.equal(doc['zh-tw'].data[0].locale, 'zh-tw');
});

test('reconcileData preserves an off-index row byte-for-byte and never deletes it', () => {
  const gone = { 'page-path': '/en/meetups/gone', title: 'Gone', subgroup: 'eu' };
  const res = reconcileData(
    [curated(), gone, { 'page-path': '' }],
    [page('/en/meetups/miami', 'NEW')],
    new Map(),
    { reportOffIndex: true },
  );
  assert.equal(res.rows.length, 2);
  assert.deepEqual(res.rows[1], gone, 'the off-index row is the SAME object, untouched');
  assert.deepEqual(res.offIndex, ['/en/meetups/gone']);
  assert.equal(res.placeholders, 1, 'the blank placeholder is dropped');
  assert.equal(res.rows[0].subgroup, 'usa');
});

test('a FAILED probe leaves en-live and last-modified exactly as they were', () => {
  // Writing '' on a network error would record "this page is not live" on the strength
  // of a DNS hiccup — and en-live is what the boards count.
  const live = { ...curated(), 'en-live': 'yes', 'last-modified': '2026-07-01T00:00:00.000Z' };
  const res = reconcileData(
    [live],
    [page('/en/meetups/miami')],
    new Map([['/en/meetups/miami', { reachable: false, why: 'timeout' }]]),
    { reportOffIndex: false },
  );
  assert.equal(res.rows[0]['en-live'], 'yes');
  assert.equal(res.rows[0]['last-modified'], '2026-07-01T00:00:00.000Z');
});

test('reconcileLocale skips NEW rows for translate="no" but keeps existing ones', () => {
  const dataRows = [
    { ...curated(), translate: 'no' },
    { 'page-path': '/en/meetups/munich', translate: '' },
  ];
  const fresh = reconcileLocale([], dataRows, 'ja');
  assert.deepEqual(fresh.added, ['/en/meetups/munich']);
  assert.equal(fresh.excluded, 1);

  const existing = [{ 'page-path': '/en/meetups/miami', locale: 'ja', 'sent-at': '2026-05-01T00:00:00.000Z' }];
  const kept = reconcileLocale(existing, dataRows, 'ja');
  const miami = kept.rows.find((r) => r['page-path'] === '/en/meetups/miami');
  assert.equal(miami['sent-at'], '2026-05-01T00:00:00.000Z', 'a curated exclusion does not erase what happened');
});

test('parseWhere fails CLOSED on an unknown column name', () => {
  // A missing column reads as '', so `subgroup=x` would select nothing and
  // `subgroup!=x` would select every row — silently, on an un-upgraded sheet.
  assert.equal(parseWhere('subgroup=usa').errors.length, 0);
  assert.match(parseWhere('subgrup=usa').errors[0], /unknown column "subgrup"/);
  assert.match(parseWhere('stage:nonsense').errors[0], /unknown stage/);
  assert.match(parseWhere('queue:nonsense').errors[0], /unknown queue/);
  assert.match(parseWhere('wat').errors[0], /cannot parse/);
  // A column the sheet carries but the schema does not is known, so a mid-upgrade
  // sheet stays selectable.
  assert.equal(parseWhere('extra=1', { rows: [{ extra: '1' }] }).errors.length, 0);
});

test('matchWhere reads a derived stage, an empty value and a negation', () => {
  const row = curated();
  assert.ok(matchWhere(parseWhere('stage:enPublished'), row));
  assert.ok(!matchWhere(parseWhere('stage:catalogued'), row));
  assert.ok(matchWhere(parseWhere('queue:content-escalation'), row));
  assert.ok(matchWhere(parseWhere('notes!='), row), 'notes is non-empty');
  assert.ok(matchWhere(parseWhere('subgroup=usa,translate=yes'), row), 'terms are ANDed');
  assert.ok(!matchWhere(parseWhere('subgroup=usa,translate=no'), row));
  // `sendable` needs the gate open AND nothing sent yet.
  assert.ok(matchWhere(parseWhere('sendable'), row, {}));
  assert.ok(!matchWhere(parseWhere('sendable'), row, { 'translation-status': 'sent' }));
  // An empty value is a real selector.
  assert.ok(matchWhere(parseWhere('subgroup='), { 'page-path': '/x' }));
});
