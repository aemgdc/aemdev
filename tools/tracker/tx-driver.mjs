#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * tx-driver.mjs — the per-(page, locale) BATCH LOOP. Runs the tiers over a group's
 * pairs, maintains the ledger and the escalation queue, writes each pair's
 * `translation-status` and refreshes each pair's review document.
 *
 * CLI SURFACE
 *   node tools/tracker/tx-driver.mjs --group=<name> --locale=<code> […]
 *        [--where=<selector>] [--limit=N] [--no-judge] [--visual]
 *        [--force] [--force-lock] [--tier=<name>] [--branch=<ref>]
 *        [--validate-only|--apply] [--dry-run] [--no-docs] [--help]
 *
 *   npm run tx:batch    -- --group=meetups --locale=de              plan only (DEFAULT)
 *   npm run tx:batch    -- --group=meetups --locale=de --apply
 *   npm run tx:validate -- --group=meetups --locale=de --limit=5    shared state untouched
 *
 * ─── The work queue is the TREE, not the sheet ──────────────────────────────
 *
 * The sheet lists every page that SHOULD eventually be translated. Only the ones that
 * actually exist can be QA'd, and running the tiers over the rest is not merely wasted:
 * it writes a failure status and a review doc for each, which is a defect record for a
 * page nobody has claimed to have translated yet.
 *
 * Measured upstream, because the first version did exactly this: a single German run
 * created 164 review docs for 13 translated pages, and would have written ~1,367 bogus
 * escalations across nine locales.
 *
 * Here presence is `previewed` on the locale row — CRAWL OUTPUT, re-observed by
 * `tx:scan` on every run and never preserved (data-contract §1). So the gate is
 * `classifyTranslation()`'s own `previewed` stage and later, and a pair the crawl has
 * not seen is counted as `notTranslated` and skipped. It is NOT an error: nothing is
 * translated on this site yet, so that is the honest and by far the commonest answer.
 *
 * ─── THE REGRESSION GUARD ───────────────────────────────────────────────────
 *
 * Before writing a status, compare with `translationOrder()` from stages.js — NOT with
 * `classifyTranslation()`.
 *
 * `classifyTranslation` folds in `review-status`, and it is right to: a human verdict
 * outranks a pipeline one on the board. That makes it useless for asking "would writing
 * this move the pair forwards or backwards?", because whenever a review-status is set it
 * compares two identical answers and EVERY write looks safe. Upstream that is exactly how
 * a reconcile silently moved 33 rows backwards: all 33 carried `ready-for-review`, so the
 * guard built on classify() could not fire.
 *
 * `translationOrder()` reads the `translation-status` column ALONE. A backwards write is
 * refused, named, and requires `--force`.
 *
 * ─── One batched sheet write, one 412 retry ─────────────────────────────────
 *
 * Every row is in hand by the end of the run, so the sheet is read once at the start and
 * written once at the end. Writing per page would eat a full read-modify-write of the
 * whole multi-sheet doc each time — N chances to lose a race instead of one. Upstream,
 * running nine locales back to back, 7 of 9 sheet writes 412'd: the previous locale's
 * preview was still settling inside the read-to-write window. The fix for a batch is one
 * write per run, not more retries, so this retries ONCE and then says so.
 *
 * EXIT CODES (data-contract.md §5)
 *   0 every pair passed (or there was nothing to do) · 1 at least one real defect ·
 *   2 at least one pair could not reach a verdict · 3 a gate refused; nothing ran
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { hostname } from 'node:os';
import {
  locale as localeFor, normalizePath, pathForLocale, isTargetLocale, TARGET_LOCALES,
} from '../../scripts/tracker/locales.js';
import { previewUrl, slugOf } from '../../scripts/tracker/paths.js';
import {
  classifyTranslation, translationOrder, translationStage, countsAsPage, indexLocaleRows,
  localeRowFor, STAGE_INDEX, TRANSLATION_STATUSES,
} from '../../scripts/tracker/stages.js';
import { TIER_SECTIONS } from '../../scripts/tracker/tx-doc.js';
import { loadConfig, groupConfig, REPO_ROOT } from './config.mjs';
import { resolveToken, TOKEN_HINT, writeStatusDoc } from './lib/status-sheet.mjs';
import {
  readGroupDoc, groupSheetLink, parseWhere, matchWhere, localeRowsOf, dataRowsOf,
  syncLocaleRow, withLocaleRows,
} from './lib/group-sheet.mjs';
import { withWriterLock } from './lib/writer-lock.mjs';
import { probe, LlmUnavailable } from './lib/llm.mjs';
import { loadDntContract } from './lib/dnt.mjs';
import { pagetypeOf } from './lib/group-map.mjs';
import { txQa, daProbe } from './tx-qa.mjs';
import { judgeTranslation, loadGlossary, resolveBrief } from './tx-judge.mjs';
import { txVisual } from './tx-visual.mjs';
import { ensureTxDoc, writeTxFindings, docLinksFor } from './lib/tx-doc-io.mjs';

const HELP = `tx-driver — run the translation QA tiers over a group's (page, locale) pairs.

  --group=<name>     required
  --locale=<code>    repeatable. Default: all ten target locales.
  --where=<sel>      narrow the batch. stage:<id> | queue:<id> | blocked | sendable |
                     col=val | col!=val   (default: whatever tx:scan has seen previewed)
  --limit=N          at most N pairs per locale
  --tier=<name>      llm tier for the judge (default: judge)
  --branch=<ref>     judge against this ref's preview host (default: the group's)
  --no-judge         tier 1 only. Do NOT report that as a full run.
  --no-brief         judge without a requirements brief. Meaning and terminology only —
                     the judge is not told what the page is REQUIRED to say, and every
                     report records \`brief: null\` so the verdict is labelled as such.
  --visual           add tier 3 (a browser, minutes per page)
  --force            re-judge pairs already passed, and allow a BACKWARDS status write
  --force-lock       take the writer lease even if one is held
  --dry-run          print the plan; write nothing. THE DEFAULT.
  --validate-only    run the tiers, write reports locally, touch no shared state. This is
                     what a --dry-run reports itself as on a host declared role=validator.
  --apply            write the ledger, the queue, the sheet and the review docs
  --no-docs          skip the review-doc writes (sheet and ledger only)
  --help             this text

exit 0 all pass · 1 a defect · 2 a pair held · 3 a gate refused, nothing ran`;

/**
 * A tier verdict → the sheet's `translation-status` enum.
 *
 * Decided from the ERRORS first, and only from warnings when there are none. Upstream
 * this scanned both together and picked the first match in a fixed order, so a page whose
 * ERROR was an unlocalized link and whose warnings were harmless key changes was labelled
 * a DNT problem — and routed to re-translation, which fixes nothing. The status has to
 * name the most serious thing wrong with the page, not the first thing in the list.
 *
 * Note what this deliberately does NOT invent: a `dnt-violation` status. The enum in
 * stages.js has none, and adding one here would put a value in the sheet that
 * `classifyTranslation` reads as unknown and quietly stops counting. DNT damage is an
 * `auto-qa-fail`, and the ROUTING lives on the escalation record's `scope` field, which is
 * where "who fixes this" belongs.
 */
export function toTranslationStatus(verdict, report) {
  if (verdict === 'error') return 'auto-qa-fail';
  if (verdict !== 'fail' && verdict !== 'escalate') return null;
  const tier = report?.tiers?.structural || {};
  const decide = (findings) => {
    if (findings.some((f) => f.check === 'not-translated')) return null;
    if (findings.some((f) => f.check === 'unlocalized-path')) return 'unlocalized-links';
    if (findings.some((f) => f.check === 'untranslated-text' || f.check === 'untranslated-cell')) {
      return 'untranslated';
    }
    if (findings.some((f) => f.check === 'expansion' && f.severity === 'error')) return 'auto-qa-fail';
    if (findings.some((f) => f.dntViolation || f.dntGap)) return 'auto-qa-fail';
    return null;
  };
  if (report?.tiers?.visual?.verdict === 'fail') return 'visual-qa-fail';
  return decide(tier.errors || [])
    ?? decide(tier.warnings || [])
    ?? (verdict === 'escalate' ? 'auto-qa-escalate' : 'auto-qa-fail');
}

/** The furthest tier a PASSING pair reached. */
export function stageStatus({ judged, visual }) {
  if (visual) return 'visual-qa-ok';
  if (judged) return 'auto-qa-ok';
  // Tier 1 alone does not clear a page. `preview-ok` is what the crawl already knows, so
  // a tier-1-only pass records exactly what it proved and no more.
  return 'preview-ok';
}

/**
 * Which class of problem this is, and therefore WHO fixes it.
 *
 * On the escalation record rather than in the status, because four of these look identical
 * in a screenshot and three of them are not a translator's problem at all. Routing a DNT
 * gap to a native-speaker reviewer wastes the review.
 */
export function scopeOf(report) {
  const tier = report?.tiers?.structural || {};
  const all = [...tier.errors || [], ...tier.warnings || []];
  if (all.some((f) => f.dntGap)) return 'template';
  if (all.some((f) => f.check === 'unlocalized-path')) return 'template';
  if (all.some((f) => f.dntViolation)) return 'content';
  return 'page';
}

/* ------------------------------------------------------------------ the ledger */

const loadLedger = (p) => (existsSync(p)
  ? JSON.parse(readFileSync(p, 'utf8'))
  : { version: 1, updated: null, runs: [], pages: {} });

/**
 * The ledger key. A NUL separator, matching `indexLocaleRows()` in stages.js.
 *
 * A separator that can occur inside a key is a silent collision, and both halves here are
 * paths and locale codes that a human types.
 */
export const ledgerKey = (pagePath, code) => `${normalizePath(pagePath)}\0${code}`;

/* ------------------------------------------------------------------ the CLI */

function parseArgs(args) {
  const o = {
    group: null,
    locales: [],
    where: null,
    limit: Infinity,
    tier: 'judge',
    branch: null,
    judge: true,
    brief: true,
    visual: false,
    force: false,
    forceLock: false,
    mode: 'dry-run',
    docs: true,
    help: false,
  };
  for (const a of args) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--dry-run') o.mode = 'dry-run';
    else if (a === '--apply') o.mode = 'apply';
    else if (a === '--validate-only') o.mode = 'validate';
    else if (a === '--no-judge') o.judge = false;
    else if (a === '--no-brief') o.brief = false;
    else if (a === '--visual') o.visual = true;
    else if (a === '--force') o.force = true;
    else if (a === '--force-lock') o.forceLock = true;
    else if (a === '--no-docs') o.docs = false;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--locale=')) o.locales.push(a.slice(9).trim().toLowerCase());
    else if (a.startsWith('--where=')) o.where = a.slice(8);
    else if (a.startsWith('--limit=')) o.limit = Number(a.slice(8));
    else if (a.startsWith('--tier=')) o.tier = a.slice(7);
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  if (!o.group) throw new Error('--group=<name> is required');
  if (!Number.isFinite(o.limit) && o.limit !== Infinity) throw new Error('--limit= must be a number');
  for (const c of o.locales) {
    if (!isTargetLocale(c)) {
      throw new Error(`--locale="${c}" is not a target locale`
        + `${c === 'en' ? ' — en is the source; there is nothing to translate it into' : ''}`);
    }
  }
  if (!o.locales.length) o.locales = [...TARGET_LOCALES];
  return o;
}

const val = (row, key) => String(row?.[key] ?? '').trim();

/**
 * THE GATES. Each returns a distinct refusal message, or null.
 *
 * Every one of these is a thing that, left unchecked, produces a run that LOOKS like it
 * worked. A judge with no glossary reports a terminology pass it never performed; a brief
 * with a `?` row judges against a contract nobody finished; an unparseable DNT rule is
 * being enforced as written and nobody knows how. Refusing is the point.
 */
export function gateFailures({
  cfg, sheetCfg, current, contract, glossaries, brief, tierHealth, batchSize, opts,
}) {
  const out = [];
  if (!current.exists) {
    out.push(`${sheetCfg.path} does not exist — run \`npm run group:scaffold -- --group=${opts.group}\``);
  }
  if (contract.errors.length) {
    out.push(`${contract.errors.length} custom-doc-rules row(s) do not parse, so those blocks are `
      + 'being enforced as fully protected and nobody chose that. Fix '
      + `${contract.source} first:\n${contract.errors.map((e) => `      row ${e.row} (${e.block}): ${e.detail}`).join('\n')}`);
  }
  for (const [code, g] of Object.entries(glossaries)) {
    if (!g.text) {
      out.push(`no glossary for ${code} — looked for ${g.missing.join(', ')}. Terminology is `
        + 'where machine translation actually fails, so a run without one would report a '
        + 'terminology pass it never performed.');
    }
  }
  /*
   * The brief gates are skipped wholesale by --no-brief, deliberately and only there. A
   * blocked brief must not become "well, judge without it" by accident: an unresolved row
   * is a question somebody owes an answer to, and the way to proceed anyway is to say so
   * on the command line, once, where it appears in the shell history.
   */
  if (opts.brief && brief.exists && brief.readiness?.state === 'blocked') {
    out.push(`${opts.group}'s requirements brief has ${brief.readiness.unresolved.length} `
      + `unresolved "?" row(s), so the judge has no contract for them:\n${
        brief.readiness.unresolved.map((r) => `      ? ${r.ref}: ${r.requirement}`).join('\n')}`
      + `\n    ${brief.path}`);
  }
  if (opts.brief && !brief.exists) {
    out.push(`no requirements brief for ${opts.group} at ${brief.path}. The judge would be `
      + 'asked whether the translation says what the English said with no statement of what the '
      + 'English is required to say. Author one, or accept a meaning-and-terminology-only '
      + 'verdict by re-running with --no-brief.');
  }
  if (opts.judge && !tierHealth.ok) {
    out.push(`the ${opts.tier} tier is unreachable (${tierHealth.detail}). Start it, or run `
      + '--no-judge for tier 1 only — but do not call that a full run.');
  }
  if (!batchSize) {
    out.push('the batch is empty. Nothing matched the selector, so there is nothing to judge — '
      + 'and a run that judges nothing must not report a clean sweep.');
  }
  if (opts.visual && !cfg.llm.vision) out.push('--visual needs an llm.vision tier in .tracker/orchestrator.json');
  /*
   * A `visual-qa-ok` that no browser produced is the worst value this tool can write, so
   * the gate is here rather than left to the tier reporting `unreachable` per page: by
   * then the run has already spent the judge on every pair.
   */
  if (opts.visual && !existsSync(join(REPO_ROOT, 'node_modules', 'playwright'))) {
    out.push('--visual needs playwright, and node_modules/playwright is not present. '
      + 'Without a browser the visual tier cannot look, and a run must not record '
      + '`visual-qa-ok` for a page nothing looked at.');
  }
  return out;
}

/**
 * The pairs this run will work, and why each one was left out.
 *
 * Pure, so the selection can be checked against real row shapes without touching DA.
 */
export function selectPairs({
  dataRows, localeIndex, code, parsed, ledger, force,
}) {
  const pending = [];
  const counts = { notTranslated: 0, skipped: 0, unselected: 0, blocked: 0 };
  for (const row of dataRows.filter((r) => countsAsPage(r))) {
    const path = normalizePath(val(row, 'page-path'));
    const localeRow = localeRowFor(localeIndex, path, code);
    const cls = classifyTranslation(row, localeRow);
    /*
     * NOT ON THE PREVIEW HOST = not translated = not this tool's problem. Counted
     * separately from `skipped` so the summary can distinguish "already passed" from
     * "does not exist yet", which are different facts and only one of them is work.
     */
    if (cls.blocked) counts.blocked += 1;
    if (!cls.blocked && (cls.order < STAGE_INDEX.previewed)) {
      counts.notTranslated += 1;
    } else if (!matchWhere(parsed, row, localeRow)) {
      counts.unselected += 1;
    } else if (!force && ledger.pages[ledgerKey(path, code)]?.verdict === 'pass') {
      counts.skipped += 1;
    } else {
      pending.push({ row, localeRow, path });
    }
  }
  return { pending, counts };
}

/**
 * THE REGRESSION GUARD.
 *
 * `translationOrder()` and never `classifyTranslation()` — see the file header for the 33
 * rows that taught this. Returns a refusal string, or null.
 *
 * A move to a BLOCKING status (order -1) is never a regression: recording that something
 * went wrong is the pipeline doing its job, and a blocker is how the pair reaches a queue.
 * A move backwards along the FORWARD funnel is the one this refuses.
 */
export function regression(fromStatus, toStatus) {
  const from = translationOrder(fromStatus);
  const to = translationOrder(toStatus);
  if (to < 0 || from < 0) return null;
  if (to >= from) return null;
  return `"${fromStatus}" (${translationStage(fromStatus)}) → "${toStatus}" `
    + `(${translationStage(toStatus)}) moves this pair BACKWARDS along the funnel. Refusing: `
    + 'the last run reached a further stage than this one, so either this run saw less than it '
    + 'should have, or the earlier status is stale and should be cleared deliberately. '
    + 'Re-run with --force to write it anyway.';
}

/** Tier findings, grouped into the review doc's own sections. */
export function docFindings(report) {
  const tier = report.tiers?.structural || {};
  const all = [...tier.errors || [], ...tier.warnings || [], ...tier.notes || []];
  const label = (f) => `[${f.check}] ${f.detail}`;
  const pick = (...checks) => all.filter((f) => checks.includes(f.check)).map(label);
  const [preview, translation, layout] = TIER_SECTIONS;
  return {
    [preview]: pick(
      'not-translated',
      'skeleton',
      'block-rows',
      'headings',
      'broken-anchor',
      'assets',
      'placeholder',
      'unlocalized-path',
    ),
    [translation]: [
      ...pick(
        'untranslated-text',
        'untranslated-cell',
        'wrong-language',
        'translated-key',
        'translated-value',
        'dnt-term',
        'dnt-identifier',
        'translated-code',
        'numbers',
        'dates',
        'typography',
        'markup-drift',
      ),
      ...(report.tiers?.judge?.issues || []).map((i) => `[${i.category}] ${i.detail}`
        + `${i.quote ? ` — "${i.quote}"` : ''}`
        + `${i.quoteVerified === false ? ' (quote unverified)' : ''}`),
    ],
    [layout]: [
      ...pick('expansion'),
      ...(report.tiers?.visual?.findings || []).map((f) => `[${f.check || 'layout'}] ${f.detail}`),
    ],
  };
}

/* ------------------------------------------------------------------ one pair */

async function runTiers(pair, ctx) {
  const {
    cfg, contract, code, branch, opts, glossary, brief, token,
  } = ctx;
  // `ctx.reportsDir` is read directly by the tier-3 branch below, so it is not destructured
  // here — one name, one place, rather than a copy that can drift from the context.
  const enPath = pathForLocale(pair.path, 'en') || pair.path;
  const targetPath = pathForLocale(pair.path, code);
  let report;
  try {
    report = await txQa({
      enUrl: previewUrl(enPath, branch),
      targetUrl: previewUrl(targetPath, branch),
      code,
      cfg,
      contract,
      pagePath: enPath,
      group: opts.group,
      template: pagetypeOf(enPath),
      branch,
      probe: daProbe(token).probe,
    });
    if (report.fatal) throw new Error(report.fatal);
  } catch (e) {
    /*
     * A tier that could not run is `error`, which is exit 2 and NOT a defect. The pair
     * holds its status and the batch continues — that separation is the whole reason a
     * batch can be interrupted and resumed without corrupting state.
     */
    return {
      verdict: 'error',
      report: {
        'page-path': enPath,
        locale: code,
        group: opts.group,
        urls: { source: previewUrl(enPath, branch), target: previewUrl(targetPath, branch) },
        branch,
        generated: new Date().toISOString(),
        tiers: {
          structural: {
            verdict: 'fail',
            fatal: e.message,
            errors: [{ severity: 'error', check: 'tool', detail: e.message }],
            warnings: [],
            notes: [],
            checks: {},
          },
          judge: null,
          visual: null,
        },
        verdict: 'error',
      },
    };
  }

  let { verdict } = report.tiers.structural;
  const nothingToJudge = report.tiers.structural.checks?.translated === false;

  // Tier 2 — only when tier 1 did not already fail. A judge's opinion on a page whose
  // blocks are broken is wasted minutes: the page is going back either way.
  if (!nothingToJudge && verdict !== 'fail' && opts.judge) {
    try {
      const result = await judgeTranslation(report, cfg, {
        tierName: opts.tier, glossary, brief: brief.section,
      });
      report.tiers.judge = result.judge;
      verdict = result.final;
    } catch (e) {
      if (!(e instanceof LlmUnavailable)) throw e;
      report.tiers.judge = { verdict: null, final: 'escalate', error: e.message };
      verdict = 'escalate';
    }
  }
  /*
   * Tier 3 — the same gate, plus opt-in. It launches a browser and loads two pages at
   * three widths, so it costs minutes per page and is not something to run on a page
   * already known to be going back.
   *
   * `--visual` MUST actually run this. Setting the flag and letting `stageStatus()` claim
   * `visual-qa-ok` without a browser having looked is the exact error data-contract §4
   * forbids: "we did not look" and "we looked and it was fine" must not be the same value.
   * A tier that could not run leaves `tiers.visual.verdict = 'escalate'` and holds the
   * pair rather than passing it.
   */
  if (!nothingToJudge && verdict !== 'fail' && opts.visual) {
    const enUrl = previewUrl(enPath, branch);
    const locUrl = previewUrl(targetPath, branch);
    const layout = await txVisual(enUrl, locUrl, code, cfg, {
      out: join(ctx.reportsDir, 'shots', `${code}--${slugOf(enPath)}`),
    });
    report.tiers.visual = layout;
    if (layout.verdict === 'fail') verdict = 'fail';
    else if (layout.verdict === 'escalate') verdict = 'escalate';
    else if (layout.verdict === 'review' && verdict === 'pass') verdict = 'review';
  }

  report.verdict = verdict;
  return { verdict, report };
}

/* ------------------------------------------------------------------ the run */

async function runLocale(code, ctx) {
  const {
    opts, sheetCfg, current, ledger, reportsDir, write,
  } = ctx;
  const loc = localeFor(code);
  const localeIndex = indexLocaleRows(current.doc);
  const dataRows = dataRowsOf(current.doc);
  const parsed = parseWhere(opts.where || '', { rows: dataRows });
  if (parsed.errors.length) throw new Error(`--where= refused: ${parsed.errors.join('; ')}`);

  const { pending, counts } = selectPairs({
    dataRows, localeIndex, code, parsed, ledger, force: opts.force,
  });
  const batch = pending.slice(0, opts.limit);
  const glossary = loadGlossary(code);

  console.log(`\n── ${loc.name} (${code}) — ${batch.length} pair(s) to judge`
    + `${counts.notTranslated ? `, ${counts.notTranslated} not translated yet` : ''}`
    + `${counts.skipped ? `, ${counts.skipped} already passed` : ''}`
    + `${counts.unselected ? `, ${counts.unselected} not selected` : ''}`
    + `${counts.blocked ? `, ${counts.blocked} blocked` : ''}`);

  const results = [];
  for (const [i, pair] of batch.entries()) {
    const enPath = pathForLocale(pair.path, 'en') || pair.path;
    console.log(`[${i + 1}/${batch.length}] ${pathForLocale(pair.path, code)}`);
    const { verdict, report } = await runTiers(pair, { ...ctx, code, glossary });

    /*
     * A pair tier 1 found NO DOCUMENT for gets no status at all.
     *
     * The crawl put it in the work queue (`previewed: yes` on the locale row) and the
     * tier then got a 404 from the preview host. Those two disagree, and writing
     * `preview-ok` would record the crawl's claim from the very evidence that contradicts
     * it. The pair holds, and the disagreement is REPORTED — a stale `previewed` column is
     * a `tx:scan` problem, not a translation defect, and it is invisible to everything
     * else because both surfaces are individually plausible.
     */
    const nothingToJudge = report.tiers.structural.checks?.translated === false;
    const status = nothingToJudge ? null : (toTranslationStatus(verdict, report)
      ?? (verdict === 'pass' || verdict === 'review'
        ? stageStatus({ judged: opts.judge, visual: opts.visual })
        : null));
    if (nothingToJudge) {
      console.log('  ⚠ the locale row says previewed=yes and the preview host answered 404. '
        + 'No status written — re-run `npm run tx:scan` to re-observe this pair.');
    }
    const was = val(pair.localeRow, 'translation-status');
    const refusal = status && !opts.force ? regression(was, status) : null;

    const tier = report.tiers.structural;
    console.log(`  → ${verdict.toUpperCase()}`
      + `${status ? ` (${status}${refusal ? ' REFUSED' : ''})` : ' (no status change)'}`
      + ` · ${tier.errors?.length || 0}E ${tier.warnings?.length || 0}W`
      + `${report.tiers.judge ? ` · judge ${report.tiers.judge.final} @${report.tiers.judge.confidence}` : ''}`);
    if (refusal) console.log(`  ⚠ ${refusal}`);

    const file = join(reportsDir, `${code}--${slugOf(enPath)}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(report, null, 2));

    results.push({
      pair, enPath, code, verdict, report, status: refusal ? null : status, refusal, file,
    });
  }

  /* ---- the plan. Per row, never a count. ---- */
  if (!write) {
    console.log(`\n  PLAN for ${sheetCfg.path} tab "${code}":`);
    for (const r of results) {
      const wasStatus = val(r.pair.localeRow, 'translation-status') || '(blank)';
      console.log(`    ${r.enPath}`);
      console.log(`      translation-status  ${wasStatus} → ${r.status || `${wasStatus} (unchanged)`}`);
      console.log(`      review doc          ${docLinksFor(sheetCfg, r.enPath, code).path}`);
      console.log(`      report              ${relative(REPO_ROOT, r.file)}`);
    }
    if (!results.length) console.log('    (nothing)');
  }
  return { code, results, counts };
}

/**
 * Apply one locale's results to the in-memory sheet doc.
 *
 * Only `translation-status` is written, and only where this run reached a verdict.
 * `sent-at`, `review-status` and `review-updated` are TESTIMONY (data-contract §1) and are
 * never touched here; `previewed`/`online` belong to `tx:scan`. That narrowness is what
 * makes the 412 re-apply below safe: merging these values onto a newer copy of the sheet
 * cannot lose anyone's work.
 */
export function applyToSheet(doc, code, results) {
  const rows = localeRowsOf(doc, code);
  const byPath = new Map(rows.map((r) => [normalizePath(String(r['page-path'] ?? '').trim()), r]));
  const applied = [];
  for (const r of results.filter((x) => x.status)) {
    let row = byPath.get(normalizePath(r.enPath));
    if (!row) {
      // A pair the crawl found and the sheet has no row for. Adding it is correct — the
      // locale tab is per (page, locale) and a judged pair with no row is invisible.
      row = syncLocaleRow(null, { pagePath: r.enPath, code }).row;
      rows.push(row);
      byPath.set(normalizePath(r.enPath), row);
    }
    row['translation-status'] = r.status;
    applied.push({ path: r.enPath, status: r.status });
  }
  return { doc: withLocaleRows(doc, code, rows), applied };
}

async function writeSheet(sheetCfg, token, current, perLocale) {
  let { doc } = current;
  const applied = [];
  for (const { code, results } of perLocale) {
    const out = applyToSheet(doc, code, results);
    doc = out.doc;
    applied.push(...out.applied.map((a) => ({ ...a, code })));
  }
  if (!applied.length) {
    return {
      written: false, nothing: true, reason: 'no pair reached a status this run', applied,
    };
  }
  try {
    const res = await writeStatusDoc(sheetCfg, token, doc, { version: current.version });
    return { written: true, applied, preview: res };
  } catch (e) {
    if (!e.conflict) return { written: false, reason: e.message, applied };
    /*
     * Re-read and re-apply ONCE. The sheet is read at the start of a run and written at
     * the end, and the tiers take minutes in between — during which another locale's
     * write previews the document and can bump the ETag inside this run's window.
     * Observed upstream: 7 of 9 sheet writes 412'd while every page verdict was fine, and
     * it did not reproduce on the next run. That is what a settling-preview race looks
     * like. One retry, not a loop: a second 412 means something really is writing
     * concurrently, and then the right answer is to say so rather than fight it.
     */
    const fresh = await readGroupDoc(sheetCfg, token);
    let next = fresh.doc;
    for (const { code, results } of perLocale) next = applyToSheet(next, code, results).doc;
    try {
      const res = await writeStatusDoc(sheetCfg, token, next, { version: fresh.version });
      return {
        written: true, retried: true, applied, preview: res,
      };
    } catch (e2) {
      return { written: false, retried: true, reason: e2.message, applied };
    }
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
  const branch = opts.branch || sheetCfg.branch;
  const write = opts.mode === 'apply';
  /*
   * A `role: validator` host's default run is a validation, not a plan for an apply.
   * The role is declared in .tracker/hosts/<hostname>.json precisely so a slow machine
   * cannot become an accidental writer, and saying so in the mode line is the difference
   * between "here is what I would write" and "this machine is not the one that writes".
   */
  const validate = opts.mode === 'validate' || (!write && cfg.host?.role === 'validator');
  const host = cfg.host?.label || cfg.host?.profile || hostname();

  console.log(`tx:batch — ${opts.group} · ${opts.locales.join(' ')} · branch ${branch} · ${host}`);
  console.log(write
    ? '  MODE apply — the ledger, the queue, the sheet and the review docs WILL be written.'
    : `  MODE ${validate ? 'validate-only' : opts.mode} — reports only; no ledger, queue, `
      + 'sheet or review-doc writes.');

  const token = resolveToken();
  if (!token) {
    console.error(`✗ tx:batch: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }

  const contract = loadDntContract();
  const current = await readGroupDoc(sheetCfg, token);
  const brief = opts.brief
    ? resolveBrief(opts.group)
    : {
      exists: false, path: null, section: null, readiness: null,
    };
  const glossaries = Object.fromEntries(opts.locales.map((c) => [c, loadGlossary(c)]));
  const tierHealth = opts.judge ? await probe(cfg.llm[opts.tier] || {}) : { ok: true, detail: 'not used' };

  /*
   * The batch size is needed for the empty-batch gate, so selection runs BEFORE the gates
   * and the gates run before anything is judged. A gate that fires after the first page
   * has been written to is not a gate.
   */
  const localeIndex = current.exists ? indexLocaleRows(current.doc) : new Map();
  const dataRows = current.exists ? dataRowsOf(current.doc) : [];
  const parsed = parseWhere(opts.where || '', { rows: dataRows });
  if (parsed.errors.length) {
    console.error(`✗ tx:batch: --where= refused: ${parsed.errors.join('; ')}`);
    return 3;
  }
  const ledgerPath = cfg.state.txLedger;
  const ledger = loadLedger(ledgerPath);
  const batchSize = opts.locales.reduce((n, code) => n + selectPairs({
    dataRows, localeIndex, code, parsed, ledger, force: opts.force,
  }).pending.length, 0);

  const failures = gateFailures({
    cfg, sheetCfg, current, contract, glossaries, brief, tierHealth, batchSize, opts,
  });
  if (failures.length) {
    console.error(`\n✗ tx:batch refuses to run — ${failures.length} gate(s) failed:`);
    for (const f of failures) console.error(`  · ${f}`);
    console.error(`\n  sheet: ${groupSheetLink(sheetCfg)}`);
    return 3;
  }

  const reportsDir = write ? cfg.state.txReportsDir : join(cfg.state.localReportsDir, 'tx');
  mkdirSync(reportsDir, { recursive: true });
  const ctx = {
    cfg, opts, sheetCfg, current, contract, ledger, brief, branch, token, reportsDir, write,
  };

  const started = new Date().toISOString();
  const perLocale = [];
  for (const code of opts.locales) perLocale.push(await runLocale(code, ctx));
  const all = perLocale.flatMap((p) => p.results);

  if (write && all.length) {
    /*
     * Everything shared is written inside ONE lease. `tx:scan` writes the same tabs and a
     * concurrent run of the two would each POST a whole multi-sheet doc — the exact
     * operation that loses the other's rows.
     */
    await withWriterLock(token, `tx:batch ${opts.group} ${opts.locales.join(',')}`, { force: opts.forceLock }, async () => {
      const sheet = await writeSheet(sheetCfg, token, current, perLocale);
      if (sheet.written) {
        console.log(`\nSheet: wrote translation-status for ${sheet.applied.length} row(s)`
          + `${sheet.retried ? ' (re-applied onto a newer copy after a 412)' : ''}`
          + `${sheet.preview?.previewed === false ? ` ⚠ preview: ${sheet.preview.previewError}` : ''}`);
      } else if (sheet.nothing) {
        // Not a failure. Every pair either held its status or had its write refused, which
        // is the correct outcome and must not be reported with a warning glyph — a tool
        // that cries wolf about its own correct behaviour gets its warnings ignored.
        console.log(`\nSheet: nothing to write — ${sheet.reason}.`);
      } else {
        console.log(`\n⚠ sheet not updated: ${sheet.reason}. The ledger and the review docs `
          + 'are already correct; re-run to sync the sheet.');
      }

      for (const r of all) {
        if (opts.docs) {
          const ens = await ensureTxDoc(sheetCfg, {
            enPath: r.enPath,
            code: r.code,
            title: val(r.pair.row, 'title') || r.enPath,
            branch,
            translationStatus: r.status || '',
            sentAt: val(r.pair.localeRow, 'sent-at'),
            token,
          });
          const put = await writeTxFindings(sheetCfg, {
            enPath: r.enPath,
            code: r.code,
            findings: docFindings(r.report),
            log: `${r.verdict} · ${r.status || 'no status change'} · tier1 `
              + `${r.report.tiers.structural.verdict}`
              + `${r.report.tiers.judge ? ` · judge ${r.report.tiers.judge.final}` : ''}`,
            translationStatus: r.status,
            sentAt: val(r.pair.localeRow, 'sent-at'),
            branch,
            token,
          });
          console.log(`  doc ${ens.created ? 'created' : 'refreshed'} ${put.path || ens.path}`
            + `${put.written ? '' : ` ⚠ ${put.reason}`}`);
        }

        ledger.pages[ledgerKey(r.enPath, r.code)] = {
          'translation-status': r.status,
          verdict: r.verdict,
          tiers: {
            structural: r.report.tiers.structural?.verdict ?? null,
            judge: r.report.tiers.judge?.final ?? null,
            visual: r.report.tiers.visual?.verdict ?? null,
          },
          judged: new Date().toISOString(),
          attempts: (ledger.pages[ledgerKey(r.enPath, r.code)]?.attempts || 0) + 1,
          report: relative(REPO_ROOT, r.file),
          ...(r.refusal ? { refusedRegression: r.refusal } : {}),
        };

        if (['fail', 'escalate', 'error'].includes(r.verdict)) {
          const tier = r.report.tiers.structural;
          appendFileSync(cfg.state.txEscalations, `${JSON.stringify({
            'page-path': r.enPath,
            locale: r.code,
            group: opts.group,
            queue: TRANSLATION_STATUSES.find((s) => s.value === r.status)?.queue || 'escalations',
            scope: scopeOf(r.report),
            summary: String(tier.errors?.[0]?.detail
              || r.report.tiers.judge?.issues?.[0]?.detail
              || r.verdict).slice(0, 200),
            tier: r.report.tiers.judge ? 'judge' : 'structural',
            confidence: r.report.tiers.judge?.confidence ?? null,
            'first-seen': started,
            attempts: ledger.pages[ledgerKey(r.enPath, r.code)].attempts,
            doc: docLinksFor(sheetCfg, r.enPath, r.code).path,
            report: relative(REPO_ROOT, r.file),
          })}\n`);
        }
      }

      const counted = (v) => all.filter((r) => r.verdict === v).length;
      ledger.runs.push({
        started,
        finished: new Date().toISOString(),
        host: hostname(),
        branch,
        group: opts.group,
        locales: opts.locales,
        pass: counted('pass'),
        fail: counted('fail'),
        escalate: counted('escalate'),
        skipped: perLocale.reduce((n, p) => n + p.counts.skipped, 0),
      });
      ledger.updated = new Date().toISOString();
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
      console.log(`Ledger: ${relative(REPO_ROOT, ledgerPath)}`);
    });
  }

  /*
   * The attempt ceiling. `escalation.maxAttempts` was carried in config for two ports and
   * compared by nothing, which let a page be re-judged forever. It is compared here: a
   * pair at or over the ceiling is named so a human decides, instead of the loop quietly
   * continuing to pay for it.
   */
  const stuck = all.filter((r) => (ledger.pages[ledgerKey(r.enPath, r.code)]?.attempts || 0)
    >= cfg.escalation.maxAttempts && r.verdict !== 'pass');
  if (stuck.length) {
    console.log(`\n⚠ ${stuck.length} pair(s) have now failed ${cfg.escalation.maxAttempts}+ times. `
      + 'Re-running will not change them — the fix is upstream:');
    for (const r of stuck) console.log(`    ${r.code} ${r.enPath} (${scopeOf(r.report)})`);
  }

  const tot = (v) => all.filter((r) => r.verdict === v).length;
  const notTranslated = perLocale.reduce((n, p) => n + p.counts.notTranslated, 0);
  console.log(`\nSUMMARY — ${all.length} pair(s) judged: pass=${tot('pass')} review=${tot('review')} `
    + `fail=${tot('fail')} escalate=${tot('escalate')} error=${tot('error')}`
    + `${notTranslated ? ` · ${notTranslated} pair(s) are not translated yet and were not judged` : ''}`);
  console.log(validate || !write
    ? `Reports: ${relative(REPO_ROOT, reportsDir)}/ (shared state untouched)`
    : `Reports: ${relative(REPO_ROOT, reportsDir)}/`);
  if (!write && all.length && !validate) {
    console.log('Re-run with --apply to write the sheet, the ledger and the review docs.');
  }

  if (tot('fail')) return 1;
  if (tot('escalate') + tot('error') + tot('review')) return 2;
  return 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ tx:batch: ${e.message}`);
      exit(/^unknown arg|is required|is not a target locale|--where=|--limit=|unknown group|no DNT contract/.test(e.message) ? 3 : 2);
    });
}
