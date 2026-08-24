/**
 * tx-scan.test.mjs — `decidePair`, the observer's whole decision.
 *
 *   npm run test:node          (node --test "test/node/*.test.mjs")
 *
 * The cases are grouped by the thing each one protects:
 *
 *   "we did not look" must never be recorded as "the page is not there" — that is what
 *   makes `classifyTranslation()`'s clamp trustworthy, and writing `previewed: ''` from
 *   a DNS hiccup would read as a withdrawn translation.
 *
 *   `sent-at` is testimony nothing else can rebuild, so it is filled from a better
 *   witness and never erased on weak evidence.
 *
 *   the transition table is closed. A scan may make exactly four moves; anything else
 *   is a status the crawl invented.
 *
 * `decidePair` is imported from the TOOL. That is safe because the tool guards its CLI
 * entry with `fileURLToPath(import.meta.url) === argv[1]`; without that guard, importing
 * it would start crawling and writing DA sheets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePair } from '../../tools/tracker/tx-scan.mjs';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const SLA = { previewHours: 48, publishHours: 24 };
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

const decide = (localeRow, obs, extra = {}) => decidePair({
  localeRow, obs, project: null, projectsRead: true, now: NOW, sla: SLA, ...extra,
});

const seen = (previewed, online) => ({
  ok: true, fellBack: false, previewed, online,
});
const blind = { ok: false, why: 'status API 0 (fetch failed)' };

test('an unobserved pair writes NEITHER crawl column', () => {
  const d = decide({ 'page-path': '/en/x', previewed: 'yes', online: 'yes' }, blind);
  assert.equal(d.observed, null, 'nothing to write — the sheet keeps what it had');
  assert.equal(d.status, null);
  assert.match(d.warnings[0], /LEFT AS THEY WERE/);
});

test('nothing translated anywhere is the honest zero, not a change', () => {
  const d = decide({ 'page-path': '/en/x', previewed: '', online: '' }, seen(false, false));
  assert.deepEqual(d.observed, { previewed: '', online: '' });
  assert.equal(d.status, null);
  assert.equal(d.changed, false, 'blank stays blank, so no row is dirtied');
  assert.deepEqual(d.warnings, []);
});

test('a withdrawn translation is re-observed as absent', () => {
  const d = decide({ previewed: 'yes', online: 'yes', 'translation-status': 'auto-qa-ok' }, seen(false, false));
  assert.deepEqual(d.observed, { previewed: '', online: '' });
  assert.equal(d.changed, true);
  // The scan records the observation; classifyTranslation's clamp is what re-reads the
  // stage. The scan does NOT rewrite a judged verdict on the strength of a crawl.
  assert.equal(d.status, null);
});

test('a project corroborates a blank row: the project outranks it', () => {
  const at = hoursAgo(3);
  const d = decide({ 'translation-status': '', 'sent-at': '' }, seen(false, false), {
    project: { at, project: '1770.json' },
  });
  assert.equal(d.status.to, 'sent');
  assert.equal(d.sentAt, at);
  assert.match(d.note, /outranks our blank row/);
});

test('a project fills a missing sent-at without moving the status', () => {
  const at = hoursAgo(3);
  const d = decide({ 'translation-status': 'sent', 'sent-at': '' }, seen(false, false), {
    project: { at, project: '1770.json' },
  });
  assert.equal(d.status, null);
  assert.equal(d.sentAt, at);
  assert.match(d.note, /sent-at filled from project/);
});

test('no active project for a stored `sent` WARNS and never rewrites', () => {
  const at = hoursAgo(3);
  const d = decide({ 'translation-status': 'sent', 'sent-at': at }, seen(false, false));
  assert.equal(d.status, null, 'testimony is not erased on weak evidence');
  assert.equal(d.sentAt, null);
  assert.match(d.warnings[0], /archived out of active\/|never made/);
  assert.match(d.warnings[0], /NOT rewritten/);
});

test('sent + on the preview host = preview-ok, the one forward move a crawl can justify', () => {
  const d = decide({ 'translation-status': 'sent', 'sent-at': hoursAgo(2) }, seen(true, false));
  assert.equal(d.status.to, 'preview-ok');
  assert.deepEqual(d.observed, { previewed: 'yes', online: '' });
  assert.equal(d.status.breach, undefined);
});

test('a blank status on a previewed page invents no send', () => {
  // `classifyTranslation` already derives the `previewed` stage from the crawl column
  // alone here. Writing `preview-ok` would assert a hand-off that may never have
  // happened, and `sent` is the one fact nothing can contradict later.
  const d = decide({ 'translation-status': '' }, seen(true, false));
  assert.equal(d.status, null);
  assert.deepEqual(d.observed, { previewed: 'yes', online: '' });
});

test('the preview SLA fires only after the window, and only from `sent`', () => {
  const inside = decide({ 'translation-status': 'sent', 'sent-at': hoursAgo(47) }, seen(false, false));
  assert.equal(inside.status, null, '47h is inside a 48h window');

  const outside = decide({ 'translation-status': 'sent', 'sent-at': hoursAgo(49) }, seen(false, false));
  assert.equal(outside.status.to, 'preview-missing');
  assert.equal(outside.status.breach, true);
  assert.match(outside.status.why, /SLA 48h/);
});

test('`sent` with no sent-at warns instead of guessing an age', () => {
  const d = decide({ 'translation-status': 'sent', 'sent-at': '' }, seen(false, false));
  assert.equal(d.status, null);
  assert.match(d.warnings.join(' '), /no sent-at/);
});

test('a late arrival recovers out of preview-missing', () => {
  const d = decide({ 'translation-status': 'preview-missing', 'sent-at': hoursAgo(200) }, seen(true, false));
  assert.equal(d.status.to, 'preview-ok');
  assert.match(d.status.why, /arrived late/);
  assert.equal(d.status.breach, undefined, 'a recovery is not a new defect');
});

test('the publish SLA needs a sign-off, a preview, and no live page', () => {
  const signedOff = {
    'translation-status': 'visual-qa-ok',
    'review-status': 'TRANSLATION OK',
    'review-updated': hoursAgo(30),
  };
  const late = decide(signedOff, seen(true, false));
  assert.equal(late.status.to, 'publish-fail');
  assert.equal(late.status.breach, true);

  const live = decide(signedOff, seen(true, true));
  assert.equal(live.status, null, 'it went live; nothing is wrong');

  const fresh = decide({ ...signedOff, 'review-updated': hoursAgo(2) }, seen(true, false));
  assert.equal(fresh.status, null, 'inside the window');

  const unreviewed = decide({ 'translation-status': 'visual-qa-ok' }, seen(true, false));
  assert.equal(unreviewed.status, null, 'nobody signed it off, so nothing is overdue');
});

test('publish-fail is not re-written on every subsequent scan', () => {
  const d = decide({
    'translation-status': 'publish-fail',
    'review-status': 'TRANSLATION OK',
    'review-updated': hoursAgo(300),
  }, seen(true, false));
  assert.equal(d.status, null);
});

test('a blocked pair keeps its queue: the scan does not move it forward', () => {
  for (const status of ['auto-qa-fail', 'untranslated', 'unlocalized-links', 'visual-qa-fail']) {
    const d = decide({ 'translation-status': status, 'sent-at': hoursAgo(100) }, seen(true, false));
    assert.equal(d.status, null, `${status} must not be overwritten by an observation`);
    assert.deepEqual(d.observed, { previewed: 'yes', online: '' });
  }
});
