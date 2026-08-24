/**
 * qa-tiers.test.mjs — the English-side QA tiers' decision logic.
 *
 * Everything here is chosen because it decides a VERDICT and a network round trip
 * cannot tell you whether it decided correctly. Two of these tests exist because the
 * behaviour they pin was a real defect found by running the pipeline against the live
 * site, and a test is the only thing that stops a defect coming back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfidence, mergeVerdict, stripEdsArtifacts, buildPrompt } from '../../tools/tracker/judge.mjs';
import { knownBlockNames, knownSectionStyles, deriveBaseline } from '../../tools/tracker/structural-qa.mjs';
import { readPairsFile } from '../../tools/tracker/qa-driver.mjs';
import {
  parseRows, glyphOf, filterBrief, verbatimRequirements, requirementsReadiness,
  enJudgeBrief, judgeBrief, htmlToBrief, briefToHtml, EN_JUDGE_SECTION,
} from '../../tools/tracker/lib/requirements.mjs';
import {
  extractContent, extractBlocks, extractSectionStyles, missingVerbatim, diffHeadings,
} from '../../tools/tracker/lib/extract.mjs';

/* ------------------------------------------------------------------- confidence */

test('confidence: a percentage is rescaled, because real reports carry one', () => {
  // The pipeline this was ported from emitted `95` against a 0..1 schema for months.
  // llama.cpp's strict mode enforces types, not ranges, so nothing caught it.
  assert.equal(normalizeConfidence(95), 0.95);
  assert.equal(normalizeConfidence(0.95), 0.95);
  assert.equal(normalizeConfidence(1), 1);
});

test('confidence: out of range is clamped, and a non-number is null not zero', () => {
  assert.equal(normalizeConfidence(150), 1);
  assert.equal(normalizeConfidence(-3), 0);
  // null, so the gate can tell "no confidence stated" from "stated as zero". An absent
  // number must never read as a high one.
  assert.equal(normalizeConfidence('high'), null);
  assert.equal(normalizeConfidence(undefined), null);
  assert.equal(normalizeConfidence(NaN), null);
});

/* ----------------------------------------------------------------- merge ladder */

const judgeSaid = (verdict, confidence, issues = []) => ({ verdict, confidence, issues });

test('ladder 1: an unresolved brief row escalates whatever the model said', () => {
  const r = mergeVerdict({
    structuralVerdict: 'pass',
    judge: judgeSaid('pass', 0.99),
    unresolved: 2,
    minConfidence: 0.55,
  });
  assert.equal(r.verdict, 'escalate');
  assert.match(r.reason, /unresolved/);
});

test('ladder 2: a deterministic fail stands; the judge cannot upgrade it', () => {
  const r = mergeVerdict({
    structuralVerdict: 'fail',
    judge: judgeSaid('pass', 1),
    minConfidence: 0.55,
  });
  assert.equal(r.verdict, 'fail');
  assert.match(r.reason, /cannot upgrade/);
});

test('ladder 3: an error-severity issue fails', () => {
  const r = mergeVerdict({
    structuralVerdict: 'pass',
    judge: judgeSaid('pass', 1, [{ severity: 'error', detail: 'the date is stated twice, differently' }]),
    minConfidence: 0.55,
  });
  assert.equal(r.verdict, 'fail');
  assert.match(r.reason, /stated twice/);
});

test('ladder 3: a warning-severity issue does NOT fail', () => {
  const r = mergeVerdict({
    structuralVerdict: 'pass',
    judge: judgeSaid('pass', 0.8, [{ severity: 'warning', detail: 'terse' }]),
    minConfidence: 0.55,
  });
  assert.equal(r.verdict, 'pass');
});

test('ladder 4: the confidence gate is real, not decorative', () => {
  const low = mergeVerdict({
    structuralVerdict: 'pass',
    judge: judgeSaid('pass', 0.4),
    minConfidence: 0.55,
  });
  assert.equal(low.verdict, 'escalate');
  assert.match(low.reason, /below the gate/);

  const ok = mergeVerdict({
    structuralVerdict: 'pass',
    judge: judgeSaid('pass', 0.56),
    minConfidence: 0.55,
  });
  assert.equal(ok.verdict, 'pass');
});

test('ladder 4: a percentage confidence passes the gate rather than tripping it', () => {
  // The whole point of normalizing on READ: `95` must not be read as "95 > 0.55, fine"
  // by accident, nor as a schema violation that escalates a good page.
  const r = mergeVerdict({
    structuralVerdict: 'pass',
    judge: judgeSaid('pass', 95),
    minConfidence: 0.55,
  });
  assert.equal(r.verdict, 'pass');
  assert.match(r.reason, /0\.95/);
});

test('ladder 4: no stated confidence escalates', () => {
  const r = mergeVerdict({
    structuralVerdict: 'pass',
    judge: judgeSaid('pass', null),
    minConfidence: 0.55,
  });
  assert.equal(r.verdict, 'escalate');
});

test('ladder: "fail" with nothing at error severity is a contradiction, not a fail', () => {
  const r = mergeVerdict({
    structuralVerdict: 'pass',
    judge: judgeSaid('fail', 0.9, [{ severity: 'note', detail: 'feels thin' }]),
    minConfidence: 0.55,
  });
  assert.equal(r.verdict, 'escalate');
  assert.match(r.reason, /no error-severity issue/);
});

test('ladder: a tier-1 review the judge clears becomes a pass', () => {
  const r = mergeVerdict({
    structuralVerdict: 'review',
    judge: judgeSaid('pass', 0.9),
    minConfidence: 0.55,
  });
  assert.equal(r.verdict, 'pass');
  assert.match(r.reason, /warnings/);
});

/* --------------------------------------------------------- the two judge contracts */

const BRIEF = `# Production requirements — demo

**REQUIREMENTS STATUS: DRAFT**

## EN QA Requirements

What a page in this group must contain, judged on its own with no comparison at all.

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| E1 | The page states its event date | ✓ (see note) | prose, not only metadata |
| E2 | The header line must read "AEM Global Developer Collective" | ✓ | |
| E3 | Body length varies with status | ~ | |
| E4 | Site chrome is out of scope | ✗ | shared fragments |

## QA Requirements

Compare the translated page against its English source and judge content fidelity.

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| Q1 | The location is byte-identical to English | ✓ | DNT. "Berlin" stays "Berlin" |
| Q2 | May a locale substitute a dubbed recording? | ? | nobody has decided |

## Visual QA

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
| V1 | The tile grid reflows at 390px | ✓ | |
`;

test('the EN judge and the translation judge get DIFFERENT sections', () => {
  const en = enJudgeBrief(BRIEF);
  const tx = judgeBrief(BRIEF);
  assert.match(en, /EN QA Requirements/);
  assert.match(tx, /^## QA Requirements/m);
  // The measured failure: handed the translation contract, the EN judge reported an
  // English page for "lacking translated content" and for a location that "should be
  // byte-identical to the English source".
  assert.doesNotMatch(en, /byte-identical/);
  assert.doesNotMatch(tx, /judged on its own/);
});

test('a missing EN section returns null and NEVER falls back to the translation one', () => {
  const noEn = BRIEF.replace(/## EN QA Requirements[\s\S]*?(?=## QA Requirements)/, '');
  assert.equal(enJudgeBrief(noEn), null);
  assert.notEqual(judgeBrief(noEn), null);
  const readiness = requirementsReadiness(noEn, (s) => s.forEnJudge);
  assert.equal(readiness.state, 'missing');
  assert.match(readiness.warnings[0], new RegExp(EN_JUDGE_SECTION));
});

test('readiness is per section: EN ready while translation is blocked', () => {
  assert.equal(requirementsReadiness(BRIEF, (s) => s.forEnJudge).state, 'ready');
  assert.equal(requirementsReadiness(BRIEF).state, 'blocked');
  assert.equal(requirementsReadiness(BRIEF).unresolved[0].ref, 'Q2');
});

/* --------------------------------------------------------------- brief parsing */

test('a glyph with trailing prose still counts — the upstream parser dropped it', () => {
  assert.equal(glyphOf('✓ (see note)').id, 'must');
  assert.equal(glyphOf('  ~ within reason').id, 'may');
  assert.equal(glyphOf('probably'), null);
});

test('an annotated row reaches the judge; a ? row and a ✗ row do not', () => {
  const shown = filterBrief(enJudgeBrief(BRIEF));
  assert.match(shown, /E1/);
  assert.match(shown, /E3/);
  assert.doesNotMatch(shown, /E4/, '✗ rows do not apply and are dropped');
  const tx = filterBrief(judgeBrief(BRIEF));
  assert.doesNotMatch(tx, /Q2/, '? rows are unknowns and must not be shown as either approved or required');
});

test('audit mode keeps ? rows, because in audit mode they are the work', () => {
  const audited = filterBrief(judgeBrief(BRIEF), true);
  assert.match(audited, /Q2/);
});

test('filterBrief strips the human-only sections and reviewer blockquotes', () => {
  const withNote = BRIEF.replace('## Visual QA', '> a note from one reviewer to another\n\n## Visual QA');
  const shown = filterBrief(withNote);
  assert.doesNotMatch(shown, /390px/, 'a text judge shown a layout criterion reports on layout it cannot see');
  assert.doesNotMatch(shown, /one reviewer to another/);
});

test('a verbatim literal comes from the Requirement cell, never from the Note', () => {
  const strings = verbatimRequirements(enJudgeBrief(BRIEF));
  assert.deepEqual(strings, ['AEM Global Developer Collective']);
  // The measured false positive: the meetups brief's Q3 NOTE reads *The word "Berlin"
  // appearing as "Berlin" in every locale is correct*. Read as a requirement, that
  // failed 12 of 14 live pages for not mentioning Berlin. A Note is an explanation.
  assert.ok(!verbatimRequirements(judgeBrief(BRIEF)).includes('Berlin'));
});

test('a row with the Status column moved still parses', () => {
  const rows = parseRows('| Status | ID | Requirement |\n| --- | --- | --- |\n| ✓ | E9 | a thing |');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'must');
  assert.equal(rows[0].ref, 'E9');
});

test('a brief survives the round trip through DA HTML', () => {
  const back = htmlToBrief(briefToHtml(BRIEF));
  assert.equal(requirementsReadiness(back, (s) => s.forEnJudge).state, 'ready');
  assert.equal(requirementsReadiness(back).unresolved.length, 1);
  assert.deepEqual(verbatimRequirements(enJudgeBrief(back)), ['AEM Global Developer Collective']);
});

/* ------------------------------------------------------------- the prompt payload */

const REPORT = {
  'page-path': '/en/meetups/x',
  group: 'meetups',
  mode: 'baseline',
  tiers: {
    structural: {
      verdict: 'review',
      checks: [
        { check: 'links', verdict: 'pass' },
        { check: 'headings', verdict: 'skip', detail: 'no requiredHeadings' },
        { check: 'image-alt', verdict: 'warn', findings: [{ verdict: 'warn', detail: 'empty alt on hero.jpg' }] },
      ],
    },
  },
  evidence: { textSample: { target: 'A meetup in Berlin. filepath /content/dam/x mode pdf' } },
};

test('the judge sees only the checks that are not passing', () => {
  const { user } = buildPrompt(REPORT, { brief: 'contract', auditMode: false });
  assert.match(user, /empty alt on hero\.jpg/);
  assert.doesNotMatch(user, /"check": "links"/, 'a passing check is noise');
  assert.doesNotMatch(user, /no requiredHeadings/, 'a skipped check is not evidence');
});

test('no brief means a DIFFERENT system prompt, not a silent judgement', () => {
  const withBrief = buildPrompt(REPORT, { brief: 'contract', auditMode: false });
  const without = buildPrompt(REPORT, { brief: null, auditMode: false });
  assert.notEqual(withBrief.system, without.system);
  assert.match(without.system, /There is NO\s+requirements brief/);
  assert.doesNotMatch(without.user, /QA REQUIREMENTS/);
});

test('block config that is invisible on the page is stripped from the evidence', () => {
  const out = stripEdsArtifacts('A meetup in Berlin. filepath /content/dam/x mode pdf');
  assert.equal(out, 'A meetup in Berlin.');
});

test('stripEdsArtifacts leaves real prose about a mode or a path alone', () => {
  const prose = 'The talk covered mode switching and the filepath convention in AEM.';
  assert.equal(stripEdsArtifacts(prose), prose);
});

/* ---------------------------------------------------- blocks vs section styles */

test('a block with a directory and a CSS-only block are both recognised', () => {
  const known = knownBlockNames();
  assert.ok(known.has('callout'), 'blocks/callout/ exists');
  assert.ok(known.has('embed'));
  assert.ok(!known.has('not-a-real-block-xyz'));
});

test('section styles are a separate namespace, matched on .section.<name>', () => {
  const styles = knownSectionStyles();
  assert.ok(styles.has('key-points'), 'styles/sections.css declares .section.key-points');
  assert.ok(!styles.has('callout'), 'a block is not a section style');
});

test('a top-level classed div is a SECTION STYLE, one level deeper is a BLOCK', () => {
  const plain = '<body>'
    + '<div class="key-points"><div><div>takeaways</div></div></div>'
    + '<div><div class="callout"><div><div>hi</div></div></div></div>'
    + '</body>';
  // The upstream extractor used only the block selector, so `key-points` — a real
  // section style on this site's meetup recap page — was invisible to it entirely.
  assert.deepEqual(extractSectionStyles(plain), ['key-points']);
  assert.deepEqual(extractBlocks(plain), ['callout']);
});

/* ------------------------------------------------------------------- extraction */

test('metadata blocks are removed before the text is read, not regexed out of it', () => {
  const plain = '<body><div><p>Real prose.</p>'
    + '<div class="metadata"><div><div>template</div><div>meetup</div></div></div>'
    + '</div></body>';
  const got = extractContent(plain, 'https://example.test/en/x', 'body');
  assert.equal(got.text, 'Real prose.');
  assert.equal(got.words, 2);
});

test('a missing alt and an empty alt are different findings', () => {
  const plain = '<body><div>'
    + '<img src="a.jpg">'
    + '<img src="b.jpg" alt="">'
    + '<img src="c.jpg" alt="A speaker at a lectern">'
    + '</div></body>';
  const { images } = extractContent(plain, 'https://example.test/en/x', 'body');
  assert.equal(images[0].alt, null, 'no attribute at all — an authoring miss');
  assert.equal(images[1].alt, '', 'declared decorative');
  assert.equal(images[2].alt, 'A speaker at a lectern');
});

test('a <picture> counts its asset once, and the alt comes off the <img>', () => {
  const plain = '<body><div><picture>'
    + '<source srcset="hero.jpg?width=2000">'
    + '<img src="hero.jpg?width=750" alt="">'
    + '</picture></div></body>';
  const { images } = extractContent(plain, 'https://example.test/en/x', 'body');
  assert.equal(images.length, 1);
  assert.equal(images[0].alt, '');
});

test('verbatim comparison folds typography on both sides and nothing else', () => {
  const text = 'The date is 28–30 September and it’s in Berlin';
  assert.deepEqual(missingVerbatim(text, ['28-30 September', "it's in berlin"]), []);
  assert.deepEqual(missingVerbatim(text, ['28-31 September']), ['28-31 September']);
});

test('heading diffs are by folded text, so trailing punctuation is not a defect', () => {
  const a = [{ level: 2, text: 'What to expect:' }];
  const b = [{ level: 3, text: 'What to expect' }];
  assert.deepEqual(diffHeadings(a, b).missing, []);
});

/* -------------------------------------------------------------- calibration seed */

test('a calibrated requiredHeadings entry is an anchored, escaped regex', () => {
  const b = deriveBaseline('demo', '/en/x', {
    evidence: { words: 120, headings: ['h2: adaptTo() 2026 (Berlin)'], blocks: ['embed'], sectionStyles: [] },
  });
  assert.deepEqual(b.requiredHeadings, ['^adaptTo\\(\\) 2026 \\(Berlin\\)$']);
  // Unescaped, `(` would be a capture group and `)` a syntax error — a calibration
  // that writes an invalid regex fails the whole group on its first real run.
  assert.ok(new RegExp(b.requiredHeadings[0], 'i').test('adaptTo() 2026 (Berlin)'));
  assert.equal(b.words.reference, 120);
  assert.equal(b.knownBlocks[0], 'embed');
});

/* ------------------------------------------------------------------ the batch list */

test('a pairs file yields page paths and the header the branch gate reads', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'qa-pairs-'));
  const file = join(dir, 'pairs.txt');
  await writeFile(file, [
    '# emit-pairs · generated 2026-08-24T00:00:00Z on somehost',
    '# group=meetups locale=(en side) branch=main',
    '# selector: stage:enPublished',
    'https://main--aemdev--aemgdc.aem.page/en/meetups/a\thttps://da.live/edit#/x',
    'https://main--aemdev--aemgdc.aem.page/en/\thttps://da.live/edit#/y',
    '',
  ].join('\n'));
  const { header, paths } = readPairsFile(file);
  assert.equal(header.group, 'meetups');
  assert.equal(header.branch, 'main', 'G7 compares this against the run\'s branch');
  // `/en/` normalizes to `/en` — the live index spells it with the trailing slash and
  // the slashed form 404s on this site, so an un-normalized join makes it two pages.
  assert.deepEqual(paths, ['/en/meetups/a', '/en']);
});
