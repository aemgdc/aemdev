import { expect } from '@esm-bundle/chai';
import init from '../../blocks/work-queue/work-queue.js';
import { FEEDS, daEditUrl } from '../../scripts/tracker/paths.js';
import { QUEUES, queueMeta } from '../../scripts/tracker/stages.js';
import {
  escalationFeed, txRollup, stubFeeds, renderBlock, textOf, has, countOf,
} from './fixtures.js';

/*
 * Three things this board must get right, and one it must never do.
 *
 * MUST: distinguish a missing feed from an empty queue; word an empty queue as the
 * success it is; name the owner of every queue it shows.
 * MUST NOT: drop a queue id the model does not define. That is work nobody owns, and
 * filtering it out is how the upstream tracker left 21 of 23 groups unfilterable while
 * every board looked fine.
 */

const BLOCK = 'work-queue';
const render = (cfg) => renderBlock(init, BLOCK, cfg);
const warnings = (block) => textOf(block.querySelector('.wq-warn-list'));
const queueTitles = (block) => [...block.querySelectorAll('.wq-title')].map((n) => textOf(n));

/** Both escalation feeds present and empty — built, nothing escalated. */
const emptyEscalations = () => ({
  [FEEDS.escalations]: escalationFeed([]),
  [FEEDS.txEscalations]: escalationFeed([]),
});

describe('work-queue', () => {
  let feeds;
  afterEach(() => {
    if (feeds) feeds.restore();
    feeds = null;
  });

  describe('the counts feed does not exist', () => {
    it('says what it wanted, where it looked and what to run', async () => {
      feeds = stubFeeds({});
      const block = await render();
      const text = textOf(block);

      expect(has(block, '.wq-panel-error')).to.equal(true);
      expect(text).to.contain(FEEDS.txRollup);
      expect(text).to.contain('404');
      expect(text).to.contain('npm run rollup');
    });

    it('does not report a missing feed as a clear queue', async () => {
      feeds = stubFeeds({});
      const block = await render();

      // "Never built" and "nothing queued" are different facts and only one of them is
      // good news. Conflating them reports a clear queue for a pipeline that never ran.
      expect(has(block, '.wq-panel-clear')).to.equal(false);
      expect(textOf(block)).to.not.contain('Nothing queued');
    });
  });

  describe('every queue empty — the good state', () => {
    it('says nothing is queued, positively, and not as an error', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: txRollup(), ...emptyEscalations() });
      const block = await render();
      const text = textOf(block);

      expect(has(block, '.wq-panel-clear')).to.equal(true);
      expect(has(block, '.wq-panel-error')).to.equal(false);
      expect(text).to.contain('Nothing queued');
      expect(text).to.contain('Nobody is owed anything');
      expect(has(block, '.wq-queue')).to.equal(false);
    });

    it(
      'names its own scope, so a filtered board cannot read as the whole tracker',
      async () => {
        feeds = stubFeeds({ [FEEDS.txRollup]: txRollup(), ...emptyEscalations() });
        const block = await render({ queue: 'escalations', locale: 'de' });
        const text = textOf(block);

        expect(text).to.contain(queueMeta('escalations').label);
        expect(text).to.contain('German');
      },
    );
  });

  describe('with work in it', () => {
    const withWork = () => txRollup({
      queues: [
        { locale: 'de', queue: 'escalations', count: 2 },
        { locale: 'fr', queue: 'layout-issues', count: 5 },
      ],
    });

    it('shows only the queues that hold something', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: withWork(), ...emptyEscalations() });
      const block = await render();

      expect(queueTitles(block)).to.deep.equal([
        queueMeta('escalations').label,
        queueMeta('layout-issues').label,
      ]);
    });

    it('names the owner of every queue, from the model', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: withWork(), ...emptyEscalations() });
      const block = await render();
      const owners = [...block.querySelectorAll('.wq-queue')]
        .map((s) => ({ owner: s.dataset.owner, chip: textOf(s.querySelector('.wq-owner')) }));

      // The board's whole job is telling a specific person something is theirs, so the
      // owner is read off QUEUES and not decided here.
      expect(owners).to.deep.equal([
        { owner: queueMeta('escalations').owner, chip: queueMeta('escalations').owner },
        { owner: queueMeta('layout-issues').owner, chip: queueMeta('layout-issues').owner },
      ]);
    });

    it('filters to one owner when asked', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: withWork(), ...emptyEscalations() });
      const block = await render({ owner: 'developer' });

      expect(queueTitles(block)).to.deep.equal([queueMeta('layout-issues').label]);
    });

    it(
      'explains a count with no published detail instead of showing an empty list',
      async () => {
        feeds = stubFeeds({ [FEEDS.txRollup]: withWork(), ...emptyEscalations() });
        const block = await render();
        const text = textOf(block.querySelector('.wq-queue'));

        // A pair enters `retranslate` because a reviewer typed a status; nothing
        // escalated, so no feed row exists and none ever will.
        expect(text).to.contain('no published escalation detail');
        expect(has(block, '.wq-list')).to.equal(false);
      },
    );

    it(
      'reports a missing escalation feed as a missing detail source, not a broken board',
      async () => {
        feeds = stubFeeds({ [FEEDS.txRollup]: withWork() });
        const block = await render();

        expect(has(block, '.wq-queue')).to.equal(true);
        expect(warnings(block)).to.contain(FEEDS.escalations);
        expect(warnings(block)).to.contain(FEEDS.txEscalations);
        expect(warnings(block)).to.contain('npm run escalations');
      },
    );
  });

  describe('detail rows', () => {
    const feedsWithDetail = () => ({
      [FEEDS.txRollup]: txRollup({ queues: [{ locale: 'de', queue: 'escalations', count: 1 }] }),
      [FEEDS.escalations]: escalationFeed([]),
      [FEEDS.txEscalations]: escalationFeed([{ summary: 'Heading 2 is missing.' }]),
    });

    it('renders the page, its review doc and a Page Tracker deep link', async () => {
      feeds = stubFeeds(feedsWithDetail());
      const block = await render();
      const item = block.querySelector('.wq-item');
      const hrefs = [...item.querySelectorAll('.wq-link')].map((a) => a.href);

      expect(textOf(item.querySelector('.wq-summary'))).to.equal('Heading 2 is missing.');
      // Every URL comes from paths.js. A hand-built one here would drift from the app's.
      expect(hrefs.some((h) => h.includes('/de/meetups/adaptto-2026-berlin'))).to.be.true;
      expect(hrefs).to.contain(daEditUrl('/tracker/tx/de/meetups/adaptto-2026-berlin'));
      expect(hrefs.some((h) => h.includes('group=meetups') && h.includes('locale=de')))
        .to.be.true;
    });

    it(
      'flags a locale code the registry does not know rather than hiding the row',
      async () => {
        const routes = feedsWithDetail();
        routes[FEEDS.txEscalations] = escalationFeed([{ locale: 'sv' }]);
        feeds = stubFeeds(routes);
        const block = await render();

        expect(has(block, '.wq-item')).to.equal(true);
        expect(has(block, '.wq-locale-unknown')).to.equal(true);
      },
    );

    it('restricts detail rows to one group when asked', async () => {
      const routes = feedsWithDetail();
      routes[FEEDS.txEscalations] = escalationFeed([
        { group: 'meetups', summary: 'A' },
        { group: 'bios', summary: 'B' },
      ]);
      feeds = stubFeeds(routes);
      const block = await render({ group: 'bios' });

      expect([...block.querySelectorAll('.wq-summary')].map((n) => textOf(n)))
        .to.deep.equal(['B']);
    });
  });

  describe('a dangling queue name', () => {
    it('is surfaced as a warning rather than silently dropped', async () => {
      feeds = stubFeeds({
        [FEEDS.txRollup]: txRollup({
          queues: [{ locale: 'de', queue: 'needs-vibes-check', count: 7 }],
        }),
        ...emptyEscalations(),
      });
      const block = await render();
      const warn = warnings(block);

      expect(warn).to.contain('"needs-vibes-check"');
      expect(warn).to.contain('not defined in the model');
      // The PAIR count, not the row count: seven pairs nobody owns must not report as
      // "appears once".
      expect(warn).to.contain('7 pair(s)');
      expect(warn).to.contain('no owner');
    });

    it('does not invent a section, a label or an owner for it', async () => {
      feeds = stubFeeds({
        [FEEDS.txRollup]: txRollup({
          queues: [{ locale: 'de', queue: 'needs-vibes-check', count: 7 }],
        }),
        ...emptyEscalations(),
      });
      const block = await render();

      // Rendering it as a queue would imply somebody is being asked to clear it. Nobody
      // is — that is the whole defect.
      expect(queueTitles(block)).to.deep.equal([]);
      expect(countOf(block, '.wq-queue')).to.equal(0);
    });

    it('catches one that arrives on an escalation row, and names the page', async () => {
      feeds = stubFeeds({
        [FEEDS.txRollup]: txRollup(),
        [FEEDS.escalations]: escalationFeed([]),
        [FEEDS.txEscalations]: escalationFeed([
          { queue: 'retranslate-retry', 'page-path': '/en/meetups/berlin' },
        ]),
      });
      const block = await render();
      const warn = warnings(block);

      expect(warn).to.contain('"retranslate-retry"');
      expect(warn).to.contain('/en/meetups/berlin');
      expect(warn).to.contain('an escalation feed');
    });

    it('names a dangling queue in the authored config too', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: txRollup(), ...emptyEscalations() });
      const block = await render({ queue: 'needs-vibes-check' });
      const warn = warnings(block);

      expect(warn).to.contain('"needs-vibes-check"');
      // Listing the real ids is what turns a dead board into a fixable typo.
      expect(warn).to.contain(QUEUES[0].id);
    });
  });
});
