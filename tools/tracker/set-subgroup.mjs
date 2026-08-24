#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * set-subgroup.mjs — classify pages into a `subgroup` of their group.
 *
 * The one dimension nothing infers. A group comes from the path prefix
 * (lib/group-map.mjs) and cannot say "these six articles are the adaptTo series" or
 * "these bios are speakers and those are contributors". `subgroup` is that dimension
 * and this is its only writer. See scripts/tracker/subgroups.js for why the value is
 * a slug rather than an enum or free prose.
 *
 * CLI SURFACE
 *   node tools/tracker/set-subgroup.mjs --group=<name> --to=<slug>
 *        [--path=<page-path> …] [--all] [--from=<slug>] [--where=<selector>]
 *        [--dry-run|--apply] [--help]
 *   node tools/tracker/set-subgroup.mjs --group=<name> --list
 *
 *   npm run subgroup -- --group=technical-articles --to=adaptto-2026 \
 *     --path=/en/articles/aem-eds-content-modeling-deep-dive
 *   npm run subgroup -- --group=meetups --to=recaps --where="status=recap"
 *   npm run subgroup -- --group=meetups --list
 *   npm run subgroup -- --group=meetups --to="" --from=recaps --apply    # clear
 *
 * ─── THREE DELIBERATE REFUSALS, all ported with their reasons ───────────────
 *
 * 1. An unmatched `--path=` is an ERROR, not a no-op. Classifying by hand is exactly
 *    where a typo'd or stale path lives, and a tool that reports "0 changed" for a
 *    misspelled path teaches you to distrust its counts.
 *
 * 2. A `--where=` naming a column the sheet does not have refuses the whole run. A
 *    missing column reads as `''`, so on a sheet that has not been upgraded yet
 *    `subgroup=x` would quietly select NOTHING and `subgroup!=x` would quietly select
 *    EVERY ROW. Failing closed on the name is the only safe reading. (Enforced in
 *    `parseWhere`, lib/group-sheet.mjs.)
 *
 * 3. `--to` has NO DEFAULT. It must be given explicitly, so no run can silently blank
 *    a column somebody spent a morning filling in. `--to=""` clears it, and that is a
 *    thing you have to type.
 *
 * Plus the slug pin: a non-slug `--to` is REFUSED and the slug is printed, never
 * silently applied. The value IS the `?sub-group=` query parameter on a Page Tracker
 * deep link, so `UK/IE` needs encoding to survive a query string — and a tool that
 * quietly rewrote it would leave the sheet saying something the person did not type,
 * so the next person grepping for their own label would not find it.
 *
 * EXIT CODES  0 written or planned · 2 could not reach DA · 3 usage/config error
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { normalizePath } from '../../scripts/tracker/locales.js';
import { countsAsPage } from '../../scripts/tracker/stages.js';
import {
  bySubgroup, subgroupOf, subgroupKey, subgroupSlug, isAssigned, UNASSIGNED,
} from '../../scripts/tracker/subgroups.js';
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

const HELP = `set-subgroup — classify a group's pages into subgroups.

  --group=<name>   required
  --to=<slug>      required (or --to="" to clear). Lowercase, digits, hyphens.
  --path=<path>    a page path, repeatable; an unmatched path is an error
  --all            every real page row
  --from=<slug>    rows currently in this subgroup ("" or omitted value = unassigned)
  --where=<sel>    stage:<id> | queue:<id> | blocked | sendable | col=val | col!=val
  --list           print the current breakdown and exit
  --dry-run        print the plan, write nothing (DEFAULT)
  --apply          write
  --help           this text

exit 0 ok · 2 could not reach DA · 3 usage/config error`;

export function parseArgs(args) {
  const o = {
    group: null,
    to: null,
    from: null,
    where: null,
    paths: [],
    all: false,
    list: false,
    apply: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--all') o.all = true;
    else if (a === '--list') o.list = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--to=')) o.to = a.slice(5).trim();
    else if (a.startsWith('--from=')) o.from = a.slice(7).replace(/\s+/g, ' ').trim();
    else if (a.startsWith('--where=')) o.where = a.slice(8);
    else if (a.startsWith('--path=')) o.paths.push(normalizePath(a.slice(7)));
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  if (!o.group) throw new Error('--group=<name> is required');
  if (o.list) return o;
  // Refusal 3: no default, so no run can blank the column by accident.
  if (o.to === null) throw new Error('--to=<slug> is required (or --to="" to clear)');
  if (o.to !== '' && subgroupSlug(o.to) !== o.to) {
    throw new Error(`--to="${o.to}" is not slug-style. Use "${subgroupSlug(o.to)}" — lowercase, digits `
      + 'and hyphens only, so it is safe in ?sub-group= on a Page Tracker deep link. Refused rather '
      + 'than rewritten: the sheet must say what you typed.');
  }
  if (!o.all && !o.paths.length && o.from === null && !o.where) {
    throw new Error('select rows with --all, --path=, --from= or --where=');
  }
  return o;
}

const val = (row, key) => String(row?.[key] ?? '').trim();

/** @returns {{ rows, refused: string|null, describe: string }} */
export function select(rows, opts, parsedWhere) {
  const real = rows.filter((r) => countsAsPage(r));
  let picked = real;
  const parts = [];

  if (parsedWhere) {
    picked = picked.filter((r) => matchWhere(parsedWhere, r));
    parts.push(`where="${parsedWhere.describe}"`);
  }
  if (opts.paths.length) {
    // Refusal 1.
    const missing = opts.paths.filter((p) => !real.some((r) => normalizePath(val(r, 'page-path')) === p));
    if (missing.length) {
      return {
        rows: [],
        refused: `${missing.length} of ${opts.paths.length} --path= value(s) are not real rows `
          + `in this group:\n     ${missing.join('\n     ')}`,
        describe: `${opts.paths.length} path(s)`,
      };
    }
    const wanted = new Set(opts.paths);
    picked = picked.filter((r) => wanted.has(normalizePath(val(r, 'page-path'))));
    parts.push(`${opts.paths.length} path(s)`);
  }
  if (opts.from !== null) {
    const want = subgroupKey(opts.from || UNASSIGNED);
    picked = picked.filter((r) => subgroupKey(subgroupOf(r)) === want);
    parts.push(`from="${opts.from || UNASSIGNED}"`);
  }
  if (opts.all) parts.push('all real rows');
  return { rows: picked, refused: null, describe: parts.join(' + ') || 'all real rows' };
}

/**
 * The subgroup breakdown of a row set.
 *
 * `(unassigned)` is a real bucket, forced last regardless of size. Blank is the normal
 * state early on, so size-sorting it to the top buries the labels somebody actually
 * authored — and it has to be a bucket rather than a filter because a group's
 * subgroups must always re-add to the group's own total, per column.
 */
function printBreakdown(label, rows) {
  const buckets = bySubgroup(rows.filter((r) => countsAsPage(r)));
  console.log(`   ${label}`);
  if (!buckets.length) {
    console.log('     (no pages)');
    return;
  }
  const w = Math.max(...buckets.map((b) => b.name.length), 12);
  for (const b of buckets) {
    console.log(`     ${isAssigned(b.name) ? ' ' : '·'} ${b.name.padEnd(w)} ${String(b.rows.length).padStart(5)}`);
  }
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

  if (opts.list) {
    console.log(`── subgroups · ${opts.group} ──`);
    printBreakdown('current:', rows);
    console.log(`\n   ${groupSheetLink(sheetCfg)}`);
    return 0;
  }

  let parsed = null;
  if (opts.where) {
    parsed = parseWhere(opts.where, { rows });
    if (parsed.errors.length) throw new Error(`--where= refused: ${parsed.errors.join('; ')}`);
  }
  const sel = select(rows, opts, parsed);
  if (sel.refused) throw new Error(sel.refused);

  const picked = new Set(sel.rows);
  const changes = [];
  const next = rows.map((row) => {
    if (!picked.has(row)) return row;
    const before = subgroupOf(row);
    if (subgroupKey(before) === subgroupKey(opts.to || UNASSIGNED)) return row;
    changes.push({ path: val(row, 'page-path'), from: before, to: opts.to || UNASSIGNED });
    return setCurated(row, { subgroup: opts.to }).row;
  });

  console.log(`── ${opts.apply ? 'set' : 'plan'} subgroup · ${opts.group} → "${opts.to || '(clear)'}" `
    + `· ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} ──`);
  console.log(`   sheet:    ${groupSheetLink(sheetCfg)}`);
  console.log(`   selector: ${sel.describe}`);
  console.log(`   matched ${sel.rows.length} of ${rows.filter((r) => countsAsPage(r)).length} real row(s) · changing ${changes.length}`);
  console.log('\n   the plan, row by row:');
  for (const c of changes) console.log(`     ${c.path}   "${c.from}" → "${c.to}"`);
  if (!changes.length) console.log('     (nothing would change)');
  console.log('');
  printBreakdown('sheet after:', next);

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
    const fresh = dataRowsOf(doc).map((row) => {
      const to = wanted.get(normalizePath(val(row, 'page-path')));
      return to === undefined ? row : setCurated(row, { subgroup: to }).row;
    });
    return withDataRows(doc, fresh);
  }, {
    confirm: (after) => {
      const bad = dataRowsOf(after)
        .filter((r) => wanted.has(normalizePath(val(r, 'page-path'))))
        .filter((r) => val(r, 'subgroup') !== opts.to)
        .map((r) => val(r, 'page-path'));
      return bad.length ? `${bad.length} row(s) did not take the value: ${bad.slice(0, 3).join(', ')}` : null;
    },
  });
  console.log(`\n   ✓ written${res.retried ? ' after one 412 retry' : ''} · preview `
    + `${res.preview?.previewed ? 'ok' : `FAILED: ${res.preview?.previewError}`}`);
  console.log('   Next: npm run rollup   (the boards read the pre-aggregated feed, not the sheet)');
  return 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ subgroup: ${e.message}`);
      exit(/^unknown arg|required|slug-style|select rows|--where=|unknown group|are not real rows/.test(e.message) ? 3 : 2);
    });
}
