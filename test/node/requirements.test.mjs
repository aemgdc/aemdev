/**
 * requirements.test.mjs — the judge's contract, and the `?` gate.
 *
 *   npm run test:node          (node --test "test/node/*.test.mjs")
 *
 * Two things are checked here. First, the parse rules, including every brittleness the
 * upstream parser had: an annotated glyph that silently did not match, `?` and `✗` rows
 * dropped without a word, and a brief that resolved to zero rows and returned `null` — a
 * judge running with no contract at all, reporting nothing wrong.
 *
 * Second, THE FOUR REAL BRIEFS on disk. They are the deliverable, so they are asserted:
 * every one must parse, carry the highlight rows it exists for, and be honest about what
 * is still open. A brief that quietly loses its `code`-blocks-are-byte-identical row is
 * a group whose whole reason for a separate contract is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  GLYPHS,
  JUDGE_SECTION,
  MIN_WORDS,
  REQ_MARKERS,
  glyphOf,
  parseRows,
  splitSections,
  judgeBrief,
  requirementsReadiness,
  briefToHtml,
  htmlToBrief,
  localBriefPath,
  isAuditMode,
} from '../../tools/tracker/lib/requirements.mjs';

const GROUPS = ['indexes', 'meetups', 'technical-articles', 'bios'];

const brief = (rows, extra = '') => `# Production requirements — x

**REQUIREMENTS STATUS: DRAFT**

**SCOPE:** everything under test
${extra}
## ${JUDGE_SECTION}

Compare the translated page against its English source, row by row, and report only what
these rows actually say.

| ID | Requirement | Status | Note |
| --- | --- | --- | --- |
${rows.join('\n')}
`;

/* --------------------------------------------------------------- the glyph rules */

test('the glyph is the first non-space character, so an annotation still parses', () => {
  // The upstream parser matched a cell that was EXACTLY `✓`, so `✓ (see note)` silently
  // did not match and a conscientious author lost a requirement.
  assert.equal(glyphOf('✓').id, 'must');
  assert.equal(glyphOf('  ✓ (see note)').id, 'must');
  assert.equal(glyphOf('~ within 1.3×').id, 'may');
  assert.equal(glyphOf('? nobody has decided').id, 'unresolved');
  assert.equal(glyphOf('✗ approved').id, 'removed');
});

test('a cell naming no glyph is reported, never silently dropped', () => {
  assert.equal(glyphOf('yes'), null);
  assert.equal(glyphOf(''), null);
  const r = requirementsReadiness(brief(['| Q1 | a thing | yes | |']));
  assert.equal(r.counts.rows, 1, 'the row survives');
  assert.equal(r.counts.unknown, 1);
  assert.match(r.warnings.join(' '), /Q1: status "yes" names no glyph/);
});

test('a row keeps its own ID — the glyph classification does not shadow it', () => {
  const rows = parseRows(brief(['| Q7 | a thing | ✓ | a note |']));
  assert.equal(rows[0].ref, 'Q7');
  assert.equal(rows[0].kind, 'must');
  assert.equal(rows[0].note, 'a note');
});

test('a row with no ID still gets a usable reference', () => {
  const rows = parseRows('| ID | Requirement | Status |\n| --- | --- | --- |\n|  | a thing | ✓ |');
  assert.equal(rows[0].ref, 'row 1');
});

test('every glyph the model defines is classified', () => {
  const rows = GLYPHS.map((g, i) => `| Q${i} | thing ${i} | ${g.glyph} | |`);
  const r = requirementsReadiness(brief(rows));
  assert.equal(r.counts.rows, GLYPHS.length);
  assert.equal(r.counts.unknown, 0);
});

/* ------------------------------------------------------------------- the `?` gate */

test('a single `?` row BLOCKS, and the row is named', () => {
  const r = requirementsReadiness(brief([
    '| Q1 | code blocks are byte-identical | ✓ | |',
    '| Q2 | is the nav in scope | ? | nobody has said |',
  ]));
  assert.equal(r.state, 'blocked');
  assert.equal(r.counts.unresolved, 1);
  assert.equal(r.unresolved[0].ref, 'Q2');
  assert.equal(r.unresolved[0].note, 'nobody has said');
});

test('`ready` requires every row decided', () => {
  const r = requirementsReadiness(brief([
    '| Q1 | a must | ✓ | |',
    '| Q2 | a may | ~ | how far |',
    '| Q3 | a removal | ✗ | approved |',
  ]));
  assert.equal(r.state, 'ready');
  assert.deepEqual(
    [r.counts.must, r.counts.may, r.counts.removed, r.counts.unresolved],
    [1, 1, 1, 0],
  );
});

test('`empty` and `missing` are distinct states, because they need different fixes', () => {
  assert.equal(requirementsReadiness(brief([])).state, 'empty');
  assert.equal(requirementsReadiness('# x\n\n## Content Requirements\n\nnothing here\n').state, 'missing');
  assert.match(requirementsReadiness('').warnings.join(' '), /no "## QA Requirements" section/);
});

/* --------------------------------------------------------------- judgeBrief only */

test('judgeBrief returns the QA section ALONE', () => {
  const md = brief(['| Q1 | a thing | ✓ | |'], `
## Content Requirements

CONTENT-ONLY-MARKER, for humans.

## Visual QA

VISUAL-ONLY-MARKER: tile grid reflow at 390px.
`);
  const out = judgeBrief(md);
  assert.ok(out.startsWith(`## ${JUDGE_SECTION}`));
  assert.ok(!out.includes('CONTENT-ONLY-MARKER'));
  // A text judge shown a layout criterion reports confidently on layout it cannot see.
  assert.ok(!out.includes('VISUAL-ONLY-MARKER'));
});

test('judgeBrief returns null for a stub, so a judge cannot run on nothing by accident', () => {
  assert.equal(judgeBrief(`## ${JUDGE_SECTION}\n\ntoo short\n`), null);
  assert.equal(judgeBrief('# nothing at all'), null);
  assert.equal(judgeBrief(''), null);
  const stub = requirementsReadiness(`## ${JUDGE_SECTION}\n\ntoo short\n`);
  assert.match(stub.warnings.join(' '), new RegExp(`under ${MIN_WORDS} words`));
});

test('a `Part N —` heading ornament does not change which section is which', () => {
  const md = `## Part 3 — ${JUDGE_SECTION}\n\n${'word '.repeat(20)}\n`;
  const { sections } = splitSections(md);
  assert.equal(sections[0].id, 'qa');
  assert.ok(judgeBrief(md));
  // And with a plain hyphen, which is what broke the upstream em-dash literal.
  assert.ok(judgeBrief(`## Part 3 - ${JUDGE_SECTION}\n\n${'word '.repeat(20)}\n`));
});

/* ------------------------------------------------------------------- the markers */

test('the document markers parse bold and bare alike', () => {
  const bold = '**REQUIREMENTS STATUS: READY**\n\n**SCOPE:** all of it\n\n**Golden master:** /en/x\n';
  assert.equal(REQ_MARKERS.status.exec(bold)[1].trim(), 'READY');
  assert.equal(REQ_MARKERS.scope.exec(bold)[1], 'all of it');
  assert.equal(REQ_MARKERS.golden.exec(bold)[1], '/en/x');
  const bare = 'REQUIREMENTS STATUS: DRAFT\nSCOPE: all\nGolden master: none\n';
  assert.equal(REQ_MARKERS.status.exec(bare)[1].trim(), 'DRAFT');
  assert.equal(REQ_MARKERS.scope.exec(bare)[1], 'all');
});

test('an unrecognised REQUIREMENTS STATUS is a warning, not a silent pass', () => {
  const r = requirementsReadiness(brief(['| Q1 | a thing | ✓ | |']).replace('DRAFT', 'PROVISIONAL'));
  assert.match(r.warnings.join(' '), /is not DRAFT or READY/);
});

/* ------------------------------------------------------------ the DA round trip */

test('briefToHtml → htmlToBrief keeps the rows and the section headings', () => {
  const md = brief([
    '| Q1 | `code` blocks are byte-identical | ✓ | DNT |',
    '| Q2 | prose may change | ~ | expected |',
  ]);
  const back = htmlToBrief(briefToHtml(md));
  const r = requirementsReadiness(back);
  assert.equal(r.counts.rows, 2);
  assert.equal(r.counts.must, 1);
  assert.equal(r.counts.may, 1);
  /*
   * The marker has to survive too. `htmlToBrief` collapses runs of spaces to one, so the
   * marker comes back with a leading space — and with the anchor allowing no whitespace,
   * the DA copy of every brief silently had no REQUIREMENTS STATUS while the identical
   * local file parsed fine.
   */
  assert.equal(r.marker, 'DRAFT', `marker lost in the round trip: ${JSON.stringify(r.marker)}`);
  assert.equal(r.scope, 'everything under test');
  assert.ok(judgeBrief(back), 'the judge section must survive the round trip');
});

test('briefToHtml carries the house DA envelope and escapes markup', () => {
  const html = briefToHtml('# x\n\nan <em>authored</em> & ampersand\n');
  assert.ok(html.startsWith('<body>'));
  assert.ok(html.includes('<main>'));
  assert.ok(html.includes('&lt;em&gt;'), 'authored angle brackets must not become markup');
  assert.ok(html.includes('&amp;'));
});

test('a heading LEVEL survives, because section splitting keys on `##`', () => {
  const html = briefToHtml(`## ${JUDGE_SECTION}\n\n### a subsection\n\nbody text here\n`);
  assert.ok(html.includes('<h2>'));
  assert.ok(html.includes('<h3>'));
  const back = htmlToBrief(html);
  assert.match(back, /^## /m);
  assert.match(back, /^### /m);
});

/* ------------------------------------------- THE FOUR REAL BRIEFS ON DISK */

test('every registered group has a brief that parses', () => {
  for (const g of GROUPS) {
    const file = localBriefPath(g);
    assert.ok(existsSync(file), `${file} is missing`);
    const md = readFileSync(file, 'utf8');
    const r = requirementsReadiness(md);
    assert.equal(r.counts.unknown, 0, `${g}: ${r.warnings.join('; ')}`);
    assert.ok(r.counts.rows >= 10, `${g} has only ${r.counts.rows} QA rows`);
    assert.ok(judgeBrief(md), `${g}: judgeBrief() returns null, so the judge has no contract`);
    assert.equal(r.marker, 'DRAFT', `${g} marker is ${JSON.stringify(r.marker)}`);
  }
});

test('every brief is BLOCKED, and honestly so — nothing is signed off yet', () => {
  for (const g of GROUPS) {
    const r = requirementsReadiness(readFileSync(localBriefPath(g), 'utf8'));
    assert.equal(r.state, 'blocked', `${g} claims to be ${r.state}`);
    assert.ok(r.counts.unresolved >= 1, `${g} has no "?" rows`);
  }
});

test('the two cross-group questions are open in all four briefs', () => {
  // Site chrome and hreflang are site-wide decisions, so a brief that quietly resolved
  // one for its own group would be answering for the other three.
  for (const g of GROUPS) {
    const r = requirementsReadiness(readFileSync(localBriefPath(g), 'utf8'));
    const refs = r.unresolved.map((u) => u.ref);
    assert.ok(refs.includes('QC1'), `${g} is missing the site-chrome question`);
    assert.ok(refs.includes('QC2'), `${g} is missing the hreflang question`);
  }
});

test('technical-articles: code blocks byte-identical, author DNT, publication date preserved', () => {
  const md = readFileSync(localBriefPath('technical-articles'), 'utf8');
  const { rows } = requirementsReadiness(md);
  const must = rows.filter((r) => r.kind === 'must');
  const text = (list) => list.map((r) => `${r.requirement} ${r.note}`).join('\n');
  assert.match(text(must), /`code` BLOCK is byte-identical/);
  assert.match(text(must), /inline `code` SPAN is byte-identical/);
  assert.match(text(must), /AUTHOR NAME is byte-identical/);
  assert.match(text(must), /PUBLICATION DATE is present and denotes the same day/);
  // And the highlight reaches the model, not just the file.
  assert.match(judgeBrief(md), /byte-identical/);
});

test('meetups: date, location and speaker names DNT; the recap embed must survive', () => {
  const md = readFileSync(localBriefPath('meetups'), 'utf8');
  const must = requirementsReadiness(md).rows.filter((r) => r.kind === 'must');
  const text = must.map((r) => `${r.requirement} ${r.note}`).join('\n');
  assert.match(text, /EVENT DATE is present and denotes the same day/);
  assert.match(text, /LOCATION .* is byte-identical/);
  assert.match(text, /SPEAKER NAMES are byte-identical/);
  assert.match(text, /RECAP VIDEO EMBED survives/);
});

test('bios: Name / LinkedIn / Image DNT; Title / Company / prose may change', () => {
  const md = readFileSync(localBriefPath('bios'), 'utf8');
  const { rows } = requirementsReadiness(md);
  const must = rows.filter((r) => r.kind === 'must').map((r) => r.requirement).join('\n');
  const may = rows.filter((r) => r.kind === 'may').map((r) => r.requirement).join('\n');
  assert.match(must, /`Name` is byte-identical/);
  assert.match(must, /`LinkedIn` URL is byte-identical/);
  assert.match(must, /`Image` path is byte-identical/);
  assert.match(may, /`Title`.*is translated/);
  assert.match(may, /`Company` is translated/);
  assert.match(may, /`Bio` body prose is translated/);
});

test('indexes: item count, order and titles are `~` — a count difference is NOT a finding', () => {
  /*
   * Getting this wrong fails every index page in every locale on every run. So it is
   * asserted at the glyph level, not just in the prose: the three rows must be `~`,
   * because `✓` on any of them turns a rollout in progress into a permanent defect.
   */
  const md = readFileSync(localBriefPath('indexes'), 'utf8');
  const { rows } = requirementsReadiness(md);
  const byRef = Object.fromEntries(rows.map((r) => [r.ref, r]));
  for (const ref of ['Q1', 'Q2', 'Q3']) {
    assert.equal(byRef[ref].kind, 'may', `${ref} must be "~", got ${byRef[ref].status}`);
  }
  assert.match(byRef.Q1.requirement, /NUMBER of items/);
  assert.match(byRef.Q1.note, /NOT a finding/);
  assert.match(byRef.Q2.requirement, /ORDER of items/);
  assert.match(byRef.Q3.requirement, /item TITLES/);
  // The instruction has to reach the model or it protects nothing.
  assert.match(judgeBrief(md), /Never report a count difference/);
});

test('indexes declares JUDGE_MODE: audit — its content is assembled at runtime', () => {
  assert.equal(isAuditMode(readFileSync(localBriefPath('indexes'), 'utf8')), true);
  for (const g of ['meetups', 'technical-articles', 'bios']) {
    assert.equal(isAuditMode(readFileSync(localBriefPath(g), 'utf8')), false, g);
  }
});

test('a JUDGE_MODE declaration inside a blockquote is instruction, not a declaration', () => {
  /*
   * BRIEF-TEMPLATE.md explains audit mode inside a `> ` quote. A grep over the whole
   * document made every freshly scaffolded brief claim `JUDGE_MODE: audit`, which
   * switches the judge from comparing a page against its source to auditing it against
   * a checklist — a silent change of what a verdict means.
   */
  assert.equal(isAuditMode('JUDGE_MODE: audit'), true);
  assert.equal(isAuditMode('> use JUDGE_MODE: audit for index pages'), false);
  assert.equal(isAuditMode('>   JUDGE_MODE: audit'), false);
  const template = join(localBriefPath('x'), '..', 'BRIEF-TEMPLATE.md');
  assert.equal(isAuditMode(readFileSync(template, 'utf8')), false, 'a scaffolded brief must not be audit mode');
});

test('BRIEF-TEMPLATE.md still carries the <group> placeholder the scaffold fills', () => {
  const template = join(localBriefPath('x'), '..', 'BRIEF-TEMPLATE.md');
  const md = readFileSync(template, 'utf8');
  assert.ok(md.includes('<group>'), 'the scaffold substitutes this');
  assert.match(md, /^\**REQUIREMENTS STATUS:/m);
  // A freshly scaffolded brief must BLOCK: every row seeded `?`.
  assert.equal(requirementsReadiness(md).state, 'blocked');
});
