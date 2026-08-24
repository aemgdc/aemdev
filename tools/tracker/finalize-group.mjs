#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * finalize-group.mjs — the group sign-off step: prove a group's sheet, envelope and
 * judge contract are all sound, repair the envelope if it is not, and record who signed
 * off on what.
 *
 * CLI SURFACE
 *   node tools/tracker/finalize-group.mjs [--group=<name>|--all] [--check]
 *        [--repair] [--by=<name>] [--dry-run|--apply] [--help]
 *
 *   npm run group:finalize -- --group=meetups --check          run the gate, write nothing
 *   npm run group:finalize -- --group=meetups --repair --apply repair the envelope
 *   npm run group:finalize -- --group=meetups --by="Tad" --apply  sign off
 *
 *   --group=<name>  a group registered in .tracker/orchestrator.json
 *   --all           every registered group
 *   --check         run the gate and report; never writes, never signs off.
 *   --repair        re-emit a clean multi-sheet document (see below).
 *   --by=<name>     who is signing off. REQUIRED to record a sign-off.
 *   --dry-run       print the plan, write nothing. THE DEFAULT.
 *   --apply         write.
 *
 * ─── WHY A REPAIR STEP EXISTS AT ALL ────────────────────────────────────────
 *
 * da.live's sheet editor collapses a ONE-TAB multi-sheet document to the single-sheet
 * form on save. The single-sheet form is accepted by admin.da.live and then refused at
 * preview with `400 error from content-bus`, leaving DA holding a file every reader 404s
 * while the tool that wrote it printed success. Group sheets are created with all ten
 * locale tabs precisely so a human editing one cannot trigger that — but a sheet created
 * before that rule, or hand-built, or edited through some other path, can still be in the
 * collapsed state.
 *
 * `--repair` re-emits the document through `groupDoc()`, which routes through
 * `multiSheetDoc()` and therefore asserts the envelope before it can leave the process.
 * It is idempotent, and it PRESERVES every value including columns the schema does not
 * recognise: a repair that lost a column would be a worse outcome than the malformed
 * envelope it fixed.
 *
 * ─── THE GATE ───────────────────────────────────────────────────────────────
 *
 * Eight checks. Each one is a state that produces a wrong number rather than an error, so
 * each one is worth a named failure:
 *
 *   1. envelope   `:type: 'multi-sheet'`, `:names` matching the tabs, all ten locales
 *   2. tabs       no unknown tab. A misspelled locale tab makes that locale read as
 *                 entirely untranslated, with no warning anywhere
 *   3. duplicates no page path twice on the `data` tab or in one locale tab. A duplicate
 *                 double-counts the page in every rollup, permanently
 *   4. ownership  every row's path resolves to THIS group. A row in the wrong sheet is
 *                 counted twice across the four groups and the totals still look plausible
 *   5. gate       every countable row has an `en-status`. Blank is "not assessed", which
 *                 is honest but is not a group anybody has finished
 *   6. coverage   every countable page has a row in all ten locale tabs, unless
 *                 `translate` says `no`
 *   7. testimony  no locale row carries a `sent-at` for a page that is not on the `data`
 *                 tab — an orphan whose only record of being sent is about to be invisible
 *   8. contract   the group's brief is `ready`: no `?` rows. A `?` blocks the batch by
 *                 design, so a group cannot be signed off while one is open
 *
 * ─── A SIGN-OFF WITH NO SIGNER IS WORTHLESS ─────────────────────────────────
 *
 * `--by=` is required to record one. The record lands in
 * `.tracker/state/group-signoff.json`, which is COMMITTED — a sign-off is a statement
 * somebody made, and git is the right place for it. It is deliberately not a tab on the
 * group sheet: every board treats an unrecognised tab as a data-quality defect (see
 * check 2), so a `signoff` tab would make every group permanently report one.
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  the gate passed (and the sign-off was recorded, with --apply --by=)
 *   1  the gate FAILED. Named checks are listed; nothing was signed off.
 *   2  could not reach a verdict — no token, DA unreachable, sheet missing
 *   3  usage or configuration error
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { TARGET_LOCALES, normalizePath } from '../../scripts/tracker/locales.js';
import { countsAsPage, sheetTabs } from '../../scripts/tracker/stages.js';
import { loadConfig, groupConfig, groupNames, REPO_ROOT } from './config.mjs';
import { resolveToken, TOKEN_HINT } from './lib/status-sheet.mjs';
import { groupForPath } from './lib/group-map.mjs';
import {
  DATA_COLUMNS,
  LOCALE_COLUMNS,
  dataRowsOf,
  localeRowsOf,
  groupDoc,
  readGroupDoc,
  updateGroupDoc,
  groupSheetLink,
} from './lib/group-sheet.mjs';
import { requirementsReadiness, localBriefPath } from './lib/requirements.mjs';

/**
 * Where a sign-off is recorded. Committed, because it is testimony.
 *
 * The brief's own path comes from `localBriefPath()` in lib/requirements.mjs — the same
 * function `loadRequirements()` falls back to — so this gate cannot pass a group by
 * reading a brief the judge will never see.
 */
const SIGNOFF_FILE = join(REPO_ROOT, '.tracker', 'state', 'group-signoff.json');

const HELP = `group:finalize — the group sign-off gate, plus an envelope repair.

  --group=<name>  a group registered in .tracker/orchestrator.json
  --all           every registered group
  --check         run the gate and report; writes nothing
  --repair        re-emit a clean multi-sheet document (idempotent, loses nothing)
  --by=<name>     who is signing off — REQUIRED to record a sign-off
  --dry-run       print the plan, write nothing (DEFAULT)
  --apply         write
  --help          this text

exit 0 gate passed · 1 gate failed · 2 no verdict · 3 usage`;

function parseArgs(args) {
  const o = {
    group: null, all: false, check: false, repair: false, by: null, apply: false, help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--all') o.all = true;
    else if (a === '--check') o.check = true;
    else if (a === '--repair') o.repair = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--by=')) o.by = a.slice(5);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!o.help && !o.group && !o.all) throw new Error('--group=<name> or --all is required');
  if (o.group && o.all) throw new Error('--group= and --all are mutually exclusive');
  if (o.check) o.apply = false;
  if (o.apply && !o.repair && !o.by) {
    throw new Error('--apply needs --by="<who>" to record a sign-off (or --repair to only fix the envelope) '
      + '— a sign-off with no signer is a claim nobody made');
  }
  return o;
}

const text = (v) => (v == null ? '' : String(v).trim());
const val = (row, key) => text(row?.[key]);

/* --------------------------------------------------------------------- the gate */

/**
 * Run the eight checks against one group document.
 *
 * Pure, so a test can hand it a deliberately broken doc and watch each check fail
 * independently. Every failure carries the page paths it is about — a check that reports
 * "3 duplicates" without naming them cannot be acted on.
 *
 * @returns {{ checks: Array<{ id, ok, detail }>, failed: number, counts: object }}
 */
export function runGate(group, doc, brief) {
  const rows = dataRowsOf(doc);
  const real = rows.filter((r) => countsAsPage(r));
  const tabs = sheetTabs(doc);
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });

  const missingTabs = TARGET_LOCALES.filter((c) => !tabs.includes(c));
  add(
    'envelope',
    doc[':type'] === 'multi-sheet' && !missingTabs.length && tabs.includes('data'),
`:type ${JSON.stringify(doc[':type'] ?? null)} · ${tabs.length} tab(s)`
    + `${missingTabs.length ? ` · MISSING ${missingTabs.join(', ')}` : ''}`,
  );

  const unknownTabs = tabs.filter((t) => t !== 'data' && !TARGET_LOCALES.includes(t));
  /*
   * Reports what it FOUND, not what it hoped for. "data + ten locales, nothing else" on
   * a doc carrying only a `data` tab was true (no unknown tab) and read as a whole
   * sheet — the envelope check sitting next to it was the only thing saying otherwise,
   * and two checks describing the same document must not contradict each other in prose.
   */
  add(
    'tabs',
    !unknownTabs.length,
    unknownTabs.length
      ? `unknown tab(s): ${unknownTabs.join(', ')}`
      : `no unknown tab (${tabs.length} present: ${tabs.join(' ')})`,
  );

  const dupes = [];
  const seen = new Set();
  for (const r of real) {
    const p = normalizePath(val(r, 'page-path'));
    if (seen.has(p)) dupes.push(p);
    else seen.add(p);
  }
  for (const code of TARGET_LOCALES) {
    const localeSeen = new Set();
    for (const r of localeRowsOf(doc, code)) {
      const p = normalizePath(val(r, 'page-path'));
      if (p) {
        if (localeSeen.has(p)) dupes.push(`${p} [${code}]`);
        else localeSeen.add(p);
      }
    }
  }
  add(
    'duplicates',
    !dupes.length,
    dupes.length ? `${dupes.length}: ${dupes.slice(0, 6).join(', ')}` : 'no path appears twice',
  );

  const foreign = real
    .map((r) => normalizePath(val(r, 'page-path')))
    .filter((p) => groupForPath(p) !== group)
    .map((p) => `${p} → ${groupForPath(p) || '(no group)'}`);
  add(
    'ownership',
    !foreign.length,
    foreign.length ? `${foreign.length} row(s) belong elsewhere: ${foreign.slice(0, 6).join(', ')}` : `all ${real.length} row(s) resolve to ${group}`,
  );

  const ungated = real.filter((r) => !val(r, 'en-status')).map((r) => val(r, 'page-path'));
  add(
    'gate',
    !ungated.length,
    ungated.length ? `${ungated.length} row(s) have no en-status: ${ungated.slice(0, 6).join(', ')}` : `all ${real.length} row(s) assessed`,
  );

  const wanted = real.filter((r) => val(r, 'translate').toLowerCase() !== 'no');
  const gaps = [];
  for (const code of TARGET_LOCALES) {
    const have = new Set(localeRowsOf(doc, code).map((r) => normalizePath(val(r, 'page-path'))));
    const missing = wanted.filter((r) => !have.has(normalizePath(val(r, 'page-path')))).length;
    if (missing) gaps.push(`${code}:${missing}`);
  }
  add(
    'coverage',
    !gaps.length,
    gaps.length ? `locale rows missing — ${gaps.join(' ')}` : `${wanted.length} page(s) × ${TARGET_LOCALES.length} locales complete`,
  );

  const known = new Set(real.map((r) => normalizePath(val(r, 'page-path'))));
  const orphans = [];
  for (const code of TARGET_LOCALES) {
    for (const r of localeRowsOf(doc, code)) {
      const p = normalizePath(val(r, 'page-path'));
      // Only a row carrying TESTIMONY matters here. An orphan with nothing in it is
      // debris; an orphan with a `sent-at` is the only record that a page was ever
      // handed to the translation service, and it is about to be invisible.
      if (p && !known.has(p) && val(r, 'sent-at')) orphans.push(`${p} [${code}]`);
    }
  }
  add(
    'testimony',
    !orphans.length,
    orphans.length ? `${orphans.length} orphan row(s) carry sent-at: ${orphans.slice(0, 6).join(', ')}` : 'no orphaned testimony',
  );

  add(
    'contract',
    brief.state === 'ready',
    brief.state === 'ready'
      ? `brief ready · ${brief.counts.rows} row(s)`
      : `brief is ${brief.state}${brief.counts.unresolved ? ` — ${brief.counts.unresolved} "?" row(s): ${brief.unresolved.map((u) => u.ref).join(', ')}` : ''}`,
  );

  return {
    checks,
    failed: checks.filter((c) => !c.ok).length,
    counts: {
      rows: rows.length,
      real: real.length,
      localeRows: TARGET_LOCALES.reduce((n, c) => n + localeRowsOf(doc, c).length, 0),
    },
  };
}

/* ------------------------------------------------------------------ the repair */

/**
 * Re-emit a clean multi-sheet document from whatever is there.
 *
 * Every row survives, every value survives, and every column survives — including
 * columns the schema does not know, which are carried through in the order the row had
 * them. The only thing that changes is the ENVELOPE. A repair that also tidied the rows
 * would be indistinguishable from a repair that lost one.
 */
export function repairDoc(doc) {
  const keep = (row, schema) => {
    const next = {};
    for (const c of schema) next[c] = text(row?.[c]);
    for (const [k, v] of Object.entries(row || {})) {
      if (!(k in next)) next[k] = v;
    }
    return next;
  };
  const data = dataRowsOf(doc).map((r) => keep(r, DATA_COLUMNS));
  const localeTab = (code) => localeRowsOf(doc, code).map((r) => keep(r, LOCALE_COLUMNS));
  const locales = Object.fromEntries(TARGET_LOCALES.map((code) => [code, localeTab(code)]));
  return groupDoc(data, locales);
}

/* ------------------------------------------------------------------ the record */

function readSignoffs() {
  if (!existsSync(SIGNOFF_FILE)) return { version: 1, updated: null, groups: {} };
  try {
    const doc = JSON.parse(readFileSync(SIGNOFF_FILE, 'utf8'));
    return { version: 1, updated: doc.updated ?? null, groups: doc.groups ?? {} };
  } catch (e) {
    throw new Error(`${SIGNOFF_FILE} is unreadable (${e.message}) — fix or delete it; this tool `
      + 'will not overwrite a record it cannot read');
  }
}

function recordSignoff(group, entry) {
  const doc = readSignoffs();
  doc.groups[group] = entry;
  doc.updated = new Date().toISOString();
  mkdirSync(dirname(SIGNOFF_FILE), { recursive: true });
  writeFileSync(SIGNOFF_FILE, `${JSON.stringify(doc, null, 2)}\n`);
  return SIGNOFF_FILE;
}

/* ---------------------------------------------------------------------- one group */

async function finalizeOne(cfg, name, opts, token) {
  const sheetCfg = groupConfig(cfg, name);
  console.log(`\n── ${name} ──`);
  console.log(`   sheet:  ${sheetCfg.path}`);
  console.log(`   editor: ${groupSheetLink(sheetCfg)}`);

  const current = await readGroupDoc(sheetCfg, token);
  if (!current.exists) {
    console.log(`   ✗ sheet does not exist — run \`npm run group:scaffold -- --group=${name}\` first`);
    return { name, unreachable: true };
  }

  const file = localBriefPath(name);
  const brief = requirementsReadiness(existsSync(file) ? readFileSync(file, 'utf8') : '');
  console.log(`   brief:  ${file}${existsSync(file) ? '' : ' (MISSING)'}`);

  const gate = runGate(name, current.doc, brief);
  console.log(`   rows:   ${gate.counts.real} countable of ${gate.counts.rows} · `
    + `${gate.counts.localeRows} locale row(s)`);
  for (const c of gate.checks) console.log(`   ${c.ok ? '✓' : '✗'} ${c.id.padEnd(11)} ${c.detail}`);

  if (opts.repair) {
    const repaired = repairDoc(current.doc);
    const before = JSON.stringify(current.doc).length;
    const after = JSON.stringify(repaired).length;
    console.log(`   repair: re-emit as :type "${repaired[':type']}" with ${repaired[':names'].length} tab(s)`
      + ` · ${before} → ${after} byte(s)`);
    if (opts.apply) {
      const res = await updateGroupDoc(sheetCfg, token, (doc, { exists }) => {
        if (!exists) throw new Error('sheet vanished between the read and the write');
        return repairDoc(doc);
      }, {
        confirm: (after2) => {
          if (after2[':type'] !== 'multi-sheet') return 'the written doc is not multi-sheet';
          const missing = ['data', ...TARGET_LOCALES].filter((t) => !(after2[':names'] || []).includes(t));
          if (missing.length) return `the written doc is missing tab(s): ${missing.join(', ')}`;
          // Row counts, both tabs kinds. A repair that dropped a row would otherwise
          // look identical to a repair that fixed an envelope.
          if (dataRowsOf(after2).length !== dataRowsOf(current.doc).length) return 'the data tab lost or gained rows';
          return null;
        },
      });
      console.log(`   ✓ repaired${res.retried ? ' after one 412 retry' : ''} · preview `
        + `${res.preview?.previewed ? 'ok' : `FAILED: ${res.preview?.previewError}`}`);
    }
  }

  if (gate.failed) {
    console.log(`   ✗ gate FAILED on ${gate.failed} check(s) — not signed off`);
    return { name, gate, failed: gate.failed };
  }
  console.log('   ✓ gate passed');

  if (!opts.by) {
    console.log('   (no --by=, so nothing was signed off. The gate above is the whole result.)');
    return { name, gate };
  }
  const entry = {
    at: new Date().toISOString(),
    by: opts.by,
    host: hostname(),
    branch: sheetCfg.branch,
    sheet: sheetCfg.path,
    rows: gate.counts.real,
    localeRows: gate.counts.localeRows,
    brief: { state: brief.state, rows: brief.counts.rows, marker: brief.marker },
    checks: Object.fromEntries(gate.checks.map((c) => [c.id, 'pass'])),
  };
  console.log(`   sign-off: ${JSON.stringify(entry)}`);
  if (opts.apply) console.log(`   ✓ recorded in ${recordSignoff(name, entry)}`);
  return { name, gate, signed: opts.apply };
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

  const writeMode = opts.apply ? 'APPLY' : 'DRY RUN (default)';
  const mode = opts.check ? 'CHECK (writes nothing)' : writeMode;
  console.log(`── group:finalize · ${mode}${opts.repair ? ' · REPAIR' : ''}`
    + `${opts.by ? ` · by ${opts.by}` : ''} ──`);

  const results = [];
  for (const name of names) {
    try {
      results.push(await finalizeOne(cfg, name, opts, token));
    } catch (e) {
      console.error(`   ✗ ${name}: ${e.message}`);
      results.push({ name, error: e.message });
    }
  }

  const unreachable = results.filter((r) => r.unreachable || r.error).length;
  const failed = results.filter((r) => r.failed).length;
  const signed = results.filter((r) => r.signed).length;
  console.log(`\n   ${signed} signed off · ${failed} gate failure(s) · ${unreachable} unreachable`);
  if (!opts.apply && !opts.check) console.log('   Re-run with --apply to write.');
  if (unreachable) return 2;
  return failed ? 1 : 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ group:finalize: ${e.message}`);
      exit(/^unknown arg|required|mutually exclusive|--apply needs|unknown group/.test(e.message) ? 3 : 2);
    });
}
