#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * tx-send.mjs — hand a batch to translation by creating a DA translation project, then
 * stamp `translation-status: sent` + `sent-at` on every (page, locale) it covers.
 *
 * CLI SURFACE
 *   node tools/tracker/tx-send.mjs --group=<name> [--locale=<code> …]
 *        [--path=<page-path> …] [--where=<selector>] [--limit=N]
 *        [--title=<text>] [--dry-run|--apply] [--force-lock] [--help]
 *
 *   npm run tx:send -- --group=meetups                        plan the whole group
 *   npm run tx:send -- --group=meetups --locale=de --locale=fr
 *   npm run tx:send -- --group=meetups --path=/en/meetups/aem-meetup-miami --apply
 *
 *   --group=<name>   REQUIRED. One registered group; a project is per group, so the
 *                    stamp and the project always describe the same set.
 *   --locale=<code>  repeatable. Default: all ten target locales.
 *   --path=<path>    a page path, repeatable. EXPLICIT selection: a named path that
 *                    fails the send gate REFUSES THE RUN (see below).
 *   --where=<sel>    the shared selector grammar (lib/group-sheet.mjs `parseWhere`).
 *   --limit=N        send at most N pages (not pairs) — a deliberate first batch.
 *   --title=<text>   the project title DA shows. Default names the group and the batch.
 *   --dry-run        list every pair it WOULD send, with a total. THE DEFAULT.
 *   --apply          create the project, then stamp the sheet.
 *   --force-lock     take the writer lease even if one is held.
 *
 * ─── The gate is `isSendable`, and it is never derived ──────────────────────
 *
 * Selection goes through `isSendable(row, localeRow)` from scripts/tracker/stages.js:
 * an EXPLICIT `en-status === 'en-published'` on the page, and a BLANK
 * `translation-status` on the pair. Never a derived default — a page that merely looks
 * published (a crawl saw a 200 once) must not be sent on that basis, because sending is
 * the one irreversible, money-costing step in the pipeline. `en-live` records the
 * observation; a human marking `en-published` with `npm run en-status` records the
 * decision, and only the decision opens this gate.
 *
 * The blank-status half of the gate is what stops a re-run masquerading as new work and
 * sending the same page twice.
 *
 * ─── Explicit selection refuses; bulk selection reports ────────────────────
 *
 * A `--path=` you typed is a claim that THAT page should be sent. If it fails the gate,
 * the whole run is refused and the reason is named per path — a tool that shrugs at a
 * hand-typed path teaches you to distrust its counts, and here the count is money.
 *
 * A bulk selection (`--where=`, or the default "everything in the group") is a filter,
 * not a claim: rows that fail the gate are reported with a reason breakdown and the
 * sendable ones proceed. Refusing the batch because one of nineteen pages is still a
 * draft would make the tool unusable.
 *
 * ─── ORDER OF OPERATIONS: project first, sheet second ──────────────────────
 *
 * The project write must succeed before a single cell is stamped. The two failure
 * directions are not symmetrical:
 *
 *   `sent` in the sheet with no project — a lie nothing can detect later. `sent-at`
 *   exists nowhere else, so no crawl, no re-read and no project list can contradict it,
 *   and the pair sits in `sentForTranslation` forever until the SLA rule guesses.
 *
 *   a project with no `sent` in the sheet — repaired automatically. `tx:scan` reads
 *   `/.da/translation/active/` and corroborates exactly this case, preferring the
 *   project over our blank row.
 *
 * So the order is chosen to fail in the recoverable direction.
 *
 * ─── What "sent" actually means here ───────────────────────────────────────
 *
 * This tool creates the project and queues it. It does NOT call the Google connector —
 * DA's Translate app does that when a human opens the project and runs the sync,
 * translate and rollout steps. So `sent` records the HAND-OFF, and `tx:scan`'s preview
 * SLA is what catches a batch nobody ran. The run output says this out loud, because a
 * status called `sent` invites the assumption that money has been spent.
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  planned, or the project was created and the sheet stamped
 *   1  the project was created and the STAMP failed. The sheet is behind the world;
 *      `npm run tx:scan` repairs it from the project. Not a lost batch, but a defect.
 *   2  could not reach a verdict — no token, sheet unreachable, project write failed.
 *      NOTHING was created and nothing stamped.
 *   3  usage or configuration error, including a named `--path=` that fails the gate.
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import {
  TARGET_LOCALES, isTargetLocale, normalizePath, pathForLocale,
} from '../../scripts/tracker/locales.js';
import { daEditUrl } from '../../scripts/tracker/paths.js';
import {
  countsAsPage, isSendable, indexLocaleRows, localeRowFor,
} from '../../scripts/tracker/stages.js';
import { loadConfig, groupConfig } from './config.mjs';
import { resolveToken, TOKEN_HINT } from './lib/status-sheet.mjs';
import {
  dataRowsOf,
  localeRowsOf,
  indexLocaleTab,
  readGroupDoc,
  withLocaleRows,
  updateGroupDoc,
  groupSheetLink,
  syncLocaleRow,
  setLocaleStatus,
  parseWhere,
  matchWhere,
} from './lib/group-sheet.mjs';
import { buildProject, writeProject, serviceCodeFor } from './lib/tx-project.mjs';
import { withWriterLock } from './lib/writer-lock.mjs';

const HELP = `tx:send — create a DA translation project for a batch and stamp the sheet.

  --group=<name>   required
  --locale=<code>  repeatable (default: all ten target locales)
  --path=<path>    a page path, repeatable; a named path that fails the gate refuses the run
  --where=<sel>    stage:<id> | queue:<id> | blocked | sendable | col=val | col!=val
  --limit=N        send at most N pages
  --title=<text>   project title shown in DA
  --dry-run        list every pair it would send (DEFAULT)
  --apply          create the project, then stamp the sheet
  --force-lock     take the writer lease even if one is held
  --help           this text

exit 0 ok · 1 project created but the stamp failed · 2 nothing created · 3 usage/config`;

function parseArgs(args) {
  const o = {
    group: null,
    locales: [],
    paths: [],
    where: null,
    limit: 0,
    title: null,
    apply: false,
    forceLock: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--force-lock') o.forceLock = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--locale=')) o.locales.push(a.slice(9).trim().toLowerCase());
    else if (a.startsWith('--path=')) o.paths.push(normalizePath(a.slice(7)));
    else if (a.startsWith('--where=')) o.where = a.slice(8);
    else if (a.startsWith('--limit=')) o.limit = Number(a.slice(8));
    else if (a.startsWith('--title=')) o.title = a.slice(8);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  if (!o.group) throw new Error('--group=<name> is required');
  if (o.limit && !Number.isInteger(o.limit)) throw new Error('--limit must be a whole number');
  for (const code of o.locales) {
    if (!isTargetLocale(code)) {
      throw new Error(`--locale=${code} is not a target locale. Known: ${TARGET_LOCALES.join(', ')}`);
    }
  }
  return o;
}

const text = (v) => (v == null ? '' : String(v).trim());
const val = (row, key) => text(row?.[key]);

/* ------------------------------------------------------------------- selection */

/**
 * Why can this pair not be sent? One sentence, or `null` when it can.
 *
 * The reasons mirror `isSendable`'s two halves exactly, so a refusal can never disagree
 * with the gate that produced it. Kept separate from the gate rather than duplicating
 * its logic: the gate answers yes/no and this explains a no.
 */
export function refusalFor(row, localeRow) {
  /*
   * The curated exclusion, checked BEFORE the gate.
   *
   * `translate: 'no'` excludes the page from every locale (data-contract section 1), and
   * `isSendable` in scripts/tracker/stages.js does NOT consult it — it asks only about
   * `en-status` and `translation-status`. So a page a human deliberately excluded is
   * `isSendable` and would have been paid to translate. `reconcileLocale` already
   * honours the column by refusing to create new locale rows for such a page; this is
   * the same rule at the one point where ignoring it costs money.
   *
   * Layered on top of the gate rather than folded into it: the gate is the model's, and
   * a tool must not quietly widen or narrow a shared definition. Narrowing it HERE is
   * visible in this function's name and in the refusal text.
   */
  if (val(row, 'translate').toLowerCase() === 'no') {
    return 'curated translate="no" — a human excluded this page from every locale, and the '
      + 'send gate in stages.js does not look at that column';
  }
  if (isSendable(row, localeRow)) return null;
  const en = val(row, 'en-status');
  if (en.toLowerCase() !== 'en-published') {
    return `en-status is "${en || '(not assessed)'}", not "en-published" — mark it with `
      + '`npm run en-status -- --to=en-published` first';
  }
  const status = val(localeRow, 'translation-status');
  const at = val(localeRow, 'sent-at');
  return `already has translation-status "${status}"${at ? ` (sent ${at})` : ''} — sending again would `
    + 'pay for the same page twice';
}

/**
 * Partition the group's pages × locales into what would be sent and what would not.
 *
 * @returns {{ pages, pairs, refused, skipped, refusedExplicit }}
 *   `pairs` is what would go in the project. `refusedExplicit` is non-empty only when a
 *   hand-typed `--path=` failed the gate, and it refuses the whole run.
 */
export function selectBatch(doc, codes, opts, parsedWhere) {
  const real = dataRowsOf(doc).filter((r) => countsAsPage(r));
  /*
   * `indexLocaleRows` + `localeRowFor` from stages.js, not a hand-built key: the join
   * key is NUL-separated and rebuilding it here is how one tool comes to read a
   * different index than the model writes.
   */
  const index = indexLocaleRows(doc);

  let candidates = real;
  const parts = [];
  if (parsedWhere) {
    candidates = candidates.filter((r) => matchWhere(parsedWhere, r));
    parts.push(`where="${parsedWhere.describe}"`);
  }

  const refusedExplicit = [];
  if (opts.paths.length) {
    const wanted = new Set(opts.paths);
    const missing = opts.paths.filter((p) => !real.some((r) => normalizePath(val(r, 'page-path')) === p));
    for (const p of missing) {
      refusedExplicit.push({ path: p, code: '*', why: 'not a real page row in this group' });
    }
    candidates = candidates.filter((r) => wanted.has(normalizePath(val(r, 'page-path'))));
    parts.push(`${opts.paths.length} path(s)`);
  }

  const pairs = [];
  const refused = [];
  const pages = new Set();
  for (const row of candidates) {
    const path = normalizePath(val(row, 'page-path'));
    for (const code of codes) {
      const localeRow = localeRowFor(index, path, code);
      const why = refusalFor(row, localeRow);
      if (why) {
        refused.push({ path, code, why });
        // An explicitly named path is a claim about that page; a filter is not.
        if (opts.paths.length) refusedExplicit.push({ path, code, why });
      } else {
        pairs.push({ path, code, localePath: pathForLocale(path, code) });
        pages.add(path);
      }
    }
  }

  // The limit is in PAGES, not pairs: a batch is a set of documents handed over, and
  // half a page's locales is not a smaller batch, it is a stranger one.
  let kept = [...pages];
  if (opts.limit && kept.length > opts.limit) {
    kept = kept.slice(0, opts.limit);
    const allowed = new Set(kept);
    return {
      pages: kept,
      pairs: pairs.filter((p) => allowed.has(p.path)),
      refused,
      refusedExplicit,
      describe: `${parts.join(' + ') || 'every real page row'} · --limit=${opts.limit}`,
    };
  }
  return {
    pages: kept,
    pairs,
    refused,
    refusedExplicit,
    describe: parts.join(' + ') || 'every real page row',
  };
}

/* ---------------------------------------------------------------------- the plan */

const SAMPLE = 40;

function printPlan(group, sheetCfg, codes, batch) {
  console.log(`   sheet:    ${sheetCfg.path} · ${groupSheetLink(sheetCfg)}`);
  console.log(`   selector: ${batch.describe}`);
  console.log(`   locales:  ${codes.map((c) => `${c}→${serviceCodeFor(c)}`).join(' ')}`);
  console.log(`\n   WOULD SEND ${batch.pairs.length} (page, locale) pair(s) — ${batch.pages.length} page(s) × up to ${codes.length} locale(s):`);
  for (const p of batch.pairs.slice(0, SAMPLE)) {
    console.log(`     → ${p.path}  [${p.code}]  ${p.localePath}`);
  }
  if (batch.pairs.length > SAMPLE) console.log(`     → … ${batch.pairs.length - SAMPLE} more`);
  console.log(`\n   TOTAL: ${batch.pairs.length} pair(s) across ${batch.pages.length} page(s) in ${group}.`);

  if (batch.refused.length) {
    const byWhy = new Map();
    for (const r of batch.refused) {
      const key = r.why.split(' — ')[0];
      byWhy.set(key, (byWhy.get(key) || 0) + 1);
    }
    console.log(`\n   NOT sendable: ${batch.refused.length} pair(s), by reason:`);
    for (const [why, n] of byWhy) console.log(`     · ${n} × ${why}`);
  }
}

/* ------------------------------------------------------------------- the stamp */

/**
 * Stamp `sent` + `sent-at` on every pair the project covers. ONE write for the group.
 *
 * The pairs are re-applied against a freshly read doc inside `updateGroupDoc`, keyed on
 * (page-path, locale) — a row set built before the project write would be stale, and on
 * a 412 retry it would overwrite somebody else's concurrent change.
 *
 * `confirm` re-reads and checks every pair actually took the value. A stamp that
 * reported success without landing is the one outcome that makes the sheet lie about a
 * project that exists.
 */
async function stampSheet(sheetCfg, token, codes, pairs, sentAt) {
  const want = new Set(pairs.map((p) => `${p.path}\0${p.code}`));
  return updateGroupDoc(sheetCfg, token, (doc, { exists }) => {
    if (!exists) throw new Error('sheet vanished between the read and the write');
    let next = doc;
    for (const code of codes) {
      const rows = localeRowsOf(doc, code).map((existing) => {
        const path = normalizePath(val(existing, 'page-path'));
        if (!path || !want.has(`${path}\0${code}`)) return existing;
        const { row } = syncLocaleRow(existing, { pagePath: path, code });
        return setLocaleStatus(row, { 'translation-status': 'sent', 'sent-at': sentAt }).row;
      });
      next = withLocaleRows(next, code, rows);
    }
    return next;
  }, {
    confirm: (after) => {
      for (const code of codes) {
        const tab = indexLocaleTab(after, code);
        const mine = pairs.filter((p) => p.code === code);
        for (const p of mine) {
          const row = tab.get(p.path);
          if (!row) return `the ${code} tab has no row for ${p.path}`;
          if (val(row, 'translation-status') !== 'sent') {
            return `${p.path} [${code}] did not take translation-status "sent"`;
          }
        }
      }
      return null;
    },
  });
}

/* ------------------------------------------------------------------------- run */

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const sheetCfg = groupConfig(cfg, opts.group);
  const codes = opts.locales.length ? [...new Set(opts.locales)] : [...TARGET_LOCALES];
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
  if (current.missingTabs.length) {
    console.error(`ERROR: missing locale tab(s): ${current.missingTabs.join(', ')} — repair the sheet `
      + 'before sending, or the stamp lands nowhere and the project has no record here.');
    return 3;
  }

  let parsed = null;
  if (opts.where) {
    parsed = parseWhere(opts.where, { rows: dataRowsOf(current.doc) });
    if (parsed.errors.length) throw new Error(`--where= refused: ${parsed.errors.join('; ')}`);
  }
  const batch = selectBatch(current.doc, codes, opts, parsed);

  console.log(`── tx:send · ${opts.group} · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} ──`);
  printPlan(opts.group, sheetCfg, codes, batch);

  /*
   * A hand-typed path that fails the gate refuses the whole run. Named per path: the
   * point of the refusal is that you learn WHICH page and WHY, not that the count came
   * back smaller than you expected.
   */
  if (batch.refusedExplicit.length) {
    console.error(`\n✗ REFUSED — ${batch.refusedExplicit.length} explicitly named pair(s) fail the send gate. `
      + 'Nothing was created.');
    for (const r of batch.refusedExplicit) {
      console.error(`   · ${r.path} [${r.code}]  ${r.why}`);
    }
    return 3;
  }

  if (!batch.pairs.length) {
    console.log('\n   = nothing to send. The gate is an explicit `en-status: en-published` plus a blank');
    console.log('     translation-status, so an empty batch usually means nobody has marked a page');
    console.log(`     ready yet: \`npm run en-status -- --group=${opts.group} --to=en-published --from=\``);
    return 0;
  }

  if (!opts.apply) {
    console.log('\n   Nothing was created. Re-run with --apply to create the project and stamp the sheet.');
    return 0;
  }

  const now = Date.now();
  const sentAt = new Date(now).toISOString();
  const title = opts.title
    || `${opts.group} · ${batch.pages.length} page(s) · ${codes.length} locale(s) · ${sentAt.slice(0, 10)}`;
  /*
   * `createdBy` is recorded, never invented: it is the machine and the host profile that
   * asked. DA's own app records the signed-in author here; a project created by the
   * pipeline should say so rather than borrow a person's name.
   */
  const createdBy = `aemdev-tracker@${hostname()}`;
  const { doc, path, epochMs } = buildProject({
    title, paths: batch.pages, codes, createdBy, now,
  });

  return withWriterLock(token, `tx:send ${opts.group}`, { force: opts.forceLock }, async () => {
    console.log(`\n   creating project ${path}.json (${epochMs}) …`);
    const wrote = await writeProject(token, path, doc);
    if (!wrote.ok) {
      console.error(`\n✗ project write FAILED (${wrote.status} ${wrote.detail}). Nothing was stamped — `
        + 'the sheet is unchanged and the batch was not handed over.');
      return 2;
    }
    console.log(`   ✓ project created and read back · ${daEditUrl(path)}`);

    let res;
    try {
      res = await stampSheet(sheetCfg, token, codes, batch.pairs, sentAt);
    } catch (e) {
      /*
       * Exit 1, not 2: the project EXISTS. The batch is handed over and the sheet is
       * behind the world, which is the recoverable direction — `tx:scan` corroborates
       * `sent` from the project queue and repairs exactly this.
       */
      console.error(`\n✗ the project was created but the sheet stamp FAILED: ${e.message}`);
      console.error(`   The batch IS handed over. Run \`npm run tx:scan -- --group=${opts.group} --apply\` `
        + 'to record it from the project.');
      return 1;
    }
    console.log(`   ✓ stamped ${batch.pairs.length} pair(s) sent-at=${sentAt}`
      + `${res.retried ? ' (after one 412 retry)' : ''} · preview `
      + `${res.preview?.previewed ? 'ok' : `FAILED: ${res.preview?.previewError}`}`);
    console.log('\n   WHAT HAPPENS NEXT — read this before assuming money was spent:');
    console.log('   the project is QUEUED in DA\'s Translate app. This tool does not call the Google');
    console.log('   connector; a human opens the project and runs sync → translate → rollout. `sent`');
    console.log(`   records the hand-off, and tx:scan's preview SLA (${cfg.tx?.previewSlaHours ?? 48}h) is what catches a`);
    console.log('   batch nobody ran.');
    console.log(`   Then: npm run tx:preview -- --group=${opts.group}   and   npm run tx:scan -- --group=${opts.group} --apply`);
    return 0;
  });
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ tx:send: ${e.message}`);
      exit(/^unknown arg|required|must be a whole number|is not a target locale|unknown group|--where=/.test(e.message) ? 3 : 2);
    });
}
