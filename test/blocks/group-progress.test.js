/*
 * group-progress against a stubbed content bus.
 *
 * The two behaviours worth the most coverage here are the ones a reader cannot check
 * for themselves: `(unassigned)` sorting LAST regardless of size, and the accordion
 * REFUSING to open when `meta['subgroups-complete']` says the tab was dropped. Both are
 * cases where a plausible-looking wrong answer is available, and both are silent.
 */
import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import init from '../../blocks/group-progress/group-progress.js';
import { clearDataCache } from '../../scripts/tracker/data.js';
import { FEEDS } from '../../scripts/tracker/paths.js';
import { PAGE_STAGES } from '../../scripts/tracker/stages.js';
import { UNASSIGNED } from '../../scripts/tracker/subgroups.js';

const stageCells = (over = {}) => ({
  ...Object.fromEntries(PAGE_STAGES.map((s) => [s.id, 0])),
  blocked: 0,
  ...over,
});

/** A group row whose funnel counts add up to `counted`, as the build guarantees. */
const groupRow = (group, counted, over = {}) => ({
  group,
  total: counted,
  counted,
  ...stageCells({ enPublished: counted, ...over }),
  subgroups: 0,
});

const subgroupRow = (group, subgroup, counted, slug) => ({
  group,
  subgroup,
  key: subgroup.toLowerCase(),
  slug: slug ?? subgroup.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
  total: counted,
  counted,
  ...stageCells({ enPublished: counted }),
});

function rollupDoc({ groups = [], subgroups = [], meta = {} } = {}) {
  const tabs = {
    meta: [{
      generated: '2026-08-24T04:00:00.000Z',
      generatedAt: '2026-08-24T04:00:00.000Z',
      branch: 'main',
      expected: 19,
      listed: 19,
      withheld: 0,
      incomplete: '',
      'groups-failed': '',
      groups: groups.length,
      subgroups: subgroups.length,
      'subgroups-complete': 'yes',
      ...meta,
    }],
    totals: [{ total: 19, counted: 19, ...stageCells() }],
    groups,
    subgroups,
    queues: [],
  };
  const doc = { ':type': 'multi-sheet', ':names': Object.keys(tabs) };
  for (const [name, rows] of Object.entries(tabs)) doc[name] = { data: rows };
  return doc;
}

function stubFeed(doc) {
  return sinon.stub(window, 'fetch').callsFake((url) => {
    if (String(url) !== FEEDS.rollup || !doc) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404')) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(doc) });
  });
}

function block() {
  const el = document.createElement('div');
  el.className = 'group-progress';
  document.body.append(el);
  return el;
}

const textOf = (el) => el.textContent.replace(/\s+/g, ' ');

describe('blocks/group-progress', () => {
  let fetchStub;

  beforeEach(() => clearDataCache());

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = null;
    document.querySelectorAll('.group-progress').forEach((el) => el.remove());
  });

  describe('the feed is missing — the state this board ships in', () => {
    it('names the feed, the error and the command, instead of rendering nothing', async () => {
      fetchStub = stubFeed(null);
      const el = block();
      await init(el);
      expect(el.querySelector('.gp-table')).to.not.exist;
      expect(el.querySelector('.gp-missing-path').textContent).to.equal(FEEDS.rollup);
      expect(el.querySelector('.gp-missing-error').textContent).to.include('404');
      expect(textOf(el)).to.include('npm run rollup');
      expect(textOf(el)).to.include('not a report that every group is at zero');
    });
  });

  describe('the feed exists but lists no groups', () => {
    it('says a build that read no sheets is not a site with no pages', async () => {
      fetchStub = stubFeed(rollupDoc());
      const el = block();
      await init(el);
      expect(el.querySelector('.gp-table')).to.not.exist;
      const warn = textOf(el.querySelector('.gp-note-warn'));
      expect(warn).to.include('lists no groups');
      expect(warn).to.include('group:scaffold');
      expect(warn).to.include('not a site with no pages');
    });
  });

  describe('the four groups', () => {
    const groups = [
      groupRow('meetups', 14),
      groupRow('indexes', 4, { catalogued: 1, enPublished: 3 }),
      groupRow('technical-articles', 1),
      groupRow('bios', 0),
    ];

    beforeEach(() => {
      fetchStub = stubFeed(rollupDoc({ groups }));
    });

    it('renders one row per group, biggest first, with the empty group last', async () => {
      const el = block();
      await init(el);
      const names = [...el.querySelectorAll('.gp-row .gp-name a')].map((a) => a.textContent);
      expect(names).to.deep.equal(['meetups', 'indexes', 'technical-articles', 'bios']);
    });

    it('renders every funnel position as a column, using the model’s short labels', async () => {
      const el = block();
      await init(el);
      const heads = [...el.querySelectorAll('.gp-table thead th')].map((th) => th.textContent);
      expect(heads).to.deep.equal(['Group', 'Pages', ...PAGE_STAGES.map((s) => s.short), 'BLK']);
    });

    it('dims exactly the seven columns the English feed cannot populate', async () => {
      const el = block();
      await init(el);
      const dimmed = [...el.querySelectorAll('.gp-table thead th.gp-downstream')]
        .map((th) => th.textContent);
      expect(dimmed).to.deep.equal(PAGE_STAGES.slice(2).map((s) => s.short));
      expect(textOf(el)).to.include('structurally zero here rather than stalled');
    });

    it('links each group into the Page Tracker app', async () => {
      const el = block();
      await init(el);
      const href = el.querySelector('.gp-row .gp-name a').getAttribute('href');
      expect(href).to.include('group=meetups');
    });

    it('offers no caret for a group nobody has classified', async () => {
      const el = block();
      await init(el);
      expect(el.querySelector('.gp-toggle')).to.not.exist;
      expect(el.querySelector('.gp-subrow')).to.not.exist;
    });

    it('reports the gate every locale waits on', async () => {
      const el = block();
      await init(el);
      // 14 + 3 + 1 + 0 published of 19 counted.
      expect(textOf(el)).to.include('18 of 19 tracked pages are published in English');
    });
  });

  describe('the subgroup accordion', () => {
    /*
     * The residue is the BIGGEST bucket here on purpose. If it were not, a plain
     * size sort would put it last anyway and this test would prove nothing.
     */
    const groups = [{ ...groupRow('meetups', 14), subgroups: 2 }];
    const subgroups = [
      subgroupRow('meetups', UNASSIGNED, 9, 'unassigned'),
      subgroupRow('meetups', 'adaptto-2026', 3),
      subgroupRow('meetups', 'regional', 2),
    ];

    beforeEach(() => {
      fetchStub = stubFeed(rollupDoc({ groups, subgroups }));
    });

    it('gates the caret on the authored count, not on the row count', async () => {
      const el = block();
      await init(el);
      const toggle = el.querySelector('.gp-toggle');
      expect(toggle).to.exist;
      expect(toggle.getAttribute('aria-expanded')).to.equal('false');
      expect(el.querySelector('.gp-subcount').textContent).to.equal('2');
    });

    it('sorts (unassigned) LAST even when it is the biggest bucket', async () => {
      const el = block();
      await init(el);
      const names = [...el.querySelectorAll('.gp-subrow .gp-sub-name a')].map((a) => a.textContent);
      expect(names).to.deep.equal(['adaptto-2026', 'regional', UNASSIGNED]);
    });

    it('marks the residue row so it does not read as a category somebody chose', async () => {
      const el = block();
      await init(el);
      const rows = [...el.querySelectorAll('.gp-subrow')];
      expect(rows.at(-1).classList.contains('gp-residue')).to.be.true;
      expect(rows[0].classList.contains('gp-residue')).to.be.false;
    });

    it('builds the rows hidden, in the document, and flips them on click', async () => {
      const el = block();
      await init(el);
      const rows = [...el.querySelectorAll('.gp-subrow')];
      expect(rows.every((r) => r.hidden), 'closed to start').to.be.true;
      const toggle = el.querySelector('.gp-toggle');
      expect(toggle.getAttribute('aria-controls').split(' ')).to.have.length(rows.length);
      toggle.click();
      expect(rows.every((r) => !r.hidden), 'open after a click').to.be.true;
      expect(toggle.getAttribute('aria-expanded')).to.equal('true');
      toggle.click();
      expect(rows.every((r) => r.hidden), 'closed again').to.be.true;
    });

    it('keeps the breakdown in the same columns as the row it opens from', async () => {
      const el = block();
      await init(el);
      const cells = (tr) => tr.querySelectorAll('td').length;
      expect(cells(el.querySelector('.gp-subrow'))).to.equal(cells(el.querySelector('.gp-row')));
    });

    it('links the residue too — it is how you find what nobody has classified', async () => {
      const el = block();
      await init(el);
      const href = [...el.querySelectorAll('.gp-subrow .gp-sub-name a')]
        .at(-1).getAttribute('href');
      expect(href).to.include('sub-group=unassigned');
    });
  });

  describe('the subgroups tab was dropped whole', () => {
    const groups = [{ ...groupRow('meetups', 14), subgroups: 2 }];

    it('refuses to open a breakdown it cannot show completely, and says why', async () => {
      fetchStub = stubFeed(rollupDoc({
        groups,
        subgroups: [],
        meta: { 'subgroups-complete': '', subgroups: 0 },
      }));
      const el = block();
      await init(el);
      expect(el.querySelector('.gp-toggle'), 'no caret when the tab is gone').to.not.exist;
      const warn = textOf(el.querySelector('.gp-note-warn'));
      expect(warn).to.include('DROPPED from this feed, whole');
      expect(warn).to.include('would not re-add to the group row it opens from');
    });

    it('shows no partial breakdown even when some subgroup rows survived', async () => {
      fetchStub = stubFeed(rollupDoc({
        groups,
        subgroups: [subgroupRow('meetups', 'adaptto-2026', 3)],
        meta: { 'subgroups-complete': '' },
      }));
      const el = block();
      await init(el);
      expect(el.querySelector('.gp-subrow')).to.not.exist;
      expect(el.querySelector('.gp-note-warn')).to.exist;
    });

    it('stays quiet on a feed where nobody has authored a subgroup at all', async () => {
      fetchStub = stubFeed(rollupDoc({
        groups: [groupRow('meetups', 14)],
        subgroups: [],
        meta: { 'subgroups-complete': '' },
      }));
      const el = block();
      await init(el);
      // A blank `subgroups-complete` with nothing authored is an old or opted-out
      // rollup, not a feed hiding something. A permanent warning there would train
      // the reader to ignore the one that matters.
      expect(el.querySelector('.gp-note-warn')).to.not.exist;
      expect(el.querySelector('.gp-table')).to.exist;
    });
  });

  describe('a feed that contradicts itself', () => {
    it('names the group rows whose funnel does not add up to the pages counted', async () => {
      const groups = [{ ...groupRow('meetups', 14), counted: 20 }];
      fetchStub = stubFeed(rollupDoc({ groups }));
      const el = block();
      await init(el);
      const warn = textOf(el.querySelector('.gp-note-warn'));
      expect(warn).to.include('do not add up');
      expect(warn).to.include('meetups');
      expect(warn).to.include(FEEDS.rollup);
    });
  });

  describe('re-rendering', () => {
    it('replaces its content instead of appending a second table', async () => {
      fetchStub = stubFeed(rollupDoc({ groups: [groupRow('meetups', 14)] }));
      const el = block();
      await init(el);
      await init(el);
      expect(el.querySelectorAll('.gp-table')).to.have.length(1);
    });
  });
});
