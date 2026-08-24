/*
 * tracker-summary against a stubbed content bus.
 *
 * The FIRST describe block is the 404 case, deliberately, because that is the state
 * this board actually ships in: no group sheet has been scaffolded, no rollup has been
 * built, and `/tracker/data/*.json` all 404. A board that renders a blank area there is
 * broken, so "renders nothing" has to be a test failure and not an untested path.
 *
 * The fetch layer is stubbed rather than reached: `data.js` memoises by path and never
 * invalidates during a page's life, so every test calls `clearDataCache()` first. Two
 * tests sharing one memoised 404 is a whole suite passing for the wrong reason — the
 * tracker this is ported from had three of those before the seam existed.
 */
import { expect } from '@esm-bundle/chai';
import sinon from 'sinon';
import init from '../../blocks/tracker-summary/tracker-summary.js';
import { clearDataCache } from '../../scripts/tracker/data.js';
import { FEEDS } from '../../scripts/tracker/paths.js';
import { TARGET_LOCALES, locale as localeFor } from '../../scripts/tracker/locales.js';
import { PROGRESS_BUCKETS, PAGE_STAGES } from '../../scripts/tracker/stages.js';

/** A DA multi-sheet envelope. Cells are strings, as they are coming out of DA. */
function sheet(tabs) {
  const doc = { ':type': 'multi-sheet', ':names': Object.keys(tabs) };
  for (const [name, rows] of Object.entries(tabs)) doc[name] = { data: rows };
  return doc;
}

const GENERATED = '2026-08-24T04:00:00.000Z';

const metaRow = (extra = {}) => ({
  generated: GENERATED,
  generatedAt: GENERATED,
  branch: 'main',
  expected: 19,
  listed: 19,
  withheld: 0,
  incomplete: '',
  'groups-failed': '',
  ...extra,
});

/** Zeroed stage columns, so a fixture never has to list all ten by hand. */
const stageCells = (over = {}) => ({
  ...Object.fromEntries(PAGE_STAGES.map((s) => [s.id, 0])),
  blocked: 0,
  ...over,
});

/** Zeroed `b_`-prefixed bucket columns. */
const bucketCells = (over = {}) => Object.fromEntries(
  PROGRESS_BUCKETS.map((b) => [`b_${b.id}`, over[b.id] ?? 0]),
);

const rollupDoc = ({ meta = {}, totals = {} } = {}) => sheet({
  meta: [metaRow(meta)],
  totals: [{
    total: 19,
    counted: 19,
    ...stageCells({ catalogued: 4, enPublished: 15 }),
    groups: 4,
    queued: 0,
    ...totals,
  }],
  groups: [],
  subgroups: [],
  queues: [],
});

/**
 * A translation rollup.
 *
 * @param {object} opts
 * @param {object} [opts.per]     bucket counts applied to every locale row
 * @param {number} [opts.blocked] blocked pairs per locale row
 * @param {string[]} [opts.codes] which locales get a row (default: all ten)
 * @param {object[]} [opts.extraRows] rows appended verbatim, for the bad-code case
 * @param {object} [opts.meta]
 */
function txDoc({
  per = { enPublished: 19 }, blocked = 0, codes = TARGET_LOCALES, extraRows = [], meta = {},
} = {}) {
  const counted = Object.values(per).reduce((a, b) => a + b, 0) + blocked;
  const locales = codes.map((code) => ({
    locale: code,
    name: localeFor(code).name,
    native: localeFor(code).native,
    total: 19,
    counted,
    ...stageCells({ blocked }),
    ...bucketCells(per),
  }));
  return sheet({
    meta: [metaRow({
      expected: counted * codes.length,
      listed: counted * codes.length,
      locales: codes.length,
      groups: 4,
      ...meta,
    })],
    locales: [...locales, ...extraRows],
    groups: [],
    cells: [],
    queues: [],
    stages: [],
  });
}

/**
 * Serve the two feeds. `undefined` for either one means 404 — which is the live state
 * of both of them right now, so it is the default rather than a special case.
 */
function stubFeeds({ rollup, tx } = {}) {
  const bodies = { [FEEDS.rollup]: rollup, [FEEDS.txRollup]: tx };
  return sinon.stub(window, 'fetch').callsFake((url) => {
    const body = bodies[String(url)];
    if (!body) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404')) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
}

function block() {
  const el = document.createElement('div');
  el.className = 'tracker-summary';
  document.body.append(el);
  return el;
}

const textOf = (el) => el.textContent.replace(/\s+/g, ' ');
const notes = (el) => [...el.querySelectorAll('.ts-note')].map(textOf).join(' ');

describe('blocks/tracker-summary', () => {
  let fetchStub;

  beforeEach(() => {
    clearDataCache();
  });

  afterEach(() => {
    fetchStub?.restore();
    fetchStub = null;
    document.querySelectorAll('.tracker-summary').forEach((el) => el.remove());
  });

  /*
   * THE STATE THAT SHIPS FIRST.
   */
  describe('both feeds 404 — the state this board is in today', () => {
    it('renders a panel, not a blank block', async () => {
      fetchStub = stubFeeds();
      const el = block();
      await init(el);
      expect(el.querySelector('.ts-missing'), 'the missing-feed panel').to.exist;
      expect(textOf(el).length, 'some prose explaining the state').to.be.greaterThan(200);
    });

    it('says what it wanted — both feed paths, and the unit each one counts', async () => {
      fetchStub = stubFeeds();
      const el = block();
      await init(el);
      const paths = [...el.querySelectorAll('.ts-missing-path')].map((n) => n.textContent);
      expect(paths).to.deep.equal([FEEDS.rollup, FEEDS.txRollup]);
      const text = textOf(el);
      expect(text).to.include('Unit: pages');
      expect(text).to.include('Unit: (page, locale) pairs');
    });

    it('says what it got — the data layer’s own message, status code included', async () => {
      fetchStub = stubFeeds();
      const el = block();
      await init(el);
      const errs = [...el.querySelectorAll('.ts-missing-error')].map((n) => n.textContent);
      expect(errs).to.have.length(2);
      expect(errs[0]).to.include(FEEDS.rollup);
      expect(errs[0]).to.include('404');
      expect(errs[1]).to.include(FEEDS.txRollup);
    });

    it('says what to run, in the order it has to run in', async () => {
      fetchStub = stubFeeds();
      const el = block();
      await init(el);
      const cmds = [...el.querySelectorAll('.ts-cmd')].map((n) => n.textContent);
      expect(cmds).to.have.length(4);
      expect(cmds[0]).to.include('group:scaffold');
      expect(cmds[1]).to.include('group:sync');
      expect(cmds[2]).to.include('tx:scan');
      expect(cmds[3]).to.equal('npm run rollup');
      // Building a feed is not enough; DA has to serve it.
      expect(textOf(el)).to.include('PREVIEWED');
    });

    it('does not draw a bar, a legend or a locale strip it has no data for', async () => {
      fetchStub = stubFeeds();
      const el = block();
      await init(el);
      expect(el.querySelector('.ts-bar')).to.not.exist;
      expect(el.querySelector('.ts-legend')).to.not.exist;
      expect(el.querySelector('.ts-locales')).to.not.exist;
    });

    it('never reports zero progress — absent is not empty', async () => {
      fetchStub = stubFeeds();
      const el = block();
      await init(el);
      expect(el.querySelector('.ts-kpis'), 'no KPI tiles without a denominator').to.not.exist;
      expect(textOf(el)).to.include('not a report that everything is at zero');
    });

    it('reads each feed once, however many blocks share the page', async () => {
      fetchStub = stubFeeds();
      await init(block());
      await init(block());
      const urls = fetchStub.getCalls().map((c) => String(c.args[0]));
      expect(urls.filter((u) => u === FEEDS.rollup)).to.have.length(1);
      expect(urls.filter((u) => u === FEEDS.txRollup)).to.have.length(1);
    });
  });

  describe('one feed missing', () => {
    it('keeps the English KPIs and explains only the feed that is gone', async () => {
      fetchStub = stubFeeds({ rollup: rollupDoc() });
      const el = block();
      await init(el);
      expect(el.querySelector('.ts-kpis')).to.exist;
      const paths = [...el.querySelectorAll('.ts-missing-path')].map((n) => n.textContent);
      expect(paths).to.deep.equal([FEEDS.txRollup]);
      expect(el.querySelector('.ts-locales'), 'no locale strip without the tx feed').to.not.exist;
    });

    it('drops the pair count rather than showing a pair total it cannot source', async () => {
      fetchStub = stubFeeds({ rollup: rollupDoc() });
      const el = block();
      await init(el);
      const labels = [...el.querySelectorAll('.ts-kpi-label')].map((n) => n.textContent);
      expect(labels).to.deep.equal(['Pages tracked', 'EN published']);
    });

    it('renders the translation side when only the English feed is missing', async () => {
      fetchStub = stubFeeds({ tx: txDoc() });
      const el = block();
      await init(el);
      expect(el.querySelector('.ts-kpis')).to.not.exist;
      expect(el.querySelector('.ts-locales')).to.exist;
      expect([...el.querySelectorAll('.ts-missing-path')].map((n) => n.textContent))
        .to.deep.equal([FEEDS.rollup]);
    });
  });

  describe('both feeds present, nothing translated — the live shape of the data', () => {
    beforeEach(() => {
      fetchStub = stubFeeds({ rollup: rollupDoc(), tx: txDoc() });
    });

    it('shows the page count and the EN-published count, each with its unit', async () => {
      const el = block();
      await init(el);
      const tiles = [...el.querySelectorAll('.ts-kpi')].map(textOf);
      expect(tiles[0]).to.include('19');
      expect(tiles[0]).to.include('English pages');
      expect(tiles[1]).to.include('15');
      expect(tiles[2]).to.include(`× ${TARGET_LOCALES.length} locales`);
    });

    it('links both English figures into the Page Tracker app', async () => {
      const el = block();
      await init(el);
      const hrefs = [...el.querySelectorAll('.ts-kpi-value a')].map((a) => a.getAttribute('href'));
      expect(hrefs).to.have.length(2);
      expect(hrefs[0]).to.include('/tools/page-tracker');
      expect(hrefs[1]).to.include('filter=en-published');
    });

    it('warns that the English feed cannot show anything past the gate', async () => {
      const el = block();
      await init(el);
      expect(notes(el)).to.include('nothing downstream of "EN published" is ever non-zero');
    });

    it('draws only the bands that have pairs in them', async () => {
      const el = block();
      await init(el);
      const drawn = [...el.querySelectorAll('.ts-bar')[0].children]
        .map((s) => s.dataset.bucket);
      expect(drawn).to.deep.equal(['enPublished']);
    });

    it('keeps every band on the legend, so the vocabulary is complete', async () => {
      const el = block();
      await init(el);
      const labels = [...el.querySelectorAll('.ts-legend-label')].map((n) => n.textContent);
      expect(labels).to.deep.equal([...PROGRESS_BUCKETS.map((b) => b.label), 'Blocked']);
      const zeroed = [...el.querySelectorAll('.ts-legend-zero')];
      expect(zeroed).to.have.length(PROGRESS_BUCKETS.length); // all but enPublished, plus blocked
    });

    it('renders one row per target locale, in registry order, by native name', async () => {
      const el = block();
      await init(el);
      const rows = [...el.querySelectorAll('.ts-locale-row')];
      expect(rows).to.have.length(TARGET_LOCALES.length);
      const codes = [...el.querySelectorAll('.ts-locale-code')].map((n) => n.textContent);
      expect(codes).to.deep.equal(TARGET_LOCALES);
      const natives = rows.map((tr) => tr.querySelector('.ts-locale-name a').textContent);
      expect(natives).to.deep.equal(TARGET_LOCALES.map((c) => localeFor(c).native));
    });

    it('links each locale row to that locale in the Page Tracker app', async () => {
      const el = block();
      await init(el);
      const href = el.querySelector('.ts-locale-row .ts-locale-name a').getAttribute('href');
      expect(href).to.include('locale=de');
    });

    it('reads zero in flight — the English bands are not this locale’s progress', async () => {
      const el = block();
      await init(el);
      const row = el.querySelector('.ts-locale-row');
      const [flight, online] = [...row.querySelectorAll('.ts-locale-num')];
      expect(flight.querySelector('b').textContent).to.equal('0');
      expect(flight.textContent).to.include('/19');
      expect(online.querySelector('b').textContent).to.equal('0');
    });

    it('stamps when the feeds were generated', async () => {
      const el = block();
      await init(el);
      expect(el.querySelector('.ts-stamp')).to.exist;
    });

    it('says nothing about withholding when nothing was withheld', async () => {
      const el = block();
      await init(el);
      expect(el.querySelector('.ts-note-withheld')).to.not.exist;
      expect(el.querySelector('.ts-note-incomplete')).to.not.exist;
    });
  });

  describe('a rollout in progress', () => {
    it('draws the bands in funnel order and counts blocked pairs separately', async () => {
      fetchStub = stubFeeds({
        rollup: rollupDoc(),
        tx: txDoc({ per: { enPublished: 10, sent: 4, previewed: 3, online: 1 }, blocked: 1 }),
      });
      const el = block();
      await init(el);
      const drawn = [...el.querySelectorAll('.ts-bar')[0].children]
        .map((s) => s.dataset.bucket);
      expect(drawn).to.deep.equal(['enPublished', 'sent', 'previewed', 'online', 'blocked']);
    });

    it('counts everything past the English gate as in flight', async () => {
      fetchStub = stubFeeds({
        rollup: rollupDoc(),
        tx: txDoc({ per: { enPublished: 10, sent: 4, previewed: 3, online: 1 }, blocked: 1 }),
      });
      const el = block();
      await init(el);
      const [flight] = [...el.querySelector('.ts-locale-row').querySelectorAll('.ts-locale-num')];
      // 19 counted − 10 enPublished − 0 catalogued: the blocked pair counts as in flight
      // too, because it did leave the gate.
      expect(flight.querySelector('b').textContent).to.equal('9');
    });

    it('renders a sub-1% figure as <1%, never as 0%', async () => {
      const per = { enPublished: 999, online: 1 };
      fetchStub = stubFeeds({ rollup: rollupDoc(), tx: txDoc({ per }) });
      const el = block();
      await init(el);
      const online = el.querySelector('.ts-locale-online');
      expect(online.textContent).to.include('<1%');
    });
  });

  describe('a short feed says so', () => {
    it('reports withheld pages with both numbers and the feed path', async () => {
      fetchStub = stubFeeds({
        rollup: rollupDoc({ meta: { expected: 23, listed: 19, withheld: 4 } }),
        tx: txDoc(),
      });
      const el = block();
      await init(el);
      const note = el.querySelector('.ts-note-withheld');
      expect(note).to.exist;
      const text = textOf(note);
      expect(text).to.include('4 of 23 pages were WITHHELD');
      expect(text).to.include(FEEDS.rollup);
      expect(text).to.include('rather than further along than it looks');
    });

    it('reports withheld pairs against the pair unit, never against pages', async () => {
      fetchStub = stubFeeds({
        rollup: rollupDoc(),
        tx: txDoc({ meta: { expected: 230, listed: 190, withheld: 40 } }),
      });
      const el = block();
      await init(el);
      const text = textOf(el.querySelector('.ts-note-withheld'));
      expect(text).to.include('40 of 230 (page, locale) pairs');
      expect(text).to.include(FEEDS.txRollup);
    });

    it('keeps an unreadable group sheet SEPARATE from a withheld count', async () => {
      fetchStub = stubFeeds({
        rollup: rollupDoc({ meta: { incomplete: 'yes', 'groups-failed': 'bios meetups' } }),
        tx: txDoc(),
      });
      const el = block();
      await init(el);
      const warn = el.querySelector('.ts-note-incomplete');
      expect(warn).to.exist;
      const text = textOf(warn);
      expect(text).to.include('bios meetups');
      expect(text).to.include('UNKNOWN number of missing rows, not a withheld one');
      expect(text).to.include('lower bound');
      // It must not be reported as a quantity we know.
      expect(el.querySelector('.ts-note-withheld')).to.not.exist;
    });
  });

  describe('a feed that contradicts itself', () => {
    it('refuses to vouch for a bar whose bands do not add up to the pairs counted', async () => {
      // The build asserts this invariant, so this can only be a hand-edited feed.
      const tx = txDoc({ per: { enPublished: 5 } });
      tx.locales.data.forEach((row) => { row.counted = 19; });
      fetchStub = stubFeeds({ rollup: rollupDoc(), tx });
      const el = block();
      await init(el);
      const warn = textOf(el.querySelector('.ts-note-incomplete'));
      expect(warn).to.include('do not add up');
      expect(warn).to.include(FEEDS.txRollup);
      expect(warn).to.include('Do not trust the bar');
    });

    it('names a registered locale the feed has no row for', async () => {
      const codes = TARGET_LOCALES.filter((c) => c !== 'ja' && c !== 'ko');
      fetchStub = stubFeeds({ rollup: rollupDoc(), tx: txDoc({ codes }) });
      const el = block();
      await init(el);
      const text = notes(el);
      expect(text).to.include('2 registered locale(s) have no row');
      expect(text).to.include('ja, ko');
      expect(el.querySelectorAll('.ts-locale-row')).to.have.length(codes.length);
    });

    it('leaves an unserved locale code out of the strip and says it did', async () => {
      const extraRows = [{
        locale: 'nl', name: 'Dutch', total: 19, counted: 19, ...bucketCells({ enPublished: 19 }),
      }];
      fetchStub = stubFeeds({ rollup: rollupDoc(), tx: txDoc({ extraRows }) });
      const el = block();
      await init(el);
      const codes = [...el.querySelectorAll('.ts-locale-code')].map((n) => n.textContent);
      expect(codes).to.not.include('nl');
      const text = notes(el);
      expect(text).to.include('name a locale this site does not serve');
      expect(text).to.include('nl');
    });
  });

  describe('a feed that is present but has no rows', () => {
    it('draws a hatched bar rather than an empty one, and no locale strip', async () => {
      fetchStub = stubFeeds({ rollup: rollupDoc(), tx: txDoc({ codes: [] }) });
      const el = block();
      await init(el);
      const bar = el.querySelector('.ts-bar');
      expect(bar.classList.contains('ts-bar-empty')).to.be.true;
      expect(bar.children).to.have.length(0);
      expect(el.querySelector('.ts-locales')).to.not.exist;
    });

    it('shows — rather than 0% for a percentage with no denominator', async () => {
      fetchStub = stubFeeds({ rollup: rollupDoc(), tx: txDoc({ codes: [] }) });
      const el = block();
      await init(el);
      expect(el.querySelector('.ts-band-meta').textContent).to.include('—');
    });
  });

  describe('re-rendering', () => {
    it('replaces its content instead of appending a second board', async () => {
      fetchStub = stubFeeds({ rollup: rollupDoc(), tx: txDoc() });
      const el = block();
      await init(el);
      const first = el.querySelectorAll('.ts-locale-row').length;
      await init(el);
      expect(el.querySelectorAll('.ts-locale-row')).to.have.length(first);
    });
  });
});
