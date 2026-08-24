#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * judge.mjs — TIER 2. A LOCAL-model verdict on a tier-1 report.
 *
 * CLI SURFACE
 *   node tools/tracker/judge.mjs --report=<file> [--tier=judge] [--min-confidence=N]
 *        [--dry-run] [--quiet] [--help]
 *
 *   --report=<file>          a report written by `qa:page --out=` (or by `qa:batch`)
 *   --tier=<name>            which llm tier in config to ask (default: judge, the 14B)
 *   --min-confidence=<0..1>  override the confidence gate for this run
 *   --dry-run                print the prompt that WOULD be sent and exit; call
 *                            nothing, write nothing
 *   --quiet                  the verdict line only
 *   --help
 *
 *   npm run qa:judge -- --report=.tracker/reports/qa/en--meetups--x.json
 *
 * The judge answers the one question code cannot: is this page a faithful, complete
 * rendition of what the requirements brief says it must be? It sees the tier-1 report
 * plus the capped text samples tier 1 already committed to that report — never a
 * fresh fetch. Judging evidence other than the evidence on record is how a report and
 * a verdict come to disagree about the page they describe.
 *
 * ─── THE MERGE LADDER ───────────────────────────────────────────────────────
 *
 * The judge is a TRIAGE LAYER, NOT AN AUTHORITY. Five steps, in order, and each one
 * exists because the step below it would otherwise give the wrong answer:
 *
 *   1. UNRESOLVED BRIEF CLAMP. The brief carries a `?` row → escalate, whatever the
 *      model said. data-contract.md §6: a requirement nobody could state is not a
 *      requirement a model can check, so those pages go to a human rather than
 *      collecting a recorded PASS. (The driver's gate normally stops the batch before
 *      this fires; it is here for the single-page run that bypasses the driver.)
 *   2. A DETERMINISTIC FAIL STANDS. The judge cannot upgrade tier 1. A broken link is
 *      a broken link and no amount of model confidence makes it resolve.
 *   3. AN ERROR-SEVERITY ISSUE FAILS. A defect the model can point to concretely.
 *   4. UNSURE, OR NOT SURE ENOUGH → escalate. `verdict: 'escalate'` from the model,
 *      or a `pass` below the confidence gate. Escalating is cheap; a wrong pass is
 *      expensive and is believed for a day.
 *   5. Otherwise pass.
 *
 * ─── TWO DEFECTS FIXED IN THE PORT, NOT CARRIED ─────────────────────────────
 *
 * (a) CONFIDENCE WAS DECORATIVE. The source's schema declared `confidence` a number
 *     in 0..1, its own reports carried `95`, and llama.cpp's strict mode does not
 *     enforce numeric RANGES — only types — so nothing caught it. Its header comment
 *     promised a "low confidence → escalate" rule that no line of code implemented.
 *     Here `normalizeConfidence` rescales a percentage and clamps, AND step 4 of the
 *     ladder is the gate the comment promised. `cfg.qa.minConfidence` sets it, in
 *     .tracker/orchestrator.json alongside the other verdict-affecting thresholds —
 *     never in a host profile, because a verdict that depends on which machine ran it
 *     is worthless.
 *
 * (b) THE APPROVED-ISSUE SUPPRESSION LISTS ARE GONE. The source shipped eleven
 *     hardcoded regexes per template, suppressing issues its brief already approved
 *     because the local model kept flagging them anyway. They are not ported: they
 *     encode one site's content, they are invisible to whoever authored the brief,
 *     and a suppression nobody can see is a verdict nobody can audit. The brief is
 *     the only suppression mechanism here. If the model keeps flagging an approved
 *     item, the brief row is too vague — which is a finding about the brief, and
 *     tightening it fixes every group at once.
 *
 * EXIT CODES  0 pass · 1 fail · 2 escalate, or the tier could not answer
 *             (LlmUnavailable) · 3 usage/config error
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { llmJson, LlmUnavailable } from './lib/llm.mjs';
import {
  loadRequirements, filterBrief, JUDGE_SECTION, EN_JUDGE_SECTION,
} from './lib/requirements.mjs';

const HELP = `judge — tier 2, the local 14B judge.

  --report=<file>          a report from \`qa:page --out=\` or \`qa:batch\`
  --tier=<name>            llm tier in config to ask (default: judge)
  --min-confidence=<0..1>  override cfg.qa.minConfidence for this run
  --dry-run                print the prompt, call nothing, write nothing
  --quiet                  verdict line only
  --help                   this text

exit 0 pass · 1 fail · 2 escalate / tier unavailable · 3 usage/config`;

/**
 * The forced-JSON contract.
 *
 * `additionalProperties: false` and `required` on every level: llama.cpp's strict
 * schema mode is the reliability lever for a small model, and a loose schema gets you
 * a plausible object with the one field you needed spelled differently. What strict
 * mode does NOT enforce is numeric RANGE — see `normalizeConfidence`.
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'escalate'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'detail'],
        properties: {
          severity: { type: 'string', enum: ['error', 'warning', 'note'] },
          category: {
            type: 'string',
            enum: ['content-missing', 'content-altered', 'content-duplicated',
              'requirement-unmet', 'authoring-artifact', 'metadata', 'other'],
          },
          detail: { type: 'string' },
        },
      },
    },
  },
};

/**
 * A confidence the ladder can actually gate on.
 *
 * `c > 1 ? c / 100 : c` is not defensive tidying — the source's committed reports
 * carry `confidence: 95` against this exact schema, so the rescale is reading real
 * data, not hypothetical data. Clamped afterwards because `150` is also possible and
 * is not 1.5. A non-number becomes `null`, which the gate treats as "no confidence
 * stated" and escalates: an absent number must not read as a high one.
 */
export function normalizeConfidence(raw) {
  const c = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  if (c === null) return null;
  return Math.min(1, Math.max(0, c > 1 ? c / 100 : c));
}

/** Fallback gate, used when nothing in config sets one. */
export const DEFAULT_MIN_CONFIDENCE = 0.55;

/** Which of the three system prompts this report gets, named once. */
const judgeMode = (report, auditMode) => {
  if (auditMode) return 'audit';
  return report.mode === 'pair' ? 'pair' : 'baseline';
};

/*
 * The English judge is shown the `EN QA Requirements` section, or NO brief at all.
 *
 * Never the translation section, and the reason is measured rather than assumed. Handed
 * the translation contract, the 14B judge read /en/meetups/aem-gdc-june-2026-eds-cdn-recap
 * — a page tier 1 passes with zero findings — and returned error-severity issues reading
 * "The page content is in English and lacks translated content" and "The LOCATION is
 * missing. The page should be byte-identical to the English source." A scope paragraph in
 * this prompt telling it those rows were out of scope did NOT stop it on the second
 * attempt either, which is the same thing the pipeline this was ported from recorded
 * about negative constraints and a model this size.
 *
 * With a resolved brief, merge-ladder step 3 would have turned that into a recorded
 * FAIL on a good page. So the contract is selected structurally in
 * lib/requirements.mjs (`enJudgeBrief`), and when there is none the judge is TOLD there
 * is none — `SYSTEM_BASELINE_NO_BRIEF` — and judges only what a page can be judged on
 * without one.
 */
const SYSTEM_BASELINE = `You are a skeptical web-content QA judge. You are shown ONE page's authored text,
the deterministic checks that already ran on it, and the QA REQUIREMENTS its team agreed.
Judge whether the page satisfies those requirements and reads as complete, coherent content.

SCOPE. The page you are shown is the ENGLISH SOURCE page. It is not a translation and it is
not being compared to anything, so nothing about language, locale or translation is in scope.
Rules:
- The requirements are the contract. Judge against them, not against your own taste in page design.
- Flag: content that is obviously truncated mid-sentence or mid-section; a section the requirements
  say must exist and is absent; placeholder or template text left in ("TBD", "Lorem", "{title}",
  "Placeholder — add ...", an empty list where content was promised); duplicated paragraphs;
  authoring artifacts leaking as visible prose (block configuration keys, stray file paths);
  a fact stated two different ways in the same page.
- Do NOT flag: layout, styling, tone, length, SEO, or anything the deterministic checks own
  (broken links, missing images, unresolved icons, metadata presence). Those are already reported
  above and repeating them adds nothing.
- Verdict "pass" only if you are confident the page satisfies the requirements.
- Verdict "fail" only for a defect you can point to concretely, quoting the text.
- When unsure, verdict "escalate". Escalating is cheap; a wrong "pass" is expensive.
- confidence is a DECIMAL between 0.0 and 1.0 (e.g. 0.85). Never a percentage, never an integer.`;

const SYSTEM_BASELINE_NO_BRIEF = `You are a skeptical web-content QA judge. You are shown ONE
page's authored text and the deterministic checks that already ran on it. There is NO
requirements brief for this page's group, so you have no statement of what it is supposed to
contain — say nothing about whether required content is present, because you cannot know.

SCOPE. The page is an ENGLISH SOURCE page. Nothing about language, locale or translation is in
scope. Judge ONLY what a page can be judged on with no specification:
- text truncated mid-sentence or mid-word, or a section that stops abruptly
- placeholder or template text left in ("TBD", "Lorem", "{title}", "Placeholder — add ...",
  "coming soon" where content was promised, an empty list under a heading that introduces one)
- the same paragraph or list item appearing twice
- authoring artifacts leaking as visible prose: block configuration keys, stray file paths,
  raw URLs where a link label belongs
- a fact stated two different ways in the same page (two different dates, two different times)
Do NOT flag: layout, styling, tone, length, SEO, missing sections, or anything the
deterministic checks own (broken links, missing images, unresolved icons, metadata presence).
- Verdict "pass" if none of the above is present.
- Verdict "fail" only for a defect you can quote.
- When unsure, verdict "escalate".
- confidence is a DECIMAL between 0.0 and 1.0 (e.g. 0.85). Never a percentage, never an integer.`;

const SYSTEM_PAIR = `You are a skeptical web-content QA judge. You compare a REFERENCE page against a
SECOND rendition of the same page and judge CONTENT FIDELITY only.
Rules:
- The two pages will differ in layout, formatting and word order. That is fine. Judge only whether
  the reference's substantive content — paragraphs, facts, names, numbers, quotes, dates, code —
  survived into the second page.
- Flag: dropped paragraphs or sections, altered facts/numbers/names/dates, duplicated content,
  text left in the wrong language, sentences truncated mid-clause.
- Treat every item in the QA REQUIREMENTS below as an APPROVED transformation. Do not flag an
  approved item as a defect under any circumstances.
- Verdict "pass" only if you are confident nothing substantive was lost or altered.
- Verdict "fail" only for a defect you can point to concretely, quoting both sides.
- When unsure, verdict "escalate". Escalating is cheap; a wrong "pass" is expensive.
- confidence is a DECIMAL between 0.0 and 1.0 (e.g. 0.85). Never a percentage, never an integer.`;

const SYSTEM_AUDIT = `You are a QA inspector evaluating ONE page against its REQUIREMENTS brief. You do
NOT have a reference page: this page type (an index or listing page) assembles most of what a
visitor sees at runtime from a query index, so that content is absent from the authored text by
design and comparing against it would produce nothing but false positives.
Evaluate the AUTHORED PAGE CONTENT against the brief's rows. Row statuses:
  ✓  confirmed / must survive — intentional, do NOT flag it.
  ~  partially approved — flag only exceptions, not the norm.
  ?  unconfirmed — EVALUATE this and report any visible defect or drift you find.
  ✗  not applicable — already filtered out; you will not see these.
Rules:
- Flag concretely: a required section missing entirely; content garbled; template literals left
  unsubstituted (e.g. "{start} to {end}"); block configuration rows leaking as visible text
  (e.g. "browse label Browse Articles"); duplicated content.
- Verdict "pass" if every row you can evaluate looks correct.
- Verdict "fail" only for a concrete, locatable defect.
- Verdict "escalate" when uncertain whether something is a real defect.
- confidence is a DECIMAL between 0.0 and 1.0 (e.g. 0.85). Never a percentage, never an integer.`;

/**
 * Strip the authoring artifacts that survive into a `.plain.html` text extraction and
 * are invisible on the rendered page.
 *
 * The bulk of this class of noise is already gone structurally — `extractContent`
 * REMOVES the `metadata` and `section-metadata` blocks rather than guessing at the
 * text form of their rows (lib/extract.mjs). What is left is block CONFIGURATION:
 * key/value rows a block's JS reads and never renders.
 *
 * The rules below are narrow on purpose, and the policy matters more than the list:
 * ONE VERIFIED RULE AT A TIME, each naming the block and the page it was observed on.
 * The pipeline this is ported from accumulated a dozen speculative regexes here, and
 * two of them ate real content — a `\\blayout\\s+[\\w-]+(?:\\s+[\\w-]+){0,2}` that
 * swallowed the three words after any sentence containing "layout". A prose
 * instruction to the model is not a substitute (the 14B judge flagged an
 * explicitly-approved omission on every single call regardless of the brief), which
 * is why this exists in code at all — but it earns each entry.
 */
export function stripEdsArtifacts(text) {
  return String(text || '')
    // `dam-display` block config — a DAM path and a render mode. Observed on
    // /en/meetups/20260625-bring-your-complicated-eds-integration-story-meetup.
    .replace(/\bfilepath\s+\/content\/dam\/\S+/g, '')
    .replace(/\bmode\s+(?:pdf|image|video)\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The prompt, built from the report and the brief. Pure, so `--dry-run` can print it. */
export function buildPrompt(report, { brief, auditMode }) {
  const structural = report.tiers?.structural || {};
  const sample = report.evidence?.textSample || {};
  const pair = report.mode === 'pair' && sample.source;

  /*
   * The model sees the checks that are NOT passing, never all of them.
   *
   * Two reasons, and the second is the expensive one. A 14B model's context is the
   * scarcest thing in this pipeline. And a literal `missing: [...]` list in the
   * payload outweighs any prose instruction not to act on it: the source fed the raw
   * heading diff alongside a brief that approved the omission, and the judge flagged
   * it as a defect on every call. Tier 1 already adjudicated these; the judge is
   * shown its conclusions, not its working.
   */
  const notable = (structural.checks || []).filter((c) => c.verdict === 'fail' || c.verdict === 'warn');

  const digest = ({ check, verdict, detail, findings }) => ({
    check,
    verdict,
    ...(detail ? { detail } : {}),
    ...(findings ? { findings: findings.map((f) => f.detail) } : {}),
  });

  const head = [
    ...(brief ? [
      `QA REQUIREMENTS — the "${report.group}" group`,
      auditMode ? '(row statuses are meaningful — see the rules above)' : '(approved transformations: do NOT flag these as defects)',
      '---',
      brief,
      '---',
      '',
    ] : []),
    `DETERMINISTIC CHECKS (tier 1, already ran — verdict ${structural.verdict}):`,
    notable.length
      ? JSON.stringify(notable.map(digest), null, 1)
      : '  all checks passed or were skipped for want of a baseline.',
    '',
  ];

  const body = pair
    ? [
      '--- REFERENCE PAGE, VISIBLE TEXT ---',
      stripEdsArtifacts(sample.source),
      '',
      '--- PAGE UNDER TEST, VISIBLE TEXT ---',
      stripEdsArtifacts(sample.target),
    ]
    : [
      `--- AUTHORED PAGE CONTENT (${report['page-path']}) ---`,
      stripEdsArtifacts(sample.target || '(missing)'),
    ];

  let system = brief ? SYSTEM_BASELINE : SYSTEM_BASELINE_NO_BRIEF;
  if (auditMode) system = SYSTEM_AUDIT;
  else if (pair) system = SYSTEM_PAIR;
  return { system, user: [...head, ...body].join('\n') };
}

/**
 * Merge the two tiers into one verdict. The ladder, in code, in order.
 *
 * Returned as `{ verdict, reason }` rather than a bare string: an escalation whose
 * cause nobody can read is an escalation nobody can clear, and this reason is what
 * lands in the escalation queue's `summary`.
 */
export function mergeVerdict({
  structuralVerdict, judge, unresolved = 0, minConfidence,
}) {
  const issues = judge?.issues || [];
  const confidence = normalizeConfidence(judge?.confidence);

  if (unresolved > 0) {
    return {
      verdict: 'escalate',
      reason: `the requirements brief has ${unresolved} unresolved "?" row(s)`
        + ' — a human owes an answer before this page can pass',
    };
  }
  if (structuralVerdict === 'fail') {
    return { verdict: 'fail', reason: 'a deterministic tier-1 check failed; the judge cannot upgrade it' };
  }
  const hard = issues.filter((i) => i.severity === 'error');
  if (hard.length) {
    return { verdict: 'fail', reason: `${hard.length} error-severity issue(s): ${hard[0].detail}` };
  }
  if (judge?.verdict === 'escalate') {
    return { verdict: 'escalate', reason: 'the model was not sure enough to call it either way' };
  }
  if (judge?.verdict === 'fail') {
    // The model said fail but raised nothing at error severity. That is a
    // contradiction, not a verdict, and guessing which half it meant is how a
    // no-evidence fail gets recorded as fact.
    return { verdict: 'escalate', reason: 'the model returned "fail" with no error-severity issue to point at' };
  }
  if (confidence === null) {
    return { verdict: 'escalate', reason: 'the model stated no usable confidence' };
  }
  if (confidence < minConfidence) {
    return {
      verdict: 'escalate',
      reason: `confidence ${confidence.toFixed(2)} is below the gate of ${minConfidence}`,
    };
  }
  return {
    verdict: 'pass',
    reason: structuralVerdict === 'review'
      ? `tier 1 raised warnings; the judge cleared them at confidence ${confidence.toFixed(2)}`
      : `both tiers clean at confidence ${confidence.toFixed(2)}`,
  };
}

/**
 * Judge one report. Returns the `tiers.judge` object plus the merged verdict.
 *
 * Throws `LlmUnavailable` straight through: the caller decides whether that is exit 2
 * for a single page or "hold this page and carry on" for a batch. Swallowing it here
 * would make a stopped service indistinguishable from a corrupt verdict, and then
 * every page in the batch collects a fabricated problem.
 */
export async function judgeReport(report, cfg, {
  tierName = 'judge', minConfidence = null, fetchBrief = loadRequirements,
} = {}) {
  const tier = cfg.llm[tierName];
  if (!tier) throw new Error(`unknown llm tier "${tierName}" — configured: ${Object.keys(cfg.llm).join(', ')}`);

  const req = await fetchBrief(report.group, { branch: report.branch });
  /*
   * `judgeBrief` and not `text`. The document holds sections for three audiences —
   * what the content owner asked for, how to build it, and the QA criteria — and only
   * the last is content-fidelity guidance. The other two dilute the one instruction
   * the model is meant to act on and burn context a 14B does not have spare.
   */
  /*
   * Pair mode compares two renditions of one page, which is the translation tier's
   * question, so it gets the translation contract. Baseline mode judges an English
   * source page on its own and gets the EN contract or none — see the note above.
   */
  const pairMode = report.mode === 'pair';
  const raw = pairMode ? req.judgeBrief : req.enJudgeBrief;
  const readiness = pairMode ? req.readiness : req.enReadiness;
  const sectionName = pairMode ? JUDGE_SECTION : EN_JUDGE_SECTION;
  const { auditMode } = req;
  const brief = raw ? filterBrief(raw, auditMode) : null;
  const unresolved = readiness.unresolved.length;
  const gate = minConfidence
    ?? cfg.qa?.minConfidence
    ?? DEFAULT_MIN_CONFIDENCE;

  const prompt = buildPrompt(report, { brief, auditMode });
  const started = Date.now();
  const answer = await llmJson(tier, { ...prompt, schema: VERDICT_SCHEMA });
  const elapsedMs = Date.now() - started;

  const judge = {
    verdict: answer.verdict,
    confidence: normalizeConfidence(answer.confidence),
    rawConfidence: answer.confidence,
    issues: answer.issues || [],
    model: `${tier.model}@${tier.endpoint}`,
    mode: judgeMode(report, auditMode),
    briefSource: raw ? req.source : null,
    briefSection: raw ? sectionName : null,
    minConfidence: gate,
    elapsedMs,
  };
  const merged = mergeVerdict({
    structuralVerdict: report.tiers?.structural?.verdict,
    judge,
    unresolved,
    minConfidence: gate,
  });
  return { judge: { ...judge, ...merged }, verdict: merged.verdict, reason: merged.reason };
}

/* -------------------------------------------------------------------------- main */

function parseArgs(args) {
  const o = {
    report: null, tier: 'judge', minConfidence: null, dryRun: false, quiet: false, help: false,
  };
  for (const a of args) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a.startsWith('--report=')) o.report = a.slice(9);
    else if (a.startsWith('--tier=')) o.tier = a.slice(7);
    else if (a.startsWith('--min-confidence=')) o.minConfidence = Number(a.slice(17));
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  if (!o.report) throw new Error('--report=<file> is required');
  if (o.minConfidence !== null && !(o.minConfidence >= 0 && o.minConfidence <= 1)) {
    throw new Error(`--min-confidence must be between 0 and 1, got "${o.minConfidence}"`);
  }
  return o;
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (!existsSync(opts.report)) throw new Error(`no such report: ${opts.report}`);
  const cfg = loadConfig();
  const report = JSON.parse(readFileSync(opts.report, 'utf8'));

  if (report.tiers?.structural?.verdict === 'unreachable') {
    console.error('JUDGE: not run — tier 1 could not reach the page, so there is no evidence to judge');
    return 2;
  }

  if (opts.dryRun) {
    const req = await loadRequirements(report.group, { branch: report.branch });
    const pairMode = report.mode === 'pair';
    const raw = pairMode ? req.judgeBrief : req.enJudgeBrief;
    const readiness = pairMode ? req.readiness : req.enReadiness;
    const prompt = buildPrompt(report, {
      brief: raw ? filterBrief(raw, req.auditMode) : null,
      auditMode: req.auditMode,
    });
    console.log(`── judge · DRY RUN · tier ${opts.tier} (${cfg.llm[opts.tier]?.model}) ──`);
    console.log(`   report:  ${opts.report}`);
    console.log(`   brief:   ${raw ? `${req.source} ${req.path}` : 'NONE for this judge'}`
      + `  [${pairMode ? JUDGE_SECTION : EN_JUDGE_SECTION}: ${readiness.state}]`
      + `${readiness.unresolved.length ? ` ⚠ ${readiness.unresolved.length} unresolved "?" row(s) → would escalate regardless` : ''}`);
    console.log(`   gate:    min confidence ${opts.minConfidence ?? cfg.qa?.minConfidence ?? DEFAULT_MIN_CONFIDENCE}`);
    console.log(`   nothing will be sent and ${opts.report} will not be modified.\n`);
    console.log('--- SYSTEM ---');
    console.log(prompt.system);
    console.log('\n--- USER ---');
    console.log(prompt.user);
    return 0;
  }

  try {
    const { judge, verdict, reason } = await judgeReport(report, cfg, {
      tierName: opts.tier,
      minConfidence: opts.minConfidence,
    });
    // In-place rewrite: one file per page holds every tier's verdict, and the merge
    // happens exactly once, here. A tier that did not run stays `null`.
    report.tiers.judge = judge;
    report.verdict = verdict;
    writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
    if (!opts.quiet) console.log(JSON.stringify(judge, null, 2));
    console.error(`JUDGE: ${verdict.toUpperCase()} — ${reason}`);
    console.error(`  model ${judge.model}  confidence ${judge.confidence}`
      + `${judge.rawConfidence !== judge.confidence ? ` (model said ${judge.rawConfidence})` : ''}`
      + `  ${(judge.elapsedMs / 1000).toFixed(1)}s`);
    return { pass: 0, fail: 1, escalate: 2 }[verdict] ?? 3;
  } catch (e) {
    if (e instanceof LlmUnavailable) {
      console.error(`JUDGE: tier "${opts.tier}" could not answer — ${e.message}`);
      console.error('  the page HOLDS its current status and the batch continues (exit 2).');
      return 2;
    }
    throw e;
  }
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`ERROR: ${e.message}`);
      exit(3);
    });
}
