#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * tx-reconcile.mjs — make the three places a pair's state lives agree, or say exactly
 * where they do not.
 *
 * CLI SURFACE
 *   node tools/tracker/tx-reconcile.mjs [--group=<name>] [--locale=<code> …]
 *        [--from-ledger] [--refresh-docs] [--limit=N] [--branch=<ref>]
 *        [--force] [--force-lock] [--json] [--dry-run|--apply] [--help]
 *
 *   npm run tx:reconcile                                     the plan, everything
 *   npm run tx:reconcile -- --group=meetups --locale=de
 *   npm run tx:reconcile -- --group=meetups --locale=de --apply
 *
 * ─── The three places, and which one wins on what ───────────────────────────
 *
 *   the LOCALE TAB      the source of truth for status (data-contract §4, explicitly)
 *   the REVIEW DOC      where a human types. WINS on `review-status`, always.
 *   the LEDGER          run bookkeeping. WINS ON NOTHING.
 *
 * The third line is the one that has to be stated, because the pipeline this was ported
 * from got it backwards: one tool read tier status from a gitignored per-machine ledger
 * while another wrote it to a sheet tab nobody read, and that was the weakest link in its
 * whole state model. So a ledger/sheet disagreement is REPORTED and repaired only when
 * asked (`--from-ledger`) — the ledger can legitimately be ahead (a batch whose sheet
 * write 412'd) or behind (another machine ran it), and only a human knows which.
 *
 * ─── THIS IS THE TOOL THE REGRESSION GUARD EXISTS FOR ───────────────────────
 *
 * Upstream, a reconcile silently moved 33 rows backwards — from a later stage to an
 * earlier one — because the guard was built on `classify()`, which folds in the human
 * review verdict. All 33 rows carried `ready-for-review`, so classify() returned the same
 * answer for the old and the new value and every write compared equal. The guard here is
 * `translationOrder()` from stages.js, which reads `translation-status` ALONE. A backwards
 * write is refused, named, and requires `--force`.
 *
 * ─── DRY RUN BY DEFAULT, AND THE PLAN IS PER ROW ────────────────────────────
 *
 * A count cannot tell you whether the right owner is on each of 272 documents. So every
 * row this would touch is printed with its column, its old value and its new value,
 * before anything is written.
 *
 * EXIT CODES (data-contract.md §5)
 *   0 in sync, or the plan printed · 1 a REGRESSION was refused — the three surfaces
 *   disagree in a direction this tool will not resolve on its own ·
 *   2 could not read a sheet or a document · 3 usage or config error
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import { normalizePath, isTargetLocale, TARGET_LOCALES } from '../../scripts/tracker/locales.js';
import {
  countsAsPage, indexLocaleRows, localeRowFor, classifyTranslation, REVIEW_STATUSES,
} from '../../scripts/tracker/stages.js';
import { loadConfig, groupConfig, groupNames, REPO_ROOT } from './config.mjs';
import { resolveToken, TOKEN_HINT, writeStatusDoc } from './lib/status-sheet.mjs';
import {
  readGroupDoc, dataRowsOf, localeRowsOf, withLocaleRows, groupSheetLink, syncLocaleRow,
} from './lib/group-sheet.mjs';
import { withWriterLock } from './lib/writer-lock.mjs';
import { fetchTxDoc, writeTxFindings, docLinksFor } from './lib/tx-doc-io.mjs';
import { ledgerKey, regression } from './tx-driver.mjs';

const HELP = `tx-reconcile — reconcile the review documents, the locale tabs and the ledger.

  --group=<name>    one registered group. Default: all of them.
  --locale=<code>   repeatable. Default: all ten target locales.
  --from-ledger     also propose repairs where the LEDGER is ahead of the sheet. Off by
                    default: the ledger is run bookkeeping and is authoritative for
                    nothing, so a repair from it is a human's decision.
  --refresh-docs    push the sheet's translation-status into each review doc's metadata
                    where the two disagree. The doc's copy of a PIPELINE value is a
                    display cache; the sheet owns it.
  --limit=N         read at most N documents per locale
  --branch=<ref>    preview against this ref after a write
  --force           write a BACKWARDS status move anyway. Read the refusal first.
  --force-lock      take the writer lease even if one is held
  --json            print the plan as JSON
  --dry-run         print the plan; write nothing. THE DEFAULT.
  --apply           write it
  --help            this text

exit 0 ok · 1 a regression was refused · 2 could not read · 3 usage or config error`;

const val = (row, key) => String(row?.[key] ?? '').trim();
const fold = (v) => String(v ?? '').trim().toLowerCase();
const KNOWN_REVIEW = new Set(REVIEW_STATUSES.map((s) => fold(s.value)));

function parseArgs(args) {
  const o = {
    groups: [],
    locales: [],
    fromLedger: false,
    refreshDocs: false,
    limit: Infinity,
    branch: null,
    force: false,
    forceLock: false,
    json: false,
    apply: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--from-ledger') o.fromLedger = true;
    else if (a === '--refresh-docs') o.refreshDocs = true;
    else if (a === '--force') o.force = true;
    else if (a === '--force-lock') o.forceLock = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('--group=')) o.groups.push(a.slice(8));
    else if (a.startsWith('--locale=')) o.locales.push(a.slice(9).trim().toLowerCase());
    else if (a.startsWith('--limit=')) o.limit = Number(a.slice(8));
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  for (const c of o.locales) if (!isTargetLocale(c)) throw new Error(`--locale="${c}" is not a target locale`);
  if (!o.locales.length) o.locales = [...TARGET_LOCALES];
  return o;
}

/*
 * THE REGRESSION GUARD is IMPORTED from tx-driver, not restated here.
 *
 * Two writers of the same column with two copies of the same rule is how they come to
 * disagree about it — and this is the tool the guard exists for (see the header), so a
 * private copy here is the last place a divergence should be allowed to live. The rule and
 * its refusal text have exactly one home.
 */

/**
 * Every proposed change for one pair, as named decisions.
 *
 * Pure — no I/O — so the whole reconcile can be checked against real row shapes, and so
 * `--dry-run` and `--apply` walk the same code. A plan built by different code from the
 * write it describes is not a plan.
 */
export function reconcilePair({
  pagePath, code, row, localeRow, doc, ledgerEntry, opts,
}) {
  const out = [];
  const sheetReview = val(localeRow, 'review-status');
  const sheetStatus = val(localeRow, 'translation-status');
  const at = { 'page-path': pagePath, locale: code };

  /* 1. review-status: THE DOC WINS. This is the only human judgement in the model. */
  if (doc.exists) {
    const d = doc.doc;
    if (d.markerUnknown) {
      out.push({
        ...at,
        kind: 'doc-marker-unparseable',
        writes: null,
        detail: 'the document\'s TRANSLATION STATUS line is outside the vocabulary, so it is NOT '
          + `read as pending — the sheet keeps "${sheetReview || '(blank)'}" and a human fixes the line.`,
        path: doc.path,
      });
    } else if (d.status !== null && KNOWN_REVIEW.has(fold(d.status))
      && fold(d.status) !== fold(sheetReview)) {
      out.push({
        ...at,
        kind: 'review-status',
        column: 'review-status',
        was: sheetReview,
        now: d.status,
        writes: 'sheet',
        detail: `the reviewer's document says "${d.status}"; the sheet cached `
          + `"${sheetReview || '(blank)'}". The document wins.`,
        updated: d.updated || '',
        actor: d.actor || '',
        path: doc.path,
        ...(d.mismatch ? { warning: `the document's own marker and metadata disagree (marker "${d.status}", metadata "${d.metaStatus}") — the visible line wins` } : {}),
      });
    }

    /* 2. translation-status in the doc's metadata is a display CACHE of a sheet value. */
    const docStatus = String(d.translationStatus ?? '').trim();
    if (opts.refreshDocs && docStatus !== sheetStatus) {
      out.push({
        ...at,
        kind: 'doc-refresh',
        column: 'translation-status (in the document)',
        was: docStatus,
        now: sheetStatus,
        writes: 'doc',
        detail: 'the document is showing a reviewer a stale pipeline status. The SHEET owns this '
          + 'value, so the document is refreshed from it and never the other way round.',
        path: doc.path,
      });
    }
  } else if (sheetStatus || sheetReview) {
    /*
     * A pair with a recorded status and no document. Reported, never repaired here:
     * creating the doc is `tx:batch`'s job and it needs the tier findings to put in it.
     * A doc scaffolded empty by a reconcile is a doc that tells a reviewer nothing.
     */
    out.push({
      ...at,
      kind: 'doc-missing',
      writes: null,
      detail: `the sheet records translation-status "${sheetStatus || '(blank)'}"`
        + `${sheetReview ? ` and review-status "${sheetReview}"` : ''} but there is no review `
        + `document (${doc.reason || doc.status}). Run \`npm run tx:batch\` for this pair — it `
        + 'creates the doc WITH its findings; a doc scaffolded empty tells a reviewer nothing.',
      path: doc.path,
    });
  }

  /* 3. the LEDGER. Authoritative for nothing; reported always, repaired only on request. */
  const ledgerStatus = String(ledgerEntry?.['translation-status'] ?? '').trim();
  if (ledgerStatus && ledgerStatus !== sheetStatus) {
    const refusal = regression(sheetStatus, ledgerStatus);
    const proposed = opts.fromLedger && (!refusal || opts.force);
    out.push({
      ...at,
      kind: 'ledger-drift',
      column: 'translation-status',
      was: sheetStatus,
      now: ledgerStatus,
      writes: proposed ? 'sheet' : null,
      refusal: refusal && !opts.force ? refusal : null,
      detail: `the ledger's last run recorded "${ledgerStatus}"; the sheet says `
        + `"${sheetStatus || '(blank)'}". ${proposed
          ? 'Repairing from the ledger because --from-ledger was given.'
          : 'NOT repaired: the ledger is run bookkeeping and is authoritative for nothing. It '
            + 'can be ahead (a batch whose sheet write 412\'d) or behind (another machine ran '
            + 'it), and only you know which. --from-ledger repairs it.'}`,
      report: ledgerEntry?.report || null,
    });
  }

  /* 4. What the model now makes of the pair, so a plan can be read without a second tool. */
  const cls = classifyTranslation(row, localeRow);
  return {
    decisions: out,
    stage: cls.stage,
    queues: cls.queues,
    blocked: cls.blocked,
    warnings: cls.warnings,
  };
}

async function planGroup(cfg, name, opts, token, ledger) {
  const sheetCfg = groupConfig(cfg, name);
  const current = await readGroupDoc(sheetCfg, token);
  if (!current.exists) {
    return { group: name, sheetCfg, error: `${sheetCfg.path} does not exist — nothing to reconcile` };
  }
  const dataRows = dataRowsOf(current.doc).filter((r) => countsAsPage(r));
  const localeIndex = indexLocaleRows(current.doc);
  const decisions = [];
  const modelWarnings = [];
  let read = 0;

  for (const code of opts.locales) {
    let perLocale = 0;
    for (const row of dataRows) {
      if (perLocale >= opts.limit) break;
      const path = normalizePath(val(row, 'page-path'));
      const localeRow = localeRowFor(localeIndex, path, code);
      const doc = await fetchTxDoc(sheetCfg, path, code, token);
      read += 1;
      perLocale += 1;
      const res = reconcilePair({
        pagePath: path,
        code,
        row,
        localeRow,
        doc,
        ledgerEntry: ledger.pages?.[ledgerKey(path, code)],
        opts,
      });
      decisions.push(...res.decisions);
      for (const w of res.warnings) modelWarnings.push({ 'page-path': path, locale: code, warning: w });
    }
  }
  return {
    group: name, sheetCfg, current, decisions, modelWarnings, read,
  };
}

/** Apply the sheet-bound decisions to the in-memory doc. Named columns only. */
export function applyToSheet(doc, code, decisions) {
  const rows = localeRowsOf(doc, code);
  const byPath = new Map(rows.map((r) => [normalizePath(val(r, 'page-path')), r]));
  const applied = [];
  for (const d of decisions.filter((x) => x.writes === 'sheet' && x.locale === code && !x.refusal)) {
    let row = byPath.get(normalizePath(d['page-path']));
    if (!row) {
      row = syncLocaleRow(null, { pagePath: d['page-path'], code }).row;
      rows.push(row);
      byPath.set(normalizePath(d['page-path']), row);
    }
    if (d.kind === 'review-status') {
      row['review-status'] = d.now;
      // The HUMAN's timestamp when the document carries one: this column records when
      // they decided, not when this tool noticed.
      row['review-updated'] = d.updated || new Date().toISOString();
    } else if (d.kind === 'ledger-drift') {
      row['translation-status'] = d.now;
    }
    applied.push(d);
  }
  return { doc: withLocaleRows(doc, code, rows), applied };
}

function printPlan(p, opts) {
  if (p.error) {
    console.log(`── ${p.group}: ⚠ ${p.error}`);
    return;
  }
  console.log(`── ${p.group} — ${p.read} document(s) read, ${p.decisions.length} finding(s)`);
  if (!p.decisions.length && !p.modelWarnings.length) {
    console.log('   in sync: every document, locale row and ledger entry agree.');
  }
  for (const d of p.decisions) {
    const target = d.writes ? d.writes.toUpperCase() : 'REPORT';
    console.log(`   [${target}] ${d.locale} ${d['page-path']}  (${d.kind})`);
    if (d.column) console.log(`     ${d.column}: "${d.was || '(blank)'}" → "${d.now}"`);
    console.log(`     ${d.detail}`);
    if (d.refusal) console.log(`     ✗ REFUSED: ${d.refusal}`);
    if (d.warning) console.log(`     ⚠ ${d.warning}`);
    if (d.path) console.log(`     ${d.path}`);
    if (d.report) console.log(`     evidence: ${d.report}`);
  }
  /*
   * The model's own complaints about the rows, printed alongside. A reconcile that fixes
   * the columns and does not mention that `classifyTranslation` is warning about six of
   * them has answered a narrower question than the one that was asked.
   */
  if (p.modelWarnings.length) {
    console.log(`   ${p.modelWarnings.length} row(s) the status model itself warns about:`);
    for (const w of p.modelWarnings.slice(0, opts.limit === Infinity ? 20 : opts.limit)) {
      console.log(`     ${w.locale} ${w['page-path']}: ${w.warning}`);
    }
  }
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const cfg = loadConfig();
  const names = opts.groups.length ? opts.groups : groupNames(cfg);
  const token = resolveToken();
  if (!token) {
    console.error(`✗ tx:reconcile: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }
  const ledgerPath = cfg.state.txLedger;
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { pages: {} };

  console.log(`tx:reconcile — ${names.join(' ')} · ${opts.locales.join(' ')}`);
  console.log(opts.apply ? '  MODE apply — the plan below WILL be written.' : '  MODE dry-run — printing the plan; nothing is written.');
  console.log('  review-status: THE DOCUMENT WINS. translation-status: THE SHEET OWNS IT.');
  console.log(`  ledger: ${existsSync(ledgerPath) ? relative(REPO_ROOT, ledgerPath) : 'none yet'}`
    + `${opts.fromLedger ? ' — repairs from it are ENABLED (--from-ledger)' : ' — reported only'}\n`);

  const plans = [];
  for (const name of names) plans.push(await planGroup(cfg, name, opts, token, ledger));
  for (const p of plans) printPlan(p, opts);
  if (opts.json) {
    const shape = plans.map((p) => ({
      group: p.group, error: p.error ?? null, decisions: p.decisions ?? [],
    }));
    console.log(JSON.stringify(shape, null, 2));
  }

  const all = plans.flatMap((p) => p.decisions || []);
  /*
   * One place decides the exit code, because callers branch on it and three nested
   * ternaries spelling the same rule three times is how they come to disagree.
   * A refusal outranks a read error: a refusal is a real inconsistency somebody must
   * resolve, while a read error means one surface was unavailable this run.
   */
  const exitCode = (refusedCount, errorCount) => {
    if (refusedCount) return 1;
    return errorCount ? 2 : 0;
  };
  const refused = all.filter((d) => d.refusal);
  const writes = all.filter((d) => d.writes && !d.refusal);
  const readErrors = plans.filter((p) => p.error).length;

  console.log(`\n${writes.length} change(s) to write · ${refused.length} refused · `
    + `${all.length - writes.length - refused.length} reported only`);
  if (refused.length) {
    console.log('A refusal is not a bug in this tool. It means the three surfaces disagree in a '
      + 'direction that needs a decision — clear the stale status deliberately, or re-run the '
      + 'tiers, or pass --force if you have read the refusal and mean it.');
  }

  if (!opts.apply) {
    for (const p of plans) if (p.sheetCfg) console.log(`  ${groupSheetLink(p.sheetCfg)}`);
    if (writes.length) console.log('Re-run with --apply to write the plan above.');
    return exitCode(refused.length, readErrors);
  }
  if (!writes.length) {
    console.log('Nothing to write.');
    return exitCode(refused.length, readErrors);
  }

  await withWriterLock(token, `tx:reconcile ${names.join(',')}`, { force: opts.forceLock }, async () => {
    for (const p of plans.filter((x) => !x.error)) {
      /* Documents first, one at a time: each is its own file and its own concurrency unit. */
      for (const d of (p.decisions || []).filter((x) => x.writes === 'doc' && !x.refusal)) {
        const res = await writeTxFindings(p.sheetCfg, {
          enPath: d['page-path'],
          code: d.locale,
          // No findings change — only the metadata line. Passing the doc's existing
          // findings back would rewrite them from a report this tool has not read.
          findings: {},
          translationStatus: d.now,
          actor: 'tx:reconcile',
          branch: opts.branch,
          token,
        });
        console.log(res.written
          ? `  doc updated ${res.path}`
          : `  ⚠ doc not updated ${docLinksFor(p.sheetCfg, d['page-path'], d.locale).path}: ${res.reason}`);
      }

      let { doc } = p.current;
      const applied = [];
      for (const code of opts.locales) {
        const out = applyToSheet(doc, code, p.decisions || []);
        doc = out.doc;
        applied.push(...out.applied);
      }
      if (!applied.length) return;
      const target = opts.branch ? { ...p.sheetCfg, branch: opts.branch } : p.sheetCfg;
      try {
        const res = await writeStatusDoc(target, token, doc, { version: p.current.version });
        console.log(`  ${p.group}: wrote ${applied.length} cell(s)`
          + `${res.previewed === false ? ` ⚠ preview: ${res.previewError}` : ''}`);
      } catch (e) {
        if (!e.conflict) {
          console.log(`  ${p.group}: ⚠ not written — ${e.message}`);
        } else {
          // ONE retry. A loop turns a contended sheet into a spin; see tx-driver.
          const fresh = await readGroupDoc(p.sheetCfg, token);
          let next = fresh.doc;
          for (const code of opts.locales) next = applyToSheet(next, code, p.decisions || []).doc;
          try {
            await writeStatusDoc(target, token, next, { version: fresh.version });
            console.log(`  ${p.group}: re-applied ${applied.length} cell(s) onto a newer copy after a 412.`);
          } catch (e2) {
            console.log(`  ${p.group}: ⚠ not written after one retry — ${e2.message}. Another writer `
              + 'is active; re-run when it finishes.');
          }
        }
      }
    }
  });
  return exitCode(refused.length, readErrors);
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ tx:reconcile: ${e.message}`);
      exit(/^unknown arg|is not a target locale|unknown group/.test(e.message) ? 3 : 2);
    });
}
