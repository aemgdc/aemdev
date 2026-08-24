#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * scaffold-group.mjs — create a group's DA tracking sheet: the `data` tab plus ten
 * locale tabs, in one correctly-enveloped multi-sheet document.
 *
 * CLI SURFACE
 *   node tools/tracker/scaffold-group.mjs --group=<name> [--dry-run|--apply]
 *                                        [--force] [--headers-only] [--help]
 *   node tools/tracker/scaffold-group.mjs --all [--apply]
 *
 *   npm run group:scaffold -- --group=meetups
 *   npm run group:scaffold -- --group=meetups --apply
 *
 *   --group=<name>   a group registered in .tracker/orchestrator.json
 *   --all            every registered group (skipping any that already exists)
 *   --dry-run        print the plan and write nothing. THE DEFAULT.
 *   --apply          actually write
 *   --force          overwrite an existing sheet — refused unless it has ZERO real
 *                    page rows (see below)
 *   --headers-only   no placeholder row; the tabs are created empty
 *
 * ─── Why all ten locale tabs are created up front ───────────────────────────
 *
 * da.live's sheet editor collapses a ONE-TAB multi-sheet document to the single-sheet
 * form on save. The single-sheet form is accepted by admin.da.live and then refused at
 * preview with `400 error from content-bus`, which leaves DA holding a file every
 * reader 404s while the tool that wrote it prints success. Creating the locale tabs
 * from the start means a human can open and edit the sheet without destroying the
 * envelope.
 *
 * ─── Why --force is not a plain overwrite ───────────────────────────────────
 *
 * The `data` tab is where a human types `subgroup`, `translate` and `notes` — columns
 * with no derivation to rebuild them from. So `--force` is allowed only on a sheet
 * with no real page rows (a placeholder shell, e.g. to widen the column set before
 * any content is entered). On a sheet with real rows it is refused outright: use
 * `group:sync` to reconcile, or edit it in DA.
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  created, or would create, or already present and left untouched
 *   2  could not reach a verdict — DA unreachable, no token
 *   3  usage or configuration error, including a refused clobber
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { TARGET_LOCALES } from '../../scripts/tracker/locales.js';
import { loadConfig, groupConfig, groupNames } from './config.mjs';
import { resolveToken, TOKEN_HINT } from './lib/status-sheet.mjs';
import {
  DATA_COLUMNS,
  LOCALE_COLUMNS,
  BANDS,
  emptyGroupDoc,
  readGroupDoc,
  realDataRows,
  updateGroupDoc,
  groupSheetLink,
} from './lib/group-sheet.mjs';

const HELP = `scaffold-group — create a group's DA sheet (data tab + ten locale tabs).

  --group=<name>   a group registered in .tracker/orchestrator.json
  --all            every registered group
  --dry-run        print the plan, write nothing (DEFAULT)
  --apply          write
  --force          overwrite an existing sheet — only if it has zero real page rows
  --headers-only   create the tabs with no placeholder row
  --help           this text

exit 0 ok · 2 could not reach DA · 3 usage error or refused clobber`;

function parseArgs(args) {
  const o = {
    group: null, all: false, apply: false, force: false, headersOnly: false, help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--all') o.all = true;
    else if (a === '--force') o.force = true;
    else if (a === '--headers-only') o.headersOnly = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!o.help && !o.group && !o.all) throw new Error('--group=<name> or --all is required');
  if (o.group && o.all) throw new Error('--group= and --all are mutually exclusive');
  // Kebab-case, because the group name IS the sheet basename IS the registry key, and
  // config.mjs refuses a registry where those three disagree.
  if (o.group && !/^[a-z0-9-]+$/.test(o.group)) throw new Error(`--group must be kebab-case: "${o.group}"`);
  return o;
}

/** Print the document that would be written, tab by tab, row by row. */
function printPlan(sheetCfg, doc, state) {
  console.log(`\n── ${state.verb} ${sheetCfg.name} ──`);
  console.log(`   sheet:   ${sheetCfg.path}   (branch ${sheetCfg.branch})`);
  console.log(`   editor:  ${groupSheetLink(sheetCfg)}`);
  console.log(`   state:   ${state.detail}`);
  console.log(`   envelope: :type=${doc[':type']} :names=[${doc[':names'].join(', ')}]`);

  for (const b of BANDS) {
    console.log(`   band ${b.band} (${b.owner}, ${b.overwritable ? 'overwritable by sync' : 'never touched by sync'}):`);
    console.log(`     ${b.columns.join(' · ')}`);
  }
  console.log(`   locale columns: ${LOCALE_COLUMNS.join(' · ')}`);

  console.log('\n   rows to be written:');
  for (const tab of doc[':names']) {
    const rows = doc[tab].data;
    if (!rows.length) {
      console.log(`     ${tab.padEnd(6)} 0 rows (headers recoverable from lib/group-sheet.mjs only)`);
    } else {
      for (const r of rows) {
        const shown = Object.entries(r).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${JSON.stringify(v)}`);
        console.log(`     ${tab.padEnd(6)} ${shown.length ? shown.join(' ') : '(all columns blank — a placeholder, not a page)'}`);
      }
    }
  }
}

async function scaffoldOne(cfg, name, opts, token) {
  const sheetCfg = groupConfig(cfg, name);
  const current = await readGroupDoc(sheetCfg, token);
  const doc = emptyGroupDoc({ seed: !opts.headersOnly });

  if (current.exists) {
    const real = realDataRows(current.doc);
    if (!opts.force) {
      printPlan(sheetCfg, doc, {
        verb: 'REFUSED',
        detail: `already exists with ${real.length} real page row(s) — left untouched. `
          + 'Pass --force to replace it (allowed only on a sheet with zero real rows).',
      });
      return { name, refused: true, created: false };
    }
    if (real.length) {
      throw new Error(`refusing --force on ${sheetCfg.path}: it has ${real.length} real page row(s). `
        + 'Those carry curated columns (subgroup, translate, notes) that nothing can rebuild. '
        + 'Reconcile with `npm run group:sync` or edit it in DA.');
    }
  }

  printPlan(sheetCfg, doc, {
    verb: opts.apply ? 'CREATE' : 'PLAN',
    detail: current.exists
      ? 'exists with zero real rows — --force will replace the shell'
      : 'does not exist yet',
  });

  if (!opts.apply) return { name, refused: false, created: false, planned: true };

  /*
   * Written through updateGroupDoc so the create is race-safe: with no existing doc it
   * goes out with `If-None-Match: '*'`, and a 412 then means somebody else created the
   * sheet between our read and our write. Without that precondition two people running
   * this at once silently lose one side's shell.
   */
  const res = await updateGroupDoc(sheetCfg, token, (existing, { exists }) => {
    if (exists && !opts.force) throw new Error('sheet appeared between the read and the write');
    return doc;
  }, {
    confirm: (after) => {
      const tabs = after[':names'] || [];
      const missing = ['data', ...TARGET_LOCALES].filter((t) => !tabs.includes(t));
      return missing.length ? `the written doc is missing tab(s): ${missing.join(', ')}` : null;
    },
  });
  console.log(`\n   ✓ written${res.created ? ' (created)' : ' (replaced an empty shell)'}`
    + `${res.retried ? ' after one 412 retry' : ''}`
    + ` · preview ${res.preview?.previewed ? 'ok' : `FAILED: ${res.preview?.previewError}`}`);
  return { name, refused: false, created: res.created, written: true };
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const names = opts.all ? groupNames(cfg) : [opts.group];
  // Resolve every name BEFORE any I/O, so a typo in one of four does not leave three
  // sheets created and the run reported as failed.
  for (const n of names) groupConfig(cfg, n);

  const token = resolveToken();
  if (!token) {
    console.error(`ERROR: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }

  console.log(`── group:scaffold · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} · `
    + `${names.length} group(s) · ${TARGET_LOCALES.length} locale tabs each ──`);
  console.log(`   data columns: ${DATA_COLUMNS.length} · locale columns: ${LOCALE_COLUMNS.length}`);

  const results = [];
  for (const name of names) {
    // One group's failure must not abandon the others: each sheet is independent, and
    // a half-run that reports which half is far more useful than an abort.
    try {
      results.push(await scaffoldOne(cfg, name, opts, token));
    } catch (e) {
      console.error(`\n   ✗ ${name}: ${e.message}`);
      results.push({ name, error: e.message });
    }
  }

  const failed = results.filter((r) => r.error);
  const refused = results.filter((r) => r.refused);
  const created = results.filter((r) => r.created).length;
  const replaced = results.filter((r) => r.written && !r.created).length;
  console.log(`\n   ${created} created · ${replaced} shell(s) replaced · ${refused.length} left untouched · `
    + `${failed.length} failed`);
  if (!opts.apply) console.log('   Re-run with --apply to write.');
  if (failed.length) return 3;
  return 0;
}

/*
 * CLI entry only when run directly, resolved through fileURLToPath rather than a
 * basename compare so another file that merely ends in the same name cannot trigger
 * it. Without this guard an `import` of this module would start writing DA sheets.
 */
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ group:scaffold: ${e.message}`);
      exit(/^unknown arg|required|mutually exclusive|kebab-case|unknown group/.test(e.message) ? 3 : 2);
    });
}
