import { expect } from '@esm-bundle/chai';
import {
  applyContentEscalation,
  applyEnStatus,
  applyQaFindings,
  appendQaLog,
  buildQaDocHtml,
  docOutsideFindings,
  EMPTY_ISSUE,
  EMPTY_NOTES,
  EN_STATUS_KEY,
  FINDING_SECTIONS,
  LOG_SECTION,
  NOTES_SECTION,
  QA_ACTOR_KEY,
  QA_UPDATED_KEY,
  readMetadata,
  readQaDoc,
  serializeQaDoc,
} from '../../../scripts/tracker/qa-doc.js';
import {
  CONTENT_ESCALATION_COLUMN,
  CONTENT_ESCALATION_RE,
} from '../../../scripts/tracker/stages.js';

/*
 * qa-doc.test.js — the EN QA-notes document model.
 *
 * This file also covers the shared DOM helper layer, because `qa-doc.js` owns it and
 * `tx-doc.js` imports it. The two modules kept private copies upstream and had drifted
 * in four places, so the layer having exactly one test is part of the point.
 *
 * The model takes a Document from its caller so the same code runs in the DA app and in
 * Node (see scripts/tracker/README.md). These tests run in a real browser under
 * web-test-runner, so `DOMParser` is the caller here; the Node side passes jsdom.
 */
const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

const fresh = (over = {}) => parse(buildQaDocHtml({
  title: 'Berlin meetup',
  previewUrl: 'https://main--aemdev--aemgdc.aem.page/en/meetups/berlin',
  ...over,
}));

/** Re-parse through the serializer, which is the only way DA ever hands the doc back. */
const roundTrip = (doc) => parse(serializeQaDoc(doc));

/** The escalation line as a reader sees it, or null. */
const escalationLineText = (doc) => [...doc.querySelectorAll('p')]
  .map((p) => (p.textContent || '').trim())
  .find((t) => CONTENT_ESCALATION_RE.test(t) || /CONTENT ESCALATION/i.test(t)) ?? null;

describe('qa-doc.js', () => {
  describe('a fresh document', () => {
    it('carries both machine sections, the notes section, and no log', () => {
      // No log section on a fresh doc: it is created by the first event, so an
      // untouched page does not show an empty audit trail as if something had run.
      const doc = fresh();
      const headings = [...doc.querySelectorAll('h2')].map((h) => h.textContent.trim());
      expect(headings).to.deep.equal([...FINDING_SECTIONS, NOTES_SECTION]);
      expect(readQaDoc(doc).log).to.deep.equal([]);
    });

    it('reads back as not escalated, not legacy, and not mismatched', () => {
      const read = readQaDoc(fresh());
      expect(read.contentEscalation).to.equal(false);
      expect(read.escalationLine).to.equal(null);
      expect(read.escalationUnknown).to.equal(false);
      expect(read.legacy).to.equal(false);
      expect(read.mismatch).to.equal(false);
      expect(read.title).to.contain('Berlin meetup');
    });

    it('omits a link line it was given no URL for', () => {
      // A line reading "Live: " with nothing after it states less than no line at all.
      const html = buildQaDocHtml({ title: 'x', previewUrl: 'https://example.test/a' });
      expect(html).to.contain('Preview');
      expect(html).to.not.contain('Live:');
      expect(html).to.not.contain('DA Edit');
    });

    it('escapes a title that would otherwise inject markup', () => {
      // The title comes off a sheet cell, and this HTML is written into a public page.
      const html = buildQaDocHtml({ title: '<img src=x onerror=alert(1)>' });
      expect(html).to.not.contain('<img');
      expect(html).to.contain('&lt;img');
    });
  });

  describe('the content-escalation flag', () => {
    it('raises a visible line AND metadata, and survives a round trip', () => {
      /*
       * Dual-write. The document is the reviewer's surface and the sheet is the
       * tracker's; a flag that exists in only one of them is a flag somebody will act
       * on and somebody else will not see.
       */
      const doc = roundTrip(applyContentEscalation(fresh(), {
        on: true, actor: 'tad', at: '2026-08-23T10:00:00Z',
      }));
      const read = readQaDoc(doc);
      expect(read.contentEscalation).to.equal(true);
      expect(read.escalationLine).to.equal('YES');
      expect(read.mismatch).to.equal(false);
      expect(read.metadata[CONTENT_ESCALATION_COLUMN]).to.equal('yes');
      expect(read.actor).to.equal('tad');
      expect(read.updated).to.equal('2026-08-23T10:00:00Z');
      expect(escalationLineText(doc)).to.match(/CONTENT ESCALATION:\s*YES/);
    });

    it('puts the line where a reviewer reads first, above the sections', () => {
      // Above the headings, not appended: a status line after the append-only log is
      // a status line nobody sees.
      const doc = applyContentEscalation(fresh(), { on: true, actor: 'tad' });
      const root = doc.querySelector('main > div');
      const nodes = [...root.children];
      const lineAt = nodes.findIndex((n) => /CONTENT ESCALATION/i.test(n.textContent || ''));
      const firstHeadingAt = nodes.findIndex((n) => n.tagName === 'H2');
      expect(lineAt).to.be.greaterThan(-1);
      expect(lineAt).to.be.lessThan(firstHeadingAt);
    });

    it('clearing REMOVES the line rather than writing a NO line', () => {
      /*
       * A resolved page is indistinguishable from one never flagged, except in the log
       * — which keeps both events. A lingering "NO" line would read as a verdict about
       * the page rather than as the absence of one.
       */
      const raised = applyContentEscalation(fresh(), { on: true, actor: 'tad' });
      const cleared = roundTrip(applyContentEscalation(raised, { on: false, actor: 'ana' }));
      const read = readQaDoc(cleared);
      expect(escalationLineText(cleared)).to.equal(null);
      expect(read.contentEscalation).to.equal(false);
      expect(read.escalationLine).to.equal(null);
      expect(read.metadata[CONTENT_ESCALATION_COLUMN]).to.equal('');
      expect(read.mismatch).to.equal(false);
      // Both events survive.
      expect(read.log.join(' | ')).to.contain('RAISED');
      expect(read.log.join(' | ')).to.contain('CLEARED');
    });

    it('corrects a mistyped flag in place instead of adding a second line', () => {
      /*
       * The line is located by LABEL, not by the vocabulary regex. Locating it by the
       * regex made a mistyped marker invisible to the writer, which then inserted a
       * second, contradictory line above it — and the reader picked whichever came
       * first. One line, always.
       */
      const doc = fresh();
      const root = doc.querySelector('main > div');
      const p = doc.createElement('p');
      const strong = doc.createElement('strong');
      strong.textContent = 'CONTENT ESCALATION: MAYBE';
      p.append(strong);
      root.insertBefore(p, root.querySelector('h2'));

      // Read first: an out-of-vocabulary value is a warning, never a bucketed verdict.
      const before = readQaDoc(doc);
      expect(before.escalationUnknown).to.equal(true);
      expect(before.escalationLine).to.equal(null);

      const fixed = roundTrip(applyContentEscalation(doc, { on: true, actor: 'tad' }));
      const lines = [...fixed.querySelectorAll('p')]
        .filter((n) => /CONTENT ESCALATION/i.test(n.textContent || ''));
      expect(lines).to.have.length(1);
      expect(readQaDoc(fixed).escalationLine).to.equal('YES');
      expect(readQaDoc(fixed).escalationUnknown).to.equal(false);
    });

    it('reports metadata-says-yes-with-no-line as a mismatch', () => {
      /*
       * A raised flag nobody can see is the failure the visible line exists to
       * prevent, so this asymmetry is deliberate: yes-in-metadata with no line is a
       * partial write or a deleted line, while no-line-and-blank-metadata is simply
       * cleared.
       */
      const doc = fresh();
      const raised = applyContentEscalation(doc, { on: true, actor: 'tad' });
      escalationLineText(raised); // sanity: the line exists before we delete it
      [...raised.querySelectorAll('p')]
        .filter((n) => /CONTENT ESCALATION/i.test(n.textContent || ''))
        .forEach((n) => n.remove());
      const read = readQaDoc(roundTrip(raised));
      expect(read.mismatch).to.equal(true);
      // Metadata still decides the value when there is no line to trust.
      expect(read.contentEscalation).to.equal(true);
    });

    it('treats a doc with no metadata block as legacy, not as mismatched', () => {
      const doc = parse('<body><main><div><h1>QA notes — x</h1></div></main></body>');
      const read = readQaDoc(doc);
      expect(read.legacy).to.equal(true);
      expect(read.mismatch).to.equal(false);
      expect(read.contentEscalation).to.equal(false);
    });

    it('appends a note without re-appending one already present', () => {
      /*
       * The drawer pre-fills its notes box with the doc's existing notes, so raising a
       * flag without editing that box re-submits every line verbatim. Upstream that put
       * the same dead-video note on one page twice.
       */
      const first = applyContentEscalation(fresh(), {
        on: true, actor: 'tad', note: 'The recap video is a dead link.',
      });
      const again = roundTrip(applyContentEscalation(roundTrip(first), {
        on: true,
        actor: 'tad',
        note: 'The recap video is a dead link.\nAnd the speaker photo 404s.',
      }));
      const { notes } = readQaDoc(again);
      expect(notes).to.deep.equal([
        'The recap video is a dead link.',
        'And the speaker photo 404s.',
      ]);
      // The placeholder is gone once there is real prose.
      expect(notes).to.not.contain(EMPTY_NOTES);
    });
  });

  describe('en-status is mirrored, never judged', () => {
    it('writes metadata and adds no visible line', () => {
      /*
       * Observed, not judged: the sheet column is authoritative and the next scan
       * rewrites it. A hand-editable line would invite a reviewer to correct a value
       * this document does not own, and their edit would vanish unexplained.
       */
      const { doc, changed } = applyEnStatus(fresh(), {
        enStatus: 'en-published', actor: 'crawl', at: '2026-08-23T11:00:00Z',
      });
      expect(changed).to.equal(true);
      const read = readQaDoc(roundTrip(doc));
      expect(read.enStatus).to.equal('en-published');
      expect(read.enStatusUnknown).to.equal(false);
      expect(serializeQaDoc(doc)).to.not.match(/EN STATUS:[^<]*<\/strong>/);
    });

    it('logs a change once and a no-op never', () => {
      // A crawl that keeps saying `en-published` is not an event, and an audit trail
      // nobody can read is not an audit trail.
      const first = applyEnStatus(fresh(), { enStatus: 'en-published', actor: 'crawl' });
      expect(first.changed).to.equal(true);
      const second = applyEnStatus(roundTrip(first.doc), { enStatus: 'en-published', actor: 'crawl' });
      expect(second.changed).to.equal(false);
      const { log } = readQaDoc(roundTrip(second.doc));
      expect(log.filter((l) => /EN STATUS/.test(l))).to.have.length(1);
    });

    it('flags a value outside the vocabulary instead of bucketing it', () => {
      const { doc } = applyEnStatus(fresh(), { enStatus: 'publishedish' });
      const read = readQaDoc(roundTrip(doc));
      expect(read.enStatus).to.equal('publishedish');
      expect(read.enStatusUnknown).to.equal(true);
    });
  });

  describe('a findings rewrite touches only the machine-owned sections', () => {
    it('replaces each section and restores the placeholder when a run finds nothing', () => {
      const doc = applyQaFindings(fresh(), {
        [FINDING_SECTIONS[0]]: ['Missing h1', 'Two h1s'],
        [FINDING_SECTIONS[1]]: ['Untranslated CTA'],
      });
      const read = readQaDoc(roundTrip(doc));
      expect(read.findings[FINDING_SECTIONS[0]]).to.deep.equal(['Missing h1', 'Two h1s']);
      expect(read.findings[FINDING_SECTIONS[1]]).to.deep.equal(['Untranslated CTA']);

      /*
       * A missing key EMPTIES that section — the run looked and found nothing, which
       * is a result and not an absence of one. `itemsUnder` filters the placeholder out
       * on the way back, deliberately: it is presentation, and a caller counting
       * findings must not count "no findings yet" as one. So the emptied section reads
       * as `[]` to a consumer and still renders a placeholder to a reader.
       */
      const emptied = roundTrip(applyQaFindings(roundTrip(doc), {}));
      const clean = readQaDoc(emptied);
      for (const section of FINDING_SECTIONS) {
        expect(clean.findings[section], section).to.deep.equal([]);
      }
      const rendered = [...emptied.querySelectorAll('ul > li > em')]
        .map((em) => em.textContent.trim());
      expect(rendered.filter((t) => t === EMPTY_ISSUE)).to.have.length(FINDING_SECTIONS.length);
    });

    it('leaves everything outside those sections BYTE-IDENTICAL', () => {
      /*
       * Structural, not field-by-field, and that is the whole point: the first version
       * of this check upstream compared parsed `notes`, which read as absent when the
       * prose was typed as paragraphs in DA — so a diff that destroyed them compared
       * equal. Serializing the remainder cannot be fooled by shape.
       */
      const doc = roundTrip(applyContentEscalation(fresh(), {
        on: true, actor: 'tad', note: 'A human wrote this and it must survive.', at: 'T',
      }));
      const before = docOutsideFindings(doc);
      applyQaFindings(doc, { [FINDING_SECTIONS[0]]: ['Missing h1'] });
      expect(docOutsideFindings(doc)).to.equal(before);
      // And the guard is one that has been seen to fail.
      appendQaLog(doc, 'QA RUN', { at: 'T2' });
      expect(docOutsideFindings(doc)).to.not.equal(before);
    });

    it('is not logged, so a nightly clean run does not bury the verdicts', () => {
      const doc = roundTrip(applyContentEscalation(fresh(), { on: true, actor: 'tad', at: 'T' }));
      const before = readQaDoc(doc).log.length;
      applyQaFindings(doc, { [FINDING_SECTIONS[0]]: ['Missing h1'] });
      expect(readQaDoc(roundTrip(doc)).log).to.have.length(before);
    });
  });

  describe('the log is append-only and stays last', () => {
    it('appends in order and keeps the log section below every other section', () => {
      /*
       * Section ORDER is a caller argument rather than baked in, so a section created
       * late cannot land underneath the append-only log — where a reviewer would never
       * scroll to find it.
       */
      const doc = fresh();
      appendQaLog(doc, 'FIRST', { at: 'T1' });
      appendQaLog(doc, 'SECOND', { at: 'T2' });
      const withNote = roundTrip(applyContentEscalation(roundTrip(doc), {
        on: true, actor: 'tad', note: 'A late note', at: 'T3',
      }));

      const { log } = readQaDoc(withNote);
      expect(log[0]).to.contain('FIRST');
      expect(log[1]).to.contain('SECOND');
      expect(log[log.length - 1]).to.contain('RAISED');

      const headings = [...withNote.querySelectorAll('h2')].map((h) => h.textContent.trim());
      expect(headings[headings.length - 1]).to.equal(LOG_SECTION);
      expect(headings.indexOf(NOTES_SECTION)).to.be.lessThan(headings.indexOf(LOG_SECTION));
    });

    it('appendQaLog changes nothing but the log', () => {
      // These docs are open in front of reviewers while automation runs, so a tool that
      // only needs to say "this ran again" must not touch a flag or a word of prose.
      const doc = roundTrip(applyContentEscalation(fresh(), {
        on: true, actor: 'tad', note: 'Human prose', at: 'T',
      }));
      const before = readQaDoc(doc);
      appendQaLog(doc, 'QA RUN', { at: 'T2' });
      const after = readQaDoc(roundTrip(doc));
      expect(after.contentEscalation).to.equal(before.contentEscalation);
      expect(after.notes).to.deep.equal(before.notes);
      expect(after.metadata[QA_ACTOR_KEY]).to.equal(before.metadata[QA_ACTOR_KEY]);
      expect(after.metadata[QA_UPDATED_KEY]).to.equal(before.metadata[QA_UPDATED_KEY]);
      expect(after.log).to.have.length(before.log.length + 1);
    });
  });

  describe('metadata keys are the sheet columns', () => {
    it('uses the column names the sheet uses, so the sync maps 1:1', () => {
      // A doc key that merely resembles its column is a mapping table nobody wrote.
      const doc = fresh({ enStatus: 'draft' });
      expect(Object.keys(readMetadata(doc))).to.include.members([
        EN_STATUS_KEY, CONTENT_ESCALATION_COLUMN, QA_ACTOR_KEY, QA_UPDATED_KEY,
      ]);
      expect(EN_STATUS_KEY).to.equal('en-status');
      expect(readQaDoc(doc).enStatus).to.equal('draft');
    });

    it('keeps one metadata block, and keeps it last, across repeated writes', () => {
      const doc = roundTrip(applyEnStatus(fresh(), { enStatus: 'en-previewed' }).doc);
      const twice = roundTrip(applyEnStatus(doc, { enStatus: 'en-published' }).doc);
      expect(twice.querySelectorAll('.metadata')).to.have.length(1);
      const root = twice.querySelector('main > div');
      expect(root.lastElementChild.className).to.contain('metadata');
      expect(readQaDoc(twice).metadata[EN_STATUS_KEY]).to.equal('en-published');
    });
  });
});
