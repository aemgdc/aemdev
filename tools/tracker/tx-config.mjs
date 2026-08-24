#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * tx-config.mjs — push `.tracker/da-translate.json` to DA as `/.da/translate.json`,
 * the config DA's own Translate app reads.
 *
 * CLI SURFACE
 *   node tools/tracker/tx-config.mjs [--dry-run|--apply|--diff] [--json] [--help]
 *
 *   npm run tx:config                  print the exact stripped payload. THE DEFAULT.
 *   npm run tx:config -- --diff        fetch the deployed config and diff against it
 *   npm run tx:config -- --apply       write it
 *
 *   --dry-run   print the payload that WOULD be written, and validate it. DEFAULT.
 *   --apply     write to DA `/.da/translate.json`, conditionally (see below).
 *   --diff      read the deployed config and report every difference. Read-only.
 *   --json      with --dry-run, print ONLY the payload (pipe it to `jq`/`diff`).
 *
 * ─── THE ANNOTATION STRIP IS THE POINT OF THIS TOOL ─────────────────────────
 *
 * `.tracker/da-translate.json` is ANNOTATED SOURCE, not the payload. It carries
 * `_comment` (top level and per sheet) and `_why` (per row), and both must be removed
 * before the write, for two different reasons — both non-obvious, both stated in that
 * file's own header:
 *
 *   `_comment` is a top-level key that is neither `:`-prefixed nor a
 *   `{total,limit,offset,data}` sheet object, so the content bus refuses the whole
 *   document — and it refuses it at PREVIEW, not at admin.da.live. The write returns
 *   200 and DA is left holding a file every reader 404s, which is the worst shape a
 *   failure can take: it looks like it worked.
 *
 *   `_why` inside a data row becomes a real sheet COLUMN. It would show up in the
 *   sheet UI and be handed to the connector as data.
 *
 * The annotations stay in git because a rule table nobody can read is a rule table
 * nobody maintains. Stripping them here is what makes that affordable.
 *
 * ─── Validation before the write, not after ────────────────────────────────
 *
 * The payload is checked against the six known sheet names and their columns, and the
 * `languages` sheet is additionally checked against the locale registry. That last
 * check earns its keep: `code` (`zh-CN`) and `location` (`/zh-cn`) differ in CASE ONLY,
 * and the connector accepts an unknown code and hands back the SOURCE TEXT
 * untranslated. So a typo there does not error — it produces a Chinese page full of
 * English, discovered weeks later in review.
 *
 * ─── This document is NOT previewed ────────────────────────────────────────
 *
 * `/.da/**` is DA application config, read by the Translate app through
 * admin.da.live. It is not site content. Previewing it would push application config
 * at the content bus (which refuses it) and, if it ever succeeded, publish the
 * translation rule table on a public host. So `writeStatusDoc` — which always
 * previews — is deliberately NOT used here, and the envelope rule it enforces is
 * enforced locally instead, by `assertSheetDoc`.
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  payload valid and printed · written · or --diff found no difference
 *   1  --diff found a difference (including "not deployed at all"). A finding, not a
 *      crash: the deployed config is not what this repo says it should be.
 *   2  could not reach DA, or the deployed config changed under us (412). Nothing written.
 *   3  usage error, or the annotated source failed validation. Nothing written.
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALES, TARGET_LOCALES, SOURCE_LOCALE } from '../../scripts/tracker/locales.js';
import { DA_TRANSLATE_CONFIG, daSourceUrl, daSheetUrl } from '../../scripts/tracker/paths.js';
import { REPO_ROOT, CONFIG_DIR } from './config.mjs';
import { resolveToken, TOKEN_HINT, assertSheetDoc } from './lib/status-sheet.mjs';
import { localeForServiceCode } from './lib/tx-project.mjs';
import { request } from './lib/http-pool.mjs';

const SOURCE_FILE = join(REPO_ROOT, CONFIG_DIR, 'da-translate.json');

/**
 * The six sheets DA's Translate app reads, and the columns each one may carry.
 *
 * Reverse-engineered from adobe/da-nx (`nx/blocks/loc/connectors/google/translate.json`,
 * parsed by `nx/blocks/loc/dnt/dnt.js`); the public docs describe only the four
 * `*.conflict.behavior` keys. An UNKNOWN sheet or an unknown column is refused rather
 * than passed through: da-nx's parser ignores what it does not recognise, so a
 * misspelled sheet name (`dnt-content-rule`) would deploy cleanly and simply never
 * apply — and "the DNT rules are not being applied" is invisible until a translated
 * page corrupts an identifier.
 */
const SHEETS = [
  { name: 'config', columns: ['key', 'value', 'description'], required: ['key'] },
  {
    name: 'languages',
    columns: ['name', 'code', 'translate type', 'location', 'actions'],
    required: ['name', 'code', 'location', 'actions'],
  },
  { name: 'custom-doc-rules', columns: ['block', 'rule'], required: ['block', 'rule'] },
  { name: 'dnt-content-rules', columns: ['content'], required: ['content'] },
  { name: 'dnt-sheet-rules', columns: ['pattern', 'action'], required: ['pattern', 'action'] },
  { name: 'dnt', columns: ['dnt-sheet', 'dnt-columns'], required: ['dnt-sheet', 'dnt-columns'] },
];

const SHEET_NAMES = SHEETS.map((s) => s.name);

/** Annotation keys, by scope. Removed before the write; see the header. */
const DOC_ANNOTATIONS = ['_comment'];
const SHEET_ANNOTATIONS = ['_comment'];
const ROW_ANNOTATIONS = ['_why'];

const HELP = `tx:config — push .tracker/da-translate.json to DA /.da/translate.json.

  --dry-run   print the exact stripped payload and validate it (DEFAULT)
  --apply     write it (conditional on the deployed ETag)
  --diff      read the deployed config and report every difference (read-only)
  --json      with --dry-run, print only the payload
  --help      this text

exit 0 ok · 1 --diff found drift · 2 DA unreachable or changed under us · 3 usage/validation`;

function parseArgs(args) {
  const o = {
    apply: false, diff: false, json: false, help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--diff') o.diff = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.apply && o.diff) throw new Error('--apply and --diff do different jobs; run them separately');
  return o;
}

/* ---------------------------------------------------------------------- the strip */

const isSheetish = (v) => Boolean(v) && typeof v === 'object' && Array.isArray(v.data);

/**
 * Remove every annotation and rebuild the row counters.
 *
 * The counters are recomputed rather than trusted: `total`/`limit` are hand-maintained
 * in the annotated source, and a row added without bumping them deploys a sheet whose
 * envelope disagrees with its own contents. Any correction is reported in the plan —
 * silently fixing it would hide that the source file is drifting.
 *
 * @returns {{ payload, stripped: string[], counters: Array }}
 */
export function stripAnnotations(source) {
  const payload = {};
  const stripped = [];
  const counters = [];

  for (const [key, value] of Object.entries(source)) {
    if (DOC_ANNOTATIONS.includes(key)) {
      stripped.push(key);
    } else if (!isSheetish(value)) {
      // `:`-prefixed metadata (`:names`, `:type`, `:version`) passes through verbatim.
      payload[key] = value;
    } else {
      const rows = value.data.map((row) => {
        const out = {};
        for (const [k, v] of Object.entries(row)) {
          if (ROW_ANNOTATIONS.includes(k)) stripped.push(`${key}[].${k}`);
          else out[k] = v;
        }
        return out;
      });
      for (const k of Object.keys(value)) {
        if (SHEET_ANNOTATIONS.includes(k)) stripped.push(`${key}.${k}`);
      }
      if (value.total !== rows.length || value.limit !== rows.length || value.offset !== 0) {
        counters.push({
          sheet: key,
          was: `total ${value.total} · limit ${value.limit} · offset ${value.offset ?? 0}`,
          now: `total ${rows.length} · limit ${rows.length} · offset 0`,
        });
      }
      payload[key] = {
        total: rows.length, limit: rows.length, offset: 0, data: rows,
      };
    }
  }
  // De-duplicate: `_why` appears on many rows and one line per row is noise.
  return { payload, stripped: [...new Set(stripped)], counters };
}

/* ----------------------------------------------------------------- the validation */

/**
 * The `languages` sheet against the locale registry.
 *
 * Every check here exists because its failure is silent. An unknown `code` returns
 * untranslated source text; a `location` that does not match the registry writes the
 * translation into a tree the tracker does not read; a missing target locale simply
 * never gets translated and no count anywhere goes down.
 */
function checkLanguageRow(row, ours, problems) {
  const code = String(row.code || '').trim();
  const reg = LOCALES.find((l) => l.code === ours);
  if (reg.serviceCode !== code) {
    problems.push(`languages: code "${code}" should be "${reg.serviceCode}" for ${ours} — these differ `
      + 'in case only and the connector fails silently on a near miss');
  }
  if (String(row.location || '').trim() !== reg.location) {
    problems.push(`languages: ${ours} location is "${row.location}", registry says "${reg.location}"`);
  }
  const action = String(row.actions || '').trim().toLowerCase();
  if (ours === SOURCE_LOCALE && action !== 'skip') {
    problems.push(`languages: ${SOURCE_LOCALE} must be "Skip" (it is the source), not "${row.actions}"`);
  }
  if (ours !== SOURCE_LOCALE && action !== 'translate') {
    problems.push(`languages: ${ours} action is "${row.actions}" — every target locale is machine-translated `
      + 'here; the human pass is the tracker\'s native-review stage, not the connector\'s');
  }
}

function validateLanguages(rows) {
  const problems = [];
  const seen = new Map();
  for (const row of rows) {
    const code = String(row.code || '').trim();
    const ours = localeForServiceCode(code);
    if (!ours) {
      problems.push(`languages: code "${code}" is not in scripts/tracker/locales.js — the connector `
        + 'accepts an unknown code and returns the source text untranslated');
    } else {
      checkLanguageRow(row, ours, problems);
      seen.set(ours, true);
    }
  }
  for (const code of TARGET_LOCALES) {
    if (!seen.has(code)) problems.push(`languages: ${code} is missing — it would simply never be translated`);
  }
  if (!seen.has(SOURCE_LOCALE)) problems.push(`languages: ${SOURCE_LOCALE} row is missing (the source, action Skip)`);
  return problems;
}

/**
 * Refuse a payload the connector would accept and then not apply.
 *
 * Returns a list of problems; empty means valid. Collected rather than thrown one at a
 * time so a hand-edit with three mistakes reports three, not the first.
 */
export function validatePayload(payload) {
  const problems = [];
  const present = Object.keys(payload).filter((k) => !k.startsWith(':'));

  for (const name of SHEET_NAMES) {
    if (!present.includes(name)) problems.push(`missing sheet "${name}"`);
  }
  for (const name of present) {
    if (!SHEET_NAMES.includes(name)) {
      problems.push(`unknown sheet "${name}" — da-nx ignores what it does not recognise, so this `
        + `would deploy cleanly and never apply. Known: ${SHEET_NAMES.join(', ')}`);
    }
  }

  for (const spec of SHEETS.filter((s) => Array.isArray(payload[s.name]?.data))) {
    const rows = payload[spec.name].data;
    if (!rows.length) problems.push(`sheet "${spec.name}" has no rows`);
    rows.forEach((row, i) => {
      for (const col of Object.keys(row)) {
        if (!spec.columns.includes(col)) {
          problems.push(`${spec.name}[${i}]: unknown column "${col}" — known: ${spec.columns.join(', ')}`);
        }
      }
      for (const col of spec.required) {
        if (!String(row[col] ?? '').trim()) problems.push(`${spec.name}[${i}]: "${col}" is required and is blank`);
      }
    });
  }

  problems.push(...validateLanguages(payload.languages?.data || []));

  // The envelope rule, enforced locally because nothing previews this path.
  try {
    assertSheetDoc(payload);
  } catch (e) {
    problems.push(e.message);
  }
  return problems;
}

/* ------------------------------------------------------------------------ the diff */

const canonical = (row) => JSON.stringify(Object.keys(row).sort().map((k) => [k, row[k]]));

/**
 * Compare two payloads sheet by sheet.
 *
 * Rows are compared as an unordered MULTISET of canonical forms, not positionally: the
 * `dnt` sheet legitimately carries two rows with the same first column, so a key-based
 * diff collides and a positional one reports every row below an insertion as changed.
 * Order is reported separately, because for these sheets order is not semantic — except
 * in `config`, where `translation.service.all.env` documents "first entry is the
 * default", so an order change there is called out.
 */
export function diffPayloads(local, deployed) {
  const out = [];
  const names = [...new Set([...Object.keys(local), ...Object.keys(deployed || {})])]
    .filter((k) => !k.startsWith(':'));
  for (const name of names) {
    const a = local[name]?.data || [];
    const b = deployed?.[name]?.data || [];
    const bag = new Map();
    for (const r of b) bag.set(canonical(r), (bag.get(canonical(r)) || 0) + 1);
    const onlyLocal = [];
    for (const r of a) {
      const k = canonical(r);
      if (bag.get(k)) bag.set(k, bag.get(k) - 1);
      else onlyLocal.push(r);
    }
    const onlyDeployed = [];
    for (const [k, n] of bag) {
      for (let i = 0; i < n; i += 1) onlyDeployed.push(JSON.parse(k));
    }
    const sameRows = !onlyLocal.length && !onlyDeployed.length;
    const orderDiffers = sameRows && a.map(canonical).join('|') !== b.map(canonical).join('|');
    if (!sameRows || orderDiffers) {
      out.push({
        sheet: name, onlyLocal, onlyDeployed, orderDiffers,
      });
    }
  }
  for (const key of [':type', ':names', ':version']) {
    const l = JSON.stringify(local[key]);
    const d = JSON.stringify(deployed?.[key]);
    if (l !== d) out.push({ sheet: key, meta: { local: l, deployed: d } });
  }
  return out;
}

/* -------------------------------------------------------------------------- DA I/O */

const strongEtag = (etag) => (etag ? etag.replace(/^W\//, '') : null);

async function fetchDeployed(token) {
  const res = await request(daSourceUrl(DA_TRANSLATE_CONFIG, 'json'), {
    headers: { Authorization: `Bearer ${token}` },
  }, { attempts: 2 });
  if (res.status === 404) return { exists: false, doc: null, version: null };
  if (!res.ok) throw new Error(`translate config GET ${res.status} (${res.detail})`);
  return {
    exists: true,
    doc: await res.res.json(),
    version: strongEtag(res.res.headers.get('ETag')),
  };
}

/**
 * Write the payload, conditionally, and read it back.
 *
 * `If-Match` on an update and `If-None-Match: *` on a create, and a 412 REFUSES rather
 * than retrying: a 412 here means somebody edited the deployed config in da.live since
 * we read it, and this tool's job is to push a file, not to win a race against a human.
 * Re-run `--diff` and decide.
 */
async function writeDeployed(token, payload, current) {
  const form = new FormData();
  form.append('data', new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'translate.json');
  const res = await request(daSourceUrl(DA_TRANSLATE_CONFIG, 'json'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(current.exists ? { 'If-Match': current.version } : { 'If-None-Match': '*' }),
    },
    body: form,
  }, { attempts: 1 });
  if (res.status === 412) {
    throw new Error(current.exists
      ? 'the deployed config changed since it was read (412) — re-run `npm run tx:config -- --diff` and decide'
      : 'somebody created the config first (412) — re-run --diff');
  }
  if (!res.ok) throw new Error(`translate config POST ${res.status} (${res.detail})`);
  const back = await fetchDeployed(token);
  const drift = diffPayloads(payload, back.doc);
  if (drift.length) throw new Error(`written, but the read-back differs in ${drift.length} place(s) — inspect with --diff`);
  return true;
}

/* --------------------------------------------------------------------- the printer */

const ROW_SAMPLE = 6;

function printRow(prefix, row) {
  const cells = Object.entries(row).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ');
  console.log(`     ${prefix} ${cells.length > 160 ? `${cells.slice(0, 157)}…` : cells}`);
}

function printDiff(diff, deployedExists) {
  if (!deployedExists) {
    console.log('   deployed: ABSENT — /.da/translate.json does not exist on this site.');
    console.log('   DA therefore resolves its translate config from /aemgdc/.da/translate.json if that');
    console.log('   exists, and otherwise from the bundled Google-connector default: no custom-doc-rules,');
    console.log('   no dnt rules, and every locale absent. That is a fine and expected answer today —');
    console.log('   nothing has been sent for translation yet — and it is exit 1 because the deployed');
    console.log('   config is not what this repo says it should be, not because anything is broken.');
    return;
  }
  if (!diff.length) {
    console.log('   deployed config is IDENTICAL to the stripped payload. Nothing to do.');
    return;
  }
  console.log(`   ${diff.length} sheet(s)/key(s) differ:`);
  for (const d of diff) {
    if (d.meta) {
      console.log(`\n   ── ${d.sheet} ──`);
      console.log(`     local:    ${d.meta.local}`);
      console.log(`     deployed: ${d.meta.deployed}`);
    } else {
      console.log(`\n   ── ${d.sheet} ── +${d.onlyLocal.length} local · +${d.onlyDeployed.length} deployed`
        + `${d.orderDiffers ? ' · SAME ROWS, DIFFERENT ORDER' : ''}`);
      if (d.orderDiffers && d.sheet === 'config') {
        console.log('     order is semantic in this sheet — `translation.service.all.env` documents that the');
        console.log('     first entry is the default.');
      }
      for (const r of d.onlyLocal.slice(0, ROW_SAMPLE)) printRow('+ local   ', r);
      if (d.onlyLocal.length > ROW_SAMPLE) console.log(`     + … ${d.onlyLocal.length - ROW_SAMPLE} more local-only row(s)`);
      for (const r of d.onlyDeployed.slice(0, ROW_SAMPLE)) printRow('- deployed', r);
      if (d.onlyDeployed.length > ROW_SAMPLE) console.log(`     - … ${d.onlyDeployed.length - ROW_SAMPLE} more deployed-only row(s)`);
    }
  }
}

/* ------------------------------------------------------------------------ the run */

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const source = JSON.parse(readFileSync(SOURCE_FILE, 'utf8'));
  const { payload, stripped, counters } = stripAnnotations(source);
  const problems = validatePayload(payload);

  if (opts.json && !opts.apply && !opts.diff) {
    if (problems.length) {
      console.error(`✗ ${problems.length} validation problem(s) — refusing to print a payload that would not apply`);
      for (const p of problems) console.error(`  · ${p}`);
      return 3;
    }
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  let mode = 'DRY RUN (default)';
  if (opts.apply) mode = 'APPLY';
  if (opts.diff) mode = 'DIFF (read-only)';
  console.log(`── tx:config · ${mode} ──`);
  console.log(`   source:   ${SOURCE_FILE}`);
  console.log(`   target:   ${daSourceUrl(DA_TRANSLATE_CONFIG, 'json')}`);
  console.log(`   editor:   ${daSheetUrl(DA_TRANSLATE_CONFIG)}`);
  console.log(`   stripped: ${stripped.length ? stripped.join(', ') : '(nothing — the source carries no annotations)'}`);
  for (const c of counters) {
    console.log(`   counters: ${c.sheet}: ${c.was} → ${c.now} (recomputed; the source's counts had drifted)`);
  }
  const sheetLine = SHEET_NAMES.map((n) => `${n} ${payload[n]?.data?.length ?? 0}`).join(' · ');
  console.log(`   sheets:   ${sheetLine}`);

  if (problems.length) {
    console.error(`\n✗ REFUSED — ${problems.length} validation problem(s). Nothing was written.`);
    for (const p of problems) console.error(`   · ${p}`);
    return 3;
  }
  console.log('   validated: six known sheets, known columns, every locale matched against the registry.');

  if (!opts.apply && !opts.diff) {
    console.log('\n   ── the exact payload that would be written ──\n');
    console.log(JSON.stringify(payload, null, 2));
    console.log('\n   Re-run with --diff to compare against the deployed config, or --apply to write.');
    return 0;
  }

  const token = resolveToken();
  if (!token) {
    console.error(`\n✗ no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first. Nothing was read or written.`);
    return 2;
  }

  let current;
  try {
    current = await fetchDeployed(token);
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    return 2;
  }

  if (opts.diff) {
    const diff = diffPayloads(payload, current.doc);
    printDiff(diff, current.exists);
    return current.exists && !diff.length ? 0 : 1;
  }

  try {
    await writeDeployed(token, payload, current);
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    return 2;
  }
  console.log(`\n   ✓ written and read back${current.exists ? ' (If-Match)' : ' (created, If-None-Match: *)'}`);
  console.log('   NOT previewed: /.da/** is DA application config, not site content.');
  console.log('   Next: open DA\'s Translate app and confirm it lists eleven languages.');
  return 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ tx:config: ${e.message}`);
      exit(/^unknown arg|do different jobs|ENOENT|Unexpected token/.test(e.message) ? 3 : 2);
    });
}
