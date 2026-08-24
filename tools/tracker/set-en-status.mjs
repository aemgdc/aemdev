#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * set-en-status.mjs — write the `en-status` column: the English-side send gate.
 *
 * `en-status: en-published` is the release signal. `emit-pairs` will only emit a pair
 * whose row carries it, so nothing reaches the translation service until a human puts
 * it there. This tool is the only writer of that column, and it is the flagging
 * mechanism: per-row (so one page is addressable) and bulk-selectable (so a whole
 * group moves in one command).
 *
 * CLI SURFACE
 *   node tools/tracker/set-en-status.mjs --group=<name> --to=<value>
 *        [--path=<page-path> …] [--all] [--from=<value>] [--where=<selector>]
 *        [--include-sent] [--dry-run|--apply] [--help]
 *
 *   npm run en-status -- --group=meetups --to=en-published --path=/en/meetups/aem-meetup-miami
 *   npm run en-status -- --group=meetups --to=en-published --from= --apply
 *   npm run en-status -- --group=indexes --to=draft --all
 *
 *   --to=<value>     REQUIRED. One of EN_STATUSES, or "" to clear.
 *   --path=          a page path; repeatable. An unmatched path is an ERROR.
 *   --all            every real page row in the group
 *   --from=<value>   only rows whose en-status is currently this. `--from=` with an
 *                    EMPTY value is a REAL selector ("not assessed yet"), which is
 *                    the most common bulk case — so it is tested for null, not for
 *                    falsiness.
 *   --where=         the shared selector grammar (lib/group-sheet.mjs `parseWhere`)
 *   --include-sent   also touch rows that already have a translation-status in some
 *                    locale (see below)
 *   --dry-run        print the plan and write nothing. THE DEFAULT.
 *   --apply          write.
 *
 * ─── The closed vocabulary is the point ─────────────────────────────────────
 *
 * A value outside `EN_STATUSES` is REJECTED rather than written. It is not a
 * cosmetic check: `classifyEnglish()` treats an unknown `en-status` as a WARNING and
 * then classifies the row as `catalogued`, so a typo'd value does not fail — it
 * quietly stops the page counting as publishable and the board shows one fewer page
 * ready to translate, with nothing pointing at the cell. Case is folded on the way in
 * because every reader of the column folds; `EN-Published` is the same instruction.
 *
 * ─── Rows already in flight are skipped ─────────────────────────────────────
 *
 * A row with a `translation-status` in any locale has already been handed to the
 * pipeline. Moving its gate afterwards does not unsend it — it just makes the board
 * disagree with what happened. Those rows are skipped and counted, and
 * `--include-sent` is the deliberate override for a re-run.
 *
 * EXIT CODES  0 written or planned · 2 could not reach DA · 3 usage/config error
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { normalizePath } from '../../scripts/tracker/locales.js';
import { EN_STATUSES, countsAsPage, indexLocaleRows } from '../../scripts/tracker/stages.js';
import { loadConfig, groupConfig } from './config.mjs';
import { resolveToken, TOKEN_HINT } from './lib/status-sheet.mjs';
import {
  setCurated,
  dataRowsOf,
  readGroupDoc,
  withDataRows,
  updateGroupDoc,
  groupSheetLink,
  parseWhere,
  matchWhere,
} from './lib/group-sheet.mjs';

const VALUES = EN_STATUSES.map((s) => s.value);
const KNOWN = new Set(VALUES.map((v) => v.toLowerCase()));

const HELP = `set-en-status — write the en-status send gate on a group's rows.

  --group=<name>   required
  --to=<value>     required: ${VALUES.map((v) => v || '""').join(' | ')}
  --path=<path>    a page path, repeatable; an unmatched path is an error
  --all            every real page row
  --from=<value>   rows whose en-status is currently this ("" selects blank rows)
  --where=<sel>    stage:<id> | queue:<id> | blocked | sendable | col=val | col!=val
  --include-sent   also touch rows already sent in some locale
  --dry-run        print the plan, write nothing (DEFAULT)
  --apply          write
  --help           this text

exit 0 ok · 2 could not reach DA · 3 usage/config error`;

function parseArgs(args) {
  const o = {
    group: null,
    to: null,
    from: null,
    where: null,
    paths: [],
    all: false,
    includeSent: false,
    apply: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--all') o.all = true;
    else if (a === '--include-sent') o.includeSent = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--to=')) o.to = a.slice(5).trim();
    else if (a.startsWith('--from=')) o.from = a.slice(7).trim();
    else if (a.startsWith('--where=')) o.where = a.slice(8);
    else if (a.startsWith('--path=')) o.paths.push(normalizePath(a.slice(7)));
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  if (!o.group) throw new Error('--group=<name> is required');
  if (o.to === null) throw new Error(`--to=<value> is required — one of: ${VALUES.map((v) => v || '""').join(', ')}`);
  /*
   * REJECT, never coerce. An unknown value classifies as a warning and silently stops
   * the row counting as publishable — the failure has no error message anywhere, so it
   * has to be refused at the door.
   */
  if (!KNOWN.has(o.to.toLowerCase())) {
    throw new Error(`--to="${o.to}" is not an en-status. Known: ${VALUES.map((v) => v || '(blank)').join(', ')}. `
      + 'An unknown value classifies as a warning and quietly stops the row counting as publishable.');
  }
  // Canonical spelling, since every reader folds case anyway. Storing `EN-Published`
  // would work and would still look wrong to the next person to read the sheet.
  o.to = VALUES.find((v) => v.toLowerCase() === o.to.toLowerCase());
  if (!o.all && !o.paths.length && o.from === null && !o.where) {
    throw new Error('select rows with --all, --path=, --from= or --where=');
  }
  return o;
}

const val = (row, key) => String(row?.[key] ?? '').trim();

/**
 * Which rows does the selector pick?
 *
 * An unmatched `--path=` refuses the WHOLE run rather than reporting "0 changed". A
 * hand-typed path is exactly where a typo or a stale spelling lives, and a tool that
 * shrugs at one teaches you to distrust its counts.
 */
export function select(rows, opts, parsedWhere, sentPaths) {
  const real = rows.filter((r) => countsAsPage(r));
  let picked = real;
  const parts = [];

  if (parsedWhere) {
    picked = picked.filter((r) => matchWhere(parsedWhere, r));
    parts.push(`where="${parsedWhere.describe}"`);
  }
  if (opts.paths.length) {
    const wanted = new Set(opts.paths);
    const missing = opts.paths.filter((p) => !real.some((r) => normalizePath(val(r, 'page-path')) === p));
    if (missing.length) {
      return {
        rows: [],
        refused: `${missing.length} of ${opts.paths.length} --path= value(s) are not real rows `
          + `in this group:\n     ${missing.join('\n     ')}`,
        describe: `${opts.paths.length} path(s)`,
      };
    }
    picked = picked.filter((r) => wanted.has(normalizePath(val(r, 'page-path'))));
    parts.push(`${opts.paths.length} path(s)`);
  }
  if (opts.from !== null) {
    picked = picked.filter((r) => val(r, 'en-status').toLowerCase() === opts.from.toLowerCase());
    parts.push(`from="${opts.from || '(blank)'}"`);
  }
  if (opts.all) parts.push('all real rows');

  const skippedSent = [];
  if (!opts.includeSent) {
    const keep = [];
    for (const r of picked) {
      if (sentPaths.has(normalizePath(val(r, 'page-path')))) skippedSent.push(r);
      else keep.push(r);
    }
    picked = keep;
  }
  return {
    rows: picked, refused: null, describe: parts.join(' + ') || 'all real rows', skippedSent,
  };
}

/** Paths that already carry a `translation-status` in at least one locale tab. */
function sentAlready(doc) {
  const out = new Set();
  const index = indexLocaleRows(doc);
  for (const [key, row] of index) {
    if (val(row, 'translation-status')) out.add(key.split('\0')[0]);
  }
  return out;
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const sheetCfg = groupConfig(cfg, opts.group);
  const token = resolveToken();
  if (!token) {
    console.error(`ERROR: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }

  const current = await readGroupDoc(sheetCfg, token);
  if (!current.exists) {
    console.error(`ERROR: ${sheetCfg.path} does not exist — run \`npm run group:scaffold -- --group=${opts.group}\``);
    return 3;
  }

  const rows = dataRowsOf(current.doc);
  let parsed = null;
  if (opts.where) {
    parsed = parseWhere(opts.where, { rows });
    if (parsed.errors.length) throw new Error(`--where= refused: ${parsed.errors.join('; ')}`);
  }
  const sel = select(rows, opts, parsed, sentAlready(current.doc));
  if (sel.refused) throw new Error(sel.refused);

  /*
   * The plan is computed as a list of intended changes rather than as a new row set:
   * the write below re-applies it against a FRESHLY read doc (see updateGroupDoc), so
   * a row set built here would be stale by the time it landed.
   */
  const changes = sel.rows
    .filter((row) => setCurated(row, { 'en-status': opts.to }).changes.length)
    .map((row) => ({ path: val(row, 'page-path'), from: val(row, 'en-status') }));

  console.log(`── ${opts.apply ? 'set' : 'plan'} en-status · ${opts.group} → "${opts.to || '(blank)'}" `
    + `· ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} ──`);
  console.log(`   sheet:    ${groupSheetLink(sheetCfg)}`);
  console.log(`   selector: ${sel.describe}`);
  console.log(`   matched ${sel.rows.length} of ${rows.filter((r) => countsAsPage(r)).length} real row(s) · changing ${changes.length}`);
  if (sel.skippedSent?.length) {
    console.log(`   skipped ${sel.skippedSent.length} row(s) already sent in some locale — pass --include-sent to touch them:`);
    for (const r of sel.skippedSent) console.log(`     · ${val(r, 'page-path')}`);
  }
  console.log('\n   the plan, row by row:');
  for (const c of changes) console.log(`     ${c.path}   "${c.from || '(blank)'}" → "${opts.to || '(blank)'}"`);
  if (!changes.length) console.log('     (nothing would change — every matched row already carries this value)');

  if (!opts.apply) {
    console.log('\n   Re-run with --apply to write.');
    return 0;
  }
  if (!changes.length) {
    console.log('\n   = nothing to write.');
    return 0;
  }

  const wanted = new Map(changes.map((c) => [normalizePath(c.path), opts.to]));
  const res = await updateGroupDoc(sheetCfg, token, (doc, { exists }) => {
    if (!exists) throw new Error('sheet vanished between the read and the write');
    // Re-applied against the FRESH doc, keyed on page-path, so a 412 retry cannot
    // write a stale row set over somebody else's concurrent change.
    const fresh = dataRowsOf(doc).map((row) => {
      const to = wanted.get(normalizePath(val(row, 'page-path')));
      return to === undefined ? row : setCurated(row, { 'en-status': to }).row;
    });
    return withDataRows(doc, fresh);
  }, {
    confirm: (after) => {
      const bad = dataRowsOf(after)
        .filter((r) => wanted.has(normalizePath(val(r, 'page-path'))))
        .filter((r) => val(r, 'en-status') !== opts.to)
        .map((r) => val(r, 'page-path'));
      return bad.length ? `${bad.length} row(s) did not take the value: ${bad.slice(0, 3).join(', ')}` : null;
    },
  });
  console.log(`\n   ✓ written${res.retried ? ' after one 412 retry' : ''} · preview `
    + `${res.preview?.previewed ? 'ok' : `FAILED: ${res.preview?.previewError}`}`);
  console.log(`   Next: npm run pairs -- --group=${opts.group}`);
  return 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ en-status: ${e.message}`);
      exit(/^unknown arg|required|is not an en-status|select rows|--where=|--path=|unknown group|are not real rows/.test(e.message) ? 3 : 2);
    });
}
