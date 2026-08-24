#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * publish-tx-reports.mjs — publish the per-locale page index and the per-page reviewer
 * subsets: `/tracker/data/tx-index/<code>.json` and
 * `/tracker/data/tx-reports/<code>--<slug>.json`.
 *
 * CLI SURFACE
 *   node tools/tracker/publish-tx-reports.mjs [--dry-run|--apply] [--locale=<code>]
 *        [--group=<name>] [--index-only] [--reports-only] [--limit=N]
 *        [--branch=<ref>] [--max-bytes=N] [--out=<dir>] [--help]
 *
 *   npm run tx:publish                        plan everything
 *   npm run tx:publish -- --apply             publish the indexes and every report
 *   npm run tx:publish -- --locale=de --apply one locale
 *
 *   --dry-run        print the plan, write nothing. THE DEFAULT.
 *   --apply          publish.
 *   --locale=<code>  one target locale. Repeatable. Default: all ten.
 *   --group=<name>   restrict the index to one group. Default: all registered.
 *   --index-only     publish the per-locale indexes and no per-page reports.
 *   --reports-only   publish the per-page reports and no indexes.
 *   --limit=N        publish at most N per-page reports (a smoke run).
 *   --branch=<ref>   the ref recorded and previewed on. Default main.
 *   --max-bytes=N    size ceiling per doc.
 *   --out=<dir>      write the docs under <dir> instead of publishing.
 *
 * ─── THE PER-LOCALE INDEX MUST BE `:type: 'multi-sheet'` ────────────────────
 *
 * NEVER `:type: 'sheet'`. A single-sheet doc carries its rows at the TOP LEVEL, and
 * that malformed form is ACCEPTED by admin.da.live and then REFUSED AT PREVIEW with
 * `400 error from content-bus` — leaving DA holding a file that every reader 404s while
 * the tool that wrote it printed success. `feedDoc()` in lib/feed.mjs routes through
 * `multiSheetDoc`, which asserts the envelope before the doc can leave this process, and
 * that is why nothing here builds a doc literal by hand.
 *
 * ─── PRESENT PAGES ONLY, AND THE WITHHELD COUNT ────────────────────────────
 *
 * The index lists the pages that are actually PRESENT in that locale's tree — the ones
 * `previewed` or `online` was observed on. Listing every EXPECTED page is what hit the
 * published index's size ceiling in the source pipeline (1,301 rows / 685 KB was refused
 * outright by the content bus while a 38 KB doc went through).
 *
 * So `meta.withheld` is the expected-but-absent remainder, and it is not decoration: a
 * short index that does not explain itself reads as "we are nearly done" rather than "the
 * rollout has barely started", and a reader cannot tell those apart from a row count.
 * `present` and `expected` are carried alongside it so the arithmetic is visible.
 *
 * ─── WHAT A PUBLISHED REPORT MAY CONTAIN ───────────────────────────────────
 *
 * `/tracker/**` is publicly readable once previewed. A local report at
 * `.tracker/reports/tx/<code>--<slug>.json` carries the whole working set — the full
 * `checks` array, the judge's `issues[]` with their verbatim `evidence` quotes, the
 * `textSample.pairs` of source and target sentences. NONE of that is publishable.
 *
 * The published subset is therefore built by ALLOW-LIST through `publishable()`: two
 * tabs of bounded scalars, `report` (the verdicts and the identity of the page) and
 * `findings` (severity / kind / a bounded description). Nothing is copied through
 * verbatim, and `evidence` is not read at all.
 *
 * ─── BEST EFFORT, NEVER FAILS THE RUN ──────────────────────────────────────
 *
 * One report failing to write must not abandon the rest, and must not fail the batch
 * that called this. Every per-doc failure is collected and reported; the exit code
 * distinguishes "some failed" (1) from "nothing could be done at all" (2).
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  published (or planned) cleanly
 *   1  at least one doc failed to write or was refused at preview
 *   2  could not reach a verdict — no token, no readable group sheet
 *   3  usage error, or a doc over the size ceiling
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  TARGET_LOCALES, locale as localeFor, normalizePath, pathForLocale,
} from '../../scripts/tracker/locales.js';
import {
  FEEDS, slugOf, previewUrl, liveUrl, txDocPath,
} from '../../scripts/tracker/paths.js';
import {
  sheetRows,
  countsAsPage,
  indexLocaleRows,
  localeRowFor,
  classifyTranslation,
  hasContentEscalation,
} from '../../scripts/tracker/stages.js';
import { subgroupOf } from '../../scripts/tracker/subgroups.js';
import {
  loadConfig, groupConfig, groupNames, REPO_ROOT,
} from './config.mjs';
import { resolveToken, TOKEN_HINT, fetchStatusDocVersioned } from './lib/status-sheet.mjs';
import { pagetypeOf } from './lib/group-map.mjs';
import {
  SIZE_CEILING_BYTES,
  metaRow,
  feedDoc,
  docBytes,
  kb,
  publishable,
  writeFeed,
  writeLocalFeed,
} from './lib/feed.mjs';

/**
 * The per-locale index's columns.
 *
 * Everything a reviewer's list needs and nothing a reviewer's list does not: the page,
 * where to read it, what state it is in, and which document carries the verdict. No
 * prose, because this is a public page.
 */
export const INDEX_COLUMNS = [
  'page-path', 'locale', 'locale-path', 'group', 'subgroup', 'pagetype', 'title',
  'stage', 'blocked', 'queues', 'translation-status', 'review-status', 'review-updated',
  'sent-at', 'previewed', 'online', 'content-escalation', 'preview-url', 'live-url', 'doc',
];

/**
 * The per-page report's identity-and-verdict row.
 *
 * `finding-count` and NOT `findings`: `findings` is a reserved name in
 * `NEVER_PUBLISH` — it is what a tier calls its LIST of findings, complete with the
 * source text each one quotes — so `publishable()` refuses to be asked for it by that
 * name even when the caller only means a number. Caught by that guard the first time
 * this tool ran, which is exactly what the guard is for; the count keeps its own name so
 * a future reader cannot confuse the two.
 */
export const REPORT_COLUMNS = [
  'page-path', 'locale', 'group', 'template', 'pagetype', 'branch', 'generated',
  'verdict', 'structural', 'judge', 'visual', 'confidence', 'finding-count',
  'source-url', 'target-url', 'doc',
];

/** One bounded row per finding. `evidence` is deliberately absent — see the header. */
export const FINDING_COLUMNS = ['tier', 'severity', 'kind', 'detail', 'width', 'check'];

const HELP = `tx:publish — publish the per-locale indexes and the per-page reviewer subsets.

  --dry-run        print the plan, write nothing (DEFAULT)
  --apply          publish
  --locale=<code>  one target locale, repeatable (default: all ten)
  --group=<name>   restrict the index to one group (default: all registered)
  --index-only     indexes only
  --reports-only   per-page reports only
  --limit=N        publish at most N per-page reports
  --branch=<ref>   the ref recorded and previewed on (default: main)
  --max-bytes=N    per-doc size ceiling (default ${SIZE_CEILING_BYTES})
  --out=<dir>      write the docs under <dir> instead of publishing
  --help           this text

The per-locale index is always :type "multi-sheet" — the single-sheet form is accepted
on write and refused at preview, which leaves DA holding a file every reader 404s.

exit 0 ok · 1 some docs failed · 2 no verdict · 3 usage or size`;

function parseArgs(args) {
  const o = {
    apply: false,
    locales: [],
    group: null,
    index: true,
    reports: true,
    limit: 0,
    branch: null,
    maxBytes: SIZE_CEILING_BYTES,
    out: null,
    help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--index-only') o.reports = false;
    else if (a === '--reports-only') o.index = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--locale=')) o.locales.push(a.slice(9));
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--limit=')) o.limit = Number(a.slice(8));
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--max-bytes=')) o.maxBytes = Number(a.slice(12));
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!o.index && !o.reports) throw new Error('--index-only and --reports-only are mutually exclusive');
  if (o.limit && !Number.isInteger(o.limit)) throw new Error('--limit must be a whole number');
  if (!Number.isInteger(o.maxBytes) || o.maxBytes <= 0) throw new Error('--max-bytes must be a positive whole number');
  for (const code of o.locales) {
    // A locale typo must fail before any I/O: `pt-br` for `pt` is a near-miss that
    // otherwise publishes an index nobody reads and leaves the real one stale.
    if (!TARGET_LOCALES.includes(code)) {
      throw new Error(`unknown target locale "${code}" — known: ${TARGET_LOCALES.join(', ')}`);
    }
  }
  return o;
}

const text = (v) => (v == null ? '' : String(v).trim());
const val = (row, key) => text(row?.[key]);
const truthy = (v) => /^(yes|y|true|1|x)$/i.test(text(v));

/* ------------------------------------------------------------ the locale index */

/**
 * Is this (page, locale) PRESENT in the locale tree?
 *
 * Presence is the OBSERVED pair of columns, never a status: `previewed` and `online`
 * are crawl output regenerated on every `tx:scan`, while `translation-status` is a
 * cached derivation nothing ever clears. Reading presence off the status column would
 * keep a withdrawn page in the index forever — the same stale-status trap the clamp in
 * `classifyTranslation()` exists for.
 */
const isPresent = (localeRow) => truthy(localeRow?.previewed) || truthy(localeRow?.online);

/**
 * Build one locale's index from the group sheets.
 *
 * @returns {{ doc, present: number, expected: number, groups: string[], failed: string[] }}
 */
export function buildLocaleIndex(code, groups, { branch, failed }) {
  const rows = [];
  let expected = 0;

  for (const g of groups) {
    const localeIndex = indexLocaleRows(g.doc);
    for (const row of sheetRows(g.doc, 'data')) {
      if (countsAsPage(row)) {
        expected += 1;
        const path = normalizePath(val(row, 'page-path'));
        const localeRow = localeRowFor(localeIndex, path, code);
        if (isPresent(localeRow)) {
          const verdict = classifyTranslation(row, localeRow);
          const localePath = pathForLocale(path, code);
          rows.push(publishable({
            'page-path': path,
            locale: code,
            'locale-path': localePath,
            group: g.name,
            subgroup: subgroupOf(row),
            pagetype: val(row, 'pagetype') || pagetypeOf(path),
            title: val(row, 'title'),
            // The DERIVED stage, not a stored one. Nothing stores a stage; a reader of
            // this index must see the same value the boards compute from the same model.
            stage: verdict.stage || '',
            blocked: verdict.blocked ? 'yes' : '',
            queues: verdict.queues.join(' '),
            'translation-status': val(localeRow, 'translation-status'),
            'review-status': val(localeRow, 'review-status'),
            'review-updated': val(localeRow, 'review-updated'),
            'sent-at': val(localeRow, 'sent-at'),
            previewed: val(localeRow, 'previewed'),
            online: val(localeRow, 'online'),
            'content-escalation': hasContentEscalation(row) ? 'yes' : '',
            'preview-url': previewUrl(localePath, branch),
            'live-url': liveUrl(localePath, branch),
            doc: txDocPath(path, code),
          }, INDEX_COLUMNS));
        }
      }
    }
  }

  const known = localeFor(code);
  const doc = feedDoc([
    ['meta', [metaRow({
      branch,
      expected,
      listed: rows.length,
      groupsFailed: failed,
      extra: {
        locale: code,
        name: known.name,
        native: known.native,
        present: rows.length,
        groups: groups.length,
        /*
         * Said in words as well as numbers. `withheld` on an index with zero rows is
         * the single most misreadable number in the whole tracker: it is the difference
         * between "nothing is translated yet" and "we lost the data", and a reader
         * looking at an empty list deserves to be told which.
         */
        note: rows.length
          ? 'present pages only; withheld = expected but not yet observed in this locale'
          : `nothing is present in /${code} yet — withheld is the whole expected set, not lost data`,
      },
    })]],
    ['pages', rows],
  ]);

  return {
    code, doc, present: rows.length, expected,
  };
}

/* ------------------------------------------------------------- the page reports */

/** A report's tier verdict, or '' when the tier did not run. Never 'pass'. */
const tierVerdict = (tiers, name) => {
  const t = tiers?.[name];
  // `null` and `''` mean "we did not look"; only a real object can say "it was fine".
  // Collapsing those two is how a skipped tier comes to read as a passing one.
  return t && typeof t === 'object' ? text(t.verdict) : '';
};

/**
 * Project one local report onto its publishable subset.
 *
 * Two tabs, because a reviewer's drawer needs the verdict at a glance and the findings
 * as a list. Both go through `publishable()`, which refuses any non-scalar — so a
 * `checks` array or a `textSample` cannot reach a public page even if a future tier adds
 * one under a name nobody here anticipated.
 */
export function buildPageReport(report, { branch }) {
  const path = normalizePath(text(report['page-path']));
  const code = text(report.locale);
  const tiers = report.tiers || {};

  const findings = [];
  const push = (tier, list, map) => {
    for (const item of Array.isArray(list) ? list : []) {
      findings.push(publishable({ tier, ...map(item) }, FINDING_COLUMNS));
    }
  };
  push('judge', tiers.judge?.issues, (i) => ({
    severity: i.severity, kind: i.kind, detail: i.detail,
  }));
  push('structural', tiers.structural?.checks?.filter?.((c) => c && c.severity && c.severity !== 'ok'), (c) => ({
    severity: c.severity, kind: c.check ?? c.kind, detail: c.detail, check: c.check,
  }));
  push('visual', tiers.visual?.findings, (f) => ({
    severity: f.severity, kind: f.check, detail: f.detail, width: f.width, check: f.check,
  }));

  const conf = Number(tiers.judge?.confidence);
  const row = publishable({
    'page-path': path,
    locale: code,
    group: text(report.group),
    template: text(report.template),
    pagetype: pagetypeOf(path),
    branch: text(report.branch) || branch,
    generated: text(report.generated),
    verdict: text(report.verdict),
    structural: tierVerdict(tiers, 'structural'),
    judge: tierVerdict(tiers, 'judge'),
    visual: tierVerdict(tiers, 'visual'),
    // Normalized to 0..1: live reports in the source carried `95` against a 0..1
    // schema, and a board rendering that as a percentage showed 9500%.
    confidence: Number.isFinite(conf) ? Math.min(1, conf > 1 ? conf / 100 : conf) : '',
    'finding-count': findings.length,
    'source-url': text(report.urls?.source),
    'target-url': text(report.urls?.target),
    doc: path && code ? txDocPath(path, code) : '',
  }, REPORT_COLUMNS);

  return {
    path,
    code,
    doc: feedDoc([
      ['meta', [metaRow({
        branch: row.branch,
        expected: findings.length,
        listed: findings.length,
        extra: { 'page-path': path, locale: code, verdict: row.verdict },
      })]],
      ['report', [row]],
      ['findings', findings],
    ]),
  };
}

/**
 * Every local tx report on disk, newest filename first for a stable `--limit`.
 *
 * The filename is `<code>--<slug>.json`, which is also how `FEEDS.txReport` addresses
 * the published copy — one naming rule, so a local report and its published subset are
 * findable from each other by eye in a directory listing.
 */
function localReports(dir, { locales, limit }) {
  if (!existsSync(dir)) return { dir, exists: false, files: [] };
  const wanted = new Set(locales);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => wanted.has(f.split('--')[0]))
    .sort();
  return {
    dir, exists: true, files: limit ? files.slice(0, limit) : files, total: files.length,
  };
}

/* ---------------------------------------------------------------- reading sheets */

async function readGroups(cfg, token, only) {
  const names = only ? [only] : groupNames(cfg);
  for (const n of names) groupConfig(cfg, n); // fail on a typo before any I/O
  const groups = [];
  const failed = [];
  for (const name of names) {
    const sheetCfg = groupConfig(cfg, name);
    try {
      const { exists, doc } = await fetchStatusDocVersioned(sheetCfg, token);
      if (exists) groups.push({ name, doc });
      else failed.push(`${name} (sheet does not exist)`);
    } catch (e) {
      failed.push(`${name} (${e.message})`);
    }
  }
  return { groups, failed };
}

/* ---------------------------------------------------------------------- the run */

const SAMPLE = 6;

async function publishDoc(path, branch, token, doc, opts, outDir) {
  if (docBytes(doc) > opts.maxBytes) {
    return { path, error: `${kb(docBytes(doc))} over the ${kb(opts.maxBytes)} ceiling`, oversize: true };
  }
  if (outDir) return { path, local: writeLocalFeed(outDir, path, doc) };
  if (!opts.apply) return { path, planned: true };
  try {
    const res = await writeFeed(path, branch, token, doc);
    if (!res.preview?.previewed) return { path, error: `preview refused: ${res.preview?.previewError}` };
    return { path, written: true, retried: res.retried };
  } catch (e) {
    // Best effort: one doc's failure is collected, never thrown. A batch that abandons
    // 200 reports because the 3rd one 412'd is worse than a batch that says which 1 failed.
    return { path, error: e.message };
  }
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const branch = opts.branch || cfg.publish?.branch;
  const locales = opts.locales.length ? opts.locales : [...TARGET_LOCALES];
  const resolveOut = (p) => (isAbsolute(p) ? p : join(REPO_ROOT, p));
  const outDir = opts.out ? resolveOut(opts.out) : null;

  const token = resolveToken();
  if (!token && !outDir) {
    console.error(`ERROR: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }

  console.log(`── tx:publish · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} · branch ${branch} ──`);
  console.log(`   locales: ${locales.join(' ')}`);

  const results = [];

  if (opts.index) {
    const { groups, failed } = await readGroups(cfg, token, opts.group);
    if (!groups.length) {
      console.error(`\n✗ no group sheet could be read — there is no page list to index.\n  ${failed.join('\n  ')}`);
      return 2;
    }
    console.log(`   group sheets read: ${groups.map((g) => g.name).join(', ')}`
      + `${failed.length ? ` · UNREADABLE: ${failed.join(', ')}` : ''}`);

    for (const code of locales) {
      const built = buildLocaleIndex(code, groups, { branch, failed });
      const path = FEEDS.txIndex(code);
      const meta = built.doc.meta.data[0];
      console.log(`\n   ── ${path} ──`);
      console.log(`      :type ${built.doc[':type']} · tabs ${(built.doc[':names'] || []).join(' ')} · ${kb(docBytes(built.doc))}`);
      console.log(`      present ${built.present} of ${built.expected} expected · withheld ${meta.withheld}`);
      console.log(`      ${meta.note}`);
      for (const r of built.doc.pages.data.slice(0, SAMPLE)) {
        console.log(`      → ${r['locale-path']}  stage=${r.stage || '(blocked)'} `
          + `tx=${r['translation-status'] || '—'} review=${r['review-status'] || '—'}`);
      }
      if (built.present > SAMPLE) console.log(`      → … ${built.present - SAMPLE} more`);
      results.push(await publishDoc(path, branch, token, built.doc, opts, outDir));
    }
  }

  if (opts.reports) {
    const found = localReports(cfg.state.txReportsDir, { locales, limit: opts.limit });
    console.log('\n   ── per-page reports ──');
    console.log(`      source: ${found.dir}`);
    if (!found.exists) {
      console.log('      (directory does not exist — no tier has written a report yet, so there is');
      console.log('       nothing to publish. That is the state of a pipeline that has not run.)');
    } else {
      console.log(`      ${found.files.length} of ${found.total} report(s) selected`
        + `${opts.limit ? ` (--limit=${opts.limit})` : ''}`);
      for (const file of found.files) {
        try {
          const report = JSON.parse(readFileSync(join(found.dir, file), 'utf8'));
          const built = buildPageReport(report, { branch });
          if (!built.path || !built.code) {
            results.push({ path: file, error: 'report has no page-path/locale — cannot address a published copy' });
          } else {
            const path = FEEDS.txReport(built.code, slugOf(built.path));
            const row = built.doc.report.data[0];
            console.log(`      → ${path}  verdict=${row.verdict || '—'} `
              + `structural=${row.structural || 'not run'} judge=${row.judge || 'not run'} `
              + `visual=${row.visual || 'not run'} findings=${row['finding-count']}`);
            results.push(await publishDoc(path, branch, token, built.doc, opts, outDir));
          }
        } catch (e) {
          results.push({ path: file, error: `unreadable report: ${e.message}` });
        }
      }
    }
  }

  const failedDocs = results.filter((r) => r.error);
  const written = results.filter((r) => r.written).length;
  const local = results.filter((r) => r.local).length;
  const planned = results.length - written - local - failedDocs.length;
  console.log(`\n   ${written} published · ${local} written locally · ${planned} planned · `
    + `${failedDocs.length} failed`);
  for (const f of failedDocs) console.error(`   ✗ ${f.path}: ${f.error}`);
  if (!opts.apply && !outDir) console.log('   Re-run with --apply to publish.');

  if (failedDocs.some((f) => f.oversize)) return 3;
  return failedDocs.length ? 1 : 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ tx:publish: ${e.message}`);
      exit(/^unknown arg|unknown target locale|mutually exclusive|must be a|unknown group/.test(e.message) ? 3 : 2);
    });
}
