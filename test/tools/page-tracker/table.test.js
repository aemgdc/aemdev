import { expect } from '@esm-bundle/chai';
import { renderTable } from '../../../tools/page-tracker/table.js';
import { activeFilters, viewRow } from '../../../tools/page-tracker/rows.js';

/*
 * table.test.js — the page list.
 *
 * The state under test hardest is the EMPTY one. Nothing is translated and no group
 * sheet exists, so a table that matched nothing is what this app shows most of the
 * time — and a blank rectangle there is indistinguishable from a broken app. It has
 * to name the filter that emptied it and offer to clear that one.
 */

const mount = () => {
  const div = document.createElement('div');
  document.body.append(div);
  return div;
};

const page = (over = {}) => viewRow(
  {
    'page-path': '/en/meetups/berlin',
    title: 'Berlin meetup',
    subgroup: 'adaptto-2026',
    'en-status': 'en-published',
    ...over.row,
  },
  over.localeRow || {},
  over.code || null,
  'main',
);

const handlers = (over = {}) => ({
  onOpen: () => {}, onClear: () => {}, active: [], readonly: false, ...over,
});

describe('page-tracker table.js', () => {
  afterEach(() => {
    document.body.textContent = '';
  });

  describe('the populated table', () => {
    it('renders one row per page with the derived stage in it', () => {
      const el = mount();
      renderTable(el, [page()], handlers());
      const row = el.querySelector('.pt-row');
      expect(row).to.exist;
      expect(row.dataset.path).to.equal('/en/meetups/berlin');
      expect(row.querySelector('.pt-stage').dataset.stage).to.equal('enpublished');
      expect(row.querySelector('.pt-stage-label').textContent).to.equal('EN published');
    });

    /*
     * Both crawl columns are always drawn, including the negative. A blank cell and a
     * "no" cell are the same pixel to a reader and only one of them means "we looked".
     */
    it('draws both crawl chips in a three-state form', () => {
      const el = mount();
      renderTable(el, [page({
        code: 'de',
        localeRow: { 'page-path': '/en/meetups/berlin', previewed: 'yes' },
      })], handlers());
      const chips = [...el.querySelectorAll('.pt-crawl')];
      expect(chips.map((c) => c.textContent)).to.deep.equal(['PREV', 'LIVE']);
      expect(chips[0].className).to.contain('pt-crawl-yes');
      expect(chips[1].className).to.contain('pt-crawl-no');
      // The crawl columns are not writable here, and the chip says why.
      expect(chips[1].title).to.contain('tx:scan');
    });

    it('marks a page with no locale row so it cannot be mistaken for an empty one', () => {
      const el = mount();
      renderTable(el, [page({ code: 'ja' })], handlers());
      const chip = [...el.querySelectorAll('.pt-chip')].find((c) => c.textContent === 'no locale row');
      expect(chip).to.exist;
      expect(chip.title).to.contain('never');
    });

    it('flags a content escalation on the row, not only in the drawer', () => {
      const el = mount();
      renderTable(el, [page({ row: { 'content-escalation': 'yes' } })], handlers());
      expect(el.querySelector('.pt-chip-flag')).to.exist;
    });

    it('opens the drawer from a click, a keypress and the button', () => {
      const el = mount();
      const opened = [];
      renderTable(el, [page()], handlers({ onOpen: (p) => opened.push(p.path) }));
      el.querySelector('.pt-row').click();
      el.querySelector('.pt-col-actions button').click();
      el.querySelector('.pt-row').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      expect(opened).to.have.length(3);
    });

    it('repaints one row in place and keeps the selection', () => {
      const el = mount();
      const table = renderTable(el, [page()], handlers());
      table.setSelected('/en/meetups/berlin');
      expect(el.querySelector('.pt-row').classList.contains('pt-row-selected')).to.equal(true);
      table.updateRow(page({ row: { 'en-status': '' } }));
      const row = el.querySelector('.pt-row');
      expect(row.classList.contains('pt-row-selected')).to.equal(true);
      expect(row.querySelector('.pt-stage').dataset.stage).to.equal('catalogued');
    });
  });

  describe('the empty state', () => {
    it('names the filter that emptied it', () => {
      const el = mount();
      renderTable(el, [], handlers({ active: activeFilters({ stage: 'online' }) }));
      const head = el.querySelector('.pt-empty-head').textContent;
      expect(head).to.contain('Stage');
      expect(head).to.contain('Online');
    });

    it('offers a button that clears exactly that filter', () => {
      const el = mount();
      const cleared = [];
      renderTable(el, [], handlers({
        active: activeFilters({ queue: 'retranslate' }),
        onClear: (key) => cleared.push(key),
      }));
      el.querySelector('.pt-empty-actions button').click();
      expect(cleared).to.deep.equal(['queue']);
    });

    it('names every active filter and offers a clear-all when there is more than one', () => {
      const el = mount();
      const cleared = [];
      renderTable(el, [], handlers({
        active: activeFilters({ stage: 'previewed', text: 'berlin' }),
        onClear: (key) => cleared.push(key),
      }));
      const head = el.querySelector('.pt-empty-head').textContent;
      expect(head).to.contain('Stage');
      expect(head).to.contain('Find');
      const buttons = [...el.querySelectorAll('.pt-empty-actions button')];
      expect(buttons).to.have.length(3);
      buttons.at(-1).click();
      expect(cleared).to.deep.equal([null]);
    });

    /*
     * No filter active and still no rows is a DIFFERENT fact — the sheet has no pages —
     * and it must not blame a filter that is not there. It says what to run instead.
     */
    it('does not invent a filter to blame when none is active', () => {
      const el = mount();
      renderTable(el, [], handlers({ active: [] }));
      expect(el.querySelector('.pt-empty-head').textContent).to.contain('No pages on this tab');
      expect(el.querySelector('.pt-hint').textContent).to.contain('group:sync');
      expect(el.querySelector('.pt-empty-actions')).to.equal(null);
    });

    it('renders no table at all when empty, so nothing reads as a header with no rows', () => {
      const el = mount();
      const table = renderTable(el, [], handlers());
      expect(el.querySelector('table')).to.equal(null);
      // The handle is still safe to call, so a write landing mid-empty cannot throw.
      expect(() => table.updateRow(page())).to.not.throw();
      expect(() => table.setSelected('/en/x')).to.not.throw();
    });
  });

  describe('column headers', () => {
    it('says which columns are derived and which are stored', () => {
      const el = mount();
      renderTable(el, [page()], handlers());
      const titles = [...el.querySelectorAll('th')].map((th) => th.title || '');
      expect(titles.join(' ')).to.contain('DERIVED');
      expect(titles.join(' ')).to.contain('read-only here');
    });
  });
});
