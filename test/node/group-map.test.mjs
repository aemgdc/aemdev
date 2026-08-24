/**
 * group-map.test.mjs — the group resolver's four load-bearing behaviours.
 *
 *   npm run test:node          (node --test "test/node/*.test.mjs")
 *
 * Node's own test runner rather than web-test-runner: the module under test is
 * `tools/tracker/**.mjs`, which is Node-only by design (`.mjs` is unserveable from
 * preview.da.live, so it must never enter a browser import graph — see
 * tools/tracker/check-browser-modules.mjs). Running it in the browser harness would
 * assert the opposite of that rule.
 *
 * Each case below is a bug that is cheap to reintroduce and silent when present:
 * a landing page in the wrong group looks like a tracked page, a dropped
 * `meetup-recaps` prefix looks like 14 pages that were never authored, an
 * un-normalized path looks like two pages where there is one, and a default bucket
 * looks like coverage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupForPath, pagetypeOf, GROUP_NAMES, MANUAL_PAGES, manualPagesFor,
} from '../../tools/tracker/lib/group-map.mjs';
import { loadConfig, groupNames } from '../../tools/tracker/config.mjs';

test('the /en/meetups landing page and its children are DIFFERENT groups', () => {
  // The landing page is a hand-built section index with its own judge brief and its
  // own visual baseline — a different BUILD from the 14 pages beneath it.
  assert.equal(groupForPath('/en/meetups'), 'indexes');
  assert.equal(groupForPath('/en/meetups/adaptto-2026-berlin'), 'meetups');
  // Same split on the articles side, where the prefix is shorter and the mistake is
  // therefore easier to make.
  assert.equal(groupForPath('/en/articles'), 'indexes');
  assert.equal(groupForPath('/en/articles/aem-eds-content-modeling-deep-dive'), 'technical-articles');
});

test('every landing page listed in `indexes` resolves to `indexes`, root home included', () => {
  for (const p of ['/', '/en', '/en/articles', '/en/meetups', '/en/contact']) {
    assert.equal(groupForPath(p), 'indexes', p);
  }
});

test('the meetups group accepts BOTH prefixes, so the rename survives either direction', () => {
  assert.equal(groupForPath('/en/meetups/post-adaptto-2025-meetup'), 'meetups');
  assert.equal(groupForPath('/en/meetup-recaps/post-adaptto-2025-meetup'), 'meetups');
  // The bare old landing page is not in the explicit `indexes` list (it no longer
  // exists), so it falls to the prefix rule rather than to nothing.
  assert.equal(groupForPath('/en/meetup-recaps'), 'meetups');
});

test('trailing slashes are normalized, so one page cannot become two rows', () => {
  // `/en/` is exactly how the live query index spells the locale home page, and the
  // slashed form 404s on this site — an un-normalized sync would record a 404 as a
  // tracked page AND keep a second row for the same page forever.
  assert.equal(groupForPath('/en/'), 'indexes');
  assert.equal(groupForPath('/en/meetups/'), 'indexes');
  assert.equal(groupForPath('/en/meetups/aem-meetup-miami/'), 'meetups');
  assert.equal(groupForPath('/en/articles/'), 'indexes');
  // The bare root must survive normalization intact rather than becoming ''.
  assert.equal(groupForPath('/'), 'indexes');
});

test('an unknown path resolves to NO group, never to a default bucket', () => {
  for (const p of ['/en/pricing', '/en/drafts/wip', '/tracker/data/groups/meetups', '/en/fragments/logos/x', '/nope']) {
    assert.equal(groupForPath(p), null, p);
  }
  // Empty and nullish inputs are `null` too, not an accidental match on '/'.
  assert.equal(groupForPath(''), null);
  assert.equal(groupForPath(null), null);
  assert.equal(groupForPath(undefined), null);
});

test('a LOCALE path resolves to no group — the data tab is keyed on EN paths', () => {
  // Accepting these would let a locale row be reconciled into the master tab as if it
  // were a page of its own, doubling the denominator.
  assert.equal(groupForPath('/de/meetups/aem-meetup-munich'), null);
  assert.equal(groupForPath('/zh-cn/articles/x'), null);
});

test('bios resolve by prefix and nothing else under /en/fragments does', () => {
  assert.equal(groupForPath('/en/fragments/bios/jane-doe'), 'bios');
  assert.equal(groupForPath('/en/fragments/bios'), 'bios');
  assert.equal(groupForPath('/en/fragments/nav'), null);
});

test('pagetypeOf is derived from the path and is locale-tolerant', () => {
  assert.equal(pagetypeOf('/'), 'home');
  assert.equal(pagetypeOf('/en'), 'home');
  assert.equal(pagetypeOf('/en/'), 'home');
  assert.equal(pagetypeOf('/en/meetups'), 'index');
  assert.equal(pagetypeOf('/en/articles'), 'index');
  assert.equal(pagetypeOf('/en/contact'), 'page');
  assert.equal(pagetypeOf('/en/meetups/aem-meetup-miami'), 'meetup');
  assert.equal(pagetypeOf('/en/articles/deep-dive'), 'article');
  assert.equal(pagetypeOf('/en/fragments/bios/jane-doe'), 'bio');
  assert.equal(pagetypeOf('/en/pricing'), '');
  // A locale row and its English source must agree about the kind, so the locale
  // prefix is stripped rather than treated as an unknown section.
  assert.equal(pagetypeOf('/de/meetups/aem-meetup-munich'), 'meetup');
  assert.equal(pagetypeOf('/ja/articles/deep-dive'), 'article');
  assert.equal(pagetypeOf('/zh-tw'), 'home');
});

test('the group name list matches the orchestrator registry, in registry order', () => {
  assert.deepEqual(GROUP_NAMES, ['indexes', 'meetups', 'technical-articles', 'bios']);
  /*
   * Read against the REAL registry rather than only a literal. The resolver and
   * .tracker/orchestrator.json have to agree exactly: a group this map can produce but
   * the registry does not know has nowhere to write, and a registered group this map
   * can never produce silently stays empty forever with nothing pointing at it.
   */
  assert.deepEqual(GROUP_NAMES, groupNames(loadConfig()));
  // Every group a path can resolve to must be registered.
  const produced = new Set([
    groupForPath('/en/meetups'), groupForPath('/en/meetups/x'),
    groupForPath('/en/articles/x'), groupForPath('/en/fragments/bios/x'),
  ]);
  for (const g of produced) assert.ok(GROUP_NAMES.includes(g), g);
});

test('the root home page is a declared manual row, because no index can list it', () => {
  assert.equal(MANUAL_PAGES.length, 1);
  assert.equal(MANUAL_PAGES[0].path, '/');
  assert.equal(MANUAL_PAGES[0].group, 'indexes');
  assert.deepEqual(manualPagesFor('meetups'), []);
  assert.equal(manualPagesFor('indexes').length, 1);
});
