import { expect } from '@esm-bundle/chai';
import {
  applyPipelineStatus,
  applyReviewVerdict,
  applyTierFindings,
  buildTxDocHtml,
  docOutsideFindings,
  EMPTY_ISSUE,
  LOG_SECTION,
  markerLineText,
  MARKER_LABEL,
  readTxDoc,
  REVIEW_STATUS_KEY,
  serializeTxDoc,
  TIER_SECTIONS,
} from '../../../scripts/tracker/tx-doc.js';
import {
  docMarkerFor,
  REVIEW_DOC_MARKERS,
  REVIEW_STATUS_RE,
  reviewStatusFromMarker,
} from '../../../scripts/tracker/stages.js';

/*
 * The doc model takes a Document from its caller so the same code runs in the DA app
 * and in Node (see scripts/tracker/README.md). These tests run in a real browser
 * under web-test-runner, so DOMParser is the caller here; the Node side passes jsdom.
 */
const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

const fresh = (over = {}) => parse(buildTxDocHtml({
  title: 'Meetup Berlin 2026',
  locale: 'de',
  enUrl: 'https://main--aemdev--aemgdc.aem.page/en/meetups/berlin-2026',
  localeUrl: 'https://main--aemdev--aemgdc.aem.page/de/meetups/berlin-2026',
  editUrl: 'https://da.live/edit#/aemgdc/aemdev/tracker/tx/de/meetups/berlin-2026',
  ...over,
}));

/*
 * A doc in the shape the pipeline scaffolded before the metadata block existed: a
 * valid, readable verdict and no machine mirror. This is `legacy`, NOT `mismatch` —
 * the source repo had ~584 documents in exactly this state, and reporting every one
 * of them as inconsistent buried the handful that really were.
 */
const LEGACY_DOC = `<body><header></header><main><div>
  <h1>German review — Meetup Berlin 2026</h1>
  <p><em>English: <a href="https://example.invalid/en">en</a></em></p>
  <p><strong>TRANSLATION STATUS: READY FOR REVIEW</strong></p>
  <h2>Preview Check</h2><ul><li><em>No findings yet</em></li></ul>
  <h2>Translation Findings</h2><ul><li>Heading 3 is still English</li></ul>
</div></main><footer></footer></body>`;

describe('tx-doc.js', () => {
  describe('the marker line', () => {
    it('writes a line stages.js can read back — the two must not drift', () => {
      for (const { status } of REVIEW_DOC_MARKERS) {
        const line = markerLineText(status);
        const match = REVIEW_STATUS_RE.exec(line);
        expect(match, `stages.js did not match ${JSON.stringify(line)}`).to.not.be.null;
        expect(reviewStatusFromMarker(match[1])).to.equal(status);
      }
    });

    it('uses the label stages.js expects', () => {
      expect(REVIEW_STATUS_RE.source).to.contain(MARKER_LABEL);
    });

    it('never lets a short marker shadow a longer one containing it', () => {
      // JavaScript alternation is first-match, not longest-match: an `OK` offered
      // before `NEEDS TERMINOLOGY FIX` would win against it.
      expect(REVIEW_STATUS_RE.exec(markerLineText('needs-terminology-fix'))[1])
        .to.equal('NEEDS TERMINOLOGY FIX');
      expect(REVIEW_STATUS_RE.exec(markerLineText('TRANSLATION OK'))[1]).to.equal('OK');
    });

    it('falls back to PENDING rather than guessing at an unknown status', () => {
      expect(markerLineText('who-knows')).to.equal(`${MARKER_LABEL}: PENDING`);
    });

    it('does not read a mistyped marker as the shorter marker it starts with', () => {
      // stages.js's alternation has no trailing boundary, so `OKAY` matches the `OK`
      // alternative. Reporting a sign-off nobody gave is the worst failure this file
      // could produce, because nothing downstream has any reason to doubt it.
      const read = readTxDoc(parse(`<body><main><div><h1>German review — X</h1>
        <p><strong>${MARKER_LABEL}: OKAY</strong></p></div></main></body>`));
      expect(read.markerUnknown).to.be.true;
      expect(read.status).to.be.null;
    });

    it('still reads a marker a reviewer wrote a comment after', () => {
      // A parser that demands an exact value is the brittleness the requirements
      // brief already suffers from; only a letter immediately after disqualifies it.
      const read = readTxDoc(parse(`<body><main><div><h1>German review — X</h1>
        <p><strong>${MARKER_LABEL}: OK — but check the date</strong></p></div></main></body>`));
      expect(read.status).to.equal('TRANSLATION OK');
      expect(read.markerUnknown).to.be.false;
    });
  });

  describe('a freshly scaffolded doc', () => {
    it('round-trips every field it was built with', () => {
      const doc = fresh({
        reviewStatus: 'ready-for-review',
        translationStatus: 'auto-qa-ok',
        sentAt: '2026-08-01T09:00:00Z',
      });
      const read = readTxDoc(doc);
      expect(read.title).to.equal('German review — Meetup Berlin 2026');
      expect(read.locale).to.equal('de');
      expect(read.marker).to.equal('READY FOR REVIEW');
      expect(read.status).to.equal('ready-for-review');
      expect(read.metaStatus).to.equal('ready-for-review');
      expect(read.translationStatus).to.equal('auto-qa-ok');
      expect(read.sentAt).to.equal('2026-08-01T09:00:00Z');
      expect(read.legacy).to.be.false;
      expect(read.mismatch).to.be.false;
      expect(read.markerUnknown).to.be.false;
    });

    it('names the locale from the registry, so ten scaffolders spell it one way', () => {
      expect(readTxDoc(fresh({ locale: 'zh-cn' })).title)
        .to.equal('Chinese (Simplified) review — Meetup Berlin 2026');
    });

    it('reads a blank verdict as PENDING — "" is a real status, absence is not', () => {
      const read = readTxDoc(fresh());
      expect(read.marker).to.equal('PENDING');
      expect(read.status).to.equal('');
      expect(read.hasMarker).to.be.true;
    });

    it('carries all three tier sections, empty, with no findings read back', () => {
      const read = readTxDoc(fresh());
      expect(Object.keys(read.findings)).to.deep.equal(TIER_SECTIONS);
      for (const section of TIER_SECTIONS) {
        expect(read.findings[section], section).to.deep.equal([]);
      }
      expect(read.notes).to.deep.equal([]);
      expect(read.log).to.deep.equal([]);
    });

    it('leaves out a link it was not given rather than writing a dangling label', () => {
      const html = buildTxDocHtml({ title: 'X', locale: 'fr' });
      expect(html).to.not.contain('DA Edit');
      expect(html).to.not.contain('<a href="">');
    });
  });

  describe('recording a verdict', () => {
    it('round-trips through build -> verdict -> serialize -> parse -> read', () => {
      const doc = fresh();
      applyReviewVerdict(doc, {
        reviewStatus: 'TRANSLATION OK',
        actor: 'reviewer@example.com',
        note: 'Terminology checked against the glossary.',
        at: '2026-08-20T10:00:00Z',
      });
      const read = readTxDoc(parse(serializeTxDoc(doc)));
      expect(read.marker).to.equal('OK');
      expect(read.status).to.equal('TRANSLATION OK');
      expect(read.metaStatus).to.equal('TRANSLATION OK');
      expect(read.actor).to.equal('reviewer@example.com');
      expect(read.updated).to.equal('2026-08-20T10:00:00Z');
      expect(read.notes).to.deep.equal(['Terminology checked against the glossary.']);
      expect(read.mismatch).to.be.false;
    });

    it('writes the visible line and the metadata together, never one of them', () => {
      const doc = fresh();
      applyReviewVerdict(doc, { reviewStatus: 'needs-layout-fix', at: 'x' });
      const line = [...doc.querySelectorAll('strong')]
        .map((el) => el.textContent)
        .find((t) => t.startsWith(MARKER_LABEL));
      expect(line).to.equal(`${MARKER_LABEL}: NEEDS LAYOUT FIX`);
      expect(readTxDoc(doc).metadata[REVIEW_STATUS_KEY]).to.equal('needs-layout-fix');
    });

    it('keeps the marker line bold instead of flattening it', () => {
      // The line element must be the innermost match: rewriting the <p> would throw
      // the <strong> away and un-bold the one line a reviewer looks for.
      const doc = fresh();
      applyReviewVerdict(doc, { reviewStatus: 'ready-for-review', at: 'x' });
      expect(serializeTxDoc(doc)).to.contain(`<strong>${MARKER_LABEL}: READY FOR REVIEW</strong>`);
    });

    it('puts the marker line back above the sections when a human deleted it', () => {
      const doc = parse(`<body><main><div>
        <h1>German review — X</h1>
        <h2>Reviewer Notes</h2><ul><li>keep me</li></ul>
      </div></main></body>`);
      applyReviewVerdict(doc, { reviewStatus: 'TRANSLATION OK', at: 'x' });
      const root = doc.querySelector('main > div');
      const tags = [...root.children].map((el) => el.tagName);
      expect(tags.indexOf('P')).to.be.lessThan(tags.indexOf('H2'));
      expect(readTxDoc(doc).notes).to.deep.equal(['keep me']);
    });

    it('corrects a mistyped marker in place instead of adding a second line', () => {
      // Located by label, interpreted by the vocabulary regex. If it were located by
      // the vocabulary regex, this line would be invisible to the writer and the doc
      // would end up carrying two contradictory verdicts.
      const doc = parse(`<body><main><div>
        <h1>German review — X</h1>
        <p><strong>TRANSLATION STATUS: OKAY</strong></p>
        <h2>Preview Check</h2><ul><li><em>No findings yet</em></li></ul>
      </div></main></body>`);
      expect(readTxDoc(doc).markerUnknown).to.be.true;
      expect(readTxDoc(doc).status).to.be.null;
      applyReviewVerdict(doc, { reviewStatus: 'TRANSLATION OK', at: 'x' });
      const lines = serializeTxDoc(doc).match(new RegExp(`${MARKER_LABEL}:`, 'g'));
      expect(lines).to.have.lengthOf(1);
      expect(readTxDoc(doc).status).to.equal('TRANSLATION OK');
    });
  });

  describe('the append-only log', () => {
    it('does not lose the first verdict when a second is appended', () => {
      const doc = fresh();
      applyReviewVerdict(doc, {
        reviewStatus: 'needs-retranslation', actor: 'ana', note: 'Section 2 is machine soup.', at: 'T1',
      });
      applyReviewVerdict(doc, {
        reviewStatus: 'TRANSLATION OK', actor: 'bo', note: 'Re-translated; reads well now.', at: 'T2',
      });
      const read = readTxDoc(doc);
      expect(read.log).to.deep.equal([
        'NEEDS RETRANSLATION — ana — T1',
        'OK — bo — T2',
      ]);
      // The verdict itself is single-valued: the latest one wins, in both places.
      expect(read.status).to.equal('TRANSLATION OK');
      expect(read.metaStatus).to.equal('TRANSLATION OK');
      // The notes are the reviewer's current statement, not an accumulating log.
      expect(read.notes).to.deep.equal(['Re-translated; reads well now.']);
    });

    it('drops the placeholder rather than reading it back as an entry', () => {
      const doc = fresh();
      applyReviewVerdict(doc, { reviewStatus: 'ready-for-review', note: '', at: 'T1' });
      const read = readTxDoc(doc);
      expect(read.notes).to.deep.equal([]);
      expect(read.log).to.deep.equal(['READY FOR REVIEW — T1']);
      expect(serializeTxDoc(doc)).to.contain('No notes yet');
    });

    it('puts a section created late back in order, not below the log', () => {
      // A section appended at the end of the doc lands under the append-only audit
      // trail — the last thing anyone reads, so effectively invisible.
      const doc = fresh();
      applyReviewVerdict(doc, { reviewStatus: 'ready-for-review', at: 'T1' });
      const stripped = parse(serializeTxDoc(doc));
      const gone = [...stripped.querySelectorAll('h2')]
        .find((h) => h.textContent === 'Preview Check');
      gone.nextElementSibling.remove();
      gone.remove();

      applyTierFindings(stripped, { 'Preview Check': ['Still English'] });
      expect([...stripped.querySelectorAll('h2')].map((h) => h.textContent)).to.deep.equal([
        ...TIER_SECTIONS, 'Reviewer Notes', LOG_SECTION,
      ]);
      expect(readTxDoc(stripped).findings['Preview Check']).to.deep.equal(['Still English']);
      expect(readTxDoc(stripped).log).to.deep.equal(['READY FOR REVIEW — T1']);
    });
  });

  describe('precedence between the visible line and the metadata', () => {
    it('lets the visible line win — it is what a human edits', () => {
      const doc = fresh({ reviewStatus: 'ready-for-review' });
      // A reviewer hand-edits the line in DA and never opens the metadata block.
      const el = [...doc.querySelectorAll('strong')]
        .find((n) => n.textContent.startsWith(MARKER_LABEL));
      el.textContent = `${MARKER_LABEL}: OK`;
      const read = readTxDoc(doc);
      expect(read.status).to.equal('TRANSLATION OK');
      expect(read.metaStatus).to.equal('ready-for-review');
      expect(read.mismatch).to.be.true;
      expect(read.legacy).to.be.false;
    });

    it('falls back to the metadata when the line is gone, without calling it a mismatch', () => {
      const doc = fresh({ reviewStatus: 'needs-terminology-fix' });
      [...doc.querySelectorAll('p')]
        .filter((p) => p.textContent.startsWith(MARKER_LABEL))
        .forEach((p) => p.remove());
      const read = readTxDoc(doc);
      expect(read.hasMarker).to.be.false;
      expect(read.status).to.equal('needs-terminology-fix');
      expect(read.mismatch).to.be.false;
    });

    it('does not report a case-only difference as a disagreement', () => {
      // `TRANSLATION OK` is a literal uppercase-with-space stored value that every
      // other reader matches via toLowerCase(); a hand-typed cell is not a conflict.
      const doc = fresh({ reviewStatus: 'translation ok' });
      const read = readTxDoc(doc);
      expect(read.marker).to.equal('OK');
      expect(read.mismatch).to.be.false;
    });

    it('reports a legacy doc as legacy and not as a mismatch', () => {
      const read = readTxDoc(parse(LEGACY_DOC));
      expect(read.legacy).to.be.true;
      expect(read.mismatch).to.be.false;
      expect(read.status).to.equal('ready-for-review');
      expect(read.metaStatus).to.be.null;
      expect(read.findings['Translation Findings']).to.deep.equal(['Heading 3 is still English']);
    });

    it('gives a legacy doc a metadata block, in agreement, on the first write', () => {
      const doc = parse(LEGACY_DOC);
      applyReviewVerdict(doc, { reviewStatus: 'TRANSLATION OK', actor: 'ana', at: 'T1' });
      const read = readTxDoc(doc);
      expect(read.legacy).to.be.false;
      expect(read.mismatch).to.be.false;
      expect(read.metaStatus).to.equal('TRANSLATION OK');
    });

    it('reads the pipeline half from the metadata only', () => {
      // translation-status and sent-at are facts about what the pipeline did, so a
      // reviewer is never invited to overrule them by typing.
      const doc = fresh();
      applyPipelineStatus(doc, { translationStatus: 'preview-ok', sentAt: 'T0', at: 'T1' });
      const read = readTxDoc(doc);
      expect(read.translationStatus).to.equal('preview-ok');
      expect(read.sentAt).to.equal('T0');
      const bold = [...doc.querySelectorAll('strong')].map((el) => el.textContent);
      expect(bold.some((t) => t.includes('preview-ok'))).to.be.false;
      expect(read.log).to.deep.equal(['PIPELINE: preview-ok — T1']);
    });

    it('logs a pipeline change but not a re-run recording the same value', () => {
      const doc = fresh();
      applyPipelineStatus(doc, { translationStatus: 'preview-ok', at: 'T1' });
      const again = applyPipelineStatus(doc, { translationStatus: 'preview-ok', at: 'T2' });
      expect(again.changed).to.be.false;
      expect(readTxDoc(doc).log).to.have.lengthOf(1);
    });

    it('ignores a blank rather than erasing a value the caller cannot see', () => {
      const doc = fresh({ translationStatus: 'sent', sentAt: 'T0' });
      applyPipelineStatus(doc, { translationStatus: 'preview-ok' });
      const read = readTxDoc(doc);
      expect(read.sentAt).to.equal('T0');
      expect(read.translationStatus).to.equal('preview-ok');
    });
  });

  describe('tier findings', () => {
    it('replaces a section wholesale and leaves the reviewer prose alone', () => {
      const doc = fresh();
      applyReviewVerdict(doc, { reviewStatus: 'ready-for-review', note: 'Mine.', at: 'T1' });
      applyTierFindings(doc, {
        'Preview Check': ['Answers on the preview host'],
        'Translation Findings': ['Product name translated: "Document Authoring"'],
      });
      applyTierFindings(doc, { 'Translation Findings': ['Nav label still English'] });
      const read = readTxDoc(doc);
      expect(read.findings['Translation Findings']).to.deep.equal(['Nav label still English']);
      // A missing key empties the section: the tier looked and found nothing.
      expect(read.findings['Preview Check']).to.deep.equal([]);
      expect(read.notes).to.deep.equal(['Mine.']);
      expect(read.log).to.deep.equal(['READY FOR REVIEW — T1']);
    });

    it('writes the shared placeholder, so an empty section reads back as empty', () => {
      const doc = fresh();
      applyTierFindings(doc, {});
      expect(serializeTxDoc(doc)).to.contain(EMPTY_ISSUE);
      expect(readTxDoc(doc).findings['Layout Findings']).to.deep.equal([]);
    });

    it('leaves everything outside the tier sections byte-identical', () => {
      const doc = fresh();
      applyReviewVerdict(doc, { reviewStatus: 'ready-for-review', note: 'Keep me.', at: 'T1' });
      const before = docOutsideFindings(doc);
      applyTierFindings(doc, { 'Layout Findings': ['Nav wraps at 390px, worse than English'] });
      expect(docOutsideFindings(doc)).to.equal(before);
    });
  });

  describe('the notes section', () => {
    it('splits a multi-line note into items and replaces them on the next verdict', () => {
      const doc = fresh();
      applyReviewVerdict(doc, { reviewStatus: 'needs-retranslation', note: 'One\n\nTwo\n', at: 'T1' });
      expect(readTxDoc(doc).notes).to.deep.equal(['One', 'Two']);
      applyReviewVerdict(doc, { reviewStatus: 'TRANSLATION OK', note: null, at: 'T2' });
      // note:null means "do not touch the prose" — distinct from an empty string.
      expect(readTxDoc(doc).notes).to.deep.equal(['One', 'Two']);
    });
  });

  describe('the enum this doc mirrors', () => {
    it('round-trips every review-status through its marker', () => {
      for (const { status } of REVIEW_DOC_MARKERS) {
        expect(reviewStatusFromMarker(docMarkerFor(status)), JSON.stringify(status))
          .to.equal(status);
      }
    });
  });
});
