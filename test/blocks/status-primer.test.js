/*
 * status-primer renders entirely from scripts/tracker/stages.js and fetches NOTHING.
 *
 * So the assertions are deliberately against the MODEL's exports rather than against
 * literal counts: `expect(rows).to.have.length(9)` would pass while silently going
 * stale the moment a stage is added, and this block exists precisely so that adding a
 * stage cannot leave a page behind. A test that hardcodes nine is the same drift the
 * block is built to prevent, one layer up.
 *
 * The two things it does hardcode are the two things that are NOT model-derived: the
 * prose of the two rules, and the fact that no request goes out.
 */
import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import init from '../../blocks/status-primer/status-primer.js';
import {
  PAGE_STAGES, QUEUES, PROGRESS_BUCKETS, EN_STATUSES, TRANSLATION_STATUSES,
  REVIEW_STATUSES, bucketForStage,
} from '../../scripts/tracker/stages.js';

/** A block element, optionally with authored key/value config rows. */
function block(config = {}) {
  const el = document.createElement('div');
  el.className = 'status-primer';
  el.innerHTML = Object.entries(config)
    .map(([k, v]) => `<div><div>${k}</div><div>${v}</div></div>`)
    .join('');
  document.body.append(el);
  return el;
}

const section = (el, id) => el.querySelector(`#sp-${id}`);
const bodyRows = (el, id) => [...(section(el, id)?.querySelectorAll('tbody tr') ?? [])];
const textOf = (el) => el.textContent.replace(/\s+/g, ' ');

describe('blocks/status-primer', () => {
  afterEach(() => {
    document.querySelectorAll('.status-primer').forEach((el) => el.remove());
  });

  describe('renders with no data at all', () => {
    it('fetches nothing — it is the one board that works before any feed exists', () => {
      const stub = sinon.stub(window, 'fetch');
      try {
        const el = block();
        init(el);
        expect(stub.called, 'status-primer must not touch the network').to.be.false;
        expect(el.querySelectorAll('section').length).to.be.greaterThan(0);
      } finally {
        stub.restore();
      }
    });

    it('renders every section by default', () => {
      const el = block();
      init(el);
      const ids = ['rules', 'funnel', 'bands', 'queues', 'english', 'translation', 'review', 'flag'];
      for (const id of ids) expect(section(el, id), id).to.exist;
    });

    it('is idempotent — a second render replaces, never appends', () => {
      const el = block();
      init(el);
      const first = el.querySelectorAll('section').length;
      init(el);
      expect(el.querySelectorAll('section').length).to.equal(first);
    });
  });

  describe('the funnel', () => {
    it('renders one row per PAGE_STAGES entry, in funnel order', () => {
      const el = block();
      init(el);
      const rows = bodyRows(el, 'funnel');
      expect(rows).to.have.length(PAGE_STAGES.length);
      const labels = rows.map((tr) => tr.querySelector('.sp-pill').textContent);
      expect(labels).to.deep.equal(PAGE_STAGES.map((s) => s.label));
    });

    it('carries each stage’s own hint, not a second copy of it', () => {
      const el = block();
      init(el);
      const rows = bodyRows(el, 'funnel');
      PAGE_STAGES.forEach((stage, i) => {
        expect(textOf(rows[i]), stage.id).to.include(stage.hint);
      });
    });

    it('shows the short label the DA app uses alongside the prose one', () => {
      const el = block();
      init(el);
      const shorts = bodyRows(el, 'funnel').map((tr) => tr.querySelector('.sp-short').textContent);
      expect(shorts).to.deep.equal(PAGE_STAGES.map((s) => s.short));
    });

    it('names the band each stage collapses into, from bucketForStage', () => {
      const el = block();
      init(el);
      const rows = bodyRows(el, 'funnel');
      PAGE_STAGES.forEach((stage, i) => {
        const band = PROGRESS_BUCKETS.find((b) => b.id === bucketForStage(stage.id));
        expect(rows[i].lastElementChild.textContent).to.equal(band.label);
      });
    });

    it('marks the two English-side rows, which are the same for every locale', () => {
      const el = block();
      init(el);
      const marked = bodyRows(el, 'funnel').filter((tr) => tr.classList.contains('sp-row-english'));
      expect(marked).to.have.length(2);
    });
  });

  describe('the progress bands', () => {
    it('renders one row per PROGRESS_BUCKETS entry', () => {
      const el = block();
      init(el);
      expect(bodyRows(el, 'bands')).to.have.length(PROGRESS_BUCKETS.length);
    });

    it('lists every stage under exactly one band, so the collapse is visible', () => {
      const el = block();
      init(el);
      const shown = bodyRows(el, 'bands')
        .flatMap((tr) => [...tr.querySelectorAll('.sp-pill')].map((p) => p.textContent));
      expect(shown.slice().sort()).to.deep.equal(PAGE_STAGES.map((s) => s.label).sort());
    });

    it('marks the bands that fold more than one stage', () => {
      const el = block();
      init(el);
      const folded = bodyRows(el, 'bands').filter((tr) => tr.classList.contains('sp-row-folded'));
      const expected = PROGRESS_BUCKETS
        .filter((b) => PAGE_STAGES.filter((s) => bucketForStage(s.id) === b.id).length > 1);
      expect(folded).to.have.length(expected.length);
    });

    it('says a blocked pair is in no band at all', () => {
      const el = block();
      init(el);
      expect(textOf(section(el, 'bands'))).to.include('A blocked pair is in NO band');
    });
  });

  describe('the work queues', () => {
    it('renders one row per queue with its label, owner and hint', () => {
      const el = block();
      init(el);
      const rows = bodyRows(el, 'queues');
      expect(rows).to.have.length(QUEUES.length);
      QUEUES.forEach((q, i) => {
        const text = textOf(rows[i]);
        expect(text, q.id).to.include(q.label);
        expect(text, q.id).to.include(q.hint);
        expect(text, q.id).to.include(q.id);
      });
    });

    it('renders the owner from the model, human chips distinct from machine ones', () => {
      const el = block();
      init(el);
      const rows = bodyRows(el, 'queues');
      QUEUES.forEach((q, i) => {
        const chip = rows[i].querySelector('.sp-chip');
        const kind = q.owner === 'human' ? 'sp-chip-human' : 'sp-chip-auto';
        expect(chip.classList.contains(kind), `${q.id} owner ${q.owner}`).to.be.true;
      });
    });
  });

  describe('the three stored vocabularies', () => {
    it('renders every en-status value and marks the send gate', () => {
      const el = block();
      init(el);
      const rows = bodyRows(el, 'english');
      expect(rows).to.have.length(EN_STATUSES.length);
      const gate = rows.filter((tr) => tr.classList.contains('sp-row-gate'));
      expect(gate).to.have.length(1);
      expect(textOf(gate[0])).to.include('en-published');
    });

    it('shows a blank stored value as (blank), because blank is a real value', () => {
      const el = block();
      init(el);
      expect(bodyRows(el, 'english')[0].querySelector('.sp-code').textContent).to.equal('(blank)');
    });

    it('renders every translation-status with the actor that writes it', () => {
      const el = block();
      init(el);
      const rows = bodyRows(el, 'translation');
      expect(rows).to.have.length(TRANSLATION_STATUSES.length);
      TRANSLATION_STATUSES.forEach((v, i) => {
        const chip = rows[i].querySelector('.sp-chip');
        const kind = v.actor === 'human' ? 'sp-chip-human' : 'sp-chip-auto';
        expect(chip.classList.contains(kind), `${v.value || '(blank)'} actor ${v.actor}`).to.be.true;
      });
    });

    it('marks exactly the blocking statuses, and names the queue each lands in', () => {
      const el = block();
      init(el);
      const rows = bodyRows(el, 'translation');
      TRANSLATION_STATUSES.forEach((v, i) => {
        const blocking = rows[i].classList.contains('sp-row-blocking');
        expect(blocking, v.value || '(blank)').to.equal(Boolean(v.queue));
        if (v.queue) {
          const queue = QUEUES.find((q) => q.id === v.queue);
          expect(textOf(rows[i]), v.value).to.include(queue.label);
        }
      });
    });

    it('renders every review-status with the marker line a reviewer types', () => {
      const el = block();
      init(el);
      const rows = bodyRows(el, 'review');
      expect(rows).to.have.length(REVIEW_STATUSES.length);
      // The stored value has a deliberate odd casing; the marker is a third spelling.
      // Both must be on the page or a reviewer cannot get from one to the other.
      const ok = rows.find((tr) => textOf(tr).includes('TRANSLATION OK'));
      expect(ok, 'the sign-off row').to.exist;
      expect(textOf(ok)).to.include('TRANSLATION STATUS: OK');
    });

    it('states who owns each of the three columns', () => {
      const el = block();
      init(el);
      for (const id of ['english', 'translation', 'review']) {
        const strip = section(el, id).querySelector('.sp-owner');
        expect(strip, id).to.exist;
        expect(textOf(strip), id).to.include(
          { english: 'en-status', translation: 'translation-status', review: 'review-status' }[id],
        );
      }
    });
  });

  describe('the two rules that surprise people', () => {
    it('states that a stage is derived and that going backwards is correct', () => {
      const el = block();
      init(el);
      const text = textOf(section(el, 'rules'));
      expect(text).to.include('DERIVED, never stored');
      expect(text).to.include('backwards');
      expect(text).to.include('That is the model working');
    });

    it('states that a human review-status outranks the pipeline in both directions', () => {
      const el = block();
      init(el);
      const text = textOf(section(el, 'rules'));
      expect(text).to.include('outranks any pipeline verdict');
      expect(text).to.include('BOTH directions');
      expect(text).to.include('signs it off even if a tier failed it');
    });

    it('puts the rules before the tables they explain', () => {
      const el = block();
      init(el);
      const order = [...el.querySelectorAll('section')].map((s) => s.id);
      expect(order[0]).to.equal('sp-rules');
    });
  });

  describe('the content-escalation flag', () => {
    it('explains that the flag coexists with a position instead of replacing it', () => {
      const el = block();
      init(el);
      const text = textOf(section(el, 'flag'));
      expect(text).to.include('content-escalation');
      expect(text).to.include('COEXISTS');
      expect(text).to.include('must never be added to them');
    });
  });

  describe('authored config', () => {
    it('renders only the sections asked for', () => {
      const el = block({ sections: 'funnel, queues' });
      init(el);
      expect(section(el, 'funnel')).to.exist;
      expect(section(el, 'queues')).to.exist;
      expect(section(el, 'rules')).to.not.exist;
      expect(section(el, 'review')).to.not.exist;
    });

    it('ignores the authored order — the sections build an argument in a fixed one', () => {
      const el = block({ sections: 'review, funnel' });
      init(el);
      const order = [...el.querySelectorAll('section')].map((s) => s.id);
      expect(order).to.deep.equal(['sp-funnel', 'sp-review']);
    });

    it('tolerates a Capitalised authored key, which readConfig folds', () => {
      const el = block({ Sections: 'flag' });
      init(el);
      expect(section(el, 'flag')).to.exist;
      expect(section(el, 'funnel')).to.not.exist;
    });
  });

  /*
   * The nearest thing this block has to an empty state. It cannot 404 — it has no feed —
   * but it CAN be authored wrong, and a blank primer is the same failure as a blank
   * board: a page that says nothing about why.
   */
  describe('a mis-authored sections row', () => {
    it('names the unknown section and lists the valid ones', () => {
      const el = block({ sections: 'funnle' });
      init(el);
      const warn = el.querySelector('.sp-config-error');
      expect(warn).to.exist;
      const text = textOf(warn);
      expect(text).to.include('funnle');
      expect(text).to.include('rules, funnel, bands, queues, english, translation, review, flag');
    });

    it('falls back to the whole primer rather than rendering nothing', () => {
      const el = block({ sections: 'funnle' });
      init(el);
      expect(textOf(el.querySelector('.sp-config-error'))).to.include('Showing the whole primer');
      expect(el.querySelectorAll('section')).to.have.length(8);
    });

    it('keeps the recognised sections when only some names are wrong', () => {
      const el = block({ sections: 'funnel, bogus' });
      init(el);
      expect(textOf(el.querySelector('.sp-config-error'))).to.include('recognised sections');
      expect([...el.querySelectorAll('section')].map((s) => s.id)).to.deep.equal(['sp-funnel']);
    });
  });
});
