/*
 * Fixtures for the tracker board tests.
 *
 * Every shape here is built FROM the model — `PAGE_STAGES`, `QUEUES`, `TARGET_LOCALES` —
 * rather than typed out, for the same reason the feed carries its own `stages` tab: a
 * hand-written fixture is a second copy of the contract, and a test that passes against
 * a stale copy is worse than no test. Add a stage to the model and these rows grow a
 * column without anyone remembering to.
 *
 * The page counts are the live inventory: 19 English pages across four groups, with
 * `bios` legitimately at zero until its roster is seeded. That matters because a group
 * with no pages and a group with no PROGRESS are the two states these boards must never
 * conflate, and only a fixture that contains both can prove they do not.
 */

import { PAGE_STAGES, PROGRESS_BUCKETS, QUEUES } from '../../scripts/tracker/stages.js';
import { TARGET_LOCALES, locale as localeFor } from '../../scripts/tracker/locales.js';
import { clearDataCache } from '../../scripts/tracker/data.js';
import { TRACKER_DATA } from '../../scripts/tracker/paths.js';
import { UNASSIGNED, subgroupKey, subgroupSlug } from '../../scripts/tracker/subgroups.js';

/** The four registered groups, and the English pages each holds today. */
export const GROUP_PAGES = {
  indexes: 4,
  meetups: 14,
  'technical-articles': 1,
  bios: 0,
};

export const GROUPS = Object.keys(GROUP_PAGES);

/** Every stage column a wide row carries, `blocked` included. */
export const STAGE_COLUMNS = [...PAGE_STAGES.map((s) => s.id), 'blocked'];

const zeroStages = () => Object.fromEntries(STAGE_COLUMNS.map((c) => [c, 0]));

/** Wrap rows in the DA multi-sheet envelope. A single-sheet feed is refused at preview. */
export function feedDoc(tabs) {
  const doc = { ':type': 'multi-sheet', ':names': Object.keys(tabs) };
  for (const [name, rows] of Object.entries(tabs)) {
    doc[name] = {
      total: rows.length, limit: rows.length, offset: 0, data: rows,
    };
  }
  return doc;
}

/** The `stages` vocabulary tab, exactly as `build-rollup` emits it. */
export const stageTab = () => [
  ...PAGE_STAGES.map((s, i) => ({
    id: s.id, label: s.label, short: s.short, hint: s.hint, order: i,
  })),
  {
    id: 'blocked',
    label: 'Blocked',
    short: 'BLK',
    hint: 'Out of the funnel entirely.',
    order: PAGE_STAGES.length,
  },
];

/**
 * One (locale, group) wide row.
 *
 * `stages` is a partial override; anything not named stays zero, and `counted` defaults
 * to the group's page count so the row's columns can legitimately add up to it.
 */
export function groupRow(locale, group, stages = {}) {
  const counted = GROUP_PAGES[group] ?? 0;
  const filled = { ...zeroStages(), ...stages };
  const placed = STAGE_COLUMNS.reduce((a, c) => a + filled[c], 0);
  return {
    locale,
    group,
    total: counted,
    counted,
    ...filled,
    // Whatever the caller did not place explicitly sits at the English gate, which is
    // where every pair really is today.
    enPublished: filled.enPublished + Math.max(0, counted - placed),
  };
}

/** The `locales` tab row for one locale: its four group rows, summed. */
export function localeRow(code, rows) {
  const mine = rows.filter((r) => r.locale === code);
  const known = localeFor(code);
  const sum = (col) => mine.reduce((a, r) => a + Number(r[col] || 0), 0);
  return {
    locale: code,
    name: known ? known.name : code,
    native: known ? known.native : code,
    total: sum('total'),
    counted: sum('counted'),
    ...Object.fromEntries(STAGE_COLUMNS.map((c) => [c, sum(c)])),
    ...Object.fromEntries(PROGRESS_BUCKETS.map((b) => [`b_${b.id}`, 0])),
  };
}

/** The `queues` tab: every locale × every queue, zero unless overridden. */
export function queueTab(overrides = []) {
  const key = (l, q) => `${l} ${q}`;
  const wanted = new Map(overrides.map((o) => [key(o.locale, o.queue), Number(o.count || 0)]));
  const rows = [];
  for (const code of TARGET_LOCALES) {
    for (const q of QUEUES) {
      rows.push({
        locale: code,
        queue: q.id,
        label: q.label,
        owner: q.owner,
        count: wanted.get(key(code, q.id)) ?? 0,
      });
    }
  }
  // Anything the caller named that is NOT a model queue is appended verbatim — that is
  // the dangling-id case, and coercing it here would hide exactly what is under test.
  for (const o of overrides) {
    if (!QUEUES.some((q) => q.id === o.queue)) {
      rows.push({
        locale: o.locale,
        queue: o.queue,
        label: o.label || '',
        owner: o.owner || '',
        count: Number(o.count || 0),
      });
    }
  }
  return rows;
}

export const META_STAMP = '2026-08-24T01:00:00.000Z';

/** The provenance row every feed carries. `extra` overrides any field. */
export function metaTab(extra = {}) {
  return [{
    generated: META_STAMP,
    generatedAt: META_STAMP,
    branch: 'main',
    expected: 190,
    listed: 190,
    withheld: 0,
    incomplete: '',
    'groups-failed': '',
    locales: TARGET_LOCALES.length,
    groups: GROUPS.length,
    'cells-nonzero': 0,
    'cells-listed': 0,
    'cells-withheld': 0,
    ...extra,
  }];
}

/**
 * A complete tx-rollup feed.
 *
 * @param {object} [opts]
 * @param {Array}  [opts.cells]   `[locale, group, { stage: n }]` triples to place
 * @param {Array}  [opts.queues]  `{ locale, queue, count }` overrides
 * @param {Array}  [opts.locales] restrict which locales appear in the feed at all
 * @param {object} [opts.meta]    meta-row overrides
 */
export function txRollup(opts = {}) {
  const codes = opts.locales || TARGET_LOCALES;
  const placed = new Map((opts.cells || []).map(([l, g, s]) => [`${l} ${g}`, s]));
  const rows = [];
  for (const code of codes) {
    for (const group of GROUPS) {
      rows.push(groupRow(code, group, placed.get(`${code} ${group}`) || {}));
    }
  }
  return feedDoc({
    meta: metaTab(opts.meta),
    locales: codes.map((code) => localeRow(code, rows)),
    groups: rows,
    cells: [],
    queues: queueTab(opts.queues),
    stages: stageTab(),
  });
}

/* ------------------------------------------------------- the English side (rollup.json) */

/*
 * `rollup.json` is a DIFFERENT shape from `tx-rollup.json`, not a subset of it, and the
 * difference is the thing most easily got wrong: its `groups` and `queues` rows carry NO
 * `locale` column, because the unit on this side is a PAGE and not a (page, locale) pair.
 * A fixture that reuses `groupRow()` here would hand the board a `locale` field the real
 * feed never has, and a board that had come to depend on one would pass the test and
 * break on the real feed.
 */

/** One `groups`-tab row. `stages` is a partial override; the rest sit at the EN gate. */
export function enGroupRow(group, stages = {}) {
  const counted = GROUP_PAGES[group] ?? 0;
  const filled = { ...Object.fromEntries(STAGE_COLUMNS.map((c) => [c, 0])), ...stages };
  const placed = STAGE_COLUMNS.reduce((a, c) => a + filled[c], 0);
  return {
    group,
    total: counted,
    counted,
    ...filled,
    enPublished: filled.enPublished + Math.max(0, counted - placed),
  };
}

/** One `subgroups`-tab row, carrying the derived `key`/`slug` the contract names. */
export function enSubgroupRow(group, subgroup, stages = {}) {
  const row = enGroupRow(group, stages);
  return {
    ...row,
    group,
    subgroup,
    key: subgroupKey(subgroup),
    slug: subgroupSlug(subgroup),
  };
}

/** The English `queues` tab: every model queue, zero unless overridden. */
export function enQueueTab(overrides = []) {
  const wanted = new Map(overrides.map((o) => [o.queue, Number(o.count || 0)]));
  return QUEUES.map((q) => ({
    queue: q.id,
    label: q.label,
    owner: q.owner,
    count: wanted.get(q.id) ?? 0,
  }));
}

/**
 * A complete `rollup.json`.
 *
 * The default is the live inventory as it really stands: 19 English pages, every one of
 * them at `enPublished`, nothing translated. Per the contract only `catalogued` and
 * `enPublished` can ever be non-zero on this side, so a fixture that lit up the later
 * stages here would be testing a feed the build cannot produce.
 *
 * @param {object} [opts]
 * @param {Array}  [opts.groups]     `[group, { stage: n }]` overrides
 * @param {Array}  [opts.subgroups]  `[group, name, { stage: n }]` rows to place
 * @param {Array}  [opts.queues]     `{ queue, count }` overrides
 * @param {object} [opts.meta]       meta-row overrides
 */
export function enRollup(opts = {}) {
  const placed = new Map((opts.groups || []).map(([g, s]) => [g, s]));
  const groups = GROUPS.map((g) => enGroupRow(g, placed.get(g) || {}));
  const sum = (col) => groups.reduce((a, r) => a + Number(r[col] || 0), 0);
  const queues = enQueueTab(opts.queues);
  return feedDoc({
    meta: metaTab({
      expected: sum('counted'), listed: sum('counted'), withheld: 0, ...opts.meta,
    }),
    totals: [{
      total: sum('total'),
      counted: sum('counted'),
      ...Object.fromEntries(STAGE_COLUMNS.map((c) => [c, sum(c)])),
      groups: groups.length,
      queued: queues.reduce((a, q) => a + q.count, 0),
    }],
    groups,
    subgroups: (opts.subgroups || []).map(([g, name, s]) => enSubgroupRow(g, name, s)),
    queues,
  });
}

/** The `(unassigned)` bucket is a real one, so a default breakdown names it. */
export const UNASSIGNED_SUBGROUP = UNASSIGNED;

/** An escalation feed. `rows` are merged onto a plausible default row. */
export function escalationFeed(rows = [], extra = {}) {
  return feedDoc({
    escalations: rows.map((row) => ({
      'page-path': '/en/meetups/adaptto-2026-berlin',
      locale: 'de',
      group: 'meetups',
      queue: 'escalations',
      scope: 'page',
      summary: 'The judge could not decide.',
      detail: '',
      tier: 'judge',
      confidence: 0.42,
      'first-seen': META_STAMP,
      attempts: 2,
      doc: '/tracker/tx/de/meetups/adaptto-2026-berlin',
      report: '.tracker/reports/tx/de--en--meetups--adaptto-2026-berlin.json',
      ...row,
    })),
    meta: metaTab({ expected: rows.length, listed: rows.length, ...extra }),
  });
}

/* ------------------------------------------------------------------- harness */

/**
 * Route TRACKER FEED fetches to fixtures. An unrouted feed path answers 404 — which is
 * what DA answers today for every one of them, so that is the real state and not a test
 * artefact.
 *
 * Scoped to `/tracker/data/**` and NOT to fetch in general, which is the hard-won part.
 * A blanket `window.fetch` stub also swallows web-test-runner's OWN reporting channel,
 * and the symptom is the worst possible one: every test passes normally, and the moment
 * one FAILS the run hangs at "did not finish within 120000ms" instead of naming the
 * failure. Verified by watching two deliberate mutations hang and then report properly
 * once the stub was narrowed.
 *
 * `clearDataCache()` on both ends is not optional either. The data layer memoises per
 * path in module scope, INCLUDING failures, and it outlives any single block — so
 * without the seam the second test in a file renders against the first test's feed and
 * passes for the wrong reason.
 */
export function stubFeeds(routes) {
  clearDataCache();
  const calls = [];
  const original = window.fetch;
  window.fetch = (input, ...rest) => {
    const path = String(input);
    if (!path.startsWith(TRACKER_DATA)) return original.call(window, input, ...rest);
    calls.push(path);
    const doc = routes[path];
    if (!doc) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, status: 200, json: async () => doc });
  };
  return {
    calls,
    restore: () => {
      window.fetch = original;
      clearDataCache();
    },
  };
}

/**
 * Author a block the way EDS delivers one — div per row, div per cell — and render it.
 *
 * Not attached to the document: `dom(block)` reads its Document off `ownerDocument`, so
 * a detached element is enough, and leaving forty test boards in the page makes every
 * later query ambiguous.
 */
export async function renderBlock(init, name, cfg = {}) {
  const block = document.createElement('div');
  block.className = name;
  for (const [key, value] of Object.entries(cfg)) {
    const row = document.createElement('div');
    const k = document.createElement('div');
    k.textContent = key;
    const v = document.createElement('div');
    v.textContent = value;
    row.append(k, v);
    block.append(row);
  }
  await init(block);
  return block;
}

/**
 * Does this root contain a match? A BOOLEAN, deliberately, never the node.
 *
 * `expect(block.querySelector(sel)).to.not.exist` reads better and is a trap. When it
 * FAILS the AssertionError's `actual` is a DOM element, web-test-runner cannot serialize
 * one back to the runner, and the whole run dies with "Browser tests did not finish
 * within 120000ms" and ZERO tests reported — instead of naming the assertion that broke.
 * Found by watching a deliberate mutation hang: the guard was working and the harness
 * could not say so, which is the worst possible failure mode for a test. Booleans and
 * counts always report.
 */
export const has = (root, sel) => Boolean(root && root.querySelector(sel));

/** How many matches. Same reason as `has`: a number survives the trip back. */
export const countOf = (root, sel) => (root ? root.querySelectorAll(sel).length : 0);

/** All the text a board rendered, whitespace-collapsed, for asserting on a message. */
export const textOf = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');
