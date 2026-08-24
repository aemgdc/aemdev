#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * tx-preview.mjs — preview (and, opt-in, publish) translated documents that exist in DA
 * and nowhere else, so `previewed` and `online` can become true.
 *
 * CLI SURFACE
 *   node tools/tracker/tx-preview.mjs [--group=<name>] [--locale=<code> …]
 *        [--where=<selector>] [--limit=N] [--branch=<ref>]
 *        [--dry-run|--apply] [--publish] [--force] [--help]
 *
 *   npm run tx:preview -- --group=meetups                 plan
 *   npm run tx:preview -- --group=meetups --locale=de --apply
 *   npm run tx:preview -- --group=meetups --apply --publish
 *
 *   --group=<name>   one registered group. Default: all of them.
 *   --locale=<code>  repeatable. Default: all ten target locales.
 *   --where=<sel>    the shared selector grammar, applied to the master row.
 *   --limit=N        act on at most N documents per group.
 *   --branch=<ref>   preview against this ref. Default `main`.
 *   --dry-run        list what WOULD be previewed. THE DEFAULT.
 *   --apply          preview.
 *   --publish        ALSO publish to the live host. A SEPARATE opt-in from --apply.
 *   --force          preview even where the page already answers on the preview host.
 *
 * ─── Why this tool exists ──────────────────────────────────────────────────
 *
 * DA's translation connector writes documents into DA and stops. It has no
 * publish-all, so a finished batch lands as source-only content: present in the DA
 * tree, absent from aem.page. That is the NORMAL state for freshly translated content,
 * not an exception.
 *
 * It matters because nothing downstream can see a document that has not been previewed.
 * The structural tier reads `<url>.plain.html` from aem.page — a 404 on an unpreviewed
 * document, which the pipeline this was ported from recorded as a rollout failure:
 * technically true, completely misleading. The rollout had worked; the preview had
 * simply never run. A reviewer cannot look at the page either.
 *
 * So previewing is not a publishing decision. It is the step that makes a translated
 * document legible to anything at all.
 *
 * ─── --publish is a SEPARATE flag from --apply, on purpose ──────────────────
 *
 * Previewing is reversible and internal. Publishing is neither: it puts a
 * machine-translated page in front of the public before a native speaker has read it.
 * So `--apply` alone previews, and publishing needs BOTH flags — you cannot get there by
 * adding one word to a command you have typed before.
 *
 * Publish is sequenced AFTER a successful preview for the same document, never in
 * parallel: the live tier serves what preview produced, so publishing a path whose
 * preview has not landed ships whatever was there before, or nothing.
 *
 * ─── The already-previewed check is SKIPPED under --publish ─────────────────
 *
 * "Already previewed" says nothing about whether a document is on the live host. The
 * first version of the tool this was ported from skipped the nine German fragments that
 * had been previewed weeks earlier and left them unpublished while publishing the other
 * seventy-two — exactly the silent partial the tool exists to prevent. So under
 * `--publish` every selected document is processed.
 *
 * ─── This tool writes NOTHING to the sheet ─────────────────────────────────
 *
 * It changes the world; `tx:scan` observes it. Keeping the two apart is what makes the
 * crawl columns an observation rather than a claim: a tool that both previewed a page
 * and recorded it as previewed would report success for a preview that silently failed
 * to build. Run `npm run tx:scan -- --apply` afterwards.
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  nothing to do, or every document previewed (and published, under --publish)
 *   1  some previews or publishes FAILED — a real defect, named per path
 *   2  could not reach a verdict — no token, a sheet unreachable. Nothing was attempted.
 *   3  usage or configuration error, including a group sheet that does not exist.
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  TARGET_LOCALES, isTargetLocale, normalizePath, pathForLocale,
} from '../../scripts/tracker/locales.js';
import {
  previewUrl, previewApiUrl, publishApiUrl, daListUrl, sourceDocPath,
} from '../../scripts/tracker/paths.js';
import { countsAsPage } from '../../scripts/tracker/stages.js';
import { loadConfig, groupConfig, groupNames } from './config.mjs';
import { resolveToken, TOKEN_HINT, aemAdminHeaders } from './lib/status-sheet.mjs';
import {
  dataRowsOf, readGroupDoc, groupSheetLink, parseWhere, matchWhere,
} from './lib/group-sheet.mjs';
import { createLimiter, pool, request } from './lib/http-pool.mjs';

/** Same fallbacks as tx:scan, for a repo whose orchestrator.json has no `tx` block. */
const DEFAULTS = { concurrency: 6, requestsPerSecond: 10 };

const HELP = `tx:preview — preview (and optionally publish) translated documents.

  --group=<name>   one registered group (default: all)
  --locale=<code>  repeatable (default: all ten target locales)
  --where=<sel>    stage:<id> | queue:<id> | blocked | sendable | col=val | col!=val
  --limit=N        act on at most N documents per group
  --branch=<ref>   preview against this ref (default: main)
  --dry-run        list what would be previewed (DEFAULT)
  --apply          preview
  --publish        ALSO publish to the live host — a separate opt-in from --apply
  --force          preview even where the page already answers on the preview host
  --help           this text

exit 0 ok · 1 some previews/publishes failed · 2 nothing attempted · 3 usage/config`;

function parseArgs(args) {
  const o = {
    group: null,
    locales: [],
    where: null,
    limit: 0,
    branch: null,
    apply: false,
    publish: false,
    force: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--publish') o.publish = true;
    else if (a === '--force') o.force = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--locale=')) o.locales.push(a.slice(9).trim().toLowerCase());
    else if (a.startsWith('--where=')) o.where = a.slice(8);
    else if (a.startsWith('--limit=')) o.limit = Number(a.slice(8));
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
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
const dirOf = (p) => (p.replace(/\/[^/]*$/, '') || '/');

/* ------------------------------------------------------------- does it exist in DA */

/**
 * Every `.html` document DA holds in one directory, as a Set of extensionless paths.
 *
 * The DA LIST api rather than a GET per path: one call answers for a whole directory,
 * and nineteen pages across ten locales collapse to a few dozen list calls instead of
 * one hundred and ninety document fetches. The cache is per run and per directory.
 *
 * A 404 on the directory is an EMPTY SET, not an error: a locale nobody has translated
 * into yet simply has no tree, which is the state every locale is in today.
 */
async function daDirectory(token, dir, cache, opts) {
  if (cache.has(dir)) return cache.get(dir);
  const res = await request(daListUrl(dir), { headers: { Authorization: `Bearer ${token}` } }, opts);
  let set = new Set();
  if (res.ok) {
    const entries = await res.res.json().catch(() => null);
    if (Array.isArray(entries)) {
      set = new Set(entries.filter((e) => e.ext === 'html').map((e) => `${dir === '/' ? '' : dir}/${e.name}`));
    }
  } else if (res.status !== 404) {
    // Distinguish "the directory is empty" from "we could not look". A failed list must
    // not read as an untranslated locale — that is a whole tree reported as absent.
    cache.set(dir, null);
    return null;
  }
  cache.set(dir, set);
  return set;
}

/**
 * Is this path already on the preview host?
 *
 * HEAD on the RENDERED url, not `.plain.html`. A document can be previewed and still
 * 404 on `.plain.html` if the pipeline choked on it, and that is a different problem
 * which previewing again will not fix. The rendered URL is the honest test of "has
 * preview run".
 */
async function isPreviewed(path, branch, opts) {
  const res = await request(previewUrl(path, branch), { method: 'HEAD', redirect: 'manual' }, opts);
  // 2xx or 3xx: the host answered for this path. A redirect is an answer — the site
  // root legitimately 301s to /en/ — and treating it as absent would queue a preview
  // for a page that is already there.
  return res.ok || (res.status >= 300 && res.status < 400);
}

/** POST one AEM admin verb for one path. `{ ok, status, detail }`, never throws. */
async function adminVerb(url, token, opts) {
  const res = await request(url, { method: 'POST', headers: aemAdminHeaders(token) }, opts);
  return { ok: res.ok, status: res.status, detail: res.ok ? null : res.detail };
}

/* ------------------------------------------------------------------- selection */

/**
 * Every (page, locale) document this run would consider, for one group.
 *
 * Selection is the TREE, not the status column: a document DA holds is previewable
 * whether or not our sheet knows it was sent. The connector can complete a rollout
 * without telling us, and refusing to preview it because `translation-status` is blank
 * would leave the page invisible to every tier while the sheet insisted nothing had
 * happened. `tx:scan` is what reconciles the status; this tool acts on what exists.
 */
export function selectDocuments(doc, codes, parsedWhere) {
  const rows = dataRowsOf(doc).filter((r) => countsAsPage(r));
  const picked = parsedWhere ? rows.filter((r) => matchWhere(parsedWhere, r)) : rows;
  const out = [];
  for (const row of picked) {
    const path = normalizePath(val(row, 'page-path'));
    // A curated `translate: no` excludes the page from every locale, so it must not be
    // previewed into one either — that would publish a page nobody agreed to translate.
    if (val(row, 'translate').toLowerCase() !== 'no') {
      for (const code of codes) {
        const localePath = pathForLocale(path, code);
        out.push({
          path, code, localePath, docPath: sourceDocPath(localePath),
        });
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- the run */

const SAMPLE = 30;

async function runGroup({
  name, cfg, codes, opts, token, http, parsedWhereFor,
}) {
  const sheetCfg = groupConfig(cfg, name);
  const current = await readGroupDoc(sheetCfg, token);
  if (!current.exists) {
    return {
      name,
      config: true,
      error: `sheet does not exist — run \`npm run group:scaffold -- --group=${name}\` first`,
    };
  }
  const parsed = parsedWhereFor(dataRowsOf(current.doc));
  const candidates = selectDocuments(current.doc, codes, parsed);

  // Which of those documents does DA actually hold?
  const cache = new Map();
  const dirs = [...new Set(candidates.map((c) => dirOf(c.docPath)))];
  const unreadable = [];
  await pool(dirs, http.lanes, async (dir) => {
    const set = await daDirectory(token, dir, cache, http.opts);
    if (set === null) unreadable.push(dir);
    return dir;
  });
  const present = candidates.filter((c) => cache.get(dirOf(c.docPath))?.has(c.docPath));

  let todo = present;
  let already = 0;
  /*
   * Skipped entirely under --publish. "Already previewed" says nothing about .live, and
   * the version of this that checked anyway left nine already-previewed documents
   * unpublished while publishing seventy-two others.
   */
  if (!opts.force && !opts.publish) {
    const checked = await pool(present, http.lanes, async (item) => ({
      ...item, previewed: await isPreviewed(item.localePath, http.branch, http.opts),
    }));
    todo = checked.filter((c) => !c.previewed);
    already = checked.length - todo.length;
  }

  const plan = {
    name,
    sheetCfg,
    considered: candidates.length,
    present: present.length,
    already,
    todo,
    unreadable,
    results: null,
  };
  if (!opts.apply || !todo.length) return plan;

  const capped = opts.limit ? todo.slice(0, opts.limit) : todo;
  plan.results = await pool(capped, http.lanes, async (item) => {
    const pv = await adminVerb(previewApiUrl(item.localePath, http.branch), token, http.opts);
    let live = null;
    if (pv.ok && opts.publish) {
      live = await adminVerb(publishApiUrl(item.localePath, http.branch), token, http.opts);
    }
    return { ...item, preview: pv, live };
  });
  plan.capped = capped.length;
  return plan;
}

function printGroup(plan, opts) {
  console.log(`\n── ${plan.name} ──`);
  if (plan.error) {
    console.log(`   ✗ ${plan.error}`);
    return 0;
  }
  console.log(`   sheet:      ${plan.sheetCfg.path} · ${groupSheetLink(plan.sheetCfg)}`);
  console.log(`   considered: ${plan.considered} (page, locale) document path(s)`);
  console.log(`   in DA:      ${plan.present}`);
  for (const dir of plan.unreadable) {
    console.log(`   ! could NOT list ${dir} — every document under it is reported as absent, which is`);
    console.log('     wrong rather than empty. Fix the credential before trusting this run.');
  }
  if (!plan.present) {
    console.log('   Nothing to preview: DA holds no translated document for these (page, locale) pairs.');
    console.log('   That is the expected answer until a translation project has been run in DA.');
    return 0;
  }
  if (plan.already) console.log(`   already previewed: ${plan.already} (skipped; --force re-previews)`);

  console.log(`   would ${opts.publish ? 'preview AND publish' : 'preview'}: ${plan.todo.length}`);
  for (const t of plan.todo.slice(0, SAMPLE)) console.log(`     → ${t.localePath}  [${t.code}]`);
  if (plan.todo.length > SAMPLE) console.log(`     → … ${plan.todo.length - SAMPLE} more`);

  if (!plan.results) return 0;
  let failed = 0;
  for (const r of plan.results) {
    let mark = 'FAIL';
    if (r.preview.ok) mark = opts.publish && r.live?.ok ? 'ok+live' : 'ok';
    if (r.preview.ok && opts.publish && !r.live?.ok) mark = 'preview-only';
    const why = r.preview.ok ? '' : ` (${r.preview.status} ${r.preview.detail || ''})`;
    const liveWhy = r.live && !r.live.ok ? ` (live ${r.live.status} ${r.live.detail || ''})` : '';
    console.log(`     ${mark.padEnd(13)} ${r.localePath}${why}${liveWhy}`);
    if (!r.preview.ok || (opts.publish && !r.live?.ok)) failed += 1;
  }
  const ok = plan.results.filter((r) => r.preview.ok).length;
  console.log(`   previewed ${ok}/${plan.results.length}`
    + `${plan.capped < plan.todo.length ? ` (--limit=${plan.capped} of ${plan.todo.length})` : ''}`);
  if (opts.publish) {
    console.log(`   published ${plan.results.filter((r) => r.live?.ok).length}/${ok}`);
  }
  return failed;
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const branch = opts.branch || cfg.publish?.branch;
  const tx = { ...DEFAULTS, ...(cfg.tx || {}) };
  const codes = opts.locales.length ? [...new Set(opts.locales)] : [...TARGET_LOCALES];
  const names = opts.group ? [opts.group] : groupNames(cfg);
  for (const n of names) groupConfig(cfg, n); // fail on a typo before any I/O

  const token = resolveToken();
  if (!token) {
    console.error(`ERROR: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }

  const limiter = createLimiter({ perSecond: tx.requestsPerSecond });
  const http = {
    lanes: tx.concurrency,
    branch,
    opts: { limiter, attempts: 3, timeoutMs: cfg.qa?.fetchTimeoutMs ?? 30000 },
  };
  const parsedWhereFor = (rows) => {
    if (!opts.where) return null;
    const parsed = parseWhere(opts.where, { rows });
    if (parsed.errors.length) throw new Error(`--where= refused: ${parsed.errors.join('; ')}`);
    return parsed;
  };

  let mode = 'DRY RUN (default)';
  if (opts.apply) mode = opts.publish ? 'APPLY + PUBLISH' : 'APPLY (preview only)';
  console.log(`── tx:preview · ${mode} · branch ${branch} · ${codes.length} locale(s) ──`);
  console.log(`   limits: ${tx.requestsPerSecond} req/s · ${tx.concurrency} lane(s), retried only on 429/5xx`);
  if (opts.publish && !opts.apply) {
    console.log('   --publish is set but --apply is not: this is still a dry run. Publishing needs BOTH,');
    console.log('   because it puts a machine-translated page in front of the public.');
  }

  let configError = false;
  let transportError = false;
  let failed = 0;
  for (const name of names) {
    try {
      const plan = await runGroup({
        name, cfg, codes, opts, token, http, parsedWhereFor,
      });
      failed += printGroup(plan, opts);
      if (plan.config) configError = true;
    } catch (e) {
      console.error(`\n── ${name} ──\n   ✗ ${e.message}`);
      transportError = true;
    }
  }

  if (!opts.apply) {
    console.log('\n   Nothing was previewed. Re-run with --apply'
      + `${opts.publish ? ' --publish' : ''} to act.`);
  } else {
    console.log('\n   This tool wrote NOTHING to the sheet — it changes the world, tx:scan observes it.');
    console.log(`   Next: npm run tx:scan -- ${opts.group ? `--group=${opts.group} ` : ''}--apply`);
    if (!opts.publish) {
      console.log('   NOT published to the live host. Publishing a machine translation is a content');
      console.log('   decision and needs --publish as well as --apply.');
    }
  }

  if (configError) return 3;
  if (transportError) return 2;
  return failed ? 1 : 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ tx:preview: ${e.message}`);
      exit(/^unknown arg|must be a whole number|is not a target locale|unknown group|--where=/.test(e.message) ? 3 : 2);
    });
}
