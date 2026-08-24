import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfidence, suppressSettled, verifyQuotes, normQuote, settledSummary,
  loadGlossary, MIN_CONFIDENCE,
} from '../../tools/tracker/tx-judge.mjs';
import {
  toTranslationStatus, stageStatus, scopeOf, regression, ledgerKey, selectPairs,
  docFindings, applyToSheet,
} from '../../tools/tracker/tx-driver.mjs';
import { reconcilePair } from '../../tools/tracker/tx-reconcile.mjs';
import { decide } from '../../tools/tracker/sync-review-status.mjs';
import { TARGET_LOCALES } from '../../scripts/tracker/locales.js';
import {
  TRANSLATION_STATUSES, classifyTranslation, indexLocaleRows,
} from '../../scripts/tracker/stages.js';
import { groupDoc, parseWhere } from '../../tools/tracker/lib/group-sheet.mjs';

const report = (tier = {}, judge = null) => ({
  'page-path': '/en/meetups/x',
  locale: 'de',
  tiers: {
    structural: {
      verdict: 'fail', errors: [], warnings: [], notes: [], checks: {}, ...tier,
    },
    judge,
    visual: null,
  },
});

/* ------------------------------------------------------------------ tier 2 */

test('confidence out of the 0..1 violation is normalized, and the original kept', () => {
  // The schema says 0..1 and live reports upstream carried `95`. llama.cpp's grammar
  // enforces the TYPE, not the range, so a raw 95 read as a confidence is 95x anything a
  // threshold compares it against.
  assert.deepEqual(normalizeConfidence(95), { confidence: 0.95, reported: 95 });
  assert.deepEqual(normalizeConfidence(0.42), { confidence: 0.42, reported: 0.42 });
  assert.deepEqual(normalizeConfidence(1), { confidence: 1, reported: 1 });
  assert.deepEqual(normalizeConfidence('nonsense'), { confidence: null, reported: 'nonsense' });
  assert.deepEqual(normalizeConfidence(400), { confidence: null, reported: 400 });
  assert.ok(MIN_CONFIDENCE > 0 && MIN_CONFIDENCE < 1);
});

test('the SUPPRESS list drops what is not a defect in a TRANSLATION, and keeps it', () => {
  const { kept, suppressed } = suppressSettled([
    { category: 'other', detail: 'The German uses a different word order than the English.' },
    { category: 'other', detail: 'The date format is written as 2. Oktober 2026.' },
    { category: 'other', detail: 'The decimal separator should be a period.' },
    { category: 'terminology', detail: 'Edge Delivery Services remains in English.' },
    { category: 'meaning-lost', detail: 'The sentence drops the figure 4.' },
  ]);
  assert.equal(kept.length, 1, `kept: ${JSON.stringify(kept)}`);
  assert.equal(kept[0].category, 'meaning-lost');
  assert.equal(suppressed.length, 4);
  // Retained, never dropped: a suppression list that hides its own work is unauditable.
  assert.ok(suppressed.every((s) => s.suppressedBy));
});

test('an unverifiable quote is downgraded and labelled, never silently dropped', () => {
  const sample = { en: 'the block is a named section', translated: 'der Block ist ein Abschnitt', pairs: [] };
  const [real, fake] = verifyQuotes([
    { severity: 'error', detail: 'x', quote: 'der Block ist ein Abschnitt' },
    { severity: 'error', detail: 'x', quote: 'ein Satz der nirgendwo steht' },
  ], sample);
  assert.equal(real.quoteVerified, true);
  assert.equal(real.severity, 'error');
  assert.equal(fake.quoteVerified, false);
  assert.equal(fake.severity, 'warning', 'a hallucinated finding must not fail a page alone');
  assert.match(fake.detail, /UNVERIFIED/);
});

test('a quote under four characters is null, not false', () => {
  const [i] = verifyQuotes([{ severity: 'error', detail: 'x', quote: 'ab' }], { en: 'ab', translated: 'ab' });
  assert.equal(i.quoteVerified, null);
  assert.equal(i.severity, 'error');
});

test('a comma-separated TERM LIST verifies when every term is present', () => {
  const sample = { translated: 'Block, Baustein und Komponente', en: '', pairs: [] };
  const [ok] = verifyQuotes([{ severity: 'error', detail: 'inconsistent', quote: 'Block, Baustein, Komponente' }], sample);
  assert.equal(ok.quoteVerified, true);
  assert.equal(ok.quotedAs, 'term-list');
  // A fabricated term in the list still fails.
  const [bad] = verifyQuotes([{ severity: 'error', detail: 'x', quote: 'Block, Baustein, Erfindung' }], sample);
  assert.equal(bad.quoteVerified, false);
});

test('normQuote strips the scaffolding the prompt itself invites', () => {
  // The upstream judge returned the perfectly valid quote `DE: Regisseur` and had it
  // downgraded, because the label the prompt printed was treated as part of the quotation.
  assert.equal(normQuote('DE: Regisseur'), 'regisseur');
  assert.equal(normQuote('[7] callout / heading\n  EN: Director\n  DE: Regisseur'), 'regisseur');
  // Surrounding quote marks are scaffolding and go; INNER ones are folded to ASCII so a
  // model's transcription matches what DA stored.
  assert.equal(normQuote('“Der Block”'), 'der block');
  assert.equal(normQuote('Er sagte “ja” dazu'), 'er sagte "ja" dazu');
});

test('settledSummary only lists checks a model would plausibly re-report', () => {
  const tier = {
    errors: [{ check: 'untranslated-text', detail: 'a' }],
    warnings: [{ check: 'expansion', detail: 'b' }],
    notes: [],
  };
  const s = settledSummary(tier);
  assert.match(s, /untranslated-text/);
  assert.doesNotMatch(s, /expansion/, 'an expansion ratio is not something a judge can act on');
  assert.equal(settledSummary({ errors: [], warnings: [], notes: [] }), null);
});

test('every target locale has a seeded glossary', () => {
  for (const code of TARGET_LOCALES) {
    const g = loadGlossary(code);
    assert.equal(g.missing.length, 0, `${code} is missing ${g.missing.join(', ')}`);
    assert.equal(g.files.length, 2, `${code} should load the shared file and its own`);
    assert.match(g.text, /Edge Delivery Services/);
  }
  // A locale with no file at all reports it rather than judging terminology it never saw.
  assert.equal(loadGlossary('xx').files.length, 1);
  assert.equal(loadGlossary('xx').missing.length, 1);
});

/* ------------------------------------------------------------------ status mapping */

test('every status the driver can write is in the stages.js enum', () => {
  const known = new Set(TRANSLATION_STATUSES.map((s) => s.value));
  const produced = [
    toTranslationStatus('error', report()),
    toTranslationStatus('fail', report({ errors: [{ check: 'unlocalized-path' }] })),
    toTranslationStatus('fail', report({ errors: [{ check: 'untranslated-text' }] })),
    toTranslationStatus('fail', report({ errors: [{ check: 'translated-code', dntViolation: true }] })),
    toTranslationStatus('escalate', report({ errors: [] })),
    stageStatus({ judged: false, visual: false }),
    stageStatus({ judged: true, visual: false }),
    stageStatus({ judged: true, visual: true }),
  ];
  for (const s of produced) assert.ok(known.has(s), `"${s}" is not a TRANSLATION_STATUS`);
});

test('errors decide the status before warnings do', () => {
  // Upstream this scanned both together in a fixed order, so a page whose ERROR was an
  // unlocalized link and whose warnings were harmless key changes was labelled a DNT
  // problem and routed to re-translation, which fixes nothing.
  const r = report({
    errors: [{ check: 'unlocalized-path' }],
    warnings: [{ check: 'untranslated-cell', dntGap: true }],
  });
  assert.equal(toTranslationStatus('fail', r), 'unlocalized-links');
});

test('a not-translated page gets NO status — there is nothing to record', () => {
  const r = report({ verdict: 'review', warnings: [{ check: 'not-translated' }] });
  assert.equal(toTranslationStatus('fail', r), 'auto-qa-fail');
  assert.equal(toTranslationStatus('review', r), null, 'a review verdict writes no failure');
  assert.equal(toTranslationStatus('pass', r), null);
});

test('tier 1 alone does not clear a page past what the crawl already knew', () => {
  assert.equal(stageStatus({ judged: false, visual: false }), 'preview-ok');
});

test('scope routes the four defect classes to different owners', () => {
  assert.equal(scopeOf(report({ errors: [{ dntGap: true }] })), 'template');
  assert.equal(scopeOf(report({ errors: [{ check: 'unlocalized-path' }] })), 'template');
  assert.equal(scopeOf(report({ errors: [{ dntViolation: true }] })), 'content');
  assert.equal(scopeOf(report({ errors: [{ check: 'untranslated-text' }] })), 'page');
});

/* ------------------------------------------------------------------ the regression guard */

test('the guard fires on a backwards move — and would NOT if built on classify()', () => {
  const r = regression('auto-qa-ok', 'preview-ok');
  assert.ok(r, 'auto-qa-ok → preview-ok is backwards');
  assert.match(r, /BACKWARDS/);
  assert.match(r, /--force/);
  // Forwards and sideways are fine.
  assert.equal(regression('preview-ok', 'auto-qa-ok'), null);
  assert.equal(regression('auto-qa-ok', 'auto-qa-ok'), null);
  assert.equal(regression('', 'preview-ok'), null);
  // A BLOCKING status is never a regression: recording a failure is the pipeline working.
  assert.equal(regression('auto-qa-ok', 'auto-qa-fail'), null);
  assert.equal(regression('auto-qa-fail', 'auto-qa-ok'), null);
  // tx-reconcile IMPORTS this guard rather than keeping a copy: two writers of one column
  // with two copies of one rule is how they come to disagree about it.
});

test('THE 33 ROWS: the guard still fires when a review-status is set', () => {
  /*
   * The whole reason `translationOrder()` exists. `classifyTranslation()` folds in
   * `review-status`, so with `ready-for-review` on the row it returns `inReview` for BOTH
   * the old and the new status and every write compares equal. That is exactly how an
   * upstream reconcile silently moved 33 rows backwards.
   */
  const row = { 'page-path': '/en/meetups/x', 'en-status': 'en-published' };
  const before = {
    'page-path': '/en/meetups/x', previewed: 'yes', 'translation-status': 'visual-qa-ok', 'review-status': 'ready-for-review',
  };
  const after = { ...before, 'translation-status': 'auto-qa-ok' };
  const stageOf = (localeRow) => classifyTranslation(row, localeRow).stage;
  assert.equal(stageOf(before), stageOf(after), 'classify() cannot see this move — that is the bug');
  assert.ok(regression('visual-qa-ok', 'auto-qa-ok'), 'translationOrder() can');
});

/* ------------------------------------------------------------------ selection */

const sheetWith = (dataRows, localeRows) => groupDoc(dataRows, localeRows);

test('the work queue is the tree: an unpreviewed pair is notTranslated, not a failure', () => {
  const doc = sheetWith(
    [{ 'page-path': '/en/meetups/a', 'en-status': 'en-published' },
      { 'page-path': '/en/meetups/b', 'en-status': 'en-published' }],
    { de: [{ 'page-path': '/en/meetups/a', locale: 'de', previewed: 'yes' }] },
  );
  const { pending, counts } = selectPairs({
    dataRows: doc.data.data,
    localeIndex: indexLocaleRows(doc),
    code: 'de',
    parsed: parseWhere(''),
    ledger: { pages: {} },
    force: false,
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].path, '/en/meetups/a');
  assert.equal(counts.notTranslated, 1);
});

test('a pair the ledger already passed is skipped unless --force', () => {
  const doc = sheetWith(
    [{ 'page-path': '/en/meetups/a', 'en-status': 'en-published' }],
    { de: [{ 'page-path': '/en/meetups/a', locale: 'de', previewed: 'yes' }] },
  );
  const args = {
    dataRows: doc.data.data,
    localeIndex: indexLocaleRows(doc),
    code: 'de',
    parsed: parseWhere(''),
    ledger: { pages: { [ledgerKey('/en/meetups/a', 'de')]: { verdict: 'pass' } } },
  };
  assert.equal(selectPairs({ ...args, force: false }).pending.length, 0);
  assert.equal(selectPairs({ ...args, force: false }).counts.skipped, 1);
  assert.equal(selectPairs({ ...args, force: true }).pending.length, 1);
});

test('the ledger key uses a NUL separator', () => {
  assert.equal(ledgerKey('/en/meetups/x', 'de'), '/en/meetups/x\0de');
  // A separator that can occur inside a key is a silent collision, and both halves are
  // hand-typed.
  assert.notEqual(ledgerKey('/en/a b', 'de'), ledgerKey('/en/a', 'b de'));
});

/* ------------------------------------------------------------------ the sheet write */

test('the driver writes translation-status and nothing else', () => {
  const doc = sheetWith(
    [{ 'page-path': '/en/meetups/a' }],
    {
      de: [{
        'page-path': '/en/meetups/a',
        locale: 'de',
        'sent-at': '2026-08-01T00:00:00.000Z',
        'review-status': 'ready-for-review',
        'review-updated': '2026-08-02T00:00:00.000Z',
        previewed: 'yes',
        'translation-status': 'preview-ok',
      }],
    },
  );
  const { doc: next, applied } = applyToSheet(doc, 'de', [
    { enPath: '/en/meetups/a', code: 'de', status: 'auto-qa-ok' },
  ]);
  const row = next.de.data[0];
  assert.equal(row['translation-status'], 'auto-qa-ok');
  // Testimony survives verbatim — that is what makes the 412 re-apply safe.
  assert.equal(row['sent-at'], '2026-08-01T00:00:00.000Z');
  assert.equal(row['review-status'], 'ready-for-review');
  assert.equal(row['review-updated'], '2026-08-02T00:00:00.000Z');
  assert.equal(applied.length, 1);
});

test('a judged pair with no locale row gets one rather than vanishing', () => {
  const doc = sheetWith([{ 'page-path': '/en/meetups/a' }], { de: [] });
  const { doc: next } = applyToSheet(doc, 'de', [
    { enPath: '/en/meetups/a', code: 'de', status: 'auto-qa-ok' },
  ]);
  assert.equal(next.de.data.length, 1);
  assert.equal(next.de.data[0].locale, 'de');
  assert.equal(next.de.data[0]['translation-status'], 'auto-qa-ok');
});

test('findings are grouped into the review doc\'s own sections', () => {
  const f = docFindings(report({
    errors: [{ check: 'skeleton', detail: 'a' }, { check: 'untranslated-text', detail: 'b' }],
    notes: [{ check: 'expansion', detail: 'c' }],
  }, { issues: [{ category: 'terminology', detail: 'd', quote: 'q' }] }));
  const [preview, translation, layout] = Object.keys(f);
  assert.ok(f[preview].some((x) => x.includes('skeleton')));
  assert.ok(f[translation].some((x) => x.includes('untranslated-text')));
  assert.ok(f[translation].some((x) => x.includes('terminology')));
  assert.ok(f[layout].some((x) => x.includes('expansion')));
});

/* ------------------------------------------------------------------ doc → sheet */

const docFor = (over = {}) => ({
  exists: true,
  path: '/tracker/tx/de/meetups/x',
  doc: {
    status: null, markerUnknown: false, metaStatus: null, mismatch: false, updated: '', actor: '', ...over,
  },
});

test('the doc wins on review-status, and a missing doc never clears the sheet', () => {
  const d = decide({
    pagePath: '/en/meetups/x', code: 'de', sheetValue: '', doc: docFor({ status: 'TRANSLATION OK', updated: 'T' }),
  });
  assert.equal(d.action, 'update');
  assert.equal(d.doc, 'TRANSLATION OK');
  assert.equal(d.updated, 'T');

  const gone = decide({
    pagePath: '/en/meetups/x', code: 'de', sheetValue: 'TRANSLATION OK', doc: { exists: false, status: 404 },
  });
  assert.equal(gone.action, 'no-doc');
  assert.equal(gone.doc, null, 'nothing to write — the cell keeps its verdict');
});

test('an unknown marker is a data-quality warning, never bucketed as pending', () => {
  const d = decide({
    pagePath: '/en/meetups/x', code: 'de', sheetValue: 'ready-for-review', doc: docFor({ markerUnknown: true }),
  });
  assert.equal(d.action, 'unknown-marker');
  assert.equal(d.doc, null);
});

test('case is folded: a hand-typed "translation ok" is not a disagreement', () => {
  const d = decide({
    pagePath: '/en/meetups/x', code: 'de', sheetValue: 'TRANSLATION OK', doc: docFor({ status: 'translation ok' }),
  });
  assert.equal(d.action, 'in-sync');
});

/* ------------------------------------------------------------------ reconcile */

const pairArgs = (over = {}) => ({
  pagePath: '/en/meetups/x',
  code: 'de',
  row: { 'page-path': '/en/meetups/x', 'en-status': 'en-published' },
  localeRow: { 'page-path': '/en/meetups/x', locale: 'de', previewed: 'yes' },
  doc: { exists: false, status: 404, reason: 'not found' },
  ledgerEntry: null,
  opts: { fromLedger: false, refreshDocs: false, force: false },
  ...over,
});

test('the ledger is authoritative for nothing: drift is reported, not repaired', () => {
  const { decisions } = reconcilePair(pairArgs({
    ledgerEntry: { 'translation-status': 'auto-qa-ok' },
  }));
  const drift = decisions.find((d) => d.kind === 'ledger-drift');
  assert.ok(drift);
  assert.equal(drift.writes, null, 'no write without --from-ledger');
  assert.match(drift.detail, /authoritative for nothing/);
});

test('--from-ledger repairs forwards and is REFUSED backwards', () => {
  const forwards = reconcilePair(pairArgs({
    localeRow: { 'page-path': '/en/meetups/x', locale: 'de', previewed: 'yes', 'translation-status': 'preview-ok' },
    ledgerEntry: { 'translation-status': 'auto-qa-ok' },
    opts: { fromLedger: true, refreshDocs: false, force: false },
  })).decisions.find((d) => d.kind === 'ledger-drift');
  assert.equal(forwards.writes, 'sheet');
  assert.equal(forwards.refusal, null);

  const backwards = reconcilePair(pairArgs({
    localeRow: {
      'page-path': '/en/meetups/x',
      locale: 'de',
      previewed: 'yes',
      'translation-status': 'visual-qa-ok',
      // The 33 rows all carried this, which is why a classify()-based guard could not fire.
      'review-status': 'ready-for-review',
    },
    ledgerEntry: { 'translation-status': 'auto-qa-ok' },
    opts: { fromLedger: true, refreshDocs: false, force: false },
  })).decisions.find((d) => d.kind === 'ledger-drift');
  assert.equal(backwards.writes, null);
  assert.match(backwards.refusal, /BACKWARDS/);
});

test('a pair with a recorded status and no document is reported, not scaffolded', () => {
  const { decisions } = reconcilePair(pairArgs({
    localeRow: { 'page-path': '/en/meetups/x', locale: 'de', previewed: 'yes', 'translation-status': 'auto-qa-ok' },
  }));
  const missing = decisions.find((d) => d.kind === 'doc-missing');
  assert.ok(missing);
  assert.equal(missing.writes, null, 'creating the doc needs the findings tx:batch has');
});

test('--refresh-docs pushes the SHEET value into the doc, never the reverse', () => {
  const { decisions } = reconcilePair(pairArgs({
    localeRow: { 'page-path': '/en/meetups/x', locale: 'de', previewed: 'yes', 'translation-status': 'auto-qa-ok' },
    doc: docFor({ translationStatus: 'preview-ok' }),
    opts: { fromLedger: false, refreshDocs: true, force: false },
  }));
  const refresh = decisions.find((d) => d.kind === 'doc-refresh');
  assert.equal(refresh.writes, 'doc');
  assert.equal(refresh.now, 'auto-qa-ok');
  assert.equal(refresh.was, 'preview-ok');
});
