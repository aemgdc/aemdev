#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * sync-review-status.mjs — carry the human's verdict from the review DOCUMENTS into the
 * sheet. ONE WAY. DOC WINS.
 *
 * CLI SURFACE
 *   node tools/tracker/sync-review-status.mjs [--group=<name>] [--locale=<code> …]
 *        [--en] [--limit=N] [--branch=<ref>] [--dry-run|--apply]
 *        [--force-lock] [--json] [--help]
 *
 *   npm run qa:sync                                  plan, every group, ten locales
 *   npm run qa:sync -- --group=meetups --locale=de --apply
 *   npm run qa:sync -- --group=meetups --en          the English QA docs instead
 *
 * ─── Why the direction is fixed ─────────────────────────────────────────────
 *
 * `review-status` is the ONLY stored human judgement in the whole model (stages.js). It
 * is typed into a review document in DA, because a document is the surface a reviewer
 * actually has — and because ten locale reviewers on one page write ten different files
 * and cannot collide, where ten rows in one sheet means ten whole-document POSTs racing
 * each other and the pipeline.
 *
 * So the sheet's copy is a CACHE of what the document says, and this tool refreshes it.
 * The document wins, always. A two-way sync would need to decide which side is newer on a
 * pair of surfaces where one has no ETag and the other is rewritten wholesale by every
 * batch — there is no honest answer to that, so the question is not asked.
 *
 * ─── It NEVER CLEARS ────────────────────────────────────────────────────────
 *
 * A document with no marker, an unreadable marker, or no document at all leaves the
 * sheet's cell exactly as it was. Blanking a verdict because a doc 404'd would delete the
 * one field in this system that cost a human their attention, and it would do it most
 * often for the pairs furthest along — the ones whose docs a reviewer has been editing.
 *
 * An UNKNOWN marker is reported as a data-quality warning, never bucketed as pending:
 * `reviewStatusFromMarker()` returns null for it precisely so "nobody has reviewed this"
 * and "this document says something I cannot parse" stay different answers.
 *
 * EXIT CODES (data-contract.md §5)
 *   0 in sync, or the plan printed · 1 nothing (this tool finds no defects) ·
 *   2 could not read a sheet or a document · 3 usage or config error
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { normalizePath, isTargetLocale, TARGET_LOCALES } from '../../scripts/tracker/locales.js';
import {
  countsAsPage, indexLocaleRows, localeRowFor, REVIEW_STATUSES, docMarkerFor,
} from '../../scripts/tracker/stages.js';
import { loadConfig, groupConfig, groupNames } from './config.mjs';
import { resolveToken, TOKEN_HINT, writeStatusDoc } from './lib/status-sheet.mjs';
import {
  readGroupDoc, dataRowsOf, localeRowsOf, withLocaleRows, groupSheetLink, syncLocaleRow,
} from './lib/group-sheet.mjs';
import { withWriterLock } from './lib/writer-lock.mjs';
import { fetchTxDoc } from './lib/tx-doc-io.mjs';
import { fetchQaDoc } from './lib/qa-doc-io.mjs';

const HELP = `sync-review-status — copy each reviewer's verdict from its DA document to the sheet.

  --group=<name>   one registered group. Default: all of them.
  --locale=<code>  repeatable. Default: all ten target locales.
  --en             read the English QA docs and report their verdicts instead. The EN
                   side has no sheet column to sync to, so --en is READ-ONLY and refuses
                   --apply; it exists so one command can answer "what have reviewers
                   said" on both lines.
  --limit=N        read at most N documents per locale
  --branch=<ref>   preview the sheet against this ref after a write
  --dry-run        print the plan; write nothing. THE DEFAULT.
  --apply          write the sheet, under the writer lease
  --force-lock     take the writer lease even if one is held
  --json           print the plan as JSON
  --help           this text

exit 0 ok · 2 could not read a sheet or a document · 3 usage or config error`;

const val = (row, key) => String(row?.[key] ?? '').trim();
const fold = (v) => String(v ?? '').trim().toLowerCase();
const KNOWN = new Set(REVIEW_STATUSES.map((s) => fold(s.value)));

function parseArgs(args) {
  const o = {
    groups: [],
    locales: [],
    limit: Infinity,
    branch: null,
    en: false,
    apply: false,
    forceLock: false,
    json: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--en') o.en = true;
    else if (a === '--json') o.json = true;
    else if (a === '--force-lock') o.forceLock = true;
    else if (a.startsWith('--group=')) o.groups.push(a.slice(8));
    else if (a.startsWith('--locale=')) o.locales.push(a.slice(9).trim().toLowerCase());
    else if (a.startsWith('--limit=')) o.limit = Number(a.slice(8));
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  for (const c of o.locales) if (!isTargetLocale(c)) throw new Error(`--locale="${c}" is not a target locale`);
  if (!o.locales.length) o.locales = [...TARGET_LOCALES];
  if (o.en && o.apply) {
    throw new Error('--en is read-only: the English QA verdict has no sheet column to sync to, '
      + 'so there is nothing for --apply to write. Drop one of the two flags.');
  }
  return o;
}

/**
 * Compare one document's verdict against the sheet's cached copy.
 *
 * Returns a decision object rather than mutating, so `--dry-run` and `--apply` walk the
 * SAME code and the plan is provably what would be written. Every branch is named:
 * `in-sync`, `update`, `no-doc`, `no-marker`, `unknown-marker`, `error`. A count of
 * "272 documents reconciled" cannot tell you whether the right verdict landed on the
 * right row; a line per row can.
 */
export function decide({ pagePath, code, sheetValue, doc }) {
  const base = {
    'page-path': pagePath, locale: code, sheet: sheetValue, doc: null,
  };
  if (!doc.exists) {
    return { ...base, action: 'no-doc', detail: doc.reason || `not found (${doc.status})` };
  }
  const parsed = doc.doc;
  if (parsed.markerUnknown) {
    return {
      ...base,
      action: 'unknown-marker',
      path: doc.path,
      detail: 'the document\'s TRANSLATION STATUS line reads something outside the vocabulary. '
        + `Not treated as pending — the sheet keeps "${sheetValue || '(blank)'}" and a human `
        + `fixes the line. Expected one of: ${REVIEW_STATUSES.map((s) => docMarkerFor(s.value)).join(', ')}.`,
    };
  }
  if (parsed.status === null) {
    return {
      ...base, action: 'no-marker', path: doc.path, detail: 'no verdict recorded in the document yet',
    };
  }
  const next = parsed.status;
  if (!KNOWN.has(fold(next))) {
    return {
      ...base, action: 'unknown-marker', path: doc.path, doc: next, detail: `"${next}" is not a review-status`,
    };
  }
  if (fold(next) === fold(sheetValue)) {
    return {
      ...base, action: 'in-sync', path: doc.path, doc: next,
    };
  }
  return {
    ...base,
    action: 'update',
    path: doc.path,
    doc: next,
    updated: parsed.updated || '',
    actor: parsed.actor || '',
    /*
     * The document ALSO carries a mismatch between its visible marker line and its
     * metadata block. Surfaced here because it means two halves of one document disagree,
     * and syncing either one silently would make the tracker agree with a document that
     * does not agree with itself.
     */
    ...(parsed.mismatch ? { warning: `the document's marker and its metadata disagree (marker "${parsed.status}", metadata "${parsed.metaStatus}") — the visible line wins` } : {}),
  };
}

async function planGroup(cfg, name, opts, token) {
  const sheetCfg = groupConfig(cfg, name);
  const current = await readGroupDoc(sheetCfg, token);
  if (!current.exists) {
    return { group: name, sheetCfg, error: `${sheetCfg.path} does not exist — nothing to sync` };
  }
  const dataRows = dataRowsOf(current.doc).filter((r) => countsAsPage(r));
  const localeIndex = indexLocaleRows(current.doc);
  const decisions = [];

  if (opts.en) {
    for (const row of dataRows.slice(0, opts.limit)) {
      const path = normalizePath(val(row, 'page-path'));
      const doc = await fetchQaDoc(sheetCfg, path, token);
      decisions.push({
        'page-path': path,
        locale: 'en',
        action: doc.exists ? 'read-only' : 'no-doc',
        path: doc.path,
        detail: doc.exists
          ? `EN QA doc verdict: ${JSON.stringify(doc.doc?.qaStatus ?? doc.doc?.status ?? null)}`
          : (doc.reason || 'not found'),
      });
    }
    return {
      group: name, sheetCfg, decisions, current,
    };
  }

  for (const code of opts.locales) {
    let read = 0;
    for (const row of dataRows) {
      if (read >= opts.limit) break;
      const path = normalizePath(val(row, 'page-path'));
      const localeRow = localeRowFor(localeIndex, path, code);
      const doc = await fetchTxDoc(sheetCfg, path, code, token);
      read += 1;
      decisions.push(decide({
        pagePath: path, code, sheetValue: val(localeRow, 'review-status'), doc,
      }));
    }
  }
  return {
    group: name, sheetCfg, decisions, current,
  };
}

/**
 * Apply the updates to the in-memory doc.
 *
 * `review-status` and `review-updated` only. Nothing else on the row is touched — not
 * `sent-at`, not `translation-status`, not the crawl columns — which is what makes a
 * re-apply onto a newer copy of the sheet safe after a 412.
 */
export function applyDecisions(doc, code, decisions) {
  const rows = localeRowsOf(doc, code);
  const byPath = new Map(rows.map((r) => [normalizePath(val(r, 'page-path')), r]));
  const applied = [];
  for (const d of decisions.filter((x) => x.action === 'update' && x.locale === code)) {
    let row = byPath.get(normalizePath(d['page-path']));
    if (!row) {
      row = syncLocaleRow(null, { pagePath: d['page-path'], code }).row;
      rows.push(row);
      byPath.set(normalizePath(d['page-path']), row);
    }
    row['review-status'] = d.doc;
    // The document's own timestamp when it has one: this column records when the HUMAN
    // decided, not when this tool noticed.
    row['review-updated'] = d.updated || new Date().toISOString();
    applied.push({ path: d['page-path'], code, status: d.doc });
  }
  return { doc: withLocaleRows(doc, code, rows), applied };
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
    console.error(`✗ qa:sync: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }

  console.log(`qa:sync — ${names.join(' ')} · ${opts.en ? 'EN QA docs (read-only)' : opts.locales.join(' ')}`);
  console.log(opts.apply
    ? '  MODE apply — review-status and review-updated WILL be written to the sheet.'
    : '  MODE dry-run — printing the plan; nothing is written.');
  console.log('  DIRECTION: document → sheet, one way. The document is where the human typed.\n');

  const plans = [];
  for (const name of names) plans.push(await planGroup(cfg, name, opts, token));

  let readErrors = 0;
  for (const p of plans) {
    if (p.error) {
      console.log(`── ${p.group}: ⚠ ${p.error}`);
      readErrors += 1;
    } else {
      const by = (a) => p.decisions.filter((d) => d.action === a);
      console.log(`── ${p.group} — ${p.decisions.length} document(s) read`);
      for (const d of by('update')) {
        console.log(`   UPDATE ${d.locale} ${d['page-path']}`);
        console.log(`     review-status   "${d.sheet || '(blank)'}" → "${d.doc}"`);
        console.log(`     review-updated  → ${d.updated || '(now)'}${d.actor ? ` by ${d.actor}` : ''}`);
        console.log(`     from            ${d.path}`);
        if (d.warning) console.log(`     ⚠ ${d.warning}`);
      }
      for (const d of by('unknown-marker')) {
        console.log(`   ⚠ UNPARSEABLE ${d.locale} ${d['page-path']} — ${d.detail}`);
        console.log(`     ${d.path}`);
      }
      for (const d of by('read-only')) console.log(`   ${d['page-path']} — ${d.detail}`);
      const quiet = by('in-sync').length + by('no-marker').length + by('no-doc').length;
      if (quiet) {
        console.log(`   ${by('in-sync').length} already in sync · ${by('no-marker').length} `
          + `no verdict yet · ${by('no-doc').length} no review doc`);
      }
      if (!p.decisions.length) {
        console.log('   (no countable pages in this group — nothing to read)');
      }
    }
  }

  if (opts.json) {
    const shape = plans.map((p) => ({
      group: p.group, error: p.error ?? null, decisions: p.decisions ?? [],
    }));
    console.log(JSON.stringify(shape, null, 2));
  }

  const updates = plans.flatMap((p) => (p.decisions || []).filter((d) => d.action === 'update'));
  if (!opts.apply) {
    console.log(`\n${updates.length} row(s) would change. Re-run with --apply to write them.`);
    for (const p of plans) if (p.sheetCfg) console.log(`  ${groupSheetLink(p.sheetCfg)}`);
    return readErrors ? 2 : 0;
  }
  if (!updates.length) {
    console.log('\nNothing to write — every sheet cell already matches its document.');
    return readErrors ? 2 : 0;
  }

  await withWriterLock(token, `qa:sync ${names.join(',')}`, { force: opts.forceLock }, async () => {
    for (const p of plans.filter((x) => !x.error)) {
      let { doc } = p.current;
      const applied = [];
      for (const code of opts.locales) {
        const out = applyDecisions(doc, code, p.decisions);
        doc = out.doc;
        applied.push(...out.applied);
      }
      if (!applied.length) return;
      const cfgWithBranch = opts.branch ? { ...p.sheetCfg, branch: opts.branch } : p.sheetCfg;
      try {
        const res = await writeStatusDoc(cfgWithBranch, token, doc, { version: p.current.version });
        console.log(`${p.group}: wrote ${applied.length} verdict(s)`
          + `${res.previewed === false ? ` ⚠ preview: ${res.previewError}` : ''}`);
      } catch (e) {
        // ONE retry on a conflict, then say so. See tx-driver's writeSheet for the
        // settling-preview race this is; a loop turns a contended sheet into a spin.
        if (!e.conflict) {
          console.log(`${p.group}: ⚠ not written — ${e.message}`);
        } else {
          const fresh = await readGroupDoc(p.sheetCfg, token);
          let next = fresh.doc;
          for (const code of opts.locales) next = applyDecisions(next, code, p.decisions).doc;
          try {
            await writeStatusDoc(cfgWithBranch, token, next, { version: fresh.version });
            console.log(`${p.group}: re-applied ${applied.length} verdict(s) onto a newer copy after a 412.`);
          } catch (e2) {
            console.log(`${p.group}: ⚠ not written after one retry — ${e2.message}. Another writer `
              + 'is active; the documents are already correct, so re-run to sync the sheet.');
          }
        }
      }
    }
  });
  return readErrors ? 2 : 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ qa:sync: ${e.message}`);
      exit(/^unknown arg|is not a target locale|--en is read-only|unknown group/.test(e.message) ? 3 : 2);
    });
}
