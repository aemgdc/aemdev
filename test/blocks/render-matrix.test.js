/*
 * Every tracker board, mounted twice: once against a 404 feed and once against a
 * realistic one.
 *
 * This exists because the six boards were built by three sessions that could not see
 * each other, each with its own test file and its own idea of what "renders" means, and
 * one of them (`escalation-list`) shipped with no test file at all. The per-board files
 * assert on the details; this one asserts the single property that has to hold for all
 * six or the page is broken — **the block put something meaningful in its element** —
 * and it asserts it against the SAME fixtures for every board, so no board can pass by
 * being tested more gently than its neighbour.
 *
 * The 404 half is the state that ships first. `/tracker/data/*.json` all 404 in DA right
 * now, so a board that renders a blank area there is not "degrading gracefully", it is
 * the only thing anyone will ever see. Hence the assertions are on CONTENT: the feed path
 * it wanted, the error it got, and enough prose to tell a reader what to run. An empty
 * `<section>` with the right class name satisfies "rendered" and fails a user, so the
 * class name alone is never the assertion.
 */

import { expect } from '@esm-bundle/chai';
import statusPrimer from '../../blocks/status-primer/status-primer.js';
import trackerSummary from '../../blocks/tracker-summary/tracker-summary.js';
import groupProgress from '../../blocks/group-progress/group-progress.js';
import translationMatrix from '../../blocks/translation-matrix/translation-matrix.js';
import workQueue from '../../blocks/work-queue/work-queue.js';
import escalationList from '../../blocks/escalation-list/escalation-list.js';
import { FEEDS } from '../../scripts/tracker/paths.js';
import { TARGET_LOCALES } from '../../scripts/tracker/locales.js';
import { PAGE_STAGES, QUEUES } from '../../scripts/tracker/stages.js';
import {
  enRollup, escalationFeed, renderBlock, stubFeeds, textOf, txRollup,
} from './fixtures.js';

/*
 * The six boards, each with the feeds it reads and the config it needs to render its
 * primary view. `feeds` is what a POPULATED run routes; the 404 run routes nothing at
 * all, which is what makes it a 404.
 *
 * `fetches` is every feed the board requests. `names` is the subset it must NAME in its
 * missing-feed panel, and the two differ for one board on purpose: `work-queue` reads
 * the tx roll-up for counts and the two escalation feeds for detail, and when the
 * roll-up is gone it cannot draw anything, so it reports that one and stops. Its missing
 * DETAIL feeds are reported on a board that did render — covered separately below,
 * because collapsing the two would have forced a board to either over-report on a state
 * it cannot render or under-report on one it can.
 */
const BOARDS = [
  {
    name: 'status-primer',
    init: statusPrimer,
    feeds: () => ({}),
    // No fetch at all — it renders the vocabulary out of `stages.js`. So it has no
    // missing state to test, and its "404" run must render the SAME board.
    fetches: [],
  },
  {
    name: 'tracker-summary',
    init: trackerSummary,
    feeds: () => ({ [FEEDS.rollup]: enRollup(), [FEEDS.txRollup]: txRollup() }),
    fetches: [FEEDS.rollup, FEEDS.txRollup],
  },
  {
    name: 'group-progress',
    init: groupProgress,
    feeds: () => ({
      [FEEDS.rollup]: enRollup({
        subgroups: [['meetups', 'adaptTo'], ['meetups', '(unassigned)']],
        meta: { 'subgroups-complete': 'yes' },
      }),
    }),
    fetches: [FEEDS.rollup],
  },
  {
    name: 'translation-matrix',
    init: translationMatrix,
    feeds: () => ({ [FEEDS.txRollup]: txRollup() }),
    fetches: [FEEDS.txRollup],
  },
  {
    name: 'work-queue',
    init: workQueue,
    feeds: () => ({
      [FEEDS.txRollup]: txRollup({ queues: [{ locale: 'de', queue: 'escalations', count: 3 }] }),
      [FEEDS.escalations]: escalationFeed([{ locale: '' }]),
      [FEEDS.txEscalations]: escalationFeed([{}, {}]),
    }),
    fetches: [FEEDS.txRollup, FEEDS.escalations, FEEDS.txEscalations],
    names: [FEEDS.txRollup],
  },
  {
    name: 'escalation-list',
    init: escalationList,
    feeds: () => ({
      [FEEDS.escalations]: escalationFeed([{ locale: '', scope: 'template' }]),
      [FEEDS.txEscalations]: escalationFeed([{ scope: 'page' }, { scope: 'content' }]),
    }),
    fetches: [FEEDS.escalations, FEEDS.txEscalations],
  },
];

/** A board that rendered nothing at all. The one failure this file exists to catch. */
const isBlank = (el) => el.children.length === 0 || textOf(el).length < 40;

describe('every board renders in both states', () => {
  let stub;

  afterEach(() => {
    if (stub) stub.restore();
    stub = null;
  });

  describe('(a) with a 404 feed — the state that ships first', () => {
    for (const board of BOARDS) {
      /* eslint-disable no-loop-func */
      it(`${board.name} renders something meaningful`, async () => {
        stub = stubFeeds({});
        const el = await renderBlock(board.init, board.name);

        expect(isBlank(el), `${board.name} rendered a blank area on a 404 feed`).to.be.false;

        if (!board.fetches.length) return;

        // It must NAME the feed it wanted. A board that says "no data" without saying
        // which document is missing sends the reader to guess.
        const text = textOf(el);
        for (const feed of board.names || board.fetches) {
          expect(text, `${board.name} did not name ${feed}`).to.include(feed);
        }
        // …and it must carry the status the data layer recorded, not just a shrug.
        expect(text, `${board.name} did not surface the 404`).to.include('404');
      });

      it(`${board.name} asks for exactly the feeds it declares`, async () => {
        stub = stubFeeds({});
        await renderBlock(board.init, board.name);
        expect([...new Set(stub.calls)].sort()).to.deep.equal([...board.fetches].sort());
      });
      /* eslint-enable no-loop-func */
    }
  });

  describe('(b) with a realistic feed built from the contract', () => {
    for (const board of BOARDS) {
      /* eslint-disable no-loop-func */
      it(`${board.name} renders something meaningful`, async () => {
        stub = stubFeeds(board.feeds());
        const el = await renderBlock(board.init, board.name);

        expect(isBlank(el), `${board.name} rendered a blank area on a real feed`).to.be.false;

        // A populated board must NOT be showing its missing-feed panel. Every one of
        // them spells that state `<prefix>-missing` or `<prefix>-panel-error`, and a
        // board that renders both is a board whose guard has the wrong polarity.
        const stale = el.querySelectorAll('[class*="-missing"], [class*="-panel-error"]');
        expect(stale.length, `${board.name} still shows a missing-feed panel`).to.equal(0);
      });
      /* eslint-enable no-loop-func */
    }
  });
});

/*
 * The populated half above proves a board is not blank. These prove it is not blank
 * because it rendered THE DATA — the distinction a `textContent.length` check cannot
 * make, and the one that catches a board wired to the wrong tab.
 */
describe('the populated boards render the feed, not a placeholder', () => {
  let stub;

  afterEach(() => {
    if (stub) stub.restore();
    stub = null;
  });

  it('tracker-summary reports the 19 English pages the feed counts', async () => {
    stub = stubFeeds({ [FEEDS.rollup]: enRollup(), [FEEDS.txRollup]: txRollup() });
    const el = await renderBlock(trackerSummary, 'tracker-summary');
    expect(textOf(el)).to.include('19');
  });

  it('group-progress lists every group in the feed', async () => {
    stub = stubFeeds({ [FEEDS.rollup]: enRollup() });
    const el = await renderBlock(groupProgress, 'group-progress');
    const text = textOf(el);
    for (const g of ['indexes', 'meetups', 'technical-articles', 'bios']) {
      expect(text, `group-progress omitted ${g}`).to.include(g);
    }
  });

  it('translation-matrix renders a row per target locale', async () => {
    stub = stubFeeds({ [FEEDS.txRollup]: txRollup() });
    const el = await renderBlock(translationMatrix, 'translation-matrix');
    const text = textOf(el);
    // Native names or codes, depending on the view — but every locale must appear.
    const missing = TARGET_LOCALES.filter((c) => !text.toLowerCase().includes(c));
    expect(missing, `locales absent from the matrix: ${missing}`).to.have.length(0);
  });

  it('work-queue shows the queue the feed puts a count on', async () => {
    stub = stubFeeds({
      [FEEDS.txRollup]: txRollup({ queues: [{ locale: 'de', queue: 'escalations', count: 3 }] }),
      [FEEDS.escalations]: escalationFeed([]),
      [FEEDS.txEscalations]: escalationFeed([]),
    });
    const el = await renderBlock(workQueue, 'work-queue');
    const { label } = QUEUES.find((q) => q.id === 'escalations');
    expect(textOf(el)).to.include(label);
  });

  it('escalation-list renders a row per escalation', async () => {
    stub = stubFeeds({
      [FEEDS.escalations]: escalationFeed([{ locale: '', scope: 'template' }]),
      [FEEDS.txEscalations]: escalationFeed([{ scope: 'page' }, { scope: 'content' }]),
    });
    const el = await renderBlock(escalationList, 'escalation-list');
    expect(textOf(el)).to.include('The judge could not decide.');
  });

  /*
   * The half-degraded state, which is a REAL one and which nothing else covered: the
   * roll-up has been built and previewed but `build-escalations` has not run, so the
   * counts are there and the per-page detail behind them is not. A board that showed the
   * counts and said nothing would be inviting the reader to conclude the queues are
   * empty of detail rather than that the detail feed is absent.
   */
  it('work-queue renders its counts and still reports absent detail feeds', async () => {
    stub = stubFeeds({
      [FEEDS.txRollup]: txRollup({ queues: [{ locale: 'de', queue: 'escalations', count: 3 }] }),
    });
    const el = await renderBlock(workQueue, 'work-queue');
    const text = textOf(el);
    expect(text).to.include(QUEUES.find((q) => q.id === 'escalations').label);
    expect(text, 'did not name the absent QA escalation feed').to.include(FEEDS.escalations);
    expect(text, 'did not name the absent tx escalation feed').to.include(FEEDS.txEscalations);
  });

  it('status-primer renders every stage in the model', async () => {
    stub = stubFeeds({});
    const el = await renderBlock(statusPrimer, 'status-primer');
    const text = textOf(el);
    const missing = PAGE_STAGES.filter((s) => !text.includes(s.label));
    expect(missing.map((s) => s.id), 'stages absent from the primer').to.have.length(0);
  });
});
