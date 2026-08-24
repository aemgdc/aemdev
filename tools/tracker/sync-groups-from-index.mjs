#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * sync-groups-from-index.mjs — reconcile `/en/query-index.json` into the four group
 * sheets: refresh band 1, preserve bands 2 and 3, add the missing locale rows.
 *
 * CLI SURFACE
 *   node tools/tracker/sync-groups-from-index.mjs [--group=<name>]
 *        [--dry-run|--apply] [--limit=N] [--min-rows=N] [--branch=<ref>]
 *        [--no-probe] [--help]
 *
 *   npm run group:sync                          plan, every group
 *   npm run group:sync -- --group=meetups       plan, one group
 *   npm run group:sync -- --apply               write
 *
 *   --group=<name>  one registered group. Default: all of them.
 *   --dry-run       print the plan and write nothing. THE DEFAULT.
 *   --apply         write.
 *   --limit=N       consider only the first N index rows (a smoke run). Suppresses
 *                   off-index reporting, which would otherwise lie.
 *   --min-rows=N    the partial-input floor. Default from `sync.minIndexRows` in
 *                   .tracker/orchestrator.json, else 10.
 *   --branch=<ref>  read the index and probe status against this ref. Default `main`.
 *   --no-probe      skip the per-page status probe. `en-live` and `last-modified` are
 *                   then LEFT ALONE rather than written blank.
 *
 * ─── The band contract, which is the whole point of this tool ───────────────
 *
 *   band 1  page-path · title · template · pagetype · en-live · last-modified
 *           regenerated here, every run.
 *   band 2  subgroup · translate · notes            NEVER written here.
 *   band 3  en-status · content-escalation          NEVER written here.
 *
 * `subgroup` is the column that makes this non-negotiable: it is the only column in
 * the sheet with no derivation to fall back on. A refresh that dropped it would
 * destroy work no re-run could rebuild. The enforcement is not in this file's
 * discipline — `syncDataRow()` in lib/group-sheet.mjs THROWS if handed a non-band-1
 * key.
 *
 * ─── REFUSE ON PARTIAL INPUT ───────────────────────────────────────────────
 *
 * Three checks, and any of them writes NOTHING and exits 2:
 *
 *   1. the index fetch failed;
 *   2. the feed is TRUNCATED — `data.length < total`. A query index paginates, and a
 *      truncated page reads exactly like a site that shrank;
 *   3. the feed carries fewer rows than the floor.
 *
 * A sync that silently halves a denominator and publishes it is the worst failure
 * this tool has: the number is believed for a day. So the refusal is global, before
 * any sheet is touched, rather than per group.
 *
 * ─── What this tool never does ─────────────────────────────────────────────
 *
 * It never DELETES a row. A page in a sheet but not in the index is preserved
 * verbatim and reported as off-index, because the schema has no `list-status` column
 * to mark it with and columns here are additive-only. A drop is far more often a
 * stale fetch, a renamed section or an unpublished page than a genuinely dead page,
 * and a human decides which.
 *
 * It never writes `en-status`. That column is the send gate, and an observed 200 on
 * the live host is not the same claim as a human marking a page ready to translate
 * from. `en-live` records the observation; `set-en-status` records the decision.
 *
 * It never reads `/bios.json`. The `bios` roster is owned by another session and this
 * is a read-only coupling that has not been wired yet, so `bios` legitimately syncs
 * zero rows from `/en/query-index.json` — `/en/fragments/**` is in that index's
 * `exclude`. That is reported as a fact, not as an error.
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  reconciled (or planned) cleanly
 *   2  could not reach a verdict — index unreachable, truncated or short; DA
 *      unreachable; no token. NOTHING was written.
 *   3  usage or configuration error, including a group whose sheet does not exist yet
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { TARGET_LOCALES, normalizePath } from '../../scripts/tracker/locales.js';
import { liveUrl, statusApiUrl } from '../../scripts/tracker/paths.js';
import { countsAsPage } from '../../scripts/tracker/stages.js';
import { loadConfig, groupConfig, groupNames } from './config.mjs';
import { resolveToken, TOKEN_HINT } from './lib/status-sheet.mjs';
import { groupForPath, pagetypeOf, manualPagesFor } from './lib/group-map.mjs';
import {
  PRESERVED_COLUMNS,
  LOCALE_PRESERVED,
  syncDataRow,
  syncLocaleRow,
  dataRowsOf,
  localeRowsOf,
  indexDataRows,
  indexLocaleTab,
  readGroupDoc,
  withDataRows,
  withLocaleRows,
  updateGroupDoc,
  groupSheetLink,
} from './lib/group-sheet.mjs';

/**
 * The default partial-input floor.
 *
 * 10 is below the 19 pages the site has today and far above the 0-or-1 a broken fetch
 * yields, so it catches the failure it exists for without tripping on a legitimate
 * unpublishing. Override it in .tracker/orchestrator.json as `sync.minIndexRows` when
 * the site grows — a floor that never moves stops being a floor.
 */
const DEFAULT_MIN_ROWS = 10;

/** How many status probes run at once. Politeness, not performance. */
const PROBE_CONCURRENCY = 6;

const HELP = `group:sync — reconcile /en/query-index.json into the group sheets.

  --group=<name>  one registered group (default: all)
  --dry-run       print the plan, write nothing (DEFAULT)
  --apply         write
  --limit=N       consider only the first N index rows; suppresses off-index reporting
  --min-rows=N    partial-input floor (default: sync.minIndexRows, else ${DEFAULT_MIN_ROWS})
  --branch=<ref>  read the index / probe status against this ref (default: main)
  --no-probe      skip the status probe; leaves en-live and last-modified untouched
  --help          this text

exit 0 ok · 2 partial input or transport failure (nothing written) · 3 usage/config`;

function parseArgs(args) {
  const o = {
    group: null,
    apply: false,
    limit: 0,
    minRows: null,
    branch: null,
    probe: true,
    help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--no-probe') o.probe = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--limit=')) o.limit = Number(a.slice(8));
    else if (a.startsWith('--min-rows=')) o.minRows = Number(a.slice(11));
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.limit && !Number.isInteger(o.limit)) throw new Error('--limit must be a whole number');
  if (o.minRows !== null && !Number.isInteger(o.minRows)) throw new Error('--min-rows must be a whole number');
  return o;
}

const text = (v) => (v == null ? '' : String(v).trim());
const val = (row, key) => text(row?.[key]);

/* ------------------------------------------------------------------ the index */

/**
 * Fetch and VALIDATE the English query index.
 *
 * Returns `{ rows, total, listed }` or throws. The truncation check is the one worth
 * being pedantic about: a query index paginates with `total`/`limit`/`offset`, and a
 * page-2-missing fetch is indistinguishable from a site that lost half its pages
 * unless the envelope is compared against the row count.
 */
export async function fetchIndex(branch, floor) {
  const url = liveUrl('/en/query-index.json', branch);
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`index fetch failed (${url}): ${e.message}`);
  }
  if (!res.ok) throw new Error(`index fetch ${res.status} (${url})`);
  const doc = await res.json();
  const rows = Array.isArray(doc.data) ? doc.data : null;
  if (!rows) throw new Error(`index at ${url} has no \`data\` array — refusing to reconcile against it`);

  const total = Number.isFinite(doc.total) ? doc.total : rows.length;
  if (rows.length < total) {
    throw new Error(`index is TRUNCATED: ${rows.length} of ${total} rows returned. A paginated feed `
      + 'reads exactly like a site that shrank, so nothing is written. Re-fetch, or page through it.');
  }
  if (rows.length < floor) {
    throw new Error(`index returned ${rows.length} row(s), below the floor of ${floor}. Refusing: a sync `
      + 'that halves a denominator and publishes it is believed for a day. Raise or lower the floor '
      + 'deliberately with --min-rows= if the site really is this small.');
  }
  return { rows, total, url };
}

/**
 * Every page the index claims, resolved to a group and normalized.
 *
 * `normalizePath` is not cosmetic here: the live index spells the locale home page
 * `/en/`, and the slashed form 404s on this site. Without normalization the sync
 * records a 404 as a tracked page AND keeps a second row for the same page forever.
 */
function resolveIndexRows(rows) {
  const pages = [];
  const unresolved = [];
  const seen = new Map();
  for (const r of rows) {
    const path = normalizePath(r.path);
    const group = path ? groupForPath(path) : null;
    if (!path) {
      // A row with no path is not a page; nothing to resolve and nothing to report.
    } else if (!group) {
      unresolved.push({ path, template: text(r.template) });
    } else if (seen.has(path)) {
      // A duplicate here means the index listed one page twice (usually a slashed and
      // an unslashed spelling). Keep the first and say so rather than writing two rows.
      unresolved.push({ path, template: 'DUPLICATE index row — ignored' });
    } else {
      const page = {
        path, group, title: text(r.title), template: text(r.template), source: 'index',
      };
      seen.set(path, page);
      pages.push(page);
    }
  }
  return { pages, unresolved };
}

/* ------------------------------------------------------------------ the probe */

/**
 * Observe one page on the AEM admin status API.
 *
 * `admin.hlx.page/status` answers UNAUTHENTICATED for this site (site.json has
 * `requireAuth` false), so `en-live` is a real observation rather than a stored
 * guess — which is why this tool does not need a substitute column for it.
 *
 * `last-modified` comes from here too, and that is a deliberate deviation from
 * "band 1 comes from the index": the deployed `aemdev-en` index defines no
 * `lastModified` property, so the index simply does not carry it. Taking it from the
 * probe that is already happening is the only honest source; the alternative is
 * inventing a timestamp.
 *
 * A probe that FAILS returns `{ reachable: false }` and the caller then writes
 * neither column, leaving whatever the sheet already had. Writing `en-live: ''` on a
 * network error would record "this page is not live" on the strength of a DNS hiccup.
 */
async function probePage(path, branch) {
  try {
    const res = await fetch(statusApiUrl(path, branch));
    if (!res.ok) return { reachable: false, why: `status ${res.status}` };
    const doc = await res.json();
    const live = doc.live || {};
    const preview = doc.preview || {};
    const stamp = live.lastModified || preview.lastModified || '';
    const iso = stamp ? new Date(stamp).toISOString() : '';
    return {
      reachable: true,
      enLive: live.status === 200 ? 'yes' : '',
      lastModified: Number.isNaN(Date.parse(stamp)) ? '' : iso,
      previewed: preview.status === 200,
    };
  } catch (e) {
    return { reachable: false, why: e.message };
  }
}

/** Probe every page, a few at a time. Order of the result matches the input. */
async function probeAll(pages, branch) {
  const out = new Map();
  const queue = [...pages];
  const worker = async () => {
    while (queue.length) {
      const page = queue.shift();
      out.set(page.path, await probePage(page.path, branch));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, worker));
  return out;
}

/* --------------------------------------------------------------- reconciliation */

/**
 * Reconcile one group's `data` tab. Pure — no I/O, so it can be reasoned about and
 * tested against real row shapes.
 *
 * Existing row ORDER is preserved and new rows are appended. Re-sorting a sheet a
 * human has been reading and editing is hostile even when every value is correct.
 *
 * @returns {{ rows, added, updated, preserved, offIndex, placeholders, changes }}
 */
export function reconcileData(existingRows, wantedPages, observations, { reportOffIndex }) {
  const wanted = new Map(wantedPages.map((p) => [p.path, p]));
  const band1For = (page) => {
    const obs = observations.get(page.path);
    const values = {
      'page-path': page.path,
      title: page.title,
      template: page.template,
      pagetype: pagetypeOf(page.path),
    };
    // Only write the observed columns when the observation actually happened.
    if (obs?.reachable) {
      values['en-live'] = obs.enLive;
      values['last-modified'] = obs.lastModified;
    }
    return values;
  };

  const rows = [];
  const changes = [];
  const offIndex = [];
  let updated = 0;
  let placeholders = 0;
  const handled = new Set();

  for (const existing of existingRows) {
    const path = normalizePath(val(existing, 'page-path'));
    const page = path ? wanted.get(path) : null;
    if (!path) {
      // A blank page-path is a scaffold placeholder. It is dropped once real rows
      // exist — it was only ever there to make the columns visible in da.live.
      placeholders += 1;
    } else if (!page) {
      // NEVER deleted. See the header: the schema has no `list-status` column to mark
      // it with, and a drop is usually a stale fetch rather than a dead page.
      rows.push(existing);
      if (reportOffIndex) offIndex.push(path);
    } else {
      handled.add(path);
      const merged = syncDataRow(existing, band1For(page));
      rows.push(merged.row);
      if (merged.changes.length) {
        updated += 1;
        for (const c of merged.changes) changes.push({ path, ...c });
      }
    }
  }

  const added = wantedPages.filter((p) => !handled.has(p.path));
  for (const page of added) rows.push(syncDataRow(null, band1For(page)).row);

  // How much curated and status data this run is carrying across untouched. Printed
  // because "preserved: 0" on a sheet somebody filled in is the alarm you want.
  const preserved = rows.filter((r) => PRESERVED_COLUMNS.some((c) => val(r, c))).length;

  return {
    rows,
    added,
    updated,
    preserved,
    offIndex,
    placeholders,
    changes,
  };
}

/**
 * Reconcile one locale tab against the final `data` rows.
 *
 * Two rules, both from the data contract:
 *   - `LOCALE_PRESERVED` (`sent-at`, the two statuses, `review-updated`) comes across
 *     verbatim. It is testimony, not cache — `sent-at` in particular is observable
 *     nowhere else, so regenerating it would erase the only record that a page was
 *     ever handed to the translation service.
 *   - `previewed`/`online` are crawl output and belong to `tx:scan`. This tool does
 *     not touch them, which is why it passes no `observed`.
 *
 * A page whose curated `translate` column says `no` gets no NEW locale row. Any row
 * it already has is still carried over: it may hold a `sent-at`, and a curated
 * exclusion is not a licence to forget what already happened.
 */
export function reconcileLocale(existingRows, dataRows, code) {
  const pages = dataRows
    .filter((r) => countsAsPage(r))
    .map((r) => ({ path: normalizePath(val(r, 'page-path')), translate: val(r, 'translate').toLowerCase() }));
  const byPath = new Map(pages.map((p) => [p.path, p]));

  const rows = [];
  const orphans = [];
  const handled = new Set();
  for (const existing of existingRows) {
    const path = normalizePath(val(existing, 'page-path'));
    if (!path) {
      // A blank join key is a placeholder row, not a (page, locale) pair.
    } else if (!byPath.has(path)) {
      // The master row is gone (or was never a countable page) but this row may carry
      // testimony. Preserve it and report it; a human decides.
      rows.push(existing);
      orphans.push(path);
    } else {
      handled.add(path);
      rows.push(syncLocaleRow(existing, { pagePath: path, code }).row);
    }
  }

  const added = pages
    .filter((p) => !handled.has(p.path) && p.translate !== 'no')
    .map((p) => p.path);
  for (const path of added) rows.push(syncLocaleRow(null, { pagePath: path, code }).row);
  const excluded = pages.filter((p) => p.translate === 'no' && !handled.has(p.path)).length;
  return {
    rows, added, orphans, excluded,
  };
}

/* -------------------------------------------------------------------- the plan */

const CHANGE_SAMPLE = 12;

function printGroupPlan(name, sheetCfg, plan) {
  console.log(`\n── ${name} ──`);
  console.log(`   sheet:  ${sheetCfg.path}`);
  console.log(`   editor: ${groupSheetLink(sheetCfg)}`);
  if (plan.error) {
    console.log(`   ✗ ${plan.error}`);
    return;
  }
  const d = plan.data;
  console.log(`   data tab: ${plan.before} row(s) → ${d.rows.length}`);
  console.log(`     added         ${d.added.length}`);
  console.log(`     band-1 updated ${d.updated}`);
  console.log(`     preserved     ${d.preserved} row(s) carry curated or status values (bands 2-3, untouched)`);
  console.log(plan.offIndexReported
    ? `     off-index     ${d.offIndex.length} — preserved verbatim, never deleted`
    : '     off-index     not checked — --limit hid part of the index, so a count here would lie');
  console.log(`     removed       0 — this tool never deletes a page row${d.placeholders ? `; ${d.placeholders} blank placeholder row(s) dropped` : ''}`);

  for (const p of d.added.slice(0, CHANGE_SAMPLE)) {
    console.log(`     + ${p.path}  pagetype=${pagetypeOf(p.path)} template=${JSON.stringify(p.template)}`
      + `${p.source === 'manual' ? '  [MANUAL ROW]' : ''}`);
  }
  if (d.added.length > CHANGE_SAMPLE) console.log(`     + … ${d.added.length - CHANGE_SAMPLE} more`);

  for (const c of d.changes.slice(0, CHANGE_SAMPLE)) {
    console.log(`     ~ ${c.path}  ${c.column}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
  }
  if (d.changes.length > CHANGE_SAMPLE) console.log(`     ~ … ${d.changes.length - CHANGE_SAMPLE} more band-1 changes`);

  for (const p of d.offIndex.slice(0, CHANGE_SAMPLE)) console.log(`     ! ${p}  in the sheet, not in the index`);

  const localeAdded = Object.entries(plan.locales)
    .map(([code, l]) => `${code}+${l.added.length}`).join(' ');
  const orphaned = Object.values(plan.locales).reduce((n, l) => n + l.orphans.length, 0);
  const excluded = Object.values(plan.locales).reduce((n, l) => n + l.excluded, 0);
  console.log(`   locale tabs: ${localeAdded || '(none)'}`);
  console.log(`     preserved per row: ${LOCALE_PRESERVED.join(', ')}`);
  if (excluded) console.log(`     ${excluded} (page, locale) row(s) NOT created — translate="no"`);
  if (orphaned) console.log(`     ${orphaned} orphan locale row(s) kept — their master row is gone`);
}

/* -------------------------------------------------------------------- the run */

async function syncGroup({
  cfg, name, pages, observations, opts, token,
}) {
  const sheetCfg = groupConfig(cfg, name);
  const current = await readGroupDoc(sheetCfg, token);
  if (!current.exists) {
    return {
      sheetCfg,
      config: true,
      error: `sheet does not exist — run \`npm run group:scaffold -- --group=${name}\` first`,
    };
  }
  if (current.missingTabs.length) {
    return {
      sheetCfg,
      config: true,
      error: `missing locale tab(s): ${current.missingTabs.join(', ')} — da.live collapsed the envelope. `
        + 'Re-scaffold or repair it before syncing, or the locale rows land nowhere.',
    };
  }

  const before = dataRowsOf(current.doc).length;
  const data = reconcileData(dataRowsOf(current.doc), pages, observations, {
    reportOffIndex: !opts.limit,
  });
  const locales = {};
  for (const code of TARGET_LOCALES) {
    locales[code] = reconcileLocale(localeRowsOf(current.doc, code), data.rows, code);
  }

  const plan = {
    sheetCfg, before, data, locales, offIndexReported: !opts.limit,
  };
  if (!opts.apply) return plan;

  /*
   * One write per group, whole-doc and ETag-conditional. A sheet write is always a
   * whole-doc write in DA, so an unconditional one loses a concurrent writer's rows
   * outright — and `updateGroupDoc` re-reads and re-applies once on a 412 rather than
   * spinning, because writes to several sheets in a row leave previews settling.
   */
  const res = await updateGroupDoc(sheetCfg, token, (doc, { exists }) => {
    if (!exists) throw new Error('sheet vanished between the read and the write');
    const fresh = reconcileData(dataRowsOf(doc), pages, observations, { reportOffIndex: false });
    let next = withDataRows(doc, fresh.rows);
    for (const code of TARGET_LOCALES) {
      const built = reconcileLocale(localeRowsOf(doc, code), fresh.rows, code);
      next = withLocaleRows(next, code, built.rows);
    }
    return next;
  }, {
    /*
     * Confirm on the read-back, not on the 200. A write whose source POST succeeds and
     * whose preview is refused exists in DA, is never served, and leaves the tool
     * printing success — so the row count is checked against what we intended.
     */
    confirm: (after) => {
      const got = indexDataRows(after);
      const missing = pages.filter((p) => !got.has(p.path)).map((p) => p.path);
      if (missing.length) return `${missing.length} page(s) are not in the written data tab: ${missing.slice(0, 3).join(', ')}`;
      for (const code of TARGET_LOCALES) {
        const tab = indexLocaleTab(after, code);
        const want = locales[code].rows.filter((r) => val(r, 'page-path')).length;
        if (tab.size !== want) return `the ${code} tab has ${tab.size} keyed row(s), expected ${want}`;
      }
      return null;
    },
  });
  return { ...plan, written: res };
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const branch = opts.branch || cfg.publish?.branch;
  const floor = opts.minRows ?? cfg.sync?.minIndexRows ?? DEFAULT_MIN_ROWS;
  const names = opts.group ? [opts.group] : groupNames(cfg);
  for (const n of names) groupConfig(cfg, n); // fail on a typo before any I/O

  const token = resolveToken();
  if (!token) {
    console.error(`ERROR: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }

  console.log(`── group:sync · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} · branch ${branch} ──`);

  let index;
  try {
    index = await fetchIndex(branch, floor);
  } catch (e) {
    // Global refusal, before any sheet is touched. Exit 2: no verdict, nothing written.
    console.error(`\n✗ REFUSED ON PARTIAL INPUT — nothing was written.\n  ${e.message}`);
    return 2;
  }
  console.log(`   index:  ${index.url}`);
  console.log(`   listed: ${index.rows.length} of ${index.total} row(s) · floor ${floor} · ok`);

  const limited = opts.limit ? index.rows.slice(0, opts.limit) : index.rows;
  if (opts.limit) {
    console.log(`   --limit=${opts.limit}: considering ${limited.length} row(s); off-index reporting is SUPPRESSED `
      + '(the rows the limit hid would otherwise be reported as dropped)');
  }
  const { pages, unresolved } = resolveIndexRows(limited);

  /*
   * The manual rows, added deliberately and named as such in the plan. `/` is outside
   * `include: /en/**` for every index in config/sites/aemdev/query.yaml, so no query
   * index will ever list it — it is not missing, it is unlistable, and it is still the
   * first page a visitor sees.
   */
  const manual = names
    .flatMap((name) => manualPagesFor(name))
    .filter((m) => !pages.some((p) => p.path === m.path));
  for (const m of manual) {
    pages.push({
      path: m.path, group: m.group, title: m.title, template: '', source: 'manual',
    });
    console.log(`   manual row: ${m.path} → ${m.group} (${m.why})`);
  }

  console.log(`   resolved: ${pages.length} page(s) into groups · ${unresolved.length} unresolved`);
  for (const u of unresolved) {
    console.log(`     ? ${u.path}${u.template ? `  (${u.template})` : ''} — in no tracked group, left out of every sheet`);
  }

  const byGroup = new Map(names.map((n) => [n, []]));
  for (const p of pages) {
    if (byGroup.has(p.group)) byGroup.get(p.group).push(p);
  }

  let observations = new Map();
  if (opts.probe) {
    const targets = [...byGroup.values()].flat();
    observations = await probeAll(targets, branch);
    const unreachable = [...observations.entries()].filter(([, o]) => !o.reachable);
    const live = [...observations.values()].filter((o) => o.reachable && o.enLive === 'yes').length;
    console.log(`   probed: ${observations.size} page(s) on admin.hlx.page · ${live} live · ${unreachable.length} unreachable`);
    for (const [path, o] of unreachable) {
      console.log(`     ! ${path} probe failed (${o.why}) — en-live and last-modified LEFT AS THEY WERE`);
    }
  } else {
    console.log('   --no-probe: en-live and last-modified will be left exactly as the sheet has them');
  }

  let configError = false;
  let transportError = false;
  for (const name of names) {
    const groupPages = byGroup.get(name) || [];
    try {
      const plan = await syncGroup({
        cfg, name, pages: groupPages, observations, opts, token,
      });
      printGroupPlan(name, plan.sheetCfg, plan);
      if (plan.config) configError = true;
      if (plan.written) {
        console.log(`   ✓ written${plan.written.retried ? ' after one 412 retry' : ''} · preview `
          + `${plan.written.preview?.previewed ? 'ok' : `FAILED: ${plan.written.preview?.previewError}`}`);
      }
      if (!groupPages.length) {
        /*
         * `bios` legitimately syncs nothing: /en/fragments/** is in the aemdev-en
         * index's `exclude`, and its roster (/bios.json) is owned by another session
         * and deliberately not read here. Saying so beats printing a bare zero.
         */
        const why = name === 'bios'
          ? 'Expected — /en/fragments/** is excluded from that index, and /bios.json is owned elsewhere.'
          : 'Check the prefix rules in lib/group-map.mjs if that is a surprise.';
        console.log(`   note: no rows for this group in /en/query-index.json. ${why}`);
      }
    } catch (e) {
      console.error(`\n── ${name} ──\n   ✗ ${e.message}`);
      transportError = true;
    }
  }

  if (!opts.apply) console.log('\n   Re-run with --apply to write.');
  // Worst outcome wins: a configuration problem needs a human before anything else.
  if (configError) return 3;
  if (transportError) return 2;
  return 0;
}

/*
 * CLI entry only when run directly. The reconcile functions above are exported for
 * testing, and without this guard importing one of them would start writing DA sheets.
 */
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ group:sync: ${e.message}`);
      exit(/^unknown arg|must be a whole number|unknown group/.test(e.message) ? 3 : 2);
    });
}
