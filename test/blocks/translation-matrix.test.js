import { expect } from '@esm-bundle/chai';
import init from '../../blocks/translation-matrix/translation-matrix.js';
import { FEEDS } from '../../scripts/tracker/paths.js';
import { TARGET_LOCALES, locale as localeFor } from '../../scripts/tracker/locales.js';
import { PAGE_STAGES } from '../../scripts/tracker/stages.js';
import {
  feedDoc, metaTab, stageTab, txRollup, stubFeeds, renderBlock, textOf, has,
} from './fixtures.js';

/*
 * The three states this board will actually be looked at in, in the order they became
 * true: no feed, a feed describing an untouched inventory, and a feed with progress.
 *
 * Nothing is translated on aemdev.org and no tracker feed exists in DA, so the first two
 * are not edge cases — they are the board. A test suite that only exercises the populated
 * matrix would pass against a block that renders a blank white area in production.
 */

const BLOCK = 'translation-matrix';
const render = (cfg) => renderBlock(init, BLOCK, cfg);
const bands = (block) => [...block.querySelectorAll('.tm-seg')].map((s) => s.dataset.band);

/** The cell at (locale row, group column) — headers excluded, so index by group order. */
function cellAt(block, code, groupIndex) {
  const row = [...block.querySelectorAll('tbody tr')]
    .find((tr) => textOf(tr.querySelector('.tm-locale-code')) === `/${code}`);
  return row ? row.querySelectorAll('td')[groupIndex] : null;
}

describe('translation-matrix', () => {
  let feeds;
  afterEach(() => {
    if (feeds) feeds.restore();
    feeds = null;
  });

  describe('the feed does not exist', () => {
    it('says what it wanted, where it looked and what to run', async () => {
      feeds = stubFeeds({});
      const block = await render();
      const text = textOf(block);

      expect(has(block, '.tm-panel-error')).to.equal(true);
      // Naming the path matters: it is how somebody checks whether the feed is there.
      expect(text).to.contain(FEEDS.txRollup);
      expect(text).to.contain('404');
      expect(text).to.contain('npm run rollup');
      // No 40 blank boxes. A matrix over data that does not exist is not a matrix.
      expect(has(block, 'table')).to.equal(false);
    });

    it('reads the feed path from paths.js and nothing else', async () => {
      feeds = stubFeeds({});
      await render();
      expect(feeds.calls).to.deep.equal([FEEDS.txRollup]);
    });
  });

  describe('the feed exists but describes nothing', () => {
    it('separates "built and empty" from "never built"', async () => {
      feeds = stubFeeds({
        [FEEDS.txRollup]: feedDoc({
          meta: metaTab(), locales: [], groups: [], cells: [], queues: [], stages: stageTab(),
        }),
      });
      const block = await render();
      const text = textOf(block);

      expect(has(block, '.tm-panel-empty')).to.equal(true);
      expect(has(block, '.tm-panel-error')).to.equal(false);
      expect(text).to.contain('group:sync');
      expect(has(block, 'table')).to.equal(false);
    });
  });

  describe('nothing translated — the state today', () => {
    it('names the command instead of rendering forty empty cells', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: txRollup() });
      const block = await render();

      expect(has(block, '.tm-panel-notice')).to.equal(true);
      expect(textOf(block.querySelector('.tm-panel-notice'))).to.contain('npm run tx:send');
    });

    it('still renders the real pre-translation inventory below the banner', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: txRollup() });
      const block = await render();

      // The English pages exist and are published. That inventory is the denominator
      // every percentage on every board divides by, so hiding it would hide real data.
      expect(has(block, 'table')).to.equal(true);
      expect(bands(block)).to.include('enPublished');
      expect(bands(block)).to.not.include('sentForTranslation');
    });

    it('is ten locales tall, from the registry rather than from the feed', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: txRollup({ locales: ['de', 'fr'] }) });
      const block = await render();

      expect(block.querySelectorAll('tbody tr')).to.have.length(TARGET_LOCALES.length);
    });

    it('shows an absent row as unknown, not as zero', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: txRollup({ locales: ['de', 'fr'] }) });
      const block = await render();

      // `?`, not `—`: the build did not describe Japanese, which is a different fact
      // from Japanese having nothing in it, and only one of the two is progress.
      const cell = cellAt(block, 'ja', 0);
      expect(has(cell, '.tm-cell-absent')).to.equal(true);
      expect(textOf(cell)).to.equal('?');
      expect(textOf(block.querySelector('.tm-warn-list'))).to.contain('ja');
    });

    it('shows a group with no pages as nothing expected, not as nothing done', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: txRollup() });
      const block = await render();

      // `bios` is real and empty: a registered group whose roster is not seeded.
      const biosColumn = 3;
      const cell = cellAt(block, 'de', biosColumn);
      expect(has(cell, '.tm-cell-none')).to.equal(true);
      expect(has(cell, '.tm-cell-absent')).to.equal(false);
      expect(cell.querySelector('a').title).to.contain('no pages tracked');
    });

    it('uses the native locale name and the code that keys every feed', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: txRollup() });
      const block = await render();
      const head = block.querySelector('tbody tr .tm-locale');

      expect(textOf(head.querySelector('.tm-locale-native'))).to.equal(localeFor('de').native);
      expect(textOf(head.querySelector('.tm-locale-code'))).to.equal('/de');
    });
  });

  describe('with progress', () => {
    const withProgress = () => txRollup({
      cells: [['de', 'meetups', { online: 3, inReview: 2, blocked: 1 }]],
    });

    it('drops the "nothing sent" banner as soon as anything has moved', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: withProgress() });
      const block = await render();
      expect(has(block, '.tm-panel-notice')).to.equal(false);
    });

    it('leads the cell with the furthest band reached', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: withProgress() });
      const block = await render();
      const cell = cellAt(block, 'de', 1);

      expect(textOf(cell.querySelector('.tm-lead-band'))).to.equal('LIVE');
      expect(textOf(cell.querySelector('.tm-lead-num'))).to.equal('3');
    });

    it('surfaces blocked pairs separately from the funnel', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: withProgress() });
      const block = await render();
      const cell = cellAt(block, 'de', 1);

      // Blocked is the one band that means somebody has to act, so it is never left to
      // be spotted inside a bar.
      expect(textOf(cell.querySelector('.tm-lead-blocked'))).to.contain('1');
      expect([...cell.querySelectorAll('.tm-seg')].map((s) => s.dataset.band))
        .to.include('blocked');
    });

    it('links each cell to the Page Tracker filtered to that locale and group', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: withProgress() });
      const block = await render();
      const { href } = cellAt(block, 'de', 1).querySelector('a');

      expect(href).to.contain('group=meetups');
      expect(href).to.contain('locale=de');
    });

    it('labels every band from the feed\'s own stage vocabulary', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: withProgress() });
      const block = await render();
      const labels = [...block.querySelectorAll('.tm-legend-label')].map((n) => textOf(n));

      for (const stage of PAGE_STAGES) expect(labels).to.contain(stage.label);
      expect(labels).to.contain('Blocked');
    });
  });

  describe('authored config', () => {
    it('restricts the locales it shows', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: txRollup() });
      const block = await render({ locales: 'de, ja' });

      expect(block.querySelectorAll('tbody tr')).to.have.length(2);
    });

    it('names a locale it could not match instead of rendering nothing', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: txRollup() });
      const block = await render({ locales: 'de xx' });

      expect(textOf(block.querySelector('.tm-warn-list'))).to.contain('"xx"');
      // Bad DATA in an authored cell must not take the board down with it.
      expect(block.querySelectorAll('tbody tr')).to.have.length(1);
    });

    it('names a group the roll-up does not carry, and says what it does carry', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: txRollup() });
      const block = await render({ groups: 'newsletters' });
      const warn = textOf(block.querySelector('.tm-warn-list'));

      expect(warn).to.contain('"newsletters"');
      expect(warn).to.contain('meetups');
      expect(has(block, 'table')).to.equal(true);
    });

    it('folds stages into progress bands in buckets view', async () => {
      feeds = stubFeeds({
        [FEEDS.txRollup]: txRollup({
          cells: [['de', 'meetups', { autoQaPass: 2, layoutQaPass: 1, sentForTranslation: 4 }]],
        }),
      });
      const block = await render({ view: 'buckets' });
      const shown = bands(block);

      // The two QA stages are one band from outside the pipeline. The fold comes from
      // `bucketForStage()` in the model, so the band ids are bucket ids.
      expect(shown).to.include('autoQa');
      expect(shown).to.include('sent');
      expect(shown).to.not.include('autoQaPass');
      expect(shown).to.not.include('layoutQaPass');
    });

    it('rejects an unknown view by name and falls back to stages', async () => {
      feeds = stubFeeds({ [FEEDS.txRollup]: txRollup() });
      const block = await render({ view: 'sparklines' });

      expect(textOf(block.querySelector('.tm-warn-list'))).to.contain('"sparklines"');
      expect(bands(block)).to.include('enPublished');
    });
  });

  describe('provenance', () => {
    it(
      'reports a withheld remainder rather than letting a short feed read as progress',
      async () => {
        feeds = stubFeeds({
          [FEEDS.txRollup]: txRollup({ meta: { expected: 190, listed: 150, withheld: 40 } }),
        });
        const block = await render();
        expect(textOf(block.querySelector('.tm-meta'))).to.contain('40 pairs were withheld');
      },
    );

    it(
      'reports an unread group sheet as an UNDERCOUNT, not as a withheld quantity',
      async () => {
        feeds = stubFeeds({
          [FEEDS.txRollup]: txRollup({ meta: { incomplete: 'yes', 'groups-failed': 'bios' } }),
        });
        const text = textOf((await render()).querySelector('.tm-meta'));

        // The contract forbids folding an unread sheet into `withheld`: one is a quantity
        // we know and the other is one we do not.
        expect(text).to.contain('UNDERCOUNT');
        expect(text).to.contain('bios');
      },
    );

    it('surfaces a locale the feed carries that the registry does not', async () => {
      const doc = txRollup();
      doc.groups.data.push({
        locale: 'sv', group: 'meetups', total: 1, counted: 1, enPublished: 1,
      });
      feeds = stubFeeds({ [FEEDS.txRollup]: doc });
      const block = await render();

      expect(textOf(block.querySelector('.tm-warn-list'))).to.contain('"sv"');
      expect(block.querySelectorAll('tbody tr')).to.have.length(TARGET_LOCALES.length);
    });
  });
});
