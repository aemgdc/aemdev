#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * tx-judge.mjs — TIER 2. The local 14B judge's verdict on a tx-qa report.
 *
 * CLI SURFACE
 *   node tools/tracker/tx-judge.mjs --report=<file> [--tier=judge|triage]
 *        [--group=<name>] [--branch=<ref>] [--json] [--no-write] [--help]
 *
 *   npm run tx:judge -- --report=.tracker/reports/tx/de--en--meetups--munich.json
 *
 * Tier 1 settles every question that is a FACT about two documents. What is left is the
 * one question code cannot answer:
 *
 *     is this good <language>, and does it say what the English said?
 *
 * Which decomposes into four things the judge is asked to look for, and nothing else — a
 * judge given a long list of concerns returns a long list of shrugs:
 *
 *   1. UNTRANSLATED passages tier 1's detector could not settle (short strings,
 *      proper-noun-heavy sentences, mixed-language paragraphs)
 *   2. TERMINOLOGY against the glossary: product and event names stay English, people's
 *      names stay as written, and a concept gets ONE rendering per locale
 *   3. MEANING: does it say what the source said, including every figure, name and claim
 *   4. REGISTER: the target language's practitioner voice, not a word-for-word gloss
 *
 * ─── What the judge is explicitly told NOT to do, twice ─────────────────────
 *
 * Everything tier 1 already decided is passed in as ALREADY SETTLED, and the categories a
 * model reliably re-invents are ALSO suppressed in code. Both, not either: a 14B model
 * shown a German page and asked an open question will find that `176.000` should be
 * `176,000` and that the section-metadata says `columns-10-90` in English. Both are
 * correct as they stand, both are already checked deterministically, and both crowd out
 * the findings only a model can produce. A local model cannot be relied on to honour a
 * negative constraint, so the prompt states it and the code enforces it.
 *
 * ─── The two things the English judge does not need ─────────────────────────
 *
 * A SUPPRESS list of things that are not defects IN A TRANSLATION — different word order,
 * a different idiom, a legitimately longer or shorter rendering, a localized date format.
 * Without these the judge fails every page for being a translation.
 *
 * A GLOSSARY, per locale. Terminology is where machine translation actually fails, and it
 * is the only one of the four categories that has a right answer somebody has to write
 * down. `.tracker/qa-requirements/glossary.md` + `glossary-<code>.md`.
 *
 * ─── The merge ladder, five rungs, in order ─────────────────────────────────
 *
 *   1. a tier-1 FAIL stands. The judge cannot upgrade it.
 *   2. a judge ERROR whose quote checked out → fail
 *   3. judge said `escalate` → escalate
 *   4. judge said `fail` but could not quote it → ESCALATE, not fail
 *   5. otherwise → pass
 *
 * Rung 4 is the important one: a claimed defect with no locatable evidence is a claim
 * about the model, not about the page, and failing a page on it sends a native speaker to
 * refute a sentence that may not exist.
 *
 * EXIT CODES (data-contract.md §5)
 *   0 pass · 1 fail · 2 escalate, or the LLM was unreachable (`LlmUnavailable`) ·
 *   3 usage or config error
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  readFileSync, writeFileSync, existsSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { locale as localeFor } from '../../scripts/tracker/locales.js';
import { loadConfig, REPO_ROOT, CONFIG_DIR } from './config.mjs';
import { llmJson, LlmUnavailable } from './lib/llm.mjs';
import { verdictExit } from './lib/exit.mjs';
import { judgeBrief, requirementsReadiness, GLYPHS } from './lib/requirements.mjs';

const HELP = `tx-judge — tier 2 translation-fidelity verdict from the local judge.

  --report=<file>   required. A report written by tx-qa (npm run tx:page).
  --tier=<name>     which llm tier in .tracker/orchestrator.json (default: judge)
  --group=<name>    resolve this group's requirements brief (default: the report's own)
  --branch=<ref>    branch the brief is read from (default: the report's own, then main)
  --no-write        do not write the verdict back into the report file
  --json            print the verdict as JSON
  --help            this text

exit 0 pass · 1 fail · 2 escalate or LLM unreachable · 3 usage or config error`;

/**
 * The schema the model's answer is FORCED into.
 *
 * Schema-forced output is the reliability lever for a small model — never parse free text
 * from one. `quote` is the single most useful field on the output: an issue that cannot be
 * located is an issue nobody can act on, and it is also the only thing that makes a
 * fabricated finding detectable.
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
            enum: ['untranslated', 'terminology', 'meaning-changed', 'meaning-lost', 'inconsistent', 'register', 'other'],
          },
          detail: { type: 'string' },
          quote: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `You are a bilingual QA reviewer checking a machine-translated technical web page.
You compare the ENGLISH source text against the TRANSLATED text and judge TRANSLATION QUALITY only.
The site is written for AEM developers and architects: practitioner prose, not marketing copy.

Report ONLY these four things:
1. UNTRANSLATED — passages still in English, or a mix of English and the target language in
   one sentence.
2. TERMINOLOGY — a term translated against the GLOSSARY. Product, platform, event and
   PERSON names are ALWAYS left in English. A concept must get ONE rendering: if the same
   page calls the same thing three different things, report it once as "inconsistent".
3. MEANING — a statement that says something different from the English, or drops a fact,
   a figure, a name or a claim that the English makes.
4. REGISTER — text that is grammatical but reads as a word-for-word gloss rather than
   professional technical prose in the target language.

Do NOT report any of the following. They are correct, or they are already checked
mechanically, and reporting them buries the findings only you can produce:
- DIFFERENT WORD ORDER, a different sentence split, or a different idiom. A translation is
  not a gloss; rearranged clauses that mean the same thing are correct.
- A LONGER OR SHORTER RENDERING. Languages differ in length. Only report length if
  something is actually MISSING or invented.
- A LOCALIZED DATE OR NUMBER FORMAT. "2 October 2026" becoming "2. Oktober 2026" is
  correct. 1.5 vs 1,5 and 176,000 vs 176.000 are the SAME figures, correctly localized.
- small numbers spelled out as words
- brand, company, product, event or person names left in English — that is REQUIRED
- code, identifiers, file paths, block names, CLI commands, URLs and link targets
- English text inside block configuration rows, layout names, style names or CSS classes
- quotation-mark style, capitalization or punctuation conventions
- anything listed under ALREADY SETTLED below

Verdict rules:
- "pass" only if you find nothing in categories 1-3. A register-only issue still passes.
- "fail" only for a defect you can QUOTE from the text you were given.
- "escalate" when you are unsure, or when the target language is one you cannot read
  reliably. Escalating is cheap; a wrong "pass" ships broken copy to a whole locale.
- Always fill "quote" with the exact offending text. An issue you cannot quote is one you
  should not report.
- confidence must be a decimal between 0.0 and 1.0. Never an integer, never a percentage.`;

/* ------------------------------------------------------------------ the brief */

/**
 * Resolve a group's requirements brief from the repo.
 *
 * Only the LOCAL file, deliberately. The DA copy at `requirementsPath(group)` is the
 * mirror a human edits and `judge.mjs` reads it over the network; a translation judge
 * running a ten-locale batch would fetch the same document ten times per page to get an
 * answer that cannot have changed inside a run. The repo copy is what `git pull` already
 * put on this machine.
 *
 * PARSING is imported, never restated: `requirementsReadiness()` owns the glyph
 * vocabulary and the `?`-row gate, so this tier and the English judge cannot come to
 * different conclusions about the same brief.
 */
export const briefPath = (group) => join(REPO_ROOT, CONFIG_DIR, 'qa-requirements', `${group}-brief.md`);

export function resolveBrief(group) {
  const path = group ? briefPath(group) : null;
  if (!path || !existsSync(path)) {
    return {
      exists: false, path, text: null, section: null, readiness: null,
    };
  }
  const text = readFileSync(path, 'utf8');
  return {
    exists: true,
    path,
    text,
    section: judgeBrief(text),
    readiness: requirementsReadiness(text),
  };
}

/**
 * The glyph legend, prepended to the brief the model sees.
 *
 * The English judge STRIPS the `✗` and `?` rows instead. That is right there and wrong
 * here: on a translated page an approved removal is content the English page also does
 * not have, so hiding the row invites the judge to report the translation for a gap the
 * requirements blessed. Telling it what the glyph means is cheaper than teaching it to
 * ignore a row it can see anyway.
 */
const glyphLegend = () => GLYPHS.map((g) => `  ${g.glyph}  ${g.label}`).join('\n');

/* ------------------------------------------------------------------ the glossary */

export const glossaryDir = () => join(REPO_ROOT, CONFIG_DIR, 'qa-requirements');

/**
 * Load the terminology glossary for a locale.
 *
 * Two files, both consulted, concatenated: the shared one for the terms that are the same
 * in every language (product names, event names, the never-translate list, the concept
 * list) and the per-locale one for the terms that are not. The split matters because the
 * shared half is genuinely universal, and duplicating it ten times is how ten copies
 * drift out of step with `dnt-content-rules`.
 *
 * Returns `{ text, files, missing }` rather than a bare string, because "there is no
 * glossary for this locale" is a fact the driver GATES on: without one, tier 2 can only
 * judge meaning and register, and terminology is where machine translation actually
 * fails. A caller that cannot tell the difference reports a terminology pass it never ran.
 */
export function loadGlossary(code, { dir = glossaryDir() } = {}) {
  const files = [];
  const missing = [];
  const parts = [];
  for (const f of ['glossary.md', `glossary-${code}.md`]) {
    const p = join(dir, f);
    if (existsSync(p)) {
      files.push(p);
      parts.push(`--- ${f} ---\n${readFileSync(p, 'utf8').trim()}`);
    } else {
      missing.push(p);
    }
  }
  return { text: parts.length ? parts.join('\n\n') : null, files, missing };
}

/* ------------------------------------------------------------------ already settled */

/**
 * Tier-1 findings rendered for the judge as things NOT to look for.
 *
 * Only the checks whose findings a model would plausibly re-report are included. Listing
 * everything would burn context on facts the judge cannot act on — an expansion ratio, a
 * broken in-page anchor, an icon count — and would dilute the instruction that matters.
 */
const SETTLED_CHECKS = new Set([
  'translated-key', 'translated-value', 'untranslated-cell', 'untranslated-text',
  'dnt-term', 'dnt-identifier', 'translated-code', 'numbers', 'dates', 'typography',
  'placeholder', 'unlocalized-path', 'markup-drift', 'skeleton', 'block-rows', 'headings',
]);

export function settledSummary(tier) {
  const items = [...tier?.errors || [], ...tier?.warnings || [], ...tier?.notes || []]
    .filter((f) => SETTLED_CHECKS.has(f.check))
    .map((f) => `- [${f.check}] ${f.detail}`);
  return items.length ? items.slice(0, 40).join('\n') : null;
}

/* ------------------------------------------------------------------ suppression */

/**
 * Categories the judge is not permitted to raise, enforced in CODE.
 *
 * The prompt already forbids these and the prompt is not enough. Every regex here is
 * either (a) something tier 1 owns deterministically, or (b) something that is not a
 * defect in a translation at all — and group (b) is the half the English judge has no
 * need for. Without it the judge fails every page for being a translation: a different
 * word order, a different idiom, a longer rendering and a localized date are what a
 * translation IS.
 *
 * Every suppressed issue is RETAINED under `suppressed[]`, never dropped. A suppression
 * list that hides its own work is unauditable, and the day one of these regexes is too
 * broad the only way to find out is to be able to read what it swallowed.
 */
export const SUPPRESS = [
  /* (b) — not defects in a translation. The reason this list differs from the EN judge. */
  /\b(word|sentence|clause)\s+order\b/i,
  /\b(rearrang|reorder|restructur|reword|rephras)/i,
  /\b(idiom|idiomatic|figure of speech|colloquial)\b/i,
  /\b(longer|shorter|more verbose|less concise|expanded|condensed)\b.*\b(than the (english|source)|rendering|translation)\b/i,
  /\b(literal|word[- ]for[- ]word)\b.*\b(is (fine|acceptable|correct)|not (a|an) (issue|error))\b/i,
  /\bdate\s+(format|formatting|is (written|localized|localised))\b/i,
  /\b(localized|localised)\s+(date|number|format)\b/i,

  /* (a) — settled deterministically by tier 1. Same lesson as the EN judge's list. */
  /\b\d+[.,]\d+\b.*\b(should|instead of|rather than|formatted|separator|decimal|thousand)\b/i,
  /\b(decimal|thousands?)\s+(separator|point|mark)\b/i,
  /\bnumber format/i,
  /\b(section-metadata|columns-\d|cta-band|key-points|article-feed|blog-post-hero|home-hero)\b/i,
  /\b(block|css|class|template)\s*(name|config|configuration|attribute)/i,
  /\b(url|href|link target|file path|slug|identifier|code (block|snippet|sample))\b/i,
  /\b(quotation marks?|quote marks?|curly quotes?|straight quotes?|apostrophe|punctuation|capitali[sz]ation)\b/i,

  /* Names left in English are required, not a miss. The glossary's other half. */
  /\b(brand|product|platform|company|event|person|proper)\s+name.*\b(english|untranslated|not translated|unchanged)\b/i,
  /\b(AEM|EDS|Adobe|adaptTo|aemdev\.org|Edge Delivery Services|Document Authoring)\b.*\b(not translated|remains? in english|should be translated|untranslated)\b/i,
];

/** Split the model's issues into the ones it was allowed to raise and the ones it was not. */
export function suppressSettled(issues) {
  const kept = [];
  const suppressed = [];
  for (const i of issues || []) {
    const text = `${i.detail || ''} ${i.quote || ''}`;
    const hit = SUPPRESS.find((re) => re.test(text));
    if (hit) suppressed.push({ ...i, suppressedBy: String(hit) });
    else kept.push(i);
  }
  return { kept, suppressed };
}

/* ------------------------------------------------------------------ quote verification */

/**
 * Normalize a quotation for matching.
 *
 * Strips the scaffolding the prompt's own format invites the model to echo — a leading
 * `[7]` pair index, an `EN:`/`DE:` side label, surrounding quote marks — and flattens the
 * punctuation variants that differ between the stored document and a model's
 * transcription of it. Without this a CORRECT finding gets marked unverified for a
 * cosmetic reason: upstream, the perfectly valid quote `DE: Regisseur` was downgraded
 * because the label the prompt itself printed was treated as part of the quotation.
 */
export const normQuote = (s) => (s || '')
  /*
   * A model that echoes a whole pair block — some models do this consistently, returning
   * `[7] callout / heading\n  EN: Director\n  DE: Regisseur` — gets its LAST labelled line
   * taken as the quotation. That is the target-language side, which is the side a finding
   * is almost always about. Without this the whole block is matched as one span, never
   * matches, and a correct finding is labelled as possibly fabricated.
   */
  .split('\n')
  .filter((l) => l.trim())
  .reduce((best, line) => (/^\s*[A-Z]{2}(-[A-Z]{2})?\s*:/i.test(line) ? line : best), s || '')
  .replace(/^\s*\[\d+\]\s*/, '')
  .replace(/^\s*(EN|[A-Z]{2}(-[A-Z]{2})?)\s*:\s*/i, '')
  .replace(/^["'“”„»«]+|["'“”„»«]+$/g, '')
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”„]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/**
 * Verify each issue's `quote` actually appears in the evidence.
 *
 * A small model hallucinating a quotation is the failure mode that makes a translation
 * judge untrustworthy, and it is worse here than on the English line: a fabricated content
 * claim can be checked against the source in seconds, while a fabricated German sentence
 * takes a native speaker to refute.
 *
 * So the quote is checked mechanically against the report's OWN evidence, and an issue
 * whose quote is not there is DOWNGRADED and labelled rather than dropped: it may still
 * point at something real, but it has lost the right to fail a page on its own.
 */
export function verifyQuotes(issues, sample) {
  const haystack = normQuote([
    sample?.translated || '',
    sample?.en || '',
    ...(sample?.pairs || []).flatMap((p) => [p.en, p.translated]),
  ].join(' '));
  return issues.map((i) => {
    const q = normQuote(i.quote);
    // Below four characters a quotation carries no evidentiary weight either way — it
    // would match something by accident. Reported as `null`, not `false`.
    if (!q || q.length < 4) return { ...i, quoteVerified: null };
    if (haystack.includes(q)) return { ...i, quoteVerified: true };
    /*
     * An INCONSISTENT finding's evidence is a set of terms, not a contiguous span. A
     * correct upstream finding — one page using three different words for one concept —
     * quoted all three as a comma-separated list, was verified as one span that never
     * matched, and was downgraded as possibly fabricated. Splitting on commas and
     * requiring EVERY term to be present keeps the check strict (a fabricated term still
     * fails) while letting the finding stand.
     */
    const terms = q.split(/\s*,\s*/).map((t) => t.trim()).filter((t) => t.length >= 4);
    if (terms.length > 1 && terms.every((t) => haystack.includes(t))) {
      return { ...i, quoteVerified: true, quotedAs: 'term-list' };
    }
    return {
      ...i,
      severity: i.severity === 'error' ? 'warning' : i.severity,
      quoteVerified: false,
      detail: `${i.detail} [UNVERIFIED: the quoted text was not found on either page, so this `
        + 'claim may be fabricated — downgraded from error]',
    };
  });
}

/* ------------------------------------------------------------------ confidence */

/**
 * Coerce the model's `confidence` into 0..1.
 *
 * The schema says 0..1 and live reports upstream carried `95`. A schema is a request, not
 * a guarantee — llama.cpp's grammar enforces the TYPE, not the range — and a raw 95 read
 * as a confidence is silently 95x anything a threshold compares it against. Normalized
 * here, once, and the ORIGINAL is kept alongside so the coercion is auditable rather than
 * invisible.
 *
 * The upstream judge's header claimed a low-confidence escalation that its code never
 * performed. It is wired here: below `minConfidence` a `pass` becomes an escalation,
 * because a model that says "clean, and I am not sure" has not cleared the page.
 */
export function normalizeConfidence(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return { confidence: null, reported: raw ?? null };
  if (n >= 0 && n <= 1) return { confidence: n, reported: n };
  if (n > 1 && n <= 100) return { confidence: Number((n / 100).toFixed(3)), reported: n };
  return { confidence: null, reported: n };
}

/** Below this a bare `pass` is not good enough to clear a page. */
export const MIN_CONFIDENCE = 0.4;

/* ------------------------------------------------------------------ the call */

/**
 * Judge one report.
 *
 * @param {object} report a tx-qa report (data-contract §4). `tiers.structural` and
 *   `textSample` are read; `tiers.judge` is what this produces.
 * @returns {{ verdict, final, judge, model, elapsedMs }} — `final` is the MERGED verdict
 *   across both tiers, `verdict` is the judge's own. Two fields because the driver needs
 *   to record what the judge said as well as what the pair ends up at.
 */
export async function judgeTranslation(report, cfg, {
  tierName = 'judge', glossary = null, brief = null,
} = {}) {
  const tier = cfg.llm[tierName];
  if (!tier) throw new Error(`no llm.${tierName} tier in .tracker/orchestrator.json`);
  const structural = report.tiers?.structural || {};
  const loc = localeFor(report.locale);
  const gloss = glossary ?? loadGlossary(report.locale);
  const settled = settledSummary(structural);

  /*
   * Aligned pairs, numbered. Tier 1 has already matched the two documents position by
   * position, so presenting them paired hands the judge the correspondence instead of
   * asking it to reconstruct it — the part a 14B model gets wrong most often, and where
   * its mistakes look exactly like real defects.
   */
  const pairs = report.textSample?.pairs || [];
  const label = String(report.locale || '').toUpperCase();
  const paired = pairs.map((p, i) => `[${i + 1}] ${p.where}\n  EN: ${p.en}\n  ${label}: ${p.translated}`);

  const user = [
    `TARGET LANGUAGE: ${loc?.name || report.locale} (${report.locale})`,
    '',
    ...(gloss.text ? ['GLOSSARY — the terminology contract. Terms listed as never-translate MUST stay',
      'in English; terms with a required rendering must use exactly that rendering:', '---', gloss.text, '---', ''] : []),
    ...(brief ? ['PAGE REQUIREMENTS — what this group\'s content must say. A translation that drops',
      'one of these has lost meaning. Row statuses:', glyphLegend(), '---', brief, '---', ''] : []),
    ...(settled ? ['ALREADY SETTLED — these were checked mechanically. Do NOT report any of them again:',
      settled, ''] : []),
    paired.length
      ? `--- ALIGNED TEXT PAIRS (${paired.length}) ---\n${paired.join('\n\n')}`
      /*
       * Fall back to the two blobs for a report written before pairs existed, rather than
       * judging an empty page and passing it. A judge shown nothing says "pass".
       */
      : [
        '--- ENGLISH SOURCE TEXT ---',
        report.textSample?.en || '(missing)',
        '',
        `--- TRANSLATED TEXT (${loc?.name || report.locale}) ---`,
        report.textSample?.translated || '(missing)',
      ].join('\n'),
  ].join('\n');

  const started = Date.now();
  const raw = await llmJson(tier, { system: SYSTEM, user, schema: VERDICT_SCHEMA });
  const elapsedMs = Date.now() - started;

  const { kept, suppressed } = suppressSettled(raw.issues);
  const issues = verifyQuotes(kept, report.textSample);
  const { confidence, reported } = normalizeConfidence(raw.confidence);

  const judge = {
    verdict: raw.verdict,
    confidence,
    reportedConfidence: reported,
    issues,
    suppressed,
    model: `${tier.model}@${tier.endpoint}`,
    tier: tierName,
    elapsedMs,
    glossary: gloss.files,
    pairs: pairs.length,
  };

  /*
   * The merge ladder. Order is the contract — see the header.
   *
   * An error only counts if its quote checked out: `verifyQuotes` has already downgraded
   * an unverified error to a warning, so reading the POST-verification severity is what
   * stops a hallucinated finding failing a page on its own.
   */
  const hasError = issues.some((i) => i.severity === 'error');
  let final;
  if (structural.verdict === 'fail') final = 'fail';
  else if (hasError) final = 'fail';
  else if (raw.verdict === 'escalate') final = 'escalate';
  else if (raw.verdict === 'fail') final = 'escalate';
  else if (confidence === null || confidence < MIN_CONFIDENCE) {
    // Wired, not decorative: "clean, and I am not sure" has not cleared the page.
    final = 'escalate';
    judge.escalatedFor = confidence === null
      ? `unparseable confidence ${JSON.stringify(reported)}`
      : `confidence ${confidence} below the ${MIN_CONFIDENCE} floor`;
  } else final = 'pass';

  judge.final = final;
  return {
    final, verdict: raw.verdict, judge, model: judge.model, elapsedMs,
  };
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(args) {
  const o = {
    report: null, tier: 'judge', group: null, branch: null, json: false, write: true, help: false,
  };
  for (const a of args) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--no-write') o.write = false;
    else if (a.startsWith('--report=')) o.report = a.slice(9);
    else if (a.startsWith('--tier=')) o.tier = a.slice(7);
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  if (!o.report) throw new Error('--report=<file> is required (write one with `npm run tx:page`)');
  return o;
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const path = isAbsolute(opts.report) ? opts.report : join(REPO_ROOT, opts.report);
  if (!existsSync(path)) throw new Error(`no such report: ${path}`);
  const cfg = loadConfig();
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (!report.tiers?.structural) {
    throw new Error(`${path} carries no tiers.structural — it is not a tx-qa report`);
  }
  if (report.tiers.structural.checks?.translated === false) {
    console.error('✗ tx-judge: tier 1 found no translated document, so there is nothing to '
      + 'judge. The pair holds its status.');
    return 2;
  }

  const gloss = loadGlossary(report.locale);
  if (!gloss.text) {
    throw new Error(`no glossary for ${report.locale} — looked for ${gloss.missing.join(', ')}. `
      + 'Terminology is where machine translation actually fails, so a run without one would '
      + 'report a terminology pass it never performed.');
  }
  for (const m of gloss.missing) console.error(`⚠ no ${m} — judging with the shared glossary only.`);

  const group = opts.group || report.group;
  const req = resolveBrief(group);
  /*
   * A brief carrying an unresolved `?` row BLOCKS. Not a warning — a gate. A requirement
   * nobody could state is not a requirement the model can check, and passing the page on
   * the rows that ARE resolved reports a verdict against a contract nobody finished.
   */
  if (req.exists && req.readiness?.state === 'blocked') {
    console.error(`✗ tx-judge: ${group}'s requirements brief has `
      + `${req.readiness.unresolved.length} unresolved "?" row(s).\n  ${req.path}`);
    for (const r of req.readiness.unresolved) console.error(`    ? ${r.ref}: ${r.requirement}`);
    return 2;
  }

  try {
    const result = await judgeTranslation(report, cfg, {
      tierName: opts.tier,
      glossary: gloss,
      brief: req.section,
    });
    report.tiers.judge = result.judge;
    report.verdict = result.final;
    if (opts.write) writeFileSync(path, JSON.stringify(report, null, 2));

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const i of result.judge.issues) {
        const mark = { error: '✗', warning: '!', note: '·' }[i.severity] || '·';
        const flag = { true: '', false: ' [unverified]', null: ' [unquoted]' }[String(i.quoteVerified)];
        console.log(`${mark} [${i.category}]${flag} ${i.detail}${i.quote ? `\n    "${i.quote}"` : ''}`);
      }
      for (const s of result.judge.suppressed) {
        console.log(`  (suppressed [${s.category}]) ${String(s.detail).slice(0, 140)}`);
      }
    }
    console.error(`TX-JUDGE: ${result.final.toUpperCase()} (judge said ${result.verdict}) — `
      + `${result.judge.model}, confidence ${result.judge.confidence}`
      + `${result.judge.reportedConfidence !== result.judge.confidence ? ` (reported ${result.judge.reportedConfidence})` : ''}, `
      + `${result.judge.issues.length} issue(s), ${result.judge.suppressed.length} suppressed, `
      + `${Math.round(result.elapsedMs / 1000)}s`
      + `${result.judge.escalatedFor ? ` — escalated: ${result.judge.escalatedFor}` : ''}`);
    return verdictExit(result.final);
  } catch (e) {
    if (e instanceof LlmUnavailable) {
      console.error(`TX-JUDGE: the ${opts.tier} tier could not answer — ${e.message}`);
      console.error('  The page HOLDS its current status and the batch continues (exit 2).');
      return 2;
    }
    throw e;
  }
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ tx-judge: ${e.message}`);
      exit(/^unknown arg|is required|no such report|carries no tiers|no glossary|no llm\./.test(e.message) ? 3 : 2);
    });
}
