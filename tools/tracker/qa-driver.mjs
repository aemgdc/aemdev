#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * qa-driver.mjs — the English-side batch QA loop. Tier 1 then tier 2, over a group.
 *
 * CLI SURFACE
 *   node tools/tracker/qa-driver.mjs --group=<name> [options]
 *
 *   --group=<name>     required. Decides the sheet, the baseline and the brief.
 *   --pairs=<file>     the batch list (default: .tracker/urls/pairs-<group>.txt,
 *                      written by `npm run pairs`)
 *   --path=<p>         repeatable. Judge exactly these pages and ignore the pairs file.
 *   --limit=N          stop after N pages
 *   --force            re-judge pages the ledger already passed, AND clear the
 *                      attempt ceiling for pages that have hit it
 *   --no-judge         tier 1 only. NOT a judge run — do not report it as one.
 *   --tier=<name>      llm tier for tier 2 (default: judge)
 *   --branch=<ref>     preview host to read (default: publish.branch)
 *   --validate-only    write nothing shared. Default ON when the host profile says
 *                      role=validator.
 *   --write            force a writing run on a validator host (say it out loud)
 *   --dry-run          print the plan — every page, every write, every document edit
 *                      — and touch nothing
 *   --no-docs          skip the DA QA-document writes; reports and ledger only
 *   --help
 *
 *   npm run qa:batch    -- --group=meetups
 *   npm run qa:validate -- --group=meetups          (never writes shared state)
 *
 * ─── THE GATE ───────────────────────────────────────────────────────────────
 *
 * This driver never "just goes". Seven checks run before any page is fetched, each
 * with its own message and its own remedy, and any failure stops the run at exit 3
 * with nothing written. A gate that cannot fail is not a gate, and the point of
 * separate messages is that a refusal has to tell you what to DO:
 *
 *   G1  the group is registered in .tracker/orchestrator.json
 *   G2  a requirements brief exists for it
 *   G3  the brief has ZERO unresolved `?` rows          (data-contract.md §6)
 *   G4  a structural baseline exists for it
 *   G5  the batch list is non-empty
 *   G6  the judge tier answers a health probe            (unless --no-judge)
 *   G7  the batch list was generated against the branch this run reads
 *
 * G7 is the "host consistency" rule made checkable. `emit-pairs` stamps the branch
 * into the file's header, so judging a list built against another ref — which
 * produces confident nonsense, not an error — is detectable rather than a thing you
 * have to remember.
 *
 * ─── A GREEN RUN WITH ZERO WORK DONE IS A FAILURE ───────────────────────────
 *
 * If the loop judged no pages, this exits NON-ZERO and says which reason: everything
 * skipped as already-passed, everything over the attempt ceiling, or the list was
 * filtered to nothing. The source exited 0 in that case, which is how a broken cron
 * reported success for a day. Read the counts, not the exit code — and the counts are
 * printed whether the run succeeded or not.
 *
 * ─── THE ATTEMPT CEILING IS WIRED ───────────────────────────────────────────
 *
 * `escalation.maxAttempts` was incremented and never compared, in this pipeline's
 * config AND in the one it was ported from, so a page that kept failing was re-judged
 * for ever. It is compared HERE, on the skip rule: a page at or over the ceiling is
 * skipped with the reason printed, and only `--force` moves it. The alternative was
 * deleting the key; a ceiling is worth having, because the pages that loop are
 * exactly the ones a human needs to look at instead.
 *
 * ─── WHAT IT WRITES ─────────────────────────────────────────────────────────
 *
 *   .tracker/reports/qa/<slug>.json          the full evidence report per page
 *   .tracker/state/qa-ledger.json            run bookkeeping (NOT the status of record)
 *   .tracker/state/qa-escalations.jsonl      the queue a human works from
 *   DA /tracker/qa/<en-path>                 findings into the reviewer's document
 *
 * Deliberately NOT the group sheet. The `data` tab's band-3 columns are `en-status`
 * (observed) and `content-escalation` (a human's flag); an automated QA verdict is
 * neither, and adding a second writer to a whole-doc-write sheet to record something
 * the per-page document already holds would buy nothing and lose rows.
 *
 * EXIT CODES  0 every judged page passed · 1 at least one fail/escalate/error ·
 *             2 nothing was judged · 3 the gate refused
 */
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { dirname, relative } from 'node:path';
import { hostname } from 'node:os';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { normalizePath } from '../../scripts/tracker/locales.js';
import { previewUrl, slugOf, DEFAULT_BRANCH } from '../../scripts/tracker/paths.js';
import { isQueue } from '../../scripts/tracker/stages.js';
import { loadConfig, groupConfig, REPO_ROOT, hostProfileName } from './config.mjs';
import { probe, LlmUnavailable } from './lib/llm.mjs';
import {
  loadRequirements, localBriefPath, JUDGE_SECTION, EN_JUDGE_SECTION,
} from './lib/requirements.mjs';
import { structuralQa, loadBaseline, baselinePath } from './structural-qa.mjs';
import { judgeReport } from './judge.mjs';
import { ensureQaDoc, writeQaFindings, docPathFor } from './lib/qa-doc-io.mjs';
import { defaultOut } from './emit-pairs.mjs';

const HELP = `qa-driver — the English-side batch QA loop (tier 1 + tier 2).

  --group=<name>     required
  --pairs=<file>     batch list (default .tracker/urls/pairs-<group>.txt)
  --path=<p>         repeatable; judge exactly these pages
  --limit=N          stop after N pages
  --force            re-judge passed pages and clear the attempt ceiling
  --no-judge         tier 1 only (this is NOT a judge run)
  --tier=<name>      llm tier for tier 2 (default: judge)
  --branch=<ref>     preview host to read
  --validate-only    write nothing shared (default on a validator host)
  --write            force a writing run on a validator host
  --dry-run          print the plan and touch nothing
  --no-docs          skip the DA QA-document writes
  --help             this text

exit 0 all judged pages passed · 1 a fail/escalate/error · 2 nothing judged · 3 gate refused`;

/** The two machine-owned sections of an EN QA doc. Named in scripts/tracker/qa-doc.js. */
const STRUCTURAL_SECTION = 'Structural Check';
const FIDELITY_SECTION = 'Fidelity Findings';

/* --------------------------------------------------------------------- the gate */

/**
 * A refusal, with its own id and its own remedy.
 *
 * Every gate check throws a DIFFERENT one, because a refusal has to tell you what to
 * DO. "gate failed" is the message the source printed, and it made every one of these
 * six situations look like the same situation.
 */
class GateFailure extends Error {
  constructor({ id, message, remedy }) {
    super(message);
    this.id = id;
    this.remedy = remedy;
  }
}

/**
 * Where a page's problem probably lives, for the escalation queue's `scope`.
 *
 * Straight from the upstream tracker's triage table, because the triage that follows a batch
 * is only fast if the queue already sorts itself: a `template` scope means the same
 * thing showed up across pages and the fix is the brief or the baseline (then re-run
 * with `--force`, which is free); `page` means one document; `content` means the prose
 * itself. A heuristic, and labelled as one in the record — but a wrong first guess
 * that a human corrects beats no guess at all, which is what the source's queue had.
 */
function scopeOf(structural, judgeIssues) {
  const failed = new Set((structural.checks || [])
    .filter((c) => c.verdict === 'fail')
    .map((c) => c.check));
  if ([...failed].some((c) => c.startsWith('headings') || c.startsWith('metadata') || c === 'text')) {
    return 'template';
  }
  if (failed.size) return 'page';
  return judgeIssues.length ? 'content' : 'page';
}

/**
 * Parse a pairs file. Column 1 is the page; column 2 is its QA document, which this
 * driver derives for itself and therefore ignores.
 *
 * The header is read, not skipped. `# group=… locale=… branch=…` is what makes G7
 * possible, and a list that records where it came from is the whole reason the queue
 * is a file rather than a filter buried in this loop.
 */
export function readPairsFile(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const header = {};
  for (const l of lines.filter((x) => x.startsWith('#'))) {
    for (const m of l.matchAll(/\b(group|locale|branch|selector)=(\S+)/g)) {
      const [, key, value] = m;
      header[key] = value;
    }
  }
  const paths = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t')[0].trim())
    .filter(Boolean)
    .map((left) => {
      try {
        return normalizePath(new URL(left).pathname);
      } catch {
        return normalizePath(left);
      }
    })
    .filter(Boolean);
  return { header, paths };
}

/**
 * Run the gate. Throws the FIRST failure, so a run is told one thing to fix at a time
 * rather than a wall of problems whose order does not matter.
 */
export async function runGate({
  group, cfg, sheetCfg, branch, pairsFile, explicitPaths, judge, tierName,
}) {
  // G2 — a brief exists at all.
  const req = await loadRequirements(group, { branch });
  if (!req.exists) {
    throw new GateFailure({
      id: 'G2',
      message: `no requirements brief for the group "${group}"`,
      remedy: `Author one at DA ${req.path}, or locally at ${localBriefPath(group)}.\n`
        + '  The brief is the contract. Without it the judge discovers differences ad hoc,\n'
        + '  which is exactly what this process exists to prevent — and a model asked to\n'
        + '  check an unstated requirement invents one.',
    });
  }
  /*
   * G2a/G2b — the brief exists but has no contract in it. Two DISTINCT refusals,
   * because they need different fixes (author the section, versus fill it in) and the
   * upstream loader collapsed both into a `null` judge brief that read exactly like
   * "no brief exists". A judge running with `null` reports nothing wrong.
   */
  /*
   * The ENGLISH judge's readiness, not the translation judge's. `req.readiness`
   * describes the `QA Requirements` section, which is the translation contract; this
   * driver is the English side and its contract is `EN QA Requirements`. Gating on the
   * wrong one is how a batch runs against criteria written for a different question —
   * measured, and it fails good pages. See the note in lib/requirements.mjs.
   */
  const readiness = req.enReadiness;
  if (readiness.state === 'missing') {
    throw new GateFailure({
      id: 'G2a',
      message: `the "${group}" brief has no "## ${EN_JUDGE_SECTION}" section`,
      remedy: `  ${req.path} exists${req.judgeBrief ? ` and has a "## ${JUDGE_SECTION}" section` : ''},`
        + ' but that is the TRANSLATION contract — its rows compare a translated page\n'
        + '  against its English source ("byte-identical to English", "is translated", "DNT").\n'
        + `  The English side needs its own: add a "## ${EN_JUDGE_SECTION}" section stating what\n`
        + '  a page in this group must CONTAIN, with no comparison in it.\n'
        + '  This is a hard refusal rather than a fallback because the fallback was tried and\n'
        + '  measured: handed the translation contract, the 14B judge reported "the page lacks\n'
        + '  translated content" and "the LOCATION is missing" about a clean English page.',
    });
  }
  if (readiness.state === 'empty') {
    throw new GateFailure({
      id: 'G2b',
      message: `the "${group}" brief's "${EN_JUDGE_SECTION}" section has no requirement rows`,
      remedy: `  ${req.path} is still a scaffold. Fill in the table:\n`
        + '    | ID | Requirement | Status | Note |\n'
        + '  Status is one of ✓ (must survive verbatim) ~ (may change) ✗ (approved removal)\n'
        + '  ? (unresolved — blocks the batch).',
    });
  }

  // G3 — the unresolved-row gate. data-contract.md §6.
  if (readiness.state === 'blocked') {
    const rows = readiness.unresolved.map((r) => `    ${r.ref}  ${r.requirement.slice(0, 88)}`);
    throw new GateFailure({
      id: 'G3',
      message: `the "${group}" brief has ${readiness.unresolved.length} unresolved "?" row(s)`,
      remedy: `${rows.join('\n')}\n`
        + `  Resolve each to ✓ / ~ / ✗ in ${req.path}.\n`
        + '  A requirement nobody could state is not a requirement the model can check, so\n'
        + '  every one of these pages would escalate instead of being judged. Answering "?"\n'
        + '  is a decision, not paperwork.',
    });
  }
  if (readiness.unknown.length) {
    throw new GateFailure({
      id: 'G3a',
      message: `the "${group}" brief has ${readiness.unknown.length} row(s) whose status names no glyph`,
      remedy: `${readiness.warnings.map((w) => `    ${w}`).join('\n')}\n`
        + '  A mistyped glyph is indistinguishable from a missing requirement once the row\n'
        + '  is parsed, so it is refused rather than guessed at.',
    });
  }

  // G4 — the baseline.
  const baseline = loadBaseline(group);
  if (!Object.keys(baseline).length) {
    throw new GateFailure({
      id: 'G4',
      message: `no structural baseline for the group "${group}"`,
      remedy: 'Calibrate one on the group\'s blessed page:\n'
        + `    npm run qa:page -- --group=${group} --path=<blessed-page> --calibrate --apply\n`
        + `  It lands at ${baselinePath(group)}. Read its $tune note and tighten it until the\n`
        + '  blessed page passes cleanly — an uncalibrated baseline reports `skip` for every\n'
        + '  check that matters, and a run of skips is not a QA pass.',
    });
  }

  // G5 — the batch list.
  let paths = explicitPaths;
  let header = {};
  if (!paths.length) {
    if (!existsSync(pairsFile)) {
      throw new GateFailure({
        id: 'G5',
        message: `no batch list at ${relative(REPO_ROOT, pairsFile)}`,
        remedy: `Generate one:\n    npm run pairs -- --group=${group} --apply\n`
          + '  Its default selector IS the gate: stage:enPublished — the English page is\n'
          + '  published, so it is worth QA-ing and it may be translated from.',
      });
    }
    const parsed = readPairsFile(pairsFile);
    paths = parsed.paths;
    header = parsed.header;
    if (!paths.length) {
      throw new GateFailure({
        id: 'G5a',
        message: `the batch list ${relative(REPO_ROOT, pairsFile)} is empty`,
        remedy: 'An empty queue is an answer, but it is not a run. Check the selector that\n'
          + `  built it (${header.selector || 'unrecorded'}), or release pages with:\n`
          + `    npm run en-status -- --group=${group} --to=en-published --all --apply`,
      });
    }
    if (header.group && header.group !== group) {
      throw new GateFailure({
        id: 'G5b',
        message: `the batch list was generated for group "${header.group}", not "${group}"`,
        remedy: `  ${relative(REPO_ROOT, pairsFile)} names a different group in its header.\n`
          + "  Judging one group's pages against another's baseline and brief produces\n"
          + '  confident nonsense. Regenerate the list, or fix --group=.',
      });
    }
  }

  // G6 — the tier answers.
  if (judge) {
    const tier = cfg.llm[tierName];
    if (!tier) {
      throw new GateFailure({
        id: 'G6',
        message: `no llm tier named "${tierName}" in config`,
        remedy: `  Configured tiers: ${Object.keys(cfg.llm).join(', ')}.`,
      });
    }
    const p = await probe(tier);
    if (!p.ok) {
      throw new GateFailure({
        id: 'G6a',
        message: `the "${tierName}" tier does not answer (${p.detail})`,
        remedy: `  Start it: ${tier.endpoint} should serve ${tier.model}.\n`
          + '  The batch is judged by LOCAL models only. If a local service is down the\n'
          + '  answer is to start it — not to substitute a cloud model, and not to run\n'
          + '  --no-judge and report the result as a judge run.',
      });
    }
  }

  // G7 — branch consistency: the list must have been built against this ref.
  if (header.branch && header.branch !== branch) {
    throw new GateFailure({
      id: 'G7',
      message: `the batch list was built against branch "${header.branch}"; this run reads "${branch}"`,
      remedy: '  A page previewed on one ref and judged on another produces a confident\n'
        + '  verdict about content that is not there. Pass '
        + `--branch=${header.branch}, or regenerate the list.`,
    });
  }

  return {
    req, baseline, paths, header, sheetCfg,
  };
}

/* ------------------------------------------------------------------ the ledger */

const emptyLedger = () => ({
  version: 1, updated: null, runs: [], pages: {},
});

const loadLedger = (path) => (existsSync(path)
  ? JSON.parse(readFileSync(path, 'utf8'))
  : emptyLedger());

/* ------------------------------------------------------------------------- main */

function parseArgs(args) {
  const o = {
    group: null,
    pairs: null,
    paths: [],
    limit: Infinity,
    force: false,
    judge: true,
    tier: 'judge',
    branch: null,
    validateOnly: null,
    dryRun: false,
    docs: true,
    help: false,
  };
  for (const a of args) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--force') o.force = true;
    else if (a === '--no-judge') o.judge = false;
    else if (a === '--validate-only') o.validateOnly = true;
    else if (a === '--write') o.validateOnly = false;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-docs') o.docs = false;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--pairs=')) o.pairs = a.slice(8);
    // Normalized AT PARSE, like every sibling tool, not at the point of comparison:
    // `opts.paths` is read in four places and the one that forgets silently matches
    // nothing rather than erroring.
    else if (a.startsWith('--path=')) o.paths.push(normalizePath(a.slice(7)));
    else if (a.startsWith('--limit=')) o.limit = Number(a.slice(8));
    else if (a.startsWith('--tier=')) o.tier = a.slice(7);
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  if (!o.group) throw new Error('--group=<name> is required');
  if (!(o.limit > 0)) throw new Error(`--limit must be a positive number, got "${o.limit}"`);
  return o;
}

/** One page, both tiers. Returns the report and the verdict; never throws. */
async function judgeOnePage({
  path, cfg, baseline, brief, branch, group, opts,
}) {
  const targetUrl = previewUrl(path, branch);
  let structural;
  try {
    structural = await structuralQa({
      targetUrl, cfg, baseline, brief, skipLinks: false,
    });
  } catch (e) {
    return {
      verdict: 'error',
      report: {
        'page-path': path,
        group,
        branch,
        generated: new Date().toISOString(),
        urls: { target: targetUrl },
        tiers: { structural: { verdict: 'error', checks: [], errors: [{ check: 'tool', detail: e.message }], warnings: [], fatal: e.message }, judge: null, visual: null },
        evidence: {},
        verdict: 'error',
      },
    };
  }

  const report = {
    'page-path': path,
    group,
    mode: 'baseline',
    urls: structural.urls,
    branch,
    generated: new Date().toISOString(),
    baseline: {
      exists: true,
      path: baselinePath(group),
      calibratedFrom: baseline.calibratedFrom || null,
    },
    tiers: {
      structural: {
        verdict: structural.verdict,
        checks: structural.checks,
        errors: structural.errors,
        warnings: structural.warnings,
        fatal: null,
      },
      judge: null,
      visual: null,
    },
    evidence: structural.evidence,
    verdict: structural.verdict,
  };

  if (structural.verdict === 'unreachable') return { verdict: 'unreachable', report };
  /*
   * Tier 2 is skipped on a deterministic FAIL. Not to save time — to stop a model
   * being asked to adjudicate something already decided, whose answer cannot change
   * the verdict (merge ladder step 2) and whose reasoning would then appear in the
   * report next to a fail as if it had been considered.
   */
  if (structural.verdict === 'fail' || !opts.judge) {
    if (structural.verdict === 'review' && !opts.judge) {
      // No judge to settle a review, so it queues rather than passing by default.
      report.verdict = 'escalate';
      return { verdict: 'escalate', report, reason: 'tier 1 raised warnings and --no-judge left nobody to settle them' };
    }
    /*
     * A reason, even here. It is the escalation queue's `summary` AND the line
     * appended to the reviewer's QA document, and "AUTO QA: FAIL" with no reason is a
     * log entry that tells the next reader to go and open a JSON file.
     */
    const first = structural.errors[0] || structural.warnings[0];
    return {
      verdict: structural.verdict,
      report,
      reason: first ? `${first.check}: ${first.detail}` : undefined,
    };
  }

  try {
    const { judge, verdict, reason } = await judgeReport(report, cfg, { tierName: opts.tier });
    report.tiers.judge = judge;
    report.verdict = verdict;
    return { verdict, report, reason };
  } catch (e) {
    if (!(e instanceof LlmUnavailable)) {
      report.tiers.judge = { verdict: 'error', error: e.message };
      report.verdict = 'error';
      return { verdict: 'error', report, reason: e.message };
    }
    /*
     * The tier went away mid-batch. The page HOLDS: it escalates rather than passing
     * or failing, and the run continues. Exit 2 vs exit 1 existing separately is the
     * whole reason a batch can be interrupted and resumed without corrupting state.
     */
    report.tiers.judge = { verdict: 'escalate', error: e.message, unavailable: true };
    report.verdict = 'escalate';
    return { verdict: 'escalate', report, reason: `the judge tier could not answer: ${e.message}` };
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
  const branch = opts.branch || sheetCfg.branch || cfg.publish?.branch || DEFAULT_BRANCH;
  const pairsFile = opts.pairs || defaultOut(opts.group, null);
  /*
   * `relative()` from the repo root is unreadable for a path outside it (`../../../tmp/
   * …`), and a batch list handed in with --pairs= legitimately lives anywhere. Print
   * whichever form is shorter — the point of the line is that a reader can find the
   * file, not that every path is spelled the same way.
   */
  const showPath = (p) => {
    const rel = relative(REPO_ROOT, p);
    return rel.startsWith('..') ? p : rel;
  };

  /*
   * Shared-state writes are gated by the HOST's declared role, so a one-off check on
   * a second machine can never clobber a batch running on the designated writer. An
   * explicit --validate-only/--write always wins over the profile.
   */
  const validateOnly = opts.validateOnly ?? cfg.host?.role === 'validator';
  const hostLabel = cfg.host?.label || cfg.host?.profile || hostProfileName();
  const reportsDir = validateOnly ? cfg.state.localReportsDir : cfg.state.reportsDir;
  const shared = !validateOnly && !opts.dryRun;

  let gate;
  try {
    gate = await runGate({
      group: opts.group,
      cfg,
      sheetCfg,
      branch,
      pairsFile,
      explicitPaths: opts.paths.map((p) => normalizePath(p)),
      judge: opts.judge,
      tierName: opts.tier,
    });
  } catch (e) {
    if (!(e instanceof GateFailure)) throw e;
    console.error(`✗ GATE ${e.id} REFUSED THE RUN — nothing ran.\n`);
    console.error(`  ${e.message}\n`);
    console.error(e.remedy);
    return 3;
  }

  const brief = gate.req.enJudgeBrief;
  const maxAttempts = cfg.escalation?.maxAttempts ?? Infinity;
  const ledger = loadLedger(cfg.state.ledger);

  const modeLine = () => {
    if (opts.dryRun) return 'DRY RUN — nothing will be written';
    if (validateOnly) {
      return `validate-only (${hostLabel}) — reports to ${relative(REPO_ROOT, reportsDir)}/,`
        + ' no ledger, queue or docs';
    }
    return `WRITING RUN (${hostLabel})`
      + ' — ⚠ single writer: stop any batch on another machine first';
  };
  const tierLine = opts.judge
    ? ` + ${opts.tier} (${cfg.llm[opts.tier].model})`
    : ' ONLY (--no-judge: this is not a judge run)';

  console.log(`── qa:batch · ${opts.group} · ${branch} ──`);
  console.log(`   mode:      ${modeLine()}`);
  console.log(`   tiers:     structural${tierLine}`);
  const enCounts = gate.req.enReadiness.counts;
  console.log(`   brief:     ${gate.req.source} ${gate.req.path}`);
  console.log(`              "${EN_JUDGE_SECTION}" · ${gate.req.enReadiness.state}`
    + ` · ${enCounts.rows} row(s): ${enCounts.must} must, ${enCounts.may} may,`
    + ` ${enCounts.removed} removed, 0 unresolved`
    + `${gate.req.readiness.marker ? `   [REQUIREMENTS STATUS: ${gate.req.readiness.marker}]` : ''}`);
  if ((gate.req.readiness.marker || '').toUpperCase() !== 'READY') {
    /*
     * Printed, not gated on. The marker is a human's statement about their own
     * confidence in the brief; the ROWS are what a machine can check, and refusing a
     * fully-resolved brief because nobody has typed READY would block the calibration
     * loop the marker exists to describe.
     */
    console.log('              ⚠ the brief is not marked READY — treat these verdicts as provisional');
  }
  console.log(`   baseline:  ${relative(REPO_ROOT, baselinePath(opts.group))} (from ${gate.baseline.calibratedFrom || 'unrecorded'})`);
  console.log(`   list:      ${opts.paths.length
    ? `${opts.paths.length} --path= argument(s)`
    : showPath(pairsFile)} · ${gate.paths.length} page(s)`);
  console.log('   gate:      G1-G7 passed');
  console.log('');

  /*
   * THE SKIP RULE, and the attempt ceiling that finally has teeth.
   *
   * A validate-only run never skips: you named these pages precisely because you want
   * a fresh opinion on them, whatever the shared ledger already says.
   */
  const counts = {
    pass: 0, fail: 0, escalate: 0, unreachable: 0, error: 0, skipped: 0,
  };
  const skips = [];
  const pending = [];
  for (const path of gate.paths.slice(0, opts.limit === Infinity ? undefined : opts.limit)) {
    const prior = ledger.pages[path];
    const attempts = prior?.attempts || 0;
    if (!validateOnly && !opts.force && prior?.verdict === 'pass') {
      skips.push({ path, why: 'already passed (--force to re-judge)' });
    } else if (!opts.force && attempts >= maxAttempts && prior?.verdict !== 'pass') {
      skips.push({
        path,
        why: `${attempts} attempt(s), at the escalation.maxAttempts ceiling of ${maxAttempts}`
          + ` — last verdict ${prior?.verdict}. Fix it or --force.`,
      });
    } else {
      pending.push(path);
    }
  }
  counts.skipped = skips.length;
  for (const s of skips) console.log(`   skip  ${s.path} — ${s.why}`);
  if (skips.length) console.log('');

  if (opts.dryRun) {
    /*
     * The plan describes what a REAL run would do, not what this dry run does. Keyed
     * on `validateOnly` and not on `shared` (which is false BECAUSE this is a dry run):
     * a plan that omits the ledger and the document edits because it is a plan is a
     * plan that cannot tell you the right value is landing on the right row.
     */
    const wouldWriteShared = !validateOnly;
    console.log(`   PLAN — ${pending.length} page(s) would be judged, in this order:`);
    for (const [i, path] of pending.entries()) {
      const prior = ledger.pages[path];
      console.log(`   ${String(i + 1).padStart(3)}. ${path}`);
      console.log(`        read   ${previewUrl(path, branch)} + its .plain.html`);
      console.log(`        tier 1 structural vs ${relative(REPO_ROOT, baselinePath(opts.group))}`);
      console.log(`        tier 2 ${opts.judge ? `${opts.tier} (${cfg.llm[opts.tier].model}) unless tier 1 fails` : 'SKIPPED (--no-judge)'}`);
      console.log(`        write  ${relative(REPO_ROOT, `${reportsDir}/${slugOf(path)}.json`)}`);
      if (wouldWriteShared) {
        console.log(`        write  ledger ${relative(REPO_ROOT, cfg.state.ledger)} pages["${path}"]`
          + ` (was ${prior ? `${prior.verdict}, ${prior.attempts} attempt(s)` : 'absent'})`);
        console.log(`        write  DA ${docPathFor(sheetCfg, path)} — "${STRUCTURAL_SECTION}" and "${FIDELITY_SECTION}" replaced, one log line appended`);
      }
    }
    console.log('\n   Nothing was written. Re-run without --dry-run to execute.');
    return pending.length ? 0 : 2;
  }

  mkdirSync(reportsDir, { recursive: true });
  if (shared) mkdirSync(dirname(cfg.state.ledger), { recursive: true });

  const started = new Date().toISOString();
  for (const [i, path] of pending.entries()) {
    console.log(`[${i + 1}/${pending.length}] ${path}`);
    const { verdict, report, reason } = await judgeOnePage({
      path, cfg, baseline: gate.baseline, brief, branch, group: opts.group, opts,
    });

    const reportPath = `${reportsDir}/${slugOf(path)}.json`;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    counts[verdict] = (counts[verdict] || 0) + 1;

    const { structural } = report.tiers;
    const issues = report.tiers.judge?.issues || [];
    console.log(`   → ${verdict.toUpperCase()}`
      + `  (tier 1 ${structural.verdict}: ${structural.errors.length}E/${structural.warnings.length}W`
      + `${report.tiers.judge ? `, judge ${report.tiers.judge.verdict} @ ${report.tiers.judge.confidence}` : ''})`
      + `${reason ? ` — ${reason}` : ''}`);

    if (shared) {
      const prior = ledger.pages[path];
      ledger.pages[path] = {
        verdict,
        tiers: {
          structural: structural.verdict,
          judge: report.tiers.judge?.verdict ?? null,
          visual: null,
        },
        judged: new Date().toISOString(),
        // Reset on a pass: an attempt count is a record of unresolved trouble, and a
        // page that has been fixed must not inherit the ceiling it hit before.
        attempts: verdict === 'pass' ? 0 : (prior?.attempts || 0) + 1,
        report: relative(REPO_ROOT, reportPath),
      };

      if (['fail', 'escalate', 'error', 'unreachable'].includes(verdict)) {
        const queue = verdict === 'fail' ? 'auto-qa-issues' : 'escalations';
        // The queue id comes from scripts/tracker/stages.js QUEUES and is asserted
        // here: an escalation whose queue no filter matches is an escalation nobody
        // ever sees, which is how most of the source's groups became unfilterable.
        if (!isQueue(queue)) throw new Error(`"${queue}" is not a known work queue`);
        appendFileSync(cfg.state.escalations, `${JSON.stringify({
          ts: new Date().toISOString(),
          'page-path': path,
          group: opts.group,
          queue,
          scope: scopeOf(structural, issues),
          summary: reason || structural.errors[0]?.detail || `tier 1 ${structural.verdict}`,
          detail: [...structural.errors, ...structural.warnings]
            .map((e) => `${e.check}: ${e.detail}`)
            .concat(issues.map((x) => `judge/${x.severity}/${x.category}: ${x.detail}`))
            .slice(0, 10),
          tier: report.tiers.judge ? 'judge' : 'structural',
          confidence: report.tiers.judge?.confidence ?? null,
          'first-seen': prior?.judged || started,
          attempts: ledger.pages[path].attempts,
          doc: docPathFor(sheetCfg, path),
          report: relative(REPO_ROOT, reportPath),
        })}\n`);
      }

      if (opts.docs) {
        const ensured = await ensureQaDoc(sheetCfg, {
          enPath: path, title: report.evidence.title, branch,
        });
        if (ensured.created) console.log(`   qa doc created: ${ensured.path}`);
        const wrote = await writeQaFindings(sheetCfg, {
          enPath: path,
          findings: {
            [STRUCTURAL_SECTION]: [
              ...structural.errors.map((e) => `FAIL ${e.check}: ${e.detail}`),
              ...structural.warnings.map((e) => `warn ${e.check}: ${e.detail}`),
            ],
            [FIDELITY_SECTION]: issues.map((x) => `${x.severity} ${x.category}: ${x.detail}`),
          },
          log: `AUTO QA: ${verdict.toUpperCase()}${reason ? ` — ${reason}` : ''}`,
          branch,
        });
        console.log(wrote.written
          ? `   qa doc updated: ${wrote.path}${wrote.previewed === false ? ` ⚠ preview: ${wrote.previewError}` : ''}`
          : `   ⚠ qa doc not updated: ${wrote.reason}`);
      }
    }
  }

  if (shared) {
    ledger.updated = new Date().toISOString();
    ledger.runs.push({
      started,
      finished: ledger.updated,
      host: hostname(),
      branch,
      group: opts.group,
      judged: pending.length,
      ...counts,
    });
    writeFileSync(cfg.state.ledger, `${JSON.stringify(ledger, null, 2)}\n`);
  }

  const judged = pending.length;
  console.log(`\nSUMMARY: ${judged} judged of ${gate.paths.length} listed — `
    + `pass=${counts.pass} fail=${counts.fail} escalate=${counts.escalate} `
    + `unreachable=${counts.unreachable} error=${counts.error} skipped=${counts.skipped}`);
  console.log(`Reports: ${relative(REPO_ROOT, reportsDir)}/`
    + `${shared ? `\nLedger:  ${relative(REPO_ROOT, cfg.state.ledger)}` : '  (validate-only — shared state untouched)'}`);

  if (!judged) {
    /*
     * A GREEN RUN WITH ZERO WORK DONE IS A FAILURE. The source exited 0 here, which is
     * how a cron reports success while judging nothing at all for a day. Name the
     * reason: which of the two skip rules ate the list, or that the list was empty.
     */
    const ceiling = skips.filter((s) => s.why.includes('ceiling')).length;
    console.error('\n✗ NOTHING WAS JUDGED. This run decided nothing.');
    console.error(`  ${counts.skipped} page(s) skipped: ${counts.skipped - ceiling} already passed, `
      + `${ceiling} at the attempt ceiling.`);
    console.error(`  Use --force to re-judge, or work the escalation queue: ${
      relative(REPO_ROOT, cfg.state.escalations)}`);
    return 2;
  }
  if (counts.fail + counts.escalate + counts.error + counts.unreachable > 0) {
    if (shared) console.log(`Queue:   ${relative(REPO_ROOT, cfg.state.escalations)}`);
    const rate = ((counts.fail + counts.escalate) / judged) * 100;
    console.log(`Escalation rate: ${rate.toFixed(0)}% (the gate for going wide is under 10%)`);
    return 1;
  }
  return 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`ERROR: ${e.message}`);
      exit(3);
    });
}
