#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * build-rollup.mjs — read the four group sheets and publish the two aggregate feeds:
 * `/tracker/data/rollup.json` (the English side) and `/tracker/data/tx-rollup.json`
 * (the translation side).
 *
 * CLI SURFACE
 *   node tools/tracker/build-rollup.mjs [--dry-run|--apply] [--branch=<ref>]
 *        [--max-bytes=N] [--no-cells] [--no-subgroups] [--out=<dir>] [--help]
 *
 *   npm run rollup -- --dry-run          build, check, print the plan, write nothing
 *   npm run rollup -- --apply            build, check, publish both feeds
 *   npm run rollup -- --out=/tmp/feeds   write the exact bytes locally instead of DA
 *
 *   --dry-run        build and verify, write nothing. THE DEFAULT.
 *   --apply          write both feeds to DA and preview them.
 *   --publish        with --apply, also publish to the live host.
 *   --branch=<ref>   which ref the feeds describe and are previewed on. Default main.
 *   --max-bytes=N    size ceiling per feed (default 400000). See the ladder below.
 *   --no-cells       omit the tx-rollup `cells` detail tab.
 *   --no-subgroups   omit the rollup `subgroups` detail tab.
 *   --out=<dir>      write both docs under <dir> instead of publishing.
 *
 * ─── THE TWO INVARIANTS ARE ASSERTED, LIVE, EVERY RUN ───────────────────────
 *
 *   (a) for every group and every locale, the stage counts plus `blocked` equal
 *       `counted`;
 *   (b) a group's subgroups re-add to the group's own total, PER COLUMN — every stage,
 *       every queue, every progress bucket, and both totals. Not just the total: a
 *       bucket that dropped only its blocked rows would keep the totals honest and the
 *       columns wrong, and the accordion on the board would then disagree with the row
 *       it opens from.
 *
 * A build that cannot satisfy both FAILS LOUDLY and WRITES NOTHING (exit 1). Half an
 * answer published as a whole one is worse than no answer, because it gets believed for
 * a day. `(unassigned)` is a real bucket, not a filter, which is what makes (b)
 * checkable at all — see scripts/tracker/subgroups.js.
 *
 * Nothing here counts anything itself: `tally()` in scripts/tracker/stages.js is the
 * one tallier, shared with the boards and the DA app, so three views cannot disagree
 * about one number.
 *
 * ─── THE SIZE CEILING, AND WHY WITHHOLDING IS VISIBLE ───────────────────────
 *
 * A 685 KB feed was refused outright by the content bus; a 38 KB one went through. So
 * a feed that lists less than it knows is normal, and the ladder is:
 *
 *   1. full doc — `cells` carries only non-zero (locale, group, stage) triples,
 *      because a long-form table's absent row already means zero;
 *   2. over the ceiling → drop `cells` WHOLE, record `cells-withheld`;
 *   3. still over → drop `subgroups` WHOLE, record `subgroups-complete: ''`;
 *   4. still over → refuse (exit 3). The smallest honest form does not fit and that
 *      needs a human, not a truncation.
 *
 * Steps 2 and 3 drop a tab ENTIRELY rather than trimming it. A partial `subgroups` tab
 * is the dangerous state: a board summing it would silently disagree with the group
 * total it sits under, which is invariant (b) failing in the reader instead of here.
 *
 * ─── A GROUP THAT CANNOT BE READ IS NOT A GROUP WITH NO PAGES ───────────────
 *
 * A per-group read failure is a WARNING and the feed is still built — but it is
 * recorded as `incomplete: 'yes'` plus `groups-failed`, never folded into `withheld`.
 * `withheld` is a known quantity; an unread sheet is an unknown one, and claiming to
 * know how many pages we did not see is how an understated denominator makes the
 * rollout look further along than it is. ALL groups failing throws (exit 2).
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  built (and published, with --apply)
 *   1  an invariant failed, or a write landed and could not be confirmed. NOTHING was
 *      published in the invariant case.
 *   2  could not reach a verdict — no token, every group sheet unreadable, DA down.
 *   3  usage error, or the smallest honest feed is still over the size ceiling.
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { TARGET_LOCALES, locale as localeFor } from '../../scripts/tracker/locales.js';
import { FEEDS } from '../../scripts/tracker/paths.js';
import {
  PAGE_STAGES,
  QUEUES,
  PROGRESS_BUCKETS,
  tally,
  sheetRows,
  indexLocaleRows,
  localeRowFor,
} from '../../scripts/tracker/stages.js';
import {
  bySubgroup, subgroupSlug, isAssigned,
} from '../../scripts/tracker/subgroups.js';
import {
  loadConfig, groupConfig, groupNames, REPO_ROOT,
} from './config.mjs';
import { resolveToken, TOKEN_HINT, fetchStatusDocVersioned } from './lib/status-sheet.mjs';
import {
  SIZE_CEILING_BYTES,
  metaRow,
  feedDoc,
  docBytes,
  kb,
  withFeedTab,
  writeFeed,
  writeLocalFeed,
} from './lib/feed.mjs';

/** Stage columns, in funnel order, plus `blocked`. The order the boards render. */
const STAGE_COLUMNS = [...PAGE_STAGES.map((s) => s.id), 'blocked'];

const HELP = `rollup — build and publish rollup.json and tx-rollup.json.

  --dry-run        build and verify, write nothing (DEFAULT)
  --apply          write both feeds to DA and preview them
  --publish        with --apply, also publish them to the LIVE host. Needed
                   whenever the /tracker/ pages themselves are published:
                   a feed on only one host makes the board on the other
                   render its "nothing published yet" panel.
  --branch=<ref>   the ref the feeds describe (default: publish.branch, i.e. main)
  --max-bytes=N    per-feed size ceiling (default ${SIZE_CEILING_BYTES})
  --no-cells       omit the tx-rollup \`cells\` detail tab
  --no-subgroups   omit the rollup \`subgroups\` detail tab
  --out=<dir>      write both docs under <dir> instead of publishing
  --help           this text

Both invariants are checked every run; a violation writes NOTHING.

exit 0 ok · 1 invariant violated · 2 no verdict (no token / no readable sheet) · 3 usage or size`;

function parseArgs(args) {
  const o = {
    apply: false,
    branch: null,
    maxBytes: SIZE_CEILING_BYTES,
    cells: true,
    subgroups: true,
    out: null,
    publish: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--publish') o.publish = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--no-cells') o.cells = false;
    else if (a === '--no-subgroups') o.subgroups = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--max-bytes=')) o.maxBytes = Number(a.slice(12));
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isInteger(o.maxBytes) || o.maxBytes <= 0) throw new Error('--max-bytes must be a positive whole number');
  return o;
}

/* ------------------------------------------------------------------ the invariants */

/**
 * Invariant (a) for one tally: the funnel plus `blocked` accounts for every counted
 * pair.
 *
 * Structurally true today — `classifyTranslation` returns a stage or sets `blocked` —
 * and checked anyway, because the day a stage id is added to PAGE_STAGES without
 * `emptyStageCounts()` learning it, this is the only thing between a silent
 * under-count and a published number nobody can reproduce.
 *
 * @returns {string|null} the violation, or null
 */
export function stageSumViolation(label, t) {
  const sum = Object.values(t.stages).reduce((a, b) => a + b, 0);
  if (sum === t.counted) return null;
  const parts = Object.entries(t.stages).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' ');
  return `${label}: stage counts + blocked = ${sum} but counted = ${t.counted} (${parts || 'all zero'})`;
}

/**
 * Every column invariant (b) has to hold for, as `[name, read]` pairs.
 *
 * Derived from the tally's own shape rather than listed by hand, so a new stage, queue
 * or progress bucket is covered the moment it exists. A hand-maintained column list is
 * how a check comes to pass on the columns that were interesting when it was written.
 */
const sumColumns = (t) => [
  ['total', (x) => x.total],
  ['counted', (x) => x.counted],
  ...Object.keys(t.stages).map((k) => [`stage:${k}`, (x) => x.stages[k]]),
  ...Object.keys(t.queues).map((k) => [`queue:${k}`, (x) => x.queues[k]]),
  ...Object.keys(t.buckets).map((k) => [`bucket:${k}`, (x) => x.buckets[k]]),
];

/**
 * Invariant (b): the subgroup buckets re-add to the whole, per column.
 *
 * @param {string} label  the scope, for the message
 * @param {object} whole  the group's own tally
 * @param {Array<{name: string, tally: object}>} parts the per-subgroup tallies
 * @returns {string[]} one violation per column that does not add up
 */
export function subgroupSumViolations(label, whole, parts) {
  const out = [];
  for (const [name, read] of sumColumns(whole)) {
    const sum = parts.reduce((n, p) => n + read(p.tally), 0);
    const want = read(whole);
    if (sum !== want) {
      const breakdown = parts.map((p) => `${p.name}=${read(p.tally)}`).join(' + ') || '(no buckets)';
      out.push(`${label}: subgroups do not re-add on ${name} — ${breakdown} = ${sum}, group says ${want}`);
    }
  }
  return out;
}

/**
 * Check every scope this build produced.
 *
 * Exported and pure so a test can hand it a deliberately broken scope and watch the
 * guard go red. A guard nobody has watched fail is not a guard.
 *
 * @param {Array<{label: string, tally: object, subgroups: Array}>} scopes
 * @returns {string[]} every violation found, in scope order
 */
export function checkInvariants(scopes) {
  const violations = [];
  for (const s of scopes) {
    const a = stageSumViolation(s.label, s.tally);
    if (a) violations.push(a);
    for (const sub of s.subgroups || []) {
      const inner = stageSumViolation(`${s.label} / ${sub.name}`, sub.tally);
      if (inner) violations.push(inner);
    }
    violations.push(...subgroupSumViolations(s.label, s.tally, s.subgroups || []));
  }
  return violations;
}

/* ------------------------------------------------------------------ the tallying */

const PATH_COLUMN = 'page-path';

/** Tally one set of pairs, plus the same set partitioned by subgroup. */
function tallyScope(pairs) {
  return {
    tally: tally(pairs),
    subgroups: bySubgroup(pairs, (p) => p.row).map((b) => ({
      name: b.name, key: b.key, slug: subgroupSlug(b.name), tally: tally(b.rows),
    })),
  };
}

/**
 * Every scope one group contributes: its English side, and one per target locale.
 *
 * The English side pairs each row with an EMPTY locale row on purpose. That is exactly
 * what `classifyTranslation` expects for "no row in that locale" — it falls through to
 * `classifyEnglish` — so the English rollup answers "how many pages are even ready to
 * translate" without picking a locale, and it does it through the same tallier as
 * everything else rather than a second code path.
 */
function scopesForGroup(name, doc) {
  const rows = sheetRows(doc, 'data');
  const localeIndex = indexLocaleRows(doc);
  const en = tallyScope(rows.map((row) => ({ row, localeRow: {} })));
  const locales = {};
  for (const code of TARGET_LOCALES) {
    locales[code] = tallyScope(rows.map((row) => ({
      row,
      localeRow: localeRowFor(localeIndex, row[PATH_COLUMN], code),
    })));
  }
  return { name, rows: rows.length, en, locales };
}

/** The stage columns of a tally, as a flat object for a wide row. */
const stageCells = (t) => Object.fromEntries(STAGE_COLUMNS.map((c) => [c, t.stages[c] ?? 0]));

/**
 * Progress-bucket columns, prefixed `b_`.
 *
 * The prefix is not decoration: `online` is both a PAGE_STAGES id and a
 * PROGRESS_BUCKETS id, and unprefixed they would be one column with two definitions in
 * one row — the exact shadowing bug the source's locale row had, where `stage.blocked`
 * overwrote `tally.blocked` and gave one column name two meanings in one table.
 */
const bucketCells = (t) => Object.fromEntries(PROGRESS_BUCKETS.map((b) => [`b_${b.id}`, t.buckets[b.id] ?? 0]));

/* ---------------------------------------------------------------- the two feeds */

/** Sum a list of tallies into one, column by column. Used for the site-wide totals. */
function sumTallies(tallies) {
  const out = {
    total: 0, counted: 0, stages: {}, queues: {}, buckets: {},
  };
  for (const t of tallies) {
    out.total += t.total;
    out.counted += t.counted;
    for (const k of Object.keys(t.stages)) out.stages[k] = (out.stages[k] ?? 0) + t.stages[k];
    for (const k of Object.keys(t.queues)) out.queues[k] = (out.queues[k] ?? 0) + t.queues[k];
    for (const k of Object.keys(t.buckets)) out.buckets[k] = (out.buckets[k] ?? 0) + t.buckets[k];
  }
  return out;
}

/** The English-side feed. */
function buildRollup(groups, { branch, failed, subgroups }) {
  const site = sumTallies(groups.map((g) => g.en.tally));
  const groupRows = groups.map((g) => ({
    group: g.name,
    total: g.en.tally.total,
    counted: g.en.tally.counted,
    ...stageCells(g.en.tally),
    // Authored buckets only. `(unassigned)` is a real bucket for the SUM invariant
    // but it is not a label anyone chose, so a `subgroups: 1` on a sheet where nobody
    // has typed one would gate open a disclosure with nothing in it.
    subgroups: g.en.subgroups.filter((s) => isAssigned(s.name)).length,
  }));

  const subgroupRows = subgroups
    ? groups.flatMap((g) => g.en.subgroups.map((s) => ({
      group: g.name,
      subgroup: s.name,
      key: s.key,
      slug: s.slug,
      total: s.tally.total,
      counted: s.tally.counted,
      ...stageCells(s.tally),
    })))
    : [];

  const queueRows = QUEUES.map((q) => ({
    queue: q.id, label: q.label, owner: q.owner, count: site.queues[q.id] ?? 0,
  }));

  const totalsRow = {
    total: site.total,
    counted: site.counted,
    ...stageCells(site),
    groups: groupRows.length,
    'groups-read': groupRows.length,
    queued: Object.values(site.queues).reduce((a, b) => a + b, 0),
  };

  return feedDoc([
    ['meta', [metaRow({
      branch,
      expected: site.total,
      listed: site.counted,
      groupsFailed: failed,
      extra: {
        groups: groupRows.length,
        subgroups: subgroupRows.length,
        'subgroups-complete': subgroups ? 'yes' : '',
      },
    })]],
    ['totals', [totalsRow]],
    ['groups', groupRows],
    ['subgroups', subgroupRows],
    ['queues', queueRows],
  ]);
}

/** The translation-side feed. */
function buildTxRollup(groups, { branch, failed, cells }) {
  const localeRows = [];
  const groupRows = [];
  const cellRows = [];
  const queueRows = [];
  let expected = 0;
  let listed = 0;
  let nonZeroCells = 0;

  for (const code of TARGET_LOCALES) {
    const known = localeFor(code);
    const perGroup = groups.map((g) => ({ name: g.name, t: g.locales[code].tally }));
    const whole = sumTallies(perGroup.map((p) => p.t));
    expected += whole.total;
    listed += whole.counted;

    localeRows.push({
      locale: code,
      name: known.name,
      native: known.native,
      total: whole.total,
      counted: whole.counted,
      ...stageCells(whole),
      ...bucketCells(whole),
    });

    for (const { name, t } of perGroup) {
      groupRows.push({
        locale: code, group: name, total: t.total, counted: t.counted, ...stageCells(t),
      });
      for (const stage of STAGE_COLUMNS) {
        const count = t.stages[stage] ?? 0;
        if (count) {
          nonZeroCells += 1;
          if (cells) {
            cellRows.push({
              locale: code, group: name, counted: t.counted, stage, count,
            });
          }
        }
      }
    }

    for (const q of QUEUES) {
      queueRows.push({
        locale: code, queue: q.id, label: q.label, owner: q.owner, count: whole.queues[q.id] ?? 0,
      });
    }
  }

  /*
   * The vocabulary travels WITH the data. A board renders the labels this build
   * counted with, so it cannot drift out of step with scripts/tracker/stages.js — the
   * failure mode being a chip labelled from a stage list that no longer exists.
   */
  const stageRows = [
    ...PAGE_STAGES.map((s, i) => ({
      id: s.id, label: s.label, short: s.short, hint: s.hint, order: i,
    })),
    {
      id: 'blocked',
      label: 'Blocked',
      short: 'BLK',
      hint: 'Out of the funnel entirely; sits in a work queue until a human or a re-run clears it.',
      order: PAGE_STAGES.length,
    },
  ];

  return feedDoc([
    ['meta', [metaRow({
      branch,
      expected,
      listed,
      groupsFailed: failed,
      extra: {
        locales: TARGET_LOCALES.length,
        groups: groups.length,
        'cells-nonzero': nonZeroCells,
        'cells-listed': cellRows.length,
        'cells-withheld': cells ? 0 : nonZeroCells,
      },
    })]],
    ['locales', localeRows],
    ['groups', groupRows],
    ['cells', cellRows],
    ['queues', queueRows],
    ['stages', stageRows],
  ]);
}

/* -------------------------------------------------------------- the size ladder */

/**
 * Bring one doc under the ceiling by dropping DETAIL tabs whole, in the given order.
 *
 * Whole, never trimmed: a partial `subgroups` tab is a board that disagrees with the
 * row it opens from, which is invariant (b) failing in the reader rather than here.
 *
 * @returns {{ doc, notes: string[], refused: string|null }}
 */
export function fitToCeiling(doc, maxBytes, detailTabs) {
  const notes = [];
  let out = doc;
  for (const tab of detailTabs) {
    if (docBytes(out) <= maxBytes) return { doc: out, notes, refused: null };
    const dropped = out[tab]?.data?.length ?? 0;
    out = withFeedTab(out, tab, []);
    /*
     * The loss is recorded under the tab's own name, generically, so a tab added to the
     * ladder later cannot be dropped silently. The two named keys below are the ones the
     * blocks read, and they say something the generic count cannot: `cells-listed` is the
     * number a reader compares against `cells-nonzero`, and `subgroups-complete` is the
     * flag that stops a board summing a breakdown it only has part of.
     */
    const meta = { ...out.meta.data[0], [`${tab}-withheld`]: dropped };
    if (tab === 'cells') meta['cells-listed'] = 0;
    if (tab === 'subgroups') {
      meta.subgroups = 0;
      meta['subgroups-complete'] = '';
    }
    out = withFeedTab(out, 'meta', [meta]);
    notes.push(`over ${kb(maxBytes)} — dropped the whole "${tab}" tab (${dropped} row(s)); `
      + 'recorded in meta so a short feed reads as withheld, not as lost');
  }
  const size = docBytes(out);
  if (size <= maxBytes) return { doc: out, notes, refused: null };
  return {
    doc: out,
    notes,
    refused: `${kb(size)} with every detail tab already dropped, ceiling ${kb(maxBytes)}. `
      + 'The smallest honest form of this feed does not fit — that needs a decision, not a truncation.',
  };
}

/* --------------------------------------------------------------------- the build */

/**
 * Read every group sheet and build both docs.
 *
 * Exported for `watch-rollup`, which needs the same build without the CLI around it.
 * The token is resolved ONCE by the caller: a missing credential is one hard failure,
 * not four per-group 401s that read like four broken sheets.
 *
 * Reads the DA SOURCE, never the published copy. The published copy is what this tool
 * writes, so aggregating it would make the rollup a function of its own last run.
 */
export async function buildFeeds(cfg, token, opts) {
  const branch = opts.branch || cfg.publish?.branch;
  const names = groupNames(cfg);
  const groups = [];
  const failed = [];

  for (const name of names) {
    const sheetCfg = groupConfig(cfg, name);
    try {
      const { exists, doc } = await fetchStatusDocVersioned(sheetCfg, token);
      if (!exists) {
        failed.push(name);
        groups.push({ name, error: `sheet does not exist (${sheetCfg.path})` });
      } else {
        groups.push(scopesForGroup(name, doc));
      }
    } catch (e) {
      failed.push(name);
      groups.push({ name, error: e.message });
    }
  }

  const readable = groups.filter((g) => !g.error);
  if (!readable.length) {
    const why = groups.map((g) => `${g.name}: ${g.error}`).join('; ');
    throw new Error(`no group sheet could be read, so there is no denominator to publish — ${why}`);
  }

  const rollup = fitToCeiling(
    buildRollup(readable, { branch, failed, subgroups: opts.subgroups }),
    opts.maxBytes,
    ['subgroups'],
  );
  /*
   * Ladder order is least-costly-first. `cells` is a long-form projection of `groups`,
   * so dropping it loses no fact a board cannot recompute; `queues` carries real counts
   * and goes only when `cells` was not enough. Ten locales × ten queues is 100 rows of
   * mostly zeros, which is exactly the shape that pushes a feed over the ceiling while
   * carrying the least information per byte.
   */
  const txRollup = fitToCeiling(
    buildTxRollup(readable, { branch, failed, cells: opts.cells }),
    opts.maxBytes,
    ['cells', 'queues'],
  );

  const scopes = readable.flatMap((g) => [
    { label: `${g.name} / en`, tally: g.en.tally, subgroups: g.en.subgroups },
    ...TARGET_LOCALES.map((code) => ({
      label: `${g.name} / ${code}`,
      tally: g.locales[code].tally,
      subgroups: g.locales[code].subgroups,
    })),
  ]);

  return {
    branch,
    groups,
    readable,
    failed,
    rollup,
    txRollup,
    scopes,
    violations: checkInvariants(scopes),
    warnings: readable.flatMap((g) => g.en.tally.warnings.map((w) => ({ group: g.name, ...w }))),
  };
}

/* ---------------------------------------------------------------------- the plan */

const SAMPLE = 8;

function printPlan(built, opts) {
  console.log(`   branch: ${built.branch}`);
  for (const g of built.groups) {
    if (g.error) console.log(`   ✗ ${g.name}: ${g.error}`);
    else {
      console.log(`   ✓ ${g.name}: ${g.rows} data row(s) · ${g.en.tally.counted} counted · `
        + `${g.en.subgroups.length} subgroup bucket(s)`);
    }
  }
  if (built.failed.length) {
    console.log(`\n   ! ${built.failed.length} group(s) unreadable: ${built.failed.join(', ')}`);
    console.log('     recorded as meta.incomplete="yes" + groups-failed, NOT as meta.withheld —');
    console.log('     an unread sheet is an unknown page count, and withheld is a known one.');
  }

  for (const [name, feed, path] of [
    ['rollup.json', built.rollup, FEEDS.rollup],
    ['tx-rollup.json', built.txRollup, FEEDS.txRollup],
  ]) {
    const meta = feed.doc.meta.data[0];
    console.log(`\n   ── ${name} → ${path} ──`);
    console.log(`      size:  ${kb(docBytes(feed.doc))} (ceiling ${kb(opts.maxBytes)})`);
    console.log(`      tabs:  ${(feed.doc[':names'] || []).map((t) => `${t}(${feed.doc[t].data.length})`).join(' ')}`);
    console.log(`      units: expected ${meta.expected} · listed ${meta.listed} · withheld ${meta.withheld}`
      + `${meta.incomplete ? ` · INCOMPLETE (${meta['groups-failed']})` : ''}`);
    // Detail-row losses are counted separately from the unit counters above, and named,
    // so `withheld 0` next to a dropped tab reads as two different facts rather than a
    // contradiction: the units are all accounted for, the breakdown of them is not.
    const lost = Object.entries(meta).filter(([k, v]) => k.endsWith('-withheld') && v);
    for (const [k, v] of lost) console.log(`      ${k}: ${v} row(s)`);
    for (const n of feed.notes) console.log(`      withheld: ${n}`);
    if (feed.refused) console.log(`      ✗ REFUSED: ${feed.refused}`);
  }

  // The wide rows, printed as rows. A count cannot tell you whether the right value is
  // landing on the right row, which is the whole point of a plan.
  console.log('\n   rollup.groups:');
  for (const r of built.rollup.doc.groups.data) {
    console.log(`      ${r.group.padEnd(20)} total=${r.total} counted=${r.counted} `
      + `${STAGE_COLUMNS.filter((c) => r[c]).map((c) => `${c}=${r[c]}`).join(' ') || '(all stages zero)'}`);
  }
  const sub = built.rollup.doc.subgroups.data;
  if (sub.length) {
    console.log('   rollup.subgroups:');
    for (const r of sub.slice(0, SAMPLE)) {
      console.log(`      ${r.group}/${r.subgroup.padEnd(16)} total=${r.total} counted=${r.counted}`);
    }
    if (sub.length > SAMPLE) console.log(`      … ${sub.length - SAMPLE} more`);
  }
  console.log('   tx-rollup.locales:');
  for (const r of built.txRollup.doc.locales.data) {
    console.log(`      ${r.locale.padEnd(6)} total=${r.total} counted=${r.counted} `
      + `${STAGE_COLUMNS.filter((c) => r[c]).map((c) => `${c}=${r[c]}`).join(' ') || '(all stages zero)'}`);
  }

  if (built.warnings.length) {
    console.log(`\n   ${built.warnings.length} model warning(s) from the sheets (not a build failure):`);
    for (const w of built.warnings.slice(0, SAMPLE)) {
      console.log(`      ${w.group} ${w.path}${w.locale ? ` [${w.locale}]` : ''}: ${w.warning}`);
    }
    if (built.warnings.length > SAMPLE) console.log(`      … ${built.warnings.length - SAMPLE} more`);
  }
}

/* ---------------------------------------------------------------------- the run */

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const token = resolveToken();
  if (!token) {
    console.error(`ERROR: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }

  console.log(`── rollup · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} ──`);

  let built;
  try {
    built = await buildFeeds(cfg, token, opts);
  } catch (e) {
    console.error(`\n✗ REFUSED — nothing was published.\n  ${e.message}`);
    return 2;
  }
  printPlan(built, opts);

  /*
   * The gate. Checked before anything is written, and the two feeds are published
   * together or not at all: rollup.json and tx-rollup.json are read side by side on the
   * same board, so a half-published pair is two numbers that disagree in public.
   */
  if (built.violations.length) {
    console.error(`\n✗ INVARIANT VIOLATED — ${built.violations.length} failure(s). NOTHING was published.`);
    for (const v of built.violations) console.error(`   ${v}`);
    console.error('\n  Half an answer published as a whole one is worse than no answer: it gets');
    console.error('  believed for a day. Fix the sheet (a duplicate page-path is the usual cause)');
    console.error('  or the model, then re-run.');
    return 1;
  }
  console.log(`\n   ✓ invariants hold across ${built.scopes.length} scope(s) `
    + '(stage sums, and subgroups re-adding per column)');

  const refused = [built.rollup, built.txRollup].filter((f) => f.refused);
  if (refused.length) {
    console.error('\n✗ over the size ceiling with nothing left to withhold — nothing was published.');
    return 3;
  }

  if (opts.out) {
    const dir = isAbsolute(opts.out) ? opts.out : join(REPO_ROOT, opts.out);
    for (const [path, feed] of [[FEEDS.rollup, built.rollup], [FEEDS.txRollup, built.txRollup]]) {
      console.log(`   wrote ${writeLocalFeed(dir, path, feed.doc)}`);
    }
    return 0;
  }

  if (!opts.apply) {
    console.log('\n   Re-run with --apply to publish both feeds.');
    return 0;
  }

  let bad = false;
  for (const [path, feed] of [[FEEDS.rollup, built.rollup], [FEEDS.txRollup, built.txRollup]]) {
    const res = await writeFeed(path, built.branch, token, feed.doc, { publish: opts.publish });
    const preview = res.preview?.previewed ? 'ok' : `FAILED: ${res.preview?.previewError}`;
    const live = res.preview?.published === null || res.preview?.published === undefined
      ? ''
      : ` · live ${res.preview.published ? 'ok' : `FAILED: ${res.preview.publishError}`}`;
    console.log(`   ✓ ${path}${res.created ? ' (created)' : ''}${res.retried ? ' after one 412 retry' : ''}`
      + ` · preview ${preview}${live}`);
    if (!res.preview?.previewed) bad = true;
    if (opts.publish && res.preview?.published === false) bad = true;
  }
  if (!opts.publish) {
    // Say it every time. A feed on preview only is invisible from the live board, and
    // the board's honest "nothing published yet" panel is indistinguishable from the
    // pipeline never having run.
    console.log('\n   NOT published to live (no --publish). The /tracker/ pages read these');
    console.log('   feeds from whichever host they are served on: if those pages are');
    console.log('   published, re-run with --publish or the live board reads as empty.');
  }
  // A refused preview means the file is in DA and served to nobody. Reporting success
  // there is how a dashboard silently skips a row for hours.
  return bad ? 1 : 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ rollup: ${e.message}`);
      exit(/^unknown arg|must be a positive|unknown group/.test(e.message) ? 3 : 2);
    });
}
