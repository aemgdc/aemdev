#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * upgrade-columns.mjs — add missing columns to an existing group sheet. Additive only,
 * by construction: there is no way to ask this tool to remove one.
 *
 * CLI SURFACE
 *   node tools/tracker/upgrade-columns.mjs [--group=<name>|--all] [--add=<col>[,<col>]]
 *        [--tab=data|locales|all|<locale>] [--reorder] [--dry-run|--apply] [--help]
 *
 *   npm run group:upgrade -- --all                     plan every sheet against the schema
 *   npm run group:upgrade -- --group=meetups --apply   bring one sheet up to the schema
 *   npm run group:upgrade -- --all --add=owner --apply  add a column the schema does not know
 *
 *   --group=<name>  a group registered in .tracker/orchestrator.json
 *   --all           every registered group
 *   --add=<cols>    comma-separated columns to add. Default: everything the schema
 *                   defines that the sheet is missing.
 *   --tab=<which>   `data`, `locales` (all ten), `all` (default), or one locale code.
 *   --reorder       rewrite every row in canonical schema order. Off by default.
 *   --dry-run       print the plan, write nothing. THE DEFAULT.
 *   --apply         write.
 *
 * ─── WHY REMOVAL IS NOT A FLAG ──────────────────────────────────────────────
 *
 * Removing a column from a group sheet is data loss that `git revert` cannot undo,
 * because the data was never in git. The sheet is the only copy: `subgroup`, `notes` and
 * `sent-at` in particular have no derivation to rebuild them from — a human typed them,
 * or they record an event observable nowhere else.
 *
 * So this tool has no `--remove`, no `--only`, and no "bring the sheet into line with the
 * schema" mode that projects rows onto the known column list. A column the schema does
 * not recognise is somebody's data until proven otherwise: it is COUNTED, NAMED in the
 * plan, and carried through untouched. If a column genuinely must go, a human deletes it
 * in da.live, having read it first.
 *
 * ─── WHAT "MISSING" MEANS, AND WHY IT IS PER ROW ────────────────────────────
 *
 * A sheet is not the only thing that can lack a column — individual ROWS can, because a
 * row appended by a tool written before the column existed simply has no such key. DA
 * renders a sheet's columns from the union of its rows' keys, so a half-populated column
 * looks present and reads as blank in the rows that lack it. That is benign for a reader
 * and not benign for a writer: `Object.assign(row, values)` on a row with no such key
 * appends it at the END of that row, so one row's column order drifts from every other
 * row's, and da.live then shows the value under the wrong heading.
 *
 * Hence the fill is per row, and `--reorder` exists for the sheets where that has already
 * happened.
 *
 * ─── --reorder IS OFF BY DEFAULT ────────────────────────────────────────────
 *
 * Column ORDER in da.live follows key order, so rewriting rows in schema order moves the
 * columns a human has been reading and editing. That is not data loss, but it is
 * disruptive enough to be a decision rather than a side effect of adding a column. The
 * default appends new keys at the end of each row, which is the smallest possible change.
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  upgraded, or already up to date
 *   2  could not reach a verdict — no token, DA unreachable, a sheet that does not exist
 *   3  usage or configuration error
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { TARGET_LOCALES } from '../../scripts/tracker/locales.js';
import { sheetTabs } from '../../scripts/tracker/stages.js';
import { loadConfig, groupConfig, groupNames } from './config.mjs';
import { resolveToken, TOKEN_HINT } from './lib/status-sheet.mjs';
import {
  DATA_COLUMNS,
  LOCALE_COLUMNS,
  bandOf,
  dataRowsOf,
  localeRowsOf,
  readGroupDoc,
  withDataRows,
  withLocaleRows,
  updateGroupDoc,
  groupSheetLink,
} from './lib/group-sheet.mjs';

const HELP = `group:upgrade — add missing columns to a group sheet. Additive only.

  --group=<name>  a group registered in .tracker/orchestrator.json
  --all           every registered group
  --add=<cols>    comma-separated columns to add (default: the whole schema)
  --tab=<which>   data | locales | all (default) | a locale code
  --reorder       rewrite rows in canonical schema order (off by default)
  --dry-run       print the plan, write nothing (DEFAULT)
  --apply         write
  --help          this text

There is no --remove. Removing a column is data loss git cannot undo, because the data
was never in git. An unrecognised column is preserved and named in the plan.

exit 0 ok · 2 no verdict (no token / no sheet) · 3 usage`;

function parseArgs(args) {
  const o = {
    group: null, all: false, add: null, tab: 'all', reorder: false, apply: false, help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--all') o.all = true;
    else if (a === '--reorder') o.reorder = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--tab=')) o.tab = a.slice(6);
    else if (a.startsWith('--add=')) o.add = a.slice(6).split(',').map((c) => c.trim()).filter(Boolean);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!o.help && !o.group && !o.all) throw new Error('--group=<name> or --all is required');
  if (o.group && o.all) throw new Error('--group= and --all are mutually exclusive');
  const tabs = ['data', 'locales', 'all', ...TARGET_LOCALES];
  if (!tabs.includes(o.tab)) throw new Error(`--tab must be one of ${tabs.join(', ')}`);
  if (o.add && !o.add.length) throw new Error('--add= needs at least one column name');
  return o;
}

/**
 * Add the wanted columns to every row of one tab.
 *
 * Pure, and returns the counts a plan needs rather than mutating in place, so the plan
 * printed and the doc written come from the same computation.
 *
 * @param {object[]} rows
 * @param {string[]} schema  the canonical column order for this tab
 * @param {string[]} wanted  the columns to ensure exist
 * @param {boolean} reorder
 * @returns {{ rows, filled: object, extras: object, changed: number, reordered: number }}
 *   `filled` maps a column to how many rows gained it; `extras` maps an unrecognised
 *   column to how many rows carry it; `reordered` counts rows whose KEY ORDER actually
 *   moved. That last one exists because a `--reorder` run with no missing columns
 *   otherwise looked like a no-op and wrote nothing, silently ignoring the flag.
 */
export function upgradeRows(rows, schema, wanted, reorder) {
  const filled = {};
  const extras = {};
  let changed = 0;
  let reordered = 0;

  const out = (rows || []).map((row) => {
    const keys = Object.keys(row || {});
    for (const k of keys) {
      if (!schema.includes(k)) extras[k] = (extras[k] ?? 0) + 1;
    }
    const missing = wanted.filter((c) => !(c in (row || {})));
    for (const c of missing) filled[c] = (filled[c] ?? 0) + 1;
    if (missing.length) changed += 1;

    if (!reorder) {
      // Appended at the end, in the order asked for. The smallest possible change to a
      // sheet a human is reading.
      const next = { ...row };
      for (const c of missing) next[c] = '';
      return next;
    }

    /*
     * Canonical order, then everything the schema does not know, in the order the row
     * already had it. The unknown columns keep their relative order deliberately: they
     * are somebody's data and their arrangement may mean something to whoever added
     * them.
     */
    const next = {};
    for (const c of schema) {
      if (wanted.includes(c) || c in (row || {})) next[c] = row?.[c] ?? '';
    }
    for (const k of keys) {
      if (!(k in next)) next[k] = row[k];
    }
    if (Object.keys(next).join('\u0001') !== keys.join('\u0001')) reordered += 1;
    return next;
  });

  return {
    rows: out, filled, extras, changed, reordered,
  };
}

/** Which tabs this run touches, and the schema each is measured against. */
function targets(opts) {
  const out = [];
  if (opts.tab === 'all' || opts.tab === 'data') out.push({ tab: 'data', schema: DATA_COLUMNS });
  if (opts.tab === 'all' || opts.tab === 'locales') {
    for (const code of TARGET_LOCALES) out.push({ tab: code, schema: LOCALE_COLUMNS });
  }
  if (TARGET_LOCALES.includes(opts.tab)) out.push({ tab: opts.tab, schema: LOCALE_COLUMNS });
  return out;
}

const bandNote = (column) => {
  const band = bandOf(column);
  return band ? `band ${band}` : 'OFF-SCHEMA';
};

async function upgradeOne(cfg, name, opts, token) {
  const sheetCfg = groupConfig(cfg, name);
  console.log(`\n── ${name} ──`);
  console.log(`   sheet:  ${sheetCfg.path}`);
  console.log(`   editor: ${groupSheetLink(sheetCfg)}`);

  const current = await readGroupDoc(sheetCfg, token);
  if (!current.exists) {
    console.log(`   ✗ sheet does not exist — run \`npm run group:scaffold -- --group=${name}\` first`);
    return { name, missing: true };
  }
  const present = sheetTabs(current.doc);
  if (current.missingTabs.length) {
    console.log(`   ! missing locale tab(s): ${current.missingTabs.join(', ')} — this tool adds COLUMNS, `
      + 'not tabs. Run `npm run group:finalize` to repair the envelope first.');
  }
  const unknownTabs = present.filter((t) => t !== 'data' && !TARGET_LOCALES.includes(t));
  if (unknownTabs.length) {
    console.log(`   ! unknown tab(s): ${unknownTabs.join(', ')} — left untouched, and every board `
      + 'reports them. A misspelled locale tab makes that whole locale read as untranslated.');
  }

  const plans = [];
  for (const { tab, schema } of targets(opts)) {
    if (present.includes(tab)) {
      const rows = tab === 'data' ? dataRowsOf(current.doc) : localeRowsOf(current.doc, tab);
      const wanted = opts.add || schema;
      plans.push({
        tab, schema, ...upgradeRows(rows, schema, wanted, opts.reorder), rowCount: rows.length,
      });
    }
  }

  let touched = 0;
  for (const p of plans) {
    const adds = Object.entries(p.filled);
    const extras = Object.entries(p.extras);
    if (adds.length || extras.length) {
      console.log(`   ${p.tab}: ${p.rowCount} row(s)`);
      for (const [col, n] of adds) {
        console.log(`     + ${col} (${bandNote(col)}) → ${n} row(s) gain it, blank`);
      }
      for (const [col, n] of extras) {
        console.log(`     = ${col} NOT IN THE SCHEMA, on ${n} row(s) — PRESERVED. This tool cannot `
          + 'remove a column; delete it in da.live if it really must go.');
      }
      if (p.reordered) console.log(`     ~ ${p.reordered} row(s) rewritten in canonical schema order (--reorder)`);
      touched += adds.length || p.reordered ? 1 : 0;
    } else if (p.reordered) {
      console.log(`   ${p.tab}: ${p.reordered} of ${p.rowCount} row(s) rewritten in canonical schema order (--reorder)`);
      touched += 1;
    }
  }
  if (!touched) {
    console.log(`   = already carries every column asked for (${(opts.add || 'the whole schema').toString()})`
      + `${opts.reorder ? ', and every row is already in canonical order' : ''}`);
  }

  if (!opts.apply || !touched) return { name, touched };

  const res = await updateGroupDoc(sheetCfg, token, (doc, { exists }) => {
    if (!exists) throw new Error('sheet vanished between the read and the write');
    let next = doc;
    for (const { tab, schema } of targets(opts)) {
      if (sheetTabs(doc).includes(tab)) {
        const rows = tab === 'data' ? dataRowsOf(doc) : localeRowsOf(doc, tab);
        const built = upgradeRows(rows, schema, opts.add || schema, opts.reorder);
        next = tab === 'data' ? withDataRows(next, built.rows) : withLocaleRows(next, tab, built.rows);
      }
    }
    return next;
  }, {
    /*
     * Confirmed on the read-back: every row of every touched tab must carry every column
     * asked for. A 200 from the POST does not prove that, and a preview refused after a
     * successful POST leaves DA holding a doc nobody is served.
     */
    confirm: (after) => {
      for (const { tab, schema } of targets(opts)) {
        if (sheetTabs(after).includes(tab)) {
          const rows = tab === 'data' ? dataRowsOf(after) : localeRowsOf(after, tab);
          const wanted = opts.add || schema;
          const bad = rows.findIndex((r) => wanted.some((c) => !(c in r)));
          if (bad >= 0) return `row ${bad} of the ${tab} tab is still missing a column`;
        }
      }
      return null;
    },
  });
  console.log(`   ✓ written${res.retried ? ' after one 412 retry' : ''} · preview `
    + `${res.preview?.previewed ? 'ok' : `FAILED: ${res.preview?.previewError}`}`);
  return { name, touched, written: true, previewFailed: !res.preview?.previewed };
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const names = opts.all ? groupNames(cfg) : [opts.group];
  for (const n of names) groupConfig(cfg, n); // fail on a typo before any I/O

  const token = resolveToken();
  if (!token) {
    console.error(`ERROR: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }

  console.log(`── group:upgrade · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} · tab=${opts.tab}`
    + `${opts.reorder ? ' · REORDER' : ''} ──`);
  console.log(`   adding: ${(opts.add || ['(the whole schema)']).join(', ')}`);
  if (opts.add) {
    const off = opts.add.filter((c) => !bandOf(c) && !LOCALE_COLUMNS.includes(c));
    if (off.length) {
      console.log(`   ! ${off.join(', ')} are not in the schema. Allowed — a tool may need a column `
        + 'before lib/group-sheet.mjs knows about it — but add it there in the same change, or the '
        + 'next --reorder run will push it to the end of every row.');
    }
  }

  const results = [];
  for (const name of names) {
    try {
      results.push(await upgradeOne(cfg, name, opts, token));
    } catch (e) {
      console.error(`   ✗ ${name}: ${e.message}`);
      results.push({ name, error: e.message });
    }
  }

  const failed = results.filter((r) => r.error || r.missing || r.previewFailed);
  console.log(`\n   ${results.filter((r) => r.written).length} written · ${failed.length} failed`);
  if (!opts.apply) console.log('   Re-run with --apply to write.');
  return failed.length ? 2 : 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ group:upgrade: ${e.message}`);
      exit(/^unknown arg|required|mutually exclusive|--tab must|--add=|unknown group/.test(e.message) ? 3 : 2);
    });
}
