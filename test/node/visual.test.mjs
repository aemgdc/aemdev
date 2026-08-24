/**
 * visual.test.mjs — the pure decision functions of the visual / layout QA tier.
 *
 * What is worth testing here is the JUDGEMENT, not the screenshots: which finding a
 * given pair of measurements produces, what severity it gets in an expanding versus a
 * contracting locale, how per-tile verdicts fold into one, and that a report merge
 * leaves the other tiers alone. All of that is deterministic and needs no browser and
 * no model — which is exactly why it belongs in a test rather than in a run log.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locale } from '../../scripts/tracker/locales.js';
import { explain } from '../../tools/tracker/check-deployed-modules.mjs';
import { resolveSide, selSlug } from '../../tools/tracker/visual-compare.mjs';
import { mergeVerdicts } from '../../tools/tracker/visual-judge.mjs';
import { compareGeometry, growthToleranceFor, mergeReport } from '../../tools/tracker/tx-visual.mjs';
import { DEFAULT_WIDTHS, defaultWaitUntil, viewportFor } from '../../tools/tracker/lib/shots.mjs';

/* ------------------------------------------------------------------ shots.mjs */

test('the three widths are the project convention, widest first', () => {
  assert.deepEqual(DEFAULT_WIDTHS, [2360, 1280, 390]);
});

test('390 gets phone emulation and a real 390 viewport — the source defect', () => {
  const mobile = viewportFor(390);
  assert.equal(mobile.viewport.width, 390);
  assert.equal(mobile.isMobile, true);
  assert.equal(mobile.deviceScaleFactor, 2);
  const desktop = viewportFor(1280);
  assert.equal(desktop.isMobile, false);
  assert.equal(desktop.deviceScaleFactor, 1);
});

test('networkidle only for hosts that go quiet', () => {
  assert.equal(defaultWaitUntil('https://main--aemdev--aemgdc.aem.page/en/'), 'networkidle');
  assert.equal(defaultWaitUntil('https://www.aemdev.org/en/'), 'networkidle');
  assert.equal(defaultWaitUntil('https://example.com/x'), 'domcontentloaded');
  assert.equal(defaultWaitUntil('not a url'), 'domcontentloaded');
});

/* --------------------------------------------------- check-deployed-modules */

test('404 and 401 get different explanations — the whole point of the tool', () => {
  assert.equal(explain(200, 'aem.page'), null);
  const absent = explain(404, 'aem.page');
  const unserved = explain(401, 'preview.da.live');
  assert.match(absent, /ABSENT/);
  assert.match(unserved, /EXTENSION IS NOT SERVED/);
  assert.notEqual(absent, unserved);
  // A request that never landed is not a 404: nothing may be concluded from it.
  assert.match(explain(0, 'aem.live'), /no verdict/i);
});

/* ---------------------------------------------------------- visual-compare */

test('side specs resolve through paths.js, never a hardcoded host', () => {
  assert.equal(
    resolveSide('/en/meetups/x', 'main').url,
    'https://main--aemdev--aemgdc.aem.page/en/meetups/x',
  );
  assert.equal(
    resolveSide('live:/en/meetups/x', 'main').url,
    'https://main--aemdev--aemgdc.aem.live/en/meetups/x',
  );
  assert.equal(resolveSide('prod:/en/x', 'main').url, 'https://www.aemdev.org/en/x');
  // A branch with capitals must be lowercased or the host does not resolve.
  assert.match(resolveSide('/en/x', 'EDGE-153').url, /^https:\/\/edge-153--/);
  // A literal URL keeps its own path, so the output directory is still named by page.
  assert.equal(resolveSide('https://example.com/a/b').path, '/a/b');
  assert.throws(() => resolveSide('nonsense:/en/x', 'main'), /unknown surface/);
  assert.throws(() => resolveSide('en/x', 'main'), /absolute path/);
});

test('selector slugs are filesystem-safe and readable', () => {
  assert.equal(selSlug('.hero.spotlight'), 'hero-spotlight');
  assert.equal(selSlug('main'), 'main');
  assert.equal(selSlug(null), 'fullpage');
});

/* ------------------------------------------------------------- visual-judge */

test('per-tile verdicts fold: damage fails, a hedge escalates, silence passes', () => {
  const clean = { label: 't1', verdict: { damaged: false, summary: 'fine', findings: [] } };
  assert.equal(mergeVerdicts([clean]).verdict, 'pass');

  const damaged = {
    label: 't2',
    verdict: {
      damaged: true,
      summary: 'button clipped',
      findings: [{
        severity: 'error', kind: 'clipped', detail: 'cut off', side: 'right',
      }],
    },
  };
  assert.equal(mergeVerdicts([clean, damaged]).verdict, 'fail');

  const hedged = {
    label: 't3',
    verdict: {
      damaged: false,
      summary: 'maybe',
      findings: [{
        severity: 'warning', kind: 'overflow', detail: 'not sure', side: 'right',
      }],
    },
  };
  assert.equal(mergeVerdicts([hedged]).verdict, 'escalate');

  // A tile the model could not answer about is never a pass.
  const broken = { label: 't4', verdict: null, error: 'invalid JSON' };
  assert.equal(mergeVerdicts([clean, broken]).verdict, 'escalate');

  // A finding carries the tile it came from, so a reviewer can find it.
  assert.equal(mergeVerdicts([damaged]).findings[0].tile, 't2');
});

test('an error finding fails even when the model said damaged: false', () => {
  const contradictory = {
    label: 't',
    verdict: {
      damaged: false,
      summary: 'all good',
      findings: [{
        severity: 'error', kind: 'missing', detail: 'the whole hero is gone', side: 'right',
      }],
    },
  };
  assert.equal(mergeVerdicts([contradictory]).verdict, 'fail');
});

/* ----------------------------------------------------------------- tx-visual */

const DE = locale('de');
const ZH = locale('zh-cn');

/** A measurement fixture: one section, one block, with sane defaults. */
const comp = (over = {}) => ({
  key: 's0/block0:cards',
  tag: 'div',
  cls: 'cards',
  text: 'some text',
  chars: 9,
  w: 400,
  h: 100,
  x: 0,
  y: 0,
  scrollW: 400,
  clientW: 400,
  scrollH: 100,
  clientH: 100,
  hides: false,
  lines: 1,
  escapeRight: -10,
  escapeLeft: -10,
  fixedH: false,
  ...over,
});
const pageOf = (components, over = {}) => ({
  components,
  page: {
    scrollW: 1280, clientW: 1280, scrollH: 3000, ...over,
  },
});

test('growth tolerance scales with the locale, with a floor', () => {
  assert.equal(growthToleranceFor(DE), 1.625);
  // Contracting locales get the floor, not a tolerance below 1.
  assert.equal(growthToleranceFor(ZH), 1.5);
});

test('proportional German growth is silent; growth beyond the tolerance is not', () => {
  const en = pageOf([comp({ h: 100 })]);
  const proportional = pageOf([comp({ h: 130 })]);
  assert.deepEqual(compareGeometry(en, proportional, 1280, DE), []);

  const excessive = pageOf([comp({ h: 200 })]);
  const found = compareGeometry(en, excessive, 1280, DE);
  assert.equal(found.length, 1);
  assert.equal(found[0].check, 'grew');
  assert.equal(found[0].severity, 'warning');
  // The message must say the tolerance it applied, or the reviewer cannot argue with it.
  assert.match(found[0].detail, /1\.63x is expected/);
});

test('clipping is an error and names both boxes', () => {
  const en = pageOf([comp()]);
  const clipped = pageOf([comp({
    hides: true, scrollH: 260, clientH: 100, h: 100,
  })]);
  const found = compareGeometry(en, clipped, 390, DE);
  assert.equal(found.length, 1);
  assert.equal(found[0].check, 'clipped');
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].width, 390);
});

test('a box already clipped in English is not blamed on the translation', () => {
  const already = comp({ hides: true, scrollH: 260, clientH: 100 });
  assert.deepEqual(compareGeometry(pageOf([already]), pageOf([already]), 1280, DE), []);
});

test('page-level horizontal overflow is an error, but only if it got worse', () => {
  const en = pageOf([comp()], { scrollW: 1280 });
  const worse = pageOf([comp()], { scrollW: 1400 });
  const found = compareGeometry(en, worse, 390, DE);
  assert.equal(found.length, 1);
  assert.equal(found[0].check, 'page-overflow');
  assert.equal(found[0].severity, 'error');

  const alreadyBad = pageOf([comp()], { scrollW: 1400 });
  assert.deepEqual(compareGeometry(alreadyBad, alreadyBad, 390, DE), []);
});

test('an extra line is a note when the locale expands and a warning when it contracts', () => {
  const button = { key: 's0/a3', tag: 'a', cls: 'button' };
  const en = pageOf([comp({ ...button, lines: 1 })]);
  const wrapped = pageOf([comp({ ...button, lines: 2 })]);

  const german = compareGeometry(en, wrapped, 390, DE);
  assert.equal(german.length, 1);
  assert.equal(german[0].check, 'rewrapped');
  assert.equal(german[0].severity, 'note');

  const chinese = compareGeometry(en, wrapped, 390, ZH);
  assert.equal(chinese[0].severity, 'warning');
  assert.match(chinese[0].detail, /untranslated string/);
});

test('a fixed-height element that now overflows is an error in any locale', () => {
  const button = {
    key: 's0/a3', tag: 'a', cls: 'button', fixedH: true,
  };
  const en = pageOf([comp({ ...button, lines: 1 })]);
  const spilled = pageOf([comp({
    ...button, lines: 2, scrollH: 140, clientH: 100,
  })]);
  assert.equal(compareGeometry(en, spilled, 1280, DE)[0].severity, 'error');
});

test('a CJK block that came in short is a note, never a failure', () => {
  const en = pageOf([comp({ h: 300 })]);
  // 0.5x expansion predicts 150px; 90px is below the 0.7 fraction of that.
  const sparse = pageOf([comp({ h: 90 })]);
  const found = compareGeometry(en, sparse, 1280, ZH);
  assert.equal(found.length, 1);
  assert.equal(found[0].check, 'sparse');
  assert.equal(found[0].severity, 'note');
  // The same shrink in an EXPANDING locale is not this finding.
  assert.deepEqual(compareGeometry(en, sparse, 1280, DE).filter((f) => f.check === 'sparse'), []);
});

test('a row that lined up in English and no longer does is one finding, not three', () => {
  const row = [0, 1, 2].map((i) => comp({ key: `s0/block${i}:card`, h: 200, y: 500 }));
  const en = pageOf(row);
  const broken = pageOf([
    comp({ key: 's0/block0:card', h: 200, y: 500 }),
    comp({ key: 's0/block1:card', h: 260, y: 500 }),
    comp({ key: 's0/block2:card', h: 200, y: 500 }),
  ]);
  const found = compareGeometry(en, broken, 1280, DE).filter((f) => f.check === 'misaligned');
  assert.equal(found.length, 1);
  assert.equal(found[0].keys.length, 3);
});

test('a component missing from English is not compared at all', () => {
  // The structural tier owns "the DOMs differ"; a geometry comparison would only
  // describe it worse.
  const en = pageOf([]);
  const extra = pageOf([comp({ hides: true, scrollH: 999, clientH: 10 })]);
  assert.deepEqual(compareGeometry(en, extra, 1280, DE), []);
});

test('mergeReport writes tiers.visual and touches nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'txvisual-'));
  const file = join(dir, 'de--meetups--x.json');
  writeFileSync(file, JSON.stringify({
    'page-path': '/en/meetups/x',
    locale: 'de',
    group: 'meetups',
    template: 'meetup',
    tiers: {
      structural: { verdict: 'pass', checks: [], fatal: null },
      judge: { verdict: 'pass', confidence: 0.9 },
      visual: null,
    },
    verdict: 'pass',
  }));

  const merged = mergeReport(file, {
    enPath: '/en/meetups/x',
    locale: 'de',
    group: 'meetups',
    branch: 'main',
    en: 'https://en',
    translated: 'https://de',
    verdict: 'fail',
    why: '1 layout defect',
    widths: [2360, 1280, 390],
    errors: [{ severity: 'error', check: 'clipped', width: 390 }],
    warnings: [],
    notes: [],
    unreachable: [],
    expansion: 1.3,
    checks: { screenshots: ['/tmp/a.png'], growthTolerance: 1.625 },
  });

  assert.equal(merged.tiers.visual.verdict, 'fail');
  assert.deepEqual(merged.tiers.visual.widths, { 2360: 'pass', 1280: 'pass', 390: 'fail' });
  // Tiers 1 and 2 survive verbatim.
  assert.equal(merged.tiers.structural.verdict, 'pass');
  assert.equal(merged.tiers.judge.confidence, 0.9);
  /*
   * And the merged page verdict is NOT overwritten by a tier. data-contract.md §4:
   * tier verdicts are merged once, by the driver. A tier that stamps the top-level
   * verdict makes that merge unobservable.
   */
  assert.equal(merged.verdict, 'pass');
});

test('a tier that has not run stays null, never "pass"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'txvisual-'));
  const merged = mergeReport(join(dir, 'fresh.json'), {
    enPath: '/en/x',
    locale: 'ja',
    group: 'indexes',
    branch: 'main',
    en: 'https://en',
    translated: 'https://ja',
    verdict: 'escalate',
    why: 'page missing',
    widths: [1280],
    errors: [],
    warnings: [],
    notes: [],
    unreachable: [{ width: 1280, translated: 'HTTP 404' }],
    expansion: 0.6,
    checks: {},
  });
  assert.equal(merged.tiers.structural, null);
  assert.equal(merged.tiers.judge, null);
  assert.equal(merged.verdict, null);
  // A width nobody could measure is an escalation for that width, not a pass.
  assert.deepEqual(merged.tiers.visual.widths, { 1280: 'escalate' });
});
