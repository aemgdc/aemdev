import { expect } from '@esm-bundle/chai';
import { renderDrawer } from '../../../tools/page-tracker/drawer.js';
import { localeStates, viewRow } from '../../../tools/page-tracker/rows.js';
import { indexLocaleRows } from '../../../scripts/tracker/stages.js';
import { TARGET_LOCALES } from '../../../scripts/tracker/locales.js';

/*
 * drawer.test.js — the per-page detail panel and the three write actions.
 *
 * Two rules are load-bearing here and both are about a control being SAFE rather than
 * about it looking right:
 *
 *   - `?readonly=1` must disable EVERY write control, and it is applied over one
 *     registry rather than at each creation site, so a control added later is covered
 *     the day it is written;
 *   - one busy gate across ALL of them, because every write is a read-modify-write of
 *     the whole group sheet and two of those racing lose a row while reporting success.
 */

const DATA_ROW = {
  'page-path': '/en/meetups/berlin',
  title: 'Berlin meetup',
  subgroup: 'adaptto-2026',
  'en-status': 'en-published',
};

const groupDoc = (localeTabs = {}) => ({
  ':type': 'multi-sheet',
  ':names': ['data', ...TARGET_LOCALES],
  data: { data: [DATA_ROW] },
  ...Object.fromEntries(TARGET_LOCALES.map((c) => [c, { data: localeTabs[c] || [] }])),
});

const mount = () => {
  const div = document.createElement('div');
  document.body.append(div);
  return div;
};

const ok = () => Promise.resolve({ ok: true, previewed: true });

function open(over = {}) {
  const host = mount();
  const doc = groupDoc(over.localeTabs);
  const row = over.row || DATA_ROW;
  const page = viewRow(row, over.localeRow || {}, over.code ?? 'de', 'main');
  const drawer = renderDrawer(page, {
    mount: host,
    readonly: Boolean(over.readonly),
    locales: localeStates(row, indexLocaleRows(doc), 'main'),
    report: over.report ?? null,
    onClose: over.onClose || (() => {}),
    onEnStatus: over.onEnStatus || ok,
    onReviewStatus: over.onReviewStatus || ok,
    onEscalation: over.onEscalation || ok,
  });
  host.append(drawer);
  return { host, drawer, page };
}

const writes = (drawer) => [...drawer.querySelectorAll('.pt-write')];

describe('page-tracker drawer.js', () => {
  afterEach(() => {
    document.body.textContent = '';
  });

  describe('one page, ten languages', () => {
    it('shows every registered locale, present or not', () => {
      const { drawer } = open({
        localeTabs: { de: [{ 'page-path': '/en/meetups/berlin', locale: 'de', previewed: 'yes' }] },
      });
      const codes = [...drawer.querySelectorAll('.pt-locale-table .pt-locale-code')]
        .map((n) => n.textContent);
      expect(codes).to.deep.equal(TARGET_LOCALES);
    });

    it('marks the focused locale so the drawer agrees with the row it came from', () => {
      const { drawer } = open({ code: 'ja' });
      const focused = drawer.querySelectorAll('.pt-locale-row-focus');
      expect(focused).to.have.length(1);
      expect(focused[0].querySelector('.pt-locale-code').textContent).to.equal('ja');
    });

    /*
     * A locale with no row has nothing to write a verdict ON — `setReviewStatus` would
     * have no row to find. Offering a select there would produce a control whose every
     * use fails, so it renders as an explained dash instead.
     */
    it('offers no verdict control for a locale that has no row at all', () => {
      const { drawer } = open({
        localeTabs: { de: [{ 'page-path': '/en/meetups/berlin', locale: 'de' }] },
      });
      const selects = drawer.querySelectorAll('.pt-locale-table select');
      expect(selects).to.have.length(1);
      const dash = drawer.querySelector('.pt-locale-table .pt-na');
      expect(dash.title).to.contain('tx:send');
    });
  });

  describe('the always-three tier chips', () => {
    it('renders three chips even with no report at all', () => {
      const { drawer } = open({ report: null });
      const chips = [...drawer.querySelectorAll('.pt-tier')];
      expect(chips).to.have.length(3);
      expect(chips.map((c) => c.dataset.state)).to.deep.equal(['not-run', 'not-run', 'not-run']);
    });

    /*
     * The distinction the panel exists for. Three states on screen at once, and the
     * "did not run" one says so in WORDS in the chip — not only in a tooltip, because a
     * grey chip a reader skims as a quiet pass is the failure being guarded against.
     */
    it('renders pass, fail and did-not-run as three visibly different states', () => {
      const { drawer } = open({
        report: {
          exists: true,
          report: {
            structural: 'pass', judge: 'fail', visual: '', verdict: 'fail', 'finding-count': 2,
          },
          findings: [
            { tier: 'judge', severity: 'high', detail: 'The heading is still English' },
            { tier: 'visual', severity: 'low', detail: 'Nav overflows', width: '390' },
          ],
          where: '/tracker/data/tx-reports/de--en--meetups--berlin.json',
        },
      });
      const chips = [...drawer.querySelectorAll('.pt-tier')];
      expect(chips.map((c) => c.dataset.state)).to.deep.equal(['pass', 'fail', 'not-run']);
      const notRun = chips[2];
      expect(notRun.textContent).to.contain('did not run');
      expect(notRun.dataset.state).to.not.equal('pass');
      expect(notRun.title.toLowerCase()).to.contain('not a pass');
      // The findings the pipeline already recorded are listed, so nobody re-finds them.
      expect(drawer.querySelectorAll('.pt-findings li')).to.have.length(2);
    });

    it('says where it looked and what to run when there is no report', () => {
      const { drawer } = open({
        report: {
          exists: false, report: null, findings: [], where: '/tracker/data/tx-reports/de--x.json',
        },
      });
      const text = drawer.textContent;
      expect(text).to.contain('/tracker/data/tx-reports/de--x.json');
      expect(text).to.contain('tx:batch');
      expect(text).to.contain('tx:publish');
    });
  });

  describe('readonly disables every write', () => {
    it('finds write controls at all in the writable case', () => {
      const { drawer } = open({
        localeTabs: { de: [{ 'page-path': '/en/meetups/berlin', locale: 'de' }] },
      });
      const controls = writes(drawer);
      // en-status select, the content-escalation button, and the de review select.
      expect(controls.length).to.be.at.least(3);
      expect(controls.every((c) => c.disabled === false)).to.equal(true);
    });

    it('disables every one of them, and says so', () => {
      const { drawer } = open({
        readonly: true,
        localeTabs: Object.fromEntries(
          TARGET_LOCALES.map((c) => [c, [{ 'page-path': '/en/meetups/berlin', locale: c }]]),
        ),
      });
      const controls = writes(drawer);
      expect(controls.length).to.be.at.least(12);
      const enabled = controls.filter((c) => !c.disabled);
      expect(enabled, `${enabled.length} write control(s) still enabled`).to.have.length(0);
      expect(drawer.querySelector('.pt-readonly').textContent).to.contain('readonly=1');
    });

    it('leaves reading and navigation alone', () => {
      const { drawer } = open({ readonly: true });
      expect(drawer.querySelectorAll('.pt-mini').length).to.be.at.least(3);
      expect(drawer.querySelector('.pt-locale-table')).to.exist;
    });
  });

  describe('one busy gate across all write controls', () => {
    it('freezes every control while any single write is in flight', async () => {
      let release;
      const pending = new Promise((res) => { release = res; });
      const { drawer } = open({
        localeTabs: { de: [{ 'page-path': '/en/meetups/berlin', locale: 'de' }] },
        onEscalation: () => pending,
      });
      const controls = writes(drawer);
      const flag = controls.find((c) => c.tagName === 'BUTTON');

      flag.click();
      await Promise.resolve();
      const stillEnabled = controls.filter((c) => !c.disabled);
      expect(stillEnabled, 'a control was left clickable during a write').to.have.length(0);

      release({ ok: true, previewed: true });
      await pending;
      await Promise.resolve();
      expect(controls.filter((c) => c.disabled)).to.have.length(0);
    });

    it('refuses a second write rather than racing it', async () => {
      let release;
      const pending = new Promise((res) => { release = res; });
      const calls = [];
      const { drawer } = open({
        localeTabs: { de: [{ 'page-path': '/en/meetups/berlin', locale: 'de' }] },
        onEscalation: () => { calls.push('flag'); return pending; },
        onEnStatus: () => { calls.push('en'); return ok(); },
      });
      const flag = writes(drawer).find((c) => c.tagName === 'BUTTON');
      const select = drawer.querySelector('.pt-field select');

      flag.click();
      await Promise.resolve();
      select.value = 'draft';
      select.dispatchEvent(new Event('change'));
      await Promise.resolve();
      expect(calls).to.deep.equal(['flag']);

      release({ ok: true, previewed: true });
      await pending;
    });
  });

  describe('write actions', () => {
    it('sends en-status values from the enum and reports the result', async () => {
      const seen = [];
      const record = (v) => {
        seen.push(v);
        return ok();
      };
      const { drawer } = open({ onEnStatus: record });
      const select = drawer.querySelector('.pt-field select');
      expect([...select.options].map((o) => o.value))
        .to.deep.equal(['', 'draft', 'en-previewed', 'en-published']);
      expect(select.value).to.equal('en-published');
      select.value = 'draft';
      select.dispatchEvent(new Event('change'));
      await Promise.resolve();
      await Promise.resolve();
      expect(seen).to.deep.equal(['draft']);
      expect(drawer.querySelector('.pt-field .pt-write-status').textContent).to.contain('saved');
    });

    it('sends a review-status with the locale it belongs to', async () => {
      const seen = [];
      const { drawer } = open({
        localeTabs: { fr: [{ 'page-path': '/en/meetups/berlin', locale: 'fr' }] },
        onReviewStatus: (code, value) => { seen.push([code, value]); return ok(); },
      });
      const select = drawer.querySelector('.pt-locale-table select');
      select.value = 'ready-for-review';
      select.dispatchEvent(new Event('change'));
      await Promise.resolve();
      await Promise.resolve();
      expect(seen).to.deep.equal([['fr', 'ready-for-review']]);
    });

    /*
     * A failed write must put the control BACK, not leave the screen claiming a value
     * the sheet does not carry. A select showing what was refused is a lie a reader
     * has no way to spot.
     */
    it('reverts the control and shows the reason when a write is refused', async () => {
      const { drawer } = open({
        onEnStatus: () => Promise.resolve({ ok: false, reason: 'the sheet changed since it was read' }),
      });
      const select = drawer.querySelector('.pt-field select');
      select.value = '';
      select.dispatchEvent(new Event('change'));
      await Promise.resolve();
      await Promise.resolve();
      expect(select.value).to.equal('en-published');
      expect(drawer.querySelector('.pt-field .pt-write-status').textContent)
        .to.contain('the sheet changed');
    });

    /*
     * The revert has to restore the OPTION, not the raw cell. A hand-typed
     * `EN-Published` matches no option value, so assigning the cell back would reset
     * the select to its first option and leave the screen showing "Not assessed" for a
     * page the sheet says is published — a refused write that lies about the data.
     */
    it('reverts correctly even when the stored cell is oddly cased', async () => {
      const { drawer } = open({
        row: { ...DATA_ROW, 'en-status': 'EN-Published' },
        onEnStatus: () => Promise.resolve({ ok: false, reason: 'nope' }),
      });
      const select = drawer.querySelector('.pt-field select');
      expect(select.value).to.equal('en-published');
      select.value = 'draft';
      select.dispatchEvent(new Event('change'));
      await Promise.resolve();
      await Promise.resolve();
      expect(select.value).to.equal('en-published');
    });

    it('offers the escalation as a raise/clear toggle, never as a verdict', async () => {
      const { drawer } = open();
      const flag = writes(drawer).find((c) => c.tagName === 'BUTTON');
      expect(flag.textContent).to.contain('Raise');
      const { drawer: raised } = open({ row: { ...DATA_ROW, 'content-escalation': 'yes' } });
      expect(writes(raised).find((c) => c.tagName === 'BUTTON').textContent).to.contain('Clear');
      // It coexists with a stage rather than replacing one — the panel says so.
      expect(raised.querySelector('.pt-flagbox').textContent).to.contain('coexists');
    });

    it('offers no control for translation-status, previewed or online', () => {
      const { drawer } = open({
        localeTabs: { de: [{ 'page-path': '/en/meetups/berlin', locale: 'de', previewed: 'yes' }] },
      });
      // Every writable control is either the en-status select, the flag button, or a
      // review select in the locale matrix. Nothing else may be interactive.
      for (const control of writes(drawer)) {
        const isReview = control.closest('.pt-col-review') !== null;
        const isEnglish = control.closest('.pt-field') !== null
          || control.closest('.pt-flagbox') !== null;
        expect(isReview || isEnglish, control.outerHTML).to.equal(true);
      }
    });
  });

  describe('the derived stage is explained on the spot', () => {
    it('shows the stage, its hint, and any model warning', () => {
      const { drawer } = open({
        localeRow: { 'page-path': '/en/meetups/berlin', 'translation-status': 'auto-qa-ok' },
      });
      expect(drawer.querySelector('.pt-stage-line .pt-stage').dataset.stage).to.equal('enpublished');
      expect(drawer.querySelector('.pt-warnings li').textContent).to.contain('preview host');
    });

    it('closes from the header button', () => {
      let closed = false;
      const { drawer } = open({ onClose: () => { closed = true; } });
      drawer.querySelector('.pt-drawer-head button').click();
      expect(closed).to.equal(true);
    });
  });
});
