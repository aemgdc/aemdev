import { expect } from '@esm-bundle/chai';
import {
  CONTENT_ESCALATION_COLUMN,
  CONTENT_ESCALATION_RE,
  PAGE_STAGES,
  QUEUES,
  REVIEW_DOC_MARKERS,
  REVIEW_STATUSES,
  REVIEW_STATUS_RE,
  STAGE_INDEX,
  TRANSLATION_STATUSES,
  classifyEnglish,
  classifyTranslation,
  countsAsPage,
  indexLocaleRows,
  isSendable,
  localeRowFor,
  passedSendGate,
  reviewStatusFromDocText,
  reviewStatusFromMarker,
  sheetRows,
  tally,
  translationOrder,
  translationStage,
} from '../../../scripts/tracker/stages.js';

/*
 * stages.js is the one file every other part of the tracker agrees through, so it is
 * tested before any consumer exists: a wrong enum here is wrong in the boards, the DA
 * app, the feeds and the pipeline at once, and each of them would look internally
 * consistent while doing it.
 *
 * The tests below are organised by the rule they protect rather than by function, and
 * every rule that exists because of a real past failure says so.
 */

/** A `data` row for a countable, published EN page. */
const enRow = (extra = {}) => ({
  'page-path': '/en/meetups/berlin',
  'en-status': 'en-published',
  ...extra,
});

/** A locale row. `previewed`/`online` are crawl output, written as text. */
const locRow = (extra = {}) => ({ locale: 'de', ...extra });

const flag = (row) => ({ ...row, [CONTENT_ESCALATION_COLUMN]: 'yes' });

const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

/*
 * One entry per distinct `return` in classifyTranslation(), named by the branch it
 * exercises. Used for the flag-survives-every-exit sweep below, so adding a branch
 * without adding a row here shows up as an uncovered exit.
 */
const EXITS = [
  ['human blocker', enRow(), locRow({ 'review-status': 'needs-retranslation' })],
  ['in review', enRow(), locRow({ 'review-status': 'ready-for-review' })],
  ['signed off, not live', enRow(), locRow({ 'review-status': 'TRANSLATION OK', previewed: 'yes' })],
  ['signed off and live', enRow(), locRow({ 'review-status': 'TRANSLATION OK', previewed: 'yes', online: 'yes' })],
  ['clamped by a missing preview', enRow(), locRow({ 'translation-status': 'auto-qa-ok' })],
  ['still in flight', enRow(), locRow({ 'translation-status': 'sent' })],
  ['never arrived', enRow(), locRow({ 'translation-status': 'preview-missing' })],
  ['send failed', enRow(), locRow({ 'translation-status': 'send-fail' })],
  ['never sent', enRow(), locRow()],
  ['ungated status', enRow({ 'en-status': 'draft' }), locRow({ 'translation-status': 'preview-ok', previewed: 'yes' })],
  ['pipeline blocker', enRow(), locRow({ 'translation-status': 'auto-qa-fail', previewed: 'yes' })],
  ['forward funnel', enRow(), locRow({ 'translation-status': 'visual-qa-ok', previewed: 'yes' })],
];

describe('stages.js', () => {
  describe('the funnel', () => {
    it('is ordered, and STAGE_INDEX agrees with array position', () => {
      PAGE_STAGES.forEach((s, i) => expect(STAGE_INDEX[s.id], s.id).to.equal(i));
      expect(Object.keys(STAGE_INDEX)).to.deep.equal(PAGE_STAGES.map((s) => s.id));
      // A duplicate id would make STAGE_INDEX silently point at the last copy.
      expect(new Set(PAGE_STAGES.map((s) => s.id)).size).to.equal(PAGE_STAGES.length);
    });

    it('runs EN gate -> sent -> preview -> QA -> review -> live', () => {
      expect(PAGE_STAGES.map((s) => s.id)).to.deep.equal([
        'catalogued', 'enPublished', 'sentForTranslation', 'previewed', 'autoQaPass',
        'layoutQaPass', 'inReview', 'reviewOk', 'online',
      ]);
      // Everything downstream compares these as numbers, so the relations are the
      // contract, not the names.
      expect(STAGE_INDEX.online).to.be.greaterThan(STAGE_INDEX.reviewOk);
      expect(STAGE_INDEX.reviewOk).to.be.greaterThan(STAGE_INDEX.inReview);
      expect(STAGE_INDEX.inReview).to.be.greaterThan(STAGE_INDEX.layoutQaPass);
      expect(STAGE_INDEX.layoutQaPass).to.be.greaterThan(STAGE_INDEX.autoQaPass);
      expect(STAGE_INDEX.autoQaPass).to.be.greaterThan(STAGE_INDEX.previewed);
      expect(STAGE_INDEX.previewed).to.be.greaterThan(STAGE_INDEX.sentForTranslation);
      expect(STAGE_INDEX.sentForTranslation).to.be.greaterThan(STAGE_INDEX.enPublished);
      expect(STAGE_INDEX.enPublished).to.be.greaterThan(STAGE_INDEX.catalogued);
    });

    it('gives every stage a label, a chip label and a hint', () => {
      for (const s of PAGE_STAGES) {
        expect(s.label, s.id).to.be.a('string').and.not.empty;
        expect(s.short, s.id).to.be.a('string').and.not.empty;
        expect(s.hint, s.id).to.be.a('string').and.not.empty;
      }
    });
  });

  describe('the status vocabularies', () => {
    const queueIds = QUEUES.map((q) => q.id);

    it('gives every translation-status a forward stage or a queue, never both', () => {
      for (const s of TRANSLATION_STATUSES) {
        const forward = translationStage(s.value);
        const label = s.value || '(blank)';
        // A value with neither is unreachable as a stage: classifyTranslation would
        // bucket it at `previewed` with a warning, which is a model bug, not data.
        expect(Boolean(forward) !== Boolean(s.queue), label).to.be.true;
        if (forward) expect(STAGE_INDEX, label).to.have.property(forward);
      }
    });

    it('names only real queue ids, so no row becomes unfilterable', () => {
      /*
       * A dangling queue name does not throw anywhere — tally() skips ids it does not
       * know and the boards render no chip for them, so the rows land in a bucket that
       * no filter can select. Silent invisibility is the failure mode being guarded.
       */
      const named = [
        ...TRANSLATION_STATUSES.map((s) => s.queue),
        ...REVIEW_STATUSES.map((s) => s.queue),
        CONTENT_ESCALATION_COLUMN,
      ].filter(Boolean);
      expect(named.length).to.be.greaterThan(0);
      for (const q of named) expect(queueIds, q).to.include(q);
      expect(new Set(queueIds).size).to.equal(QUEUES.length);
    });

    it('gives every queue an owner and a hint, so three views name one owner', () => {
      for (const q of QUEUES) {
        expect(q.owner, q.id).to.be.a('string').and.not.empty;
        expect(q.hint, q.id).to.be.a('string').and.not.empty;
      }
    });
  });

  describe('THE CLAMP — no preview means not translated', () => {
    /*
     * The single most load-bearing rule in the file. Nothing ever clears a status
     * column, so without the clamp a page that was translated, judged and then
     * withdrawn from preview reads `autoQaPass` forever — the board's most advanced
     * numbers would be its least trustworthy ones.
     */
    it('drops auto-qa-ok back to the English stage when nothing is previewed', () => {
      const row = enRow();
      const clamped = classifyTranslation(row, locRow({ 'translation-status': 'auto-qa-ok' }));

      expect(clamped.stage).to.equal(classifyEnglish(row).stage);
      expect(clamped.stage).to.equal('enPublished');
      expect(clamped.order).to.equal(STAGE_INDEX.enPublished);
      expect(clamped.blocked).to.be.false;
    });

    it('warns, naming the preview host, rather than clamping silently', () => {
      const { warnings } = classifyTranslation(enRow(), locRow({ 'translation-status': 'auto-qa-ok' }));
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.match(/preview host/);
      expect(warnings[0]).to.contain('auto-qa-ok');
    });

    it('is what moved the pair — the same row previewed reads autoQaPass', () => {
      const previewed = locRow({ 'translation-status': 'auto-qa-ok', previewed: 'yes' });
      const result = classifyTranslation(enRow(), previewed);
      expect(result.stage).to.equal('autoQaPass');
      expect(result.warnings).to.deep.equal([]);
    });

    it('still reports a pair legitimately in flight as sent, with no warning', () => {
      const inFlight = classifyTranslation(enRow(), locRow({ 'translation-status': 'sent' }));
      expect(inFlight.stage).to.equal('sentForTranslation');
      expect(inFlight.warnings).to.deep.equal([]);
    });
  });

  describe('THE UNGATED GUARD — a status without en-published is not progress', () => {
    it('does not count a previewed translation on an unpublished EN page as sent', () => {
      const row = enRow({ 'en-status': 'draft' });
      const result = classifyTranslation(row, locRow({ 'translation-status': 'preview-ok', previewed: 'yes' }));

      // Falls back to where the ENGLISH page actually is, not to a translation stage.
      expect(result.stage).to.equal(classifyEnglish(row).stage);
      expect(result.stage).to.equal('catalogued');
      expect(result.order).to.equal(STAGE_INDEX.catalogued);
      expect(result.blocked).to.be.false;
    });

    it('warns, because an ungated status inflates the only number anyone reads', () => {
      const row = enRow({ 'en-status': 'draft' });
      const { warnings } = classifyTranslation(row, locRow({ 'translation-status': 'preview-ok', previewed: 'yes' }));
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.contain('not counted as sent');
      expect(warnings[0]).to.contain('preview-ok');
    });

    it('lets the same pair through once EN is published', () => {
      const gated = classifyTranslation(enRow(), locRow({ 'translation-status': 'preview-ok', previewed: 'yes' }));
      expect(gated.stage).to.equal('previewed');
      expect(gated.warnings).to.deep.equal([]);
    });
  });

  describe('a human verdict outranks the pipeline', () => {
    it('blocks a visual-qa-ok pair the reviewer sent back for retranslation', () => {
      const localeRow = locRow({
        'translation-status': 'visual-qa-ok',
        'review-status': 'needs-retranslation',
        previewed: 'yes',
      });
      const result = classifyTranslation(enRow(), localeRow);

      expect(result.blocked).to.be.true;
      expect(result.stage).to.be.null;
      expect(result.order).to.equal(-1);
      expect(result.queues).to.deep.equal(['retranslate']);
    });

    it('sends every human blocker to the queue its enum declares', () => {
      for (const s of REVIEW_STATUSES.filter((r) => r.queue)) {
        const result = classifyTranslation(enRow(), locRow({ 'review-status': s.value, previewed: 'yes' }));
        expect(result.queues, s.value).to.deep.equal([s.queue]);
        expect(result.blocked, s.value).to.be.true;
      }
    });

    it('reads TRANSLATION OK as online when the live host answers', () => {
      const result = classifyTranslation(enRow(), locRow({
        'review-status': 'TRANSLATION OK',
        previewed: 'yes',
        online: 'yes',
      }));
      expect(result.stage).to.equal('online');
      expect(result.order).to.equal(STAGE_INDEX.online);
    });

    it('reads TRANSLATION OK as reviewOk when it does not', () => {
      const result = classifyTranslation(enRow(), locRow({
        'review-status': 'TRANSLATION OK',
        previewed: 'yes',
      }));
      expect(result.stage).to.equal('reviewOk');
      expect(result.order).to.equal(STAGE_INDEX.reviewOk);
    });

    it('matches the stored verdict case-insensitively', () => {
      // The stored value is literally `TRANSLATION OK`, but a human hand-edits the
      // review document in DA's rich-text editor, so casing arrives as it arrives.
      for (const v of ['TRANSLATION OK', 'Translation OK', 'translation ok']) {
        const result = classifyTranslation(enRow(), locRow({ 'review-status': v, previewed: 'yes' }));
        expect(result.stage, v).to.equal('reviewOk');
        expect(result.warnings, v).to.deep.equal([]);
      }
    });
  });

  describe('content-escalation coexists with EVERY exit path', () => {
    /*
     * In the tracker this is ported from the flag was appended only on the
     * fall-through path, so the early returns dropped it — and the pages furthest
     * along, the ones it matters most for, were exactly the ones that lost it. Hence
     * a sweep over every distinct exit rather than an illustrative case or two.
     */
    for (const [name, row, localeRow] of EXITS) {
      it(`carries the flag out of the "${name}" exit`, () => {
        const plain = classifyTranslation(row, localeRow);
        const flagged = classifyTranslation(flag(row), localeRow);

        expect(flagged.queues).to.include('content-escalation');
        expect(plain.queues).to.not.include('content-escalation');
        // The flag adds a queue and changes NOTHING else about the classification.
        expect(flagged.stage).to.equal(plain.stage);
        expect(flagged.order).to.equal(plain.order);
        expect(flagged.blocked).to.equal(plain.blocked);
        expect(flagged.warnings).to.deep.equal(plain.warnings);
        // Any queue the unflagged row had is preserved, not replaced.
        for (const q of plain.queues) expect(flagged.queues).to.include(q);
        expect(flagged.queues.filter((q) => q === 'content-escalation')).to.have.length(1);
      });
    }

    it('survives the sign-off path, the one the original lost it on', () => {
      const signedOff = classifyTranslation(
        flag(enRow()),
        locRow({ 'review-status': 'TRANSLATION OK', previewed: 'yes' }),
      );
      expect(signedOff.stage).to.equal('reviewOk');
      expect(signedOff.queues).to.deep.equal(['content-escalation']);
      expect(signedOff.blocked).to.be.false;
    });

    it('never removes a pair from the funnel on its own', () => {
      const result = classifyTranslation(flag(enRow()), locRow({
        'translation-status': 'visual-qa-ok',
        previewed: 'yes',
      }));
      expect(result.blocked).to.be.false;
      expect(result.stage).to.equal('layoutQaPass');
    });
  });

  describe('THE REGRESSION GUARD — translationStage / translationOrder', () => {
    /*
     * classifyTranslation deliberately lets a human verdict win, so both rows below
     * classify identically as `inReview`. A writer that asks classify() "would this
     * write move the pair backwards?" therefore compares two identical answers and
     * concludes every write is safe. That is exactly how a reconcile silently moved 33
     * rows from layout-QA-passed back to auto-QA-passed in the tracker this is ported
     * from: all 33 carried `ready-for-review`. Any writer claiming to prevent
     * regressions must ask translationOrder, which ignores review-status entirely.
     */
    it('orders visual-qa-ok above auto-qa-ok even when both rows read ready-for-review', () => {
      const ready = { 'review-status': 'ready-for-review', previewed: 'yes' };
      const behind = classifyTranslation(enRow(), locRow({ ...ready, 'translation-status': 'auto-qa-ok' }));
      const ahead = classifyTranslation(enRow(), locRow({ ...ready, 'translation-status': 'visual-qa-ok' }));

      // classify() cannot tell the two rows apart...
      expect(behind.stage).to.equal('inReview');
      expect(ahead.stage).to.equal(behind.stage);
      expect(ahead.order).to.equal(behind.order);

      // ...but the guard can, which is the whole reason it exists.
      expect(translationOrder('visual-qa-ok')).to.be.greaterThan(translationOrder('auto-qa-ok'));
      expect(translationStage('visual-qa-ok')).to.equal('layoutQaPass');
      expect(translationStage('auto-qa-ok')).to.equal('autoQaPass');
    });

    it('answers on the status string alone, trimmed and case-folded', () => {
      expect(translationStage(' Visual-QA-OK ')).to.equal('layoutQaPass');
      expect(translationStage('sent')).to.equal('sentForTranslation');
      // A blank is the pre-send position on the funnel, not a missing answer.
      expect(translationStage('')).to.equal('enPublished');
      expect(translationOrder('')).to.equal(STAGE_INDEX.enPublished);
    });

    it('implies no stage for a blocker or a junk value', () => {
      for (const v of ['auto-qa-fail', 'send-fail', 'preview-missing', 'nonsense']) {
        expect(translationStage(v), v).to.be.null;
        expect(translationOrder(v), v).to.equal(-1);
      }
    });

    it('agrees with the funnel it is guarding', () => {
      for (const s of TRANSLATION_STATUSES) {
        const stage = translationStage(s.value);
        const expected = stage ? STAGE_INDEX[stage] : -1;
        expect(translationOrder(s.value), s.value || '(blank)').to.equal(expected);
      }
    });
  });

  describe('isSendable — the one irreversible step', () => {
    it('requires an explicit en-published', () => {
      // Never a derived default: a page that merely looks published (the crawl saw a
      // 200 once) must not be sent on that basis, because sending costs money and
      // cannot be undone.
      expect(isSendable({ 'en-status': 'en-published' }, {})).to.be.true;
      for (const en of ['', 'draft', 'en-previewed']) {
        expect(isSendable({ 'en-status': en }, {}), en || '(blank)').to.be.false;
      }
      expect(isSendable({}, {})).to.be.false;
      expect(isSendable(null, null)).to.be.false;
    });

    it('excludes a pair the pipeline already worked, so nothing is sent twice', () => {
      for (const tx of ['sent', 'preview-ok', 'auto-qa-ok', 'send-fail', 'preview-missing']) {
        expect(isSendable({ 'en-status': 'en-published' }, { 'translation-status': tx }), tx).to.be.false;
      }
    });
  });

  describe('countsAsPage', () => {
    it('excludes drafts and sandboxes, in every locale tree', () => {
      for (const p of ['/en/drafts/x', '/en/sandbox/x', '/de/drafts/x', '/zh-cn/sandbox/deep/x']) {
        expect(countsAsPage({ 'page-path': p }), p).to.be.false;
      }
    });

    it('INCLUDES /en/fragments/bios/** and excludes every other fragment', () => {
      // A deliberate difference from the tracker this is ported from, which excluded
      // all fragments: bios are a tracked group here, so they are translated and they
      // are countable pages.
      expect(countsAsPage({ 'page-path': '/en/fragments/bios/ada-lovelace' })).to.be.true;
      expect(countsAsPage({ 'page-path': '/de/fragments/bios/ada-lovelace' })).to.be.true;
      for (const p of ['/en/fragments/nav', '/en/fragments/footer/legal', '/ja/fragments/nav']) {
        expect(countsAsPage({ 'page-path': p }), p).to.be.false;
      }
    });

    it('counts an ordinary page', () => {
      expect(countsAsPage({ 'page-path': '/en/meetups/berlin' })).to.be.true;
      expect(countsAsPage({ 'page-path': '/zh-tw/meetups/berlin' })).to.be.true;
    });

    it('does not count a row with a blank page-path', () => {
      // A blank path is a scaffold placeholder da.live leaves behind, not a page.
      expect(countsAsPage({ 'page-path': '' })).to.be.false;
      expect(countsAsPage({ 'page-path': '   ' })).to.be.false;
      expect(countsAsPage({})).to.be.false;
      expect(countsAsPage(null)).to.be.false;
    });
  });

  describe('tally', () => {
    const pairs = [
      {
        row: enRow({ 'page-path': '/en/a' }),
        localeRow: locRow({ 'translation-status': 'visual-qa-ok', previewed: 'yes' }),
      },
      {
        row: enRow({ 'page-path': '/en/b' }),
        localeRow: locRow({ 'review-status': 'needs-retranslation' }),
      },
      {
        row: enRow({ 'page-path': '/en/c', 'en-status': '' }),
        localeRow: locRow(),
      },
      {
        row: flag(enRow({ 'page-path': '/en/d' })),
        localeRow: locRow({ 'review-status': 'TRANSLATION OK', previewed: 'yes', online: 'yes' }),
      },
      {
        row: enRow({ 'page-path': '' }),
        localeRow: locRow({ 'translation-status': 'sent' }),
      },
      {
        row: enRow({ 'page-path': '/en/drafts/e' }),
        localeRow: locRow(),
      },
    ];

    it('sums stages plus blocked to `counted`', () => {
      const t = tally(pairs);
      expect(sum(t.stages)).to.equal(t.counted);
      expect(t.stages.blocked).to.equal(1);
    });

    it('sums buckets to `counted` minus the blocked pairs', () => {
      // Blocked pairs are off the line entirely — inventory, not progress — so the
      // bands must not silently absorb them.
      const t = tally(pairs);
      expect(sum(t.buckets)).to.equal(t.counted - t.stages.blocked);
    });

    it('does not count a row with a blank page-path, but keeps it in `total`', () => {
      const t = tally(pairs);
      expect(t.total).to.equal(pairs.length);
      expect(t.counted).to.equal(pairs.length - 2); // the blank path and the draft
    });

    it('counts a queue that coexists with a stage', () => {
      const t = tally(pairs);
      expect(t.queues['content-escalation']).to.equal(1);
      expect(t.queues.retranslate).to.equal(1);
      expect(t.buckets.online).to.equal(1);
      expect(t.buckets.autoQa).to.equal(1);
    });

    it('reports each warning against the pair that produced it', () => {
      const t = tally([{
        row: enRow({ 'page-path': '/en/a' }),
        localeRow: locRow({ 'translation-status': 'auto-qa-ok' }),
      }]);
      expect(t.warnings).to.have.length(1);
      expect(t.warnings[0].path).to.equal('/en/a');
      expect(t.warnings[0].locale).to.equal('de');
      expect(t.warnings[0].warning).to.match(/preview host/);
    });

    it('returns zeroed accumulators for no pairs at all', () => {
      const t = tally([]);
      expect(t.total).to.equal(0);
      expect(t.counted).to.equal(0);
      expect(sum(t.stages)).to.equal(0);
      expect(sum(t.buckets)).to.equal(0);
      expect(sum(t.queues)).to.equal(0);
    });
  });

  describe('REVIEW_STATUS_RE', () => {
    it('matches the LONGEST marker, so NEEDS TERMINOLOGY FIX is not read as OK', () => {
      /*
       * JavaScript alternation is FIRST-match, not longest-match. A regex offering
       * `OK` before `NEEDS TERMINOLOGY FIX` would match the shorter marker on any text
       * where both could apply, and the reviewer's verdict would round-trip as the
       * opposite of itself. The alternation is sorted longest-first for that reason.
       */
      const text = 'TRANSLATION STATUS: NEEDS TERMINOLOGY FIX';
      expect(REVIEW_STATUS_RE.exec(text)[1]).to.equal('NEEDS TERMINOLOGY FIX');
      expect(reviewStatusFromDocText(text)).to.equal('needs-terminology-fix');
      expect(reviewStatusFromDocText(text)).to.not.equal('TRANSLATION OK');
    });

    it('offers its alternatives longest-first, so a new marker cannot regress it', () => {
      // The FIRST parenthesised run with no nested parens, so the trailing
      // `(?![A-Za-z])` boundary group cannot be swallowed into the capture and read as
      // a seventh, longer alternative. A greedy `/\((.+)\)/` did exactly that.
      const alternatives = /\(([^()]+)\)/.exec(REVIEW_STATUS_RE.source)[1].split('|');
      const lengths = alternatives.map((a) => a.length);
      expect(alternatives).to.have.length(REVIEW_DOC_MARKERS.length);
      expect([...lengths].sort((a, b) => b - a)).to.deep.equal(lengths);
    });

    it('round-trips every marker in the table', () => {
      for (const { status, marker } of REVIEW_DOC_MARKERS) {
        expect(reviewStatusFromDocText(`TRANSLATION STATUS: ${marker}`), marker).to.equal(status);
      }
    });

    it('returns null when there is no marker at all', () => {
      // null, not '' — "the document says nothing" and "the document says pending"
      // are different facts, and only one of them should overwrite a sheet.
      expect(reviewStatusFromDocText('a document with no verdict in it')).to.be.null;
      expect(reviewStatusFromDocText('')).to.be.null;
    });
  });

  describe('sheetRows', () => {
    it('tolerates both DA sheet shapes', () => {
      // A single-sheet doc carries `{ data: [...] }`; a multi-sheet doc carries
      // `{ <name>: { data: [...] }, ':names': [...] }`. Every reader goes through here
      // so neither shape needs handling twice.
      expect(sheetRows({ data: [{ 'page-path': '/en/a' }] })).to.have.length(1);
      expect(sheetRows({ data: { data: [{}, {}] }, ':names': ['data', 'de'] })).to.have.length(2);
      expect(sheetRows({ de: { data: [{}] }, ':names': ['data', 'de'] }, 'de')).to.have.length(1);
    });

    it('returns an empty array for a missing tab or a missing doc', () => {
      expect(sheetRows({ data: [{}] }, 'de')).to.deep.equal([]);
      expect(sheetRows({ data: { data: [{}] } }, 'fr')).to.deep.equal([]);
      expect(sheetRows(null)).to.deep.equal([]);
      expect(sheetRows(undefined, 'de')).to.deep.equal([]);
    });
  });

  describe('indexLocaleRows / localeRowFor', () => {
    const doc = {
      ':names': ['data', 'de', 'ja'],
      data: { data: [enRow({ 'page-path': '/en/meetups/berlin' })] },
      de: {
        data: [{
          'page-path': '/en/meetups/berlin/',
          'locale-path': '/de/meetups/berlin',
          locale: 'de',
          'translation-status': 'sent',
        }],
      },
      ja: {
        data: [{
          'page-path': '/en/meetups/berlin',
          'locale-path': '/ja/meetups/berlin',
          locale: 'ja',
          'translation-status': 'auto-qa-ok',
        }],
      },
    };

    it('joins a data row to its locale row', () => {
      const index = indexLocaleRows(doc);
      expect(localeRowFor(index, '/en/meetups/berlin', 'de')['translation-status']).to.equal('sent');
      expect(localeRowFor(index, '/en/meetups/berlin', 'ja')['translation-status']).to.equal('auto-qa-ok');
    });

    it('joins across the two spellings of one path', () => {
      // The `de` row above is stored with a trailing slash. Both sides normalize, so
      // the two spellings cannot become two rows for one page.
      const index = indexLocaleRows(doc);
      expect(localeRowFor(index, '/en/meetups/berlin/', 'de')['translation-status']).to.equal('sent');
    });

    it('indexes locale tabs only, never the data tab', () => {
      const index = indexLocaleRows(doc);
      expect(index.size).to.equal(2);
    });

    it('keys on a separator that cannot appear in a path', () => {
      // A delimiter a path could contain is a silent key collision, so the key is
      // joined with NUL.
      const index = indexLocaleRows(doc);
      for (const key of index.keys()) expect(key).to.contain('\u0000');
    });

    it('returns {} for a miss, never undefined', () => {
      const index = indexLocaleRows(doc);
      expect(localeRowFor(index, '/en/meetups/berlin', 'fr')).to.deep.equal({});
      expect(localeRowFor(index, '/en/nothing/here', 'de')).to.deep.equal({});
      expect(localeRowFor(new Map(), '/en/meetups/berlin', 'de')).to.deep.equal({});
    });

    it('skips a locale row with no page-path', () => {
      const index = indexLocaleRows({ de: { data: [{ locale: 'de' }, { 'page-path': '/en/a' }] } });
      expect(index.size).to.equal(1);
      expect(localeRowFor(index, '/en/a', 'de')).to.deep.equal({ 'page-path': '/en/a' });
    });
  });
  /*
   * ─── THE MARKER BOUNDARY ──────────────────────────────────────────────────────
   *
   * Both marker regexes used to have no trailing boundary, so the alternation matched
   * a marker that was merely a PREFIX of what a human typed. Both failures pointed the
   * dangerous way: `TRANSLATION STATUS: OKAY` read as a sign-off nobody gave, and
   * `CONTENT ESCALATION: NOPE` read as an escalation somebody had cleared.
   */
  describe('a marker must end where the vocabulary ends', () => {
    it('does not read a longer word as the marker it starts with', () => {
      expect(reviewStatusFromDocText('TRANSLATION STATUS: OKAY')).to.equal(null);
      expect(reviewStatusFromDocText('TRANSLATION STATUS: READY FOR REVIEWING')).to.equal(null);
      expect(reviewStatusFromDocText('TRANSLATION STATUS: NEEDS TERMINOLOGY FIXES')).to.equal(null);
    });

    it('still reads a marker a reviewer appended prose to', () => {
      // Reviewers annotate these lines. Forbidding that would get the line rewritten
      // by hand into something no reader can parse at all.
      expect(reviewStatusFromDocText('TRANSLATION STATUS: OK — check the date')).to.equal('TRANSLATION OK');
      expect(reviewStatusFromDocText('TRANSLATION STATUS: OK.')).to.equal('TRANSLATION OK');
    });

    it('does not let NOPE clear a content escalation', () => {
      expect(CONTENT_ESCALATION_RE.test('CONTENT ESCALATION: NOPE')).to.equal(false);
      expect(CONTENT_ESCALATION_RE.test('CONTENT ESCALATION: YESTERDAY')).to.equal(false);
      expect(CONTENT_ESCALATION_RE.exec('CONTENT ESCALATION: NO (fixed)')[1]).to.equal('NO');
      expect(CONTENT_ESCALATION_RE.exec('CONTENT ESCALATION: YES')[1]).to.equal('YES');
    });

    it('keeps "unparseable" distinct from "pending"', () => {
      // '' is the real value of the PENDING marker, so an unknown marker cannot also
      // be '' — that would bucket a data-quality problem as ordinary not-yet-reviewed.
      expect(reviewStatusFromMarker('PENDING')).to.equal('');
      expect(reviewStatusFromMarker('BOGUS')).to.equal(null);
      expect(reviewStatusFromMarker('')).to.equal(null);
    });
  });

  /*
   * ─── THE CLAMP CLAMPS THE STAGE, NOT THE QUEUE ────────────────────────────────
   *
   * Step 4 used to name `send-fail` alone, so the other six blockers fell through to
   * the English fallback and came back `{stage:'enPublished', queues:[], blocked:false}`
   * with no warning — the queue, the blocked flag and every trace that a human owed an
   * answer disappeared, for exactly the pairs where something had already gone wrong.
   */
  describe('a pipeline blocker keeps its queue when the page is not previewed', () => {
    const blockers = TRANSLATION_STATUSES.filter((s) => s.queue);

    it('has blockers to test', () => {
      expect(blockers.length).to.be.greaterThan(2);
    });

    blockers.forEach(({ value, queue }) => {
      it(`keeps "${queue}" for ${value} with nothing on preview`, () => {
        const r = classifyTranslation(enRow(), locRow({ 'translation-status': value, previewed: '' }));
        expect(r.queues, value).to.contain(queue);
        expect(r.blocked, value).to.equal(true);
        expect(r.stage, value).to.equal(null);
      });
    });

    it('warns about a judged verdict on a page that answers nothing', () => {
      // The pipeline could only have said this by reading the page off preview, so
      // its absence now means withdrawn-or-stale and a human should see that.
      const r = classifyTranslation(enRow(), locRow({ 'translation-status': 'visual-qa-fail', previewed: '' }));
      expect(r.warnings.join(' ')).to.match(/preview host/);
    });

    it('does NOT warn for send-fail, where nothing on preview is the definition', () => {
      const r = classifyTranslation(enRow(), locRow({ 'translation-status': 'send-fail', previewed: '' }));
      expect(r.queues).to.deep.equal(['send-issues']);
      expect(r.warnings).to.deep.equal([]);
    });
  });

  /*
   * ─── ONE READING OF en-status ─────────────────────────────────────────────────
   *
   * The gates compared the cell raw while `classifyEnglish` folded case, so a
   * hand-typed `EN-Published` classified as stage `enPublished` on the board while
   * `classifyTranslation` warned "en-status is not en-published" about the same row.
   */
  describe('en-status is read the same way everywhere', () => {
    ['en-published', 'EN-Published', 'EN-PUBLISHED', ' en-published '].forEach((raw) => {
      it(`agrees about ${JSON.stringify(raw)}`, () => {
        const row = enRow({ 'en-status': raw });
        expect(passedSendGate(row), 'passedSendGate').to.equal(true);
        expect(isSendable(row, locRow()), 'isSendable').to.equal(true);
        const en = classifyEnglish(row);
        expect(en.stage, 'classifyEnglish').to.equal('enPublished');
        expect(en.warnings, 'no unknown-status warning').to.deep.equal([]);
        const tx = classifyTranslation(row, locRow({ 'translation-status': 'auto-qa-ok', previewed: 'yes' }));
        expect(tx.warnings.join(' '), 'no ungated warning').to.not.match(/not en-published/);
      });
    });

    it('still refuses a value that is not en-published', () => {
      expect(passedSendGate(enRow({ 'en-status': 'draft' }))).to.equal(false);
      expect(passedSendGate(enRow({ 'en-status': 'en-previewed' }))).to.equal(false);
      expect(passedSendGate(enRow({ 'en-status': '' }))).to.equal(false);
    });
  });
});
