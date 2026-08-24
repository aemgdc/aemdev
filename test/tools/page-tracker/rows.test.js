import { expect } from '@esm-bundle/chai';
import {
  BLOCKED,
  activeFilters,
  applyFilters,
  buildRows,
  localeStates,
  queueOptions,
  stageOptions,
  subGroupOptions,
  tierStates,
  viewRow,
} from '../../../tools/page-tracker/rows.js';
import {
  PAGE_STAGES, QUEUES, TRANSLATION_STATUSES, classifyTranslation, indexLocaleRows,
} from '../../../scripts/tracker/stages.js';
import { TARGET_LOCALES } from '../../../scripts/tracker/locales.js';
import { UNASSIGNED } from '../../../scripts/tracker/subgroups.js';

/*
 * rows.test.js — the Page Tracker's row model.
 *
 * The rules under test are the ones that, if broken, would make the app internally
 * consistent and wrong: a stage read from a cell instead of derived, and a missing
 * locale row treated as an error instead of as the normal state of a rollout that has
 * not started.
 */

const DATA_ROW = {
  'page-path': '/en/meetups/berlin',
  title: 'Berlin meetup',
  template: 'meetup',
  pagetype: 'meetup',
  subgroup: 'adaptto-2026',
  'en-status': 'en-published',
};

/** A group doc with one page and whatever locale rows a test wants. */
const doc = (localeTabs = {}) => ({
  ':type': 'multi-sheet',
  ':names': ['data', ...TARGET_LOCALES],
  data: { data: [DATA_ROW] },
  ...Object.fromEntries(TARGET_LOCALES.map((code) => [code, { data: localeTabs[code] || [] }])),
});

const buildFor = (localeTabs, code) => {
  const d = doc(localeTabs);
  return buildRows({
    rows: d.data.data, localeIndex: indexLocaleRows(d), code, branch: 'main',
  });
};

describe('page-tracker rows.js', () => {
  describe('the stage is derived, never read', () => {
    /*
     * The load-bearing test. Nothing in this system stores a stage: a `stage` column
     * on a sheet is a cache of a derivation, and `classifyTranslation`'s step-4 clamp
     * exists precisely so a crawl can CORRECT one instead of trusting it. An app that
     * read the column would be a second implementation of the funnel.
     */
    it('ignores a stage column even when the sheet carries one', () => {
      const [page] = buildFor({
        de: [{
          'page-path': '/en/meetups/berlin',
          locale: 'de',
          // A stale, wrong, and very tempting cell.
          stage: 'online',
          'translation-status': 'auto-qa-ok',
          previewed: 'yes',
        }],
      }, 'de');
      expect(page.stage).to.equal('autoQaPass');
      expect(page.stage).to.not.equal('online');
    });

    it('agrees with classifyTranslation on every input, by construction', () => {
      const localeRow = {
        'page-path': '/en/meetups/berlin',
        locale: 'de',
        'translation-status': 'visual-qa-ok',
        previewed: 'yes',
      };
      const page = viewRow(DATA_ROW, localeRow, 'de', 'main');
      const model = classifyTranslation(DATA_ROW, localeRow);
      expect(page.stage).to.equal(model.stage);
      expect(page.blocked).to.equal(model.blocked);
      expect(page.queues).to.deep.equal(model.queues);
    });

    /*
     * The step-4 clamp, through the app. A page that was translated, judged and then
     * withdrawn from preview must NOT read `autoQaPass`, and the app must not be the
     * thing that reintroduces the stale answer.
     */
    it('clamps a recorded verdict when nothing answers on the preview host', () => {
      const [page] = buildFor({
        de: [{
          'page-path': '/en/meetups/berlin', locale: 'de', 'translation-status': 'auto-qa-ok',
        }],
      }, 'de');
      expect(page.stage).to.equal('enPublished');
      expect(page.warnings.join(' ')).to.contain('preview host');
    });

    it('falls through to the English gate in English mode', () => {
      const [page] = buildFor({}, null);
      expect(page.stage).to.equal('enPublished');
      expect(page.locale).to.equal(null);
    });
  });

  describe('a missing locale row', () => {
    /*
     * 19 pages times 10 locales is 190 pairs and today all 190 locale rows are absent.
     * The absent row is the NORMAL input, so it has to render as a state rather than
     * as a hole — and "not sent" is the enum's own first label, not a phrase the app
     * invented.
     */
    it('renders as "not sent" rather than crashing', () => {
      const rows = buildFor({}, 'ja');
      expect(rows).to.have.length(1);
      const [page] = rows;
      expect(page.missingLocaleRow).to.equal(true);
      expect(page.translationStatus).to.equal('');
      expect(page.translationLabel).to.equal(TRANSLATION_STATUSES[0].label);
      expect(page.translationLabel).to.equal('Not sent');
      expect(page.previewed).to.equal(false);
      expect(page.online).to.equal(false);
      expect(page.reviewStatus).to.equal('');
    });

    it('is distinguishable from a present-but-blank row', () => {
      const [absent] = buildFor({}, 'de');
      const [blank] = buildFor({
        de: [{ 'page-path': '/en/meetups/berlin', locale: 'de' }],
      }, 'de');
      expect(absent.missingLocaleRow).to.equal(true);
      expect(blank.missingLocaleRow).to.equal(false);
      // Same stage, different fact — which is why the flag exists at all.
      expect(blank.stage).to.equal(absent.stage);
    });

    it('survives a row whose locale tab is absent from the doc entirely', () => {
      const bare = { ':type': 'sheet', data: { data: [DATA_ROW] } };
      const rows = buildRows({
        rows: bare.data.data, localeIndex: indexLocaleRows(bare), code: 'zh-tw', branch: 'main',
      });
      expect(rows[0].missingLocaleRow).to.equal(true);
      expect(rows[0].stage).to.equal('enPublished');
    });
  });

  describe('localeStates', () => {
    it('is always all ten locales, in registry order, present or not', () => {
      const d = doc({ de: [{ 'page-path': '/en/meetups/berlin', locale: 'de', previewed: 'yes' }] });
      const states = localeStates(DATA_ROW, indexLocaleRows(d), 'main');
      expect(states.map((s) => s.locale)).to.deep.equal(TARGET_LOCALES);
      expect(states.find((s) => s.locale === 'de').previewed).to.equal(true);
      expect(states.filter((s) => s.missingLocaleRow)).to.have.length(9);
    });
  });

  describe('tierStates — the always-three chips', () => {
    it('returns three tiers whatever the report says', () => {
      for (const report of [null, {}, { structural: 'pass' }]) {
        expect(tierStates(report).map((t) => t.id))
          .to.deep.equal(['structural', 'judge', 'visual']);
      }
    });

    /*
     * The distinction the whole panel exists for: `''` is "we did not look" and must
     * never render as `pass`. The publisher enforces the storage half (a tier that did
     * not run writes `''`, never `'pass'`); this is the rendering half.
     */
    it('never lets a tier that did not run look like a pass', () => {
      const states = tierStates({ structural: 'pass', judge: '', visual: 'fail' });
      const by = Object.fromEntries(states.map((s) => [s.id, s]));
      expect(by.structural.state).to.equal('pass');
      expect(by.judge.state).to.equal('not-run');
      expect(by.visual.state).to.equal('fail');
      expect(by.judge.state).to.not.equal('pass');
      expect(by.judge.title.toLowerCase()).to.contain('did not run');
    });

    it('reports every tier as not-run when there is no report at all', () => {
      expect(tierStates(null).every((t) => t.state === 'not-run')).to.equal(true);
    });

    it('shows an unrecognised verdict as itself rather than guessing', () => {
      const [structural] = tierStates({ structural: 'probably-fine' });
      expect(structural.state).to.equal('unknown');
      expect(structural.verdict).to.equal('probably-fine');
    });
  });

  describe('filter options come from the model', () => {
    it('offers every PAGE_STAGES id plus blocked', () => {
      const ids = stageOptions([]).map((s) => s.id);
      expect(ids).to.deep.equal([...PAGE_STAGES.map((s) => s.id), BLOCKED]);
    });

    it('offers every QUEUES id', () => {
      expect(queueOptions([]).map((q) => q.id)).to.deep.equal(QUEUES.map((q) => q.id));
    });

    it('counts stages and queues off the derived rows', () => {
      const rows = buildFor({
        de: [{
          'page-path': '/en/meetups/berlin',
          locale: 'de',
          'review-status': 'needs-retranslation',
        }],
      }, 'de');
      const blocked = stageOptions(rows).find((s) => s.id === BLOCKED);
      expect(blocked.count).to.equal(1);
      expect(queueOptions(rows).find((q) => q.id === 'retranslate').count).to.equal(1);
    });

    it('puts (unassigned) last, whatever its size', () => {
      const rows = [
        viewRow({ 'page-path': '/en/a' }, {}, null, 'main'),
        viewRow({ 'page-path': '/en/b' }, {}, null, 'main'),
        viewRow({ 'page-path': '/en/c', subgroup: 'deep-dives' }, {}, null, 'main'),
      ];
      expect(subGroupOptions(rows).map((o) => o.id)).to.deep.equal(['deep-dives', UNASSIGNED]);
    });
  });

  describe('applyFilters', () => {
    const rows = () => [
      viewRow({ 'page-path': '/en/meetups/berlin', title: 'Berlin', subgroup: 'adaptto-2026' }, {}, null, 'main'),
      viewRow({ 'page-path': '/en/articles/caching', title: 'Caching', 'en-status': 'en-published' }, {}, null, 'main'),
    ];

    it('matches everything when nothing is set', () => {
      expect(applyFilters(rows(), {})).to.have.length(2);
    });

    it('filters by stage', () => {
      expect(applyFilters(rows(), { stage: 'enPublished' })).to.have.length(1);
      expect(applyFilters(rows(), { stage: 'catalogued' })).to.have.length(1);
    });

    it('filters by subgroup, case-insensitively', () => {
      expect(applyFilters(rows(), { subGroup: 'ADAPTTO-2026' })).to.have.length(1);
    });

    it('searches path, title and subgroup', () => {
      expect(applyFilters(rows(), { text: 'caching' })).to.have.length(1);
      expect(applyFilters(rows(), { text: 'Berlin' })).to.have.length(1);
      expect(applyFilters(rows(), { text: 'adaptto' })).to.have.length(1);
      expect(applyFilters(rows(), { text: 'nothing-here' })).to.have.length(0);
    });

    it('treats blocked as a stage', () => {
      const blocked = viewRow(
        { 'page-path': '/en/x', 'en-status': 'en-published' },
        { 'review-status': 'needs-layout-fix' },
        'de',
        'main',
      );
      expect(applyFilters([blocked], { stage: BLOCKED })).to.have.length(1);
      expect(applyFilters([blocked], { stage: 'online' })).to.have.length(0);
    });
  });

  describe('activeFilters names what the empty state has to name', () => {
    it('is empty when nothing is filtered', () => {
      expect(activeFilters({})).to.deep.equal([]);
    });

    it('labels a stage by its model label, not its id', () => {
      const [f] = activeFilters({ stage: 'autoQaPass' });
      expect(f.key).to.equal('stage');
      expect(f.label).to.equal('Stage');
      expect(f.value).to.equal('Auto QA passed');
    });

    it('labels a queue by its model label', () => {
      expect(activeFilters({ queue: 'retranslate' })[0].value).to.equal('Needs retranslation');
    });

    it('names every active constraint, so the empty state can offer each one', () => {
      const active = activeFilters({
        stage: 'previewed', queue: 'terminology', subGroup: 'speakers', text: 'berlin',
      });
      expect(active.map((a) => a.key)).to.deep.equal(['stage', 'queue', 'subGroup', 'text']);
    });
  });

  describe('the stored statuses travel raw as well as labelled', () => {
    it('keeps the raw cell beside the label, so a sheet stays greppable', () => {
      const page = viewRow(
        DATA_ROW,
        { 'page-path': '/en/meetups/berlin', 'review-status': 'TRANSLATION OK', previewed: 'yes' },
        'de',
        'main',
      );
      expect(page.reviewStatus).to.equal('TRANSLATION OK');
      expect(page.reviewLabel).to.equal('Translation OK');
      expect(page.enStatus).to.equal('en-published');
      expect(page.enStatusLabel).to.equal('Published');
    });

    it('falls back to the raw value for a status nobody defined', () => {
      const page = viewRow(DATA_ROW, { 'review-status': 'looks fine to me' }, 'de', 'main');
      expect(page.reviewLabel).to.equal('looks fine to me');
    });
  });
});
