#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * emit-pairs.mjs — turn a group sheet into a batch list the drivers consume.
 *
 * CLI SURFACE
 *   node tools/tracker/emit-pairs.mjs --group=<name> [--locale=<code>]
 *        [--where=<selector>] [--reason=<text>] [--out=<path>]
 *        [--branch=<ref>] [--dry-run|--apply] [--help]
 *
 *   npm run pairs -- --group=meetups                          EN side, the gate
 *   npm run pairs -- --group=meetups --locale=de              (en, de) pairs to send
 *   npm run pairs -- --group=meetups --locale=de --where=stage:previewed --apply
 *
 * ─── What a "pair" is ───────────────────────────────────────────────────────
 *
 *   EN side (no --locale)   (english page, its QA document)
 *   locale side             (english page, the same page in that locale)
 *
 * Two columns, tab-separated, one pair per line. Tab rather than comma because a DA
 * edit URL contains a `#` and a comma-separated list of URLs is one bad quoting rule
 * away from being unparseable.
 *
 * ─── Why a file, and why it carries a header ────────────────────────────────
 *
 * The gate could have been a filter inside a driver. Making it an artifact instead
 * means the queue can be read, diffed, committed and pointed at: you can see exactly
 * what a run was asked to do, months later. A filter buried in a driver is invisible.
 *
 * That only holds if the file says where it came from, so the header records the
 * generation time, the selector, the branch and the sheet. A list nobody can trace is
 * a list nobody trusts — and the temptation to hand-edit one is why the header also
 * names the command that regenerates it.
 *
 * ─── The default selector IS the gate ───────────────────────────────────────
 *
 * With no `--where=`:
 *   EN side      `stage:enPublished` — the English page is published, so it is
 *                worth QA-ing and it may be translated FROM.
 *   locale side  `sendable` — passes the send gate AND has no translation-status
 *                yet, so it has not already been handed over. Sending is the one
 *                irreversible, money-costing step in the pipeline, so the default
 *                can never be "everything".
 *
 * DRY RUN BY DEFAULT. The full list is printed either way — that is the plan — and
 * `--apply` writes it to disk.
 *
 * EXIT CODES  0 emitted (even zero pairs — an empty queue is an answer) ·
 *             2 could not read the sheet · 3 usage/config error
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { hostname } from 'node:os';
import { isTargetLocale, locale, normalizePath } from '../../scripts/tracker/locales.js';
import { links, TRACKER_ROOT } from '../../scripts/tracker/paths.js';
import { countsAsPage, indexLocaleRows, localeRowFor } from '../../scripts/tracker/stages.js';
import { loadConfig, groupConfig, REPO_ROOT } from './config.mjs';
import { resolveToken, TOKEN_HINT } from './lib/status-sheet.mjs';
import {
  dataRowsOf, readGroupDoc, groupSheetLink, parseWhere, matchWhere,
} from './lib/group-sheet.mjs';

/**
 * Where batch lists live.
 *
 * `.tracker/urls/pairs-*.txt` is COMMITTED (see .gitignore, which ignores only
 * `pending-*.txt` there) and that is the hand-off mechanism: another machine gets the
 * queue by `git pull`, not by anyone pasting URLs into a terminal.
 */
const URLS_DIR = join(REPO_ROOT, '.tracker', 'urls');

const HELP = `emit-pairs — write a batch list from a group sheet.

  --group=<name>    required
  --locale=<code>   emit (en, locale) pairs instead of (en, QA doc) pairs
  --where=<sel>     stage:<id> | queue:<id> | blocked | sendable | col=val | col!=val
                    default: stage:enPublished (EN side) / sendable (locale side)
  --reason=<text>   recorded in the header, for a deliberate re-queue
  --out=<path>      default .tracker/urls/pairs-<group>[-<locale>].txt
  --branch=<ref>    build the URLs against this ref (default: main)
  --dry-run         print the list, write nothing (DEFAULT)
  --apply           write the file
  --help            this text

exit 0 ok · 2 could not read the sheet · 3 usage/config error`;

function parseArgs(args) {
  const o = {
    group: null,
    locale: null,
    where: null,
    reason: null,
    out: null,
    branch: null,
    apply: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--locale=')) o.locale = a.slice(9).trim().toLowerCase();
    else if (a.startsWith('--where=')) o.where = a.slice(8);
    else if (a.startsWith('--reason=')) o.reason = a.slice(9);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  if (!o.group) throw new Error('--group=<name> is required');
  /*
   * `en` is refused explicitly rather than treated as "no locale". A run asked for the
   * source locale is asking to translate the page into itself, and answering it with
   * the EN-side list would look like it worked.
   */
  if (o.locale && !isTargetLocale(o.locale)) {
    throw new Error(`--locale="${o.locale}" is not a target locale`
      + `${o.locale === 'en' ? ' — en is the source; omit --locale for the EN-side list' : ''}`);
  }
  return o;
}

const val = (row, key) => String(row?.[key] ?? '').trim();

/** The default file name, which is also the name every consumer expects. */
export const defaultOut = (group, code) => join(URLS_DIR, `pairs-${group}${code ? `-${code}` : ''}.txt`);

/**
 * Build the pair list.
 *
 * Pure, so the selector's behaviour can be checked against real row shapes without
 * touching DA. Returns rows in sheet order — a queue that reorders itself between
 * runs cannot be diffed, and diffing it is most of why it is a file.
 */
export function buildPairs({
  dataRows, localeIndex, code, parsed, branch,
}) {
  const pairs = [];
  const skipped = [];
  for (const row of dataRows.filter((r) => countsAsPage(r))) {
    const path = normalizePath(val(row, 'page-path'));
    /*
     * `{}` for the EN side, not `undefined`: that is what classifyTranslation expects
     * for a pair with no locale row, and it makes `stage:` mean the same thing on the
     * master tab as on a locale tab that has not been populated yet.
     */
    const localeRow = code ? localeRowFor(localeIndex, path, code) : {};
    if (matchWhere(parsed, row, localeRow)) {
      const link = links(path, code, branch);
      pairs.push({ path, left: link.enPreview, right: code ? link.localePreview : link.qaDoc });
    } else {
      skipped.push(path);
    }
  }
  return { pairs, skipped };
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const sheetCfg = groupConfig(cfg, opts.group);
  const branch = opts.branch || sheetCfg.branch;
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

  const dataRows = dataRowsOf(current.doc);
  const selector = opts.where || (opts.locale ? 'sendable' : 'stage:enPublished');
  const parsed = parseWhere(selector, { rows: dataRows });
  if (parsed.errors.length) throw new Error(`--where= refused: ${parsed.errors.join('; ')}`);

  const { pairs, skipped } = buildPairs({
    dataRows,
    localeIndex: indexLocaleRows(current.doc),
    code: opts.locale,
    parsed,
    branch,
  });

  const explicitOut = opts.out && (isAbsolute(opts.out) ? opts.out : join(REPO_ROOT, opts.out));
  const outPath = explicitOut || defaultOut(opts.group, opts.locale);
  const generated = new Date().toISOString();
  const rightLabel = opts.locale ? `${locale(opts.locale).name} page` : `QA doc (${TRACKER_ROOT}/qa/…)`;

  /*
   * The header is four lines and every one of them answers a question somebody asks
   * of a stale list: when, from what, by which rule, and how to regenerate it.
   */
  const header = [
    `# emit-pairs · generated ${generated} on ${hostname()}`,
    `# group=${opts.group} locale=${opts.locale || '(en side)'} branch=${branch}`,
    `# selector: ${selector}${opts.where ? '' : '   [default — this IS the gate]'}`
      + `${opts.reason ? `   reason: ${opts.reason}` : ''}`,
    `# source: ${sheetCfg.path} · ${pairs.length} pair(s) of ${dataRows.filter((r) => countsAsPage(r)).length} real row(s)`,
    `# columns: english page<TAB>${rightLabel}`,
    `# regenerate: npm run pairs -- --group=${opts.group}${opts.locale ? ` --locale=${opts.locale}` : ''}`
      + `${opts.where ? ` --where=${opts.where}` : ''} --apply`,
  ].join('\n');

  const body = pairs.map((p) => `${p.left}\t${p.right}`).join('\n');

  console.log(`── pairs · ${opts.group}${opts.locale ? ` · ${opts.locale}` : ''} `
    + `· ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} ──`);
  console.log(`   sheet:  ${groupSheetLink(sheetCfg)}`);
  console.log(`   out:    ${outPath}`);
  console.log('');
  console.log(header);
  if (pairs.length) console.log(body);
  console.log('');
  console.log(`   ${pairs.length} pair(s) selected · ${skipped.length} row(s) filtered out`);

  if (!pairs.length) {
    /*
     * An empty queue is an answer, not an error — and on this site it is the EXPECTED
     * answer today: nothing is translated yet, every locale tree is empty, and no page
     * has been marked `en-published`. Say which of those it is instead of printing a
     * bare zero.
     */
    const published = dataRows.filter((r) => val(r, 'en-status').toLowerCase() === 'en-published').length;
    console.log(`   nothing selected. ${published} row(s) in this group carry en-status=en-published.`);
    console.log(published
      ? '   Check the selector — the pages are gated open but do not match it.'
      : `   Nothing is released yet. Release a set with:\n     npm run en-status -- --group=${opts.group} --to=en-published --all --apply`);
    return 0;
  }

  if (!opts.apply) {
    console.log('\n   Re-run with --apply to write the file.');
    return 0;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${header}\n${body}\n`);
  console.log(`\n   ✓ wrote ${outPath}`);
  console.log('   This file is committed on purpose: another machine gets the queue by `git pull`.');
  return 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ pairs: ${e.message}`);
      exit(/^unknown arg|required|is not a target locale|--where=|unknown group/.test(e.message) ? 3 : 2);
    });
}
