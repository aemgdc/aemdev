/**
 * requirements.mjs — the judge's contract: how a group's requirements brief is parsed,
 * what blocks a batch, and what the model is allowed to see.
 *
 * The brief lives at `.tracker/qa-requirements/<group>-brief.md` and is mirrored to DA
 * at `requirementsPath(group)`. It is the ONE document a human writes that the judge
 * reads, so its parse rules are a contract in exactly the sense
 * docs/tracker/data-contract.md section 6 means: a change here changes what a verdict
 * means.
 *
 * ─── THE FOUR GLYPHS, AND WHY `?` IS A GATE ────────────────────────────────
 *
 *   ✓  must survive verbatim. The judge FAILS the page if it is missing or altered.
 *   ~  may change. The judge must NOT flag it — with a note saying how far.
 *   ✗  an approved removal. Absent by decision, not by accident.
 *   ?  UNRESOLVED. Nobody has decided.
 *
 * A brief containing any `?` row BLOCKS the batch. The judge escalates those pages
 * rather than passing them silently, because a requirement nobody could state is not a
 * requirement a model can check — and a model asked to check an unstated requirement
 * invents one. This is a gate, not a warning, and `?` is therefore the correct thing to
 * write when the answer is not yours to invent.
 *
 * ─── ONLY ONE SECTION REACHES THE MODEL ────────────────────────────────────
 *
 * `judgeBrief()` returns the `## QA Requirements` section ALONE, or `null`. The
 * Content and Implementation sections are for humans and would only dilute the
 * instruction; the Visual section describes checks a different tier performs, and a
 * text judge shown "tile grid reflow at 390px" will confidently report on layout it
 * cannot see.
 *
 * ─── THE UPSTREAM PARSER'S BRITTLENESS, FIXED HERE DELIBERATELY ────────────
 *
 * The parser this replaces matched a status cell that was EXACTLY `✓` or `~`. So
 * `✓ (see note)` silently did not match, `?` and `✗` rows were dropped without a word,
 * and a brief whose every row was annotated resolved to zero requirements and returned
 * `null` — a judge running with no contract at all, reporting nothing wrong.
 *
 * Here the glyph is the FIRST non-space character of the status cell, every glyph is
 * classified, an unrecognised status is REPORTED rather than dropped, and a brief that
 * parses to zero rows is a distinct, named state. Trailing prose in a status cell is
 * normal — a human annotating a decision is doing the right thing.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { previewUrl, requirementsPath } from '../../../scripts/tracker/paths.js';
import { REPO_ROOT, CONFIG_DIR } from '../config.mjs';

/** Status glyphs, and what each one obliges. */
export const GLYPHS = [
  { glyph: '✓', id: 'must', label: 'must survive verbatim', resolved: true },
  { glyph: '~', id: 'may', label: 'may change', resolved: true },
  { glyph: '✗', id: 'removed', label: 'approved removal', resolved: true },
  { glyph: '?', id: 'unresolved', label: 'UNRESOLVED — blocks the batch', resolved: false },
];

const GLYPH_BY_CHAR = new Map(GLYPHS.map((g) => [g.glyph, g]));

/**
 * The brief's sections, and which one the judge is shown.
 *
 * Matched on the heading TEXT, case-folded, with any leading `Part N —` stripped. The
 * upstream `filterBrief` hardwired `## Part 4 — Visual` with an em-dash, so a brief
 * authored with a hyphen silently sent the visual section to a text judge. Matching the
 * name and tolerating the ornament is the fix.
 */
export const REQ_SECTIONS = [
  { id: 'content', heading: 'Content Requirements', forJudge: false },
  { id: 'implementation', heading: 'Implementation Requirements', forJudge: false },
  { id: 'en-qa', heading: 'EN QA Requirements', forJudge: false, forEnJudge: true },
  { id: 'qa', heading: 'QA Requirements', forJudge: true },
  { id: 'visual', heading: 'Visual QA', forJudge: false },
  { id: 'open', heading: 'Open Questions', forJudge: false },
];

/**
 * TWO judges, TWO contracts, and they are not interchangeable.
 *
 * `QA Requirements` is the TRANSLATION contract: its rows compare a translated page
 * against its English source, and they read "byte-identical to English", "is
 * translated", "DNT". `EN QA Requirements` is what the English-side judge
 * (tools/tracker/judge.mjs, baseline mode) is shown: what a page in this group must
 * CONTAIN, with no comparison in it.
 *
 * The section exists because giving the EN judge the translation contract does not
 * degrade gracefully — it fails good pages. Measured twice, on
 * /en/meetups/aem-gdc-june-2026-eds-cdn-recap, a page tier 1 passes with zero findings:
 * the 14B judge returned error-severity issues reading "The page content is in English
 * and lacks translated content" and "The LOCATION is missing. The page should be
 * byte-identical to the English source." A paragraph in the system prompt telling it
 * that translation rows are out of scope did not stop it — the same thing the pipeline
 * this was ported from recorded about negative constraints and a 14B.
 *
 * So the fix is structural: a judge is shown the contract written for it, or none.
 * `enJudgeBrief()` returns null when the section is absent, and the EN judge then
 * judges intrinsic completeness only (truncation, placeholders, duplication, leaked
 * authoring artifacts) rather than against somebody else's criteria.
 */
export const JUDGE_SECTION = REQ_SECTIONS.find((s) => s.forJudge).heading;

/** The section the ENGLISH-side judge sees. */
export const EN_JUDGE_SECTION = REQ_SECTIONS.find((s) => s.forEnJudge).heading;

/**
 * Minimum words for a section to count as written.
 *
 * A heading with a stub under it is the shape a scaffold leaves behind, and it must not
 * read as a contract. 12 is inherited from the upstream parser and is roughly one real
 * sentence — below that there is nothing for a judge to check against.
 */
export const MIN_WORDS = 12;

/**
 * Document-level markers a human sets by hand.
 *
 * Bold emphasis is TOLERATED on both sides — `**REQUIREMENTS STATUS: DRAFT**` is how
 * BRIEF-TEMPLATE.md writes it, and it is the natural thing to type, so a parser that
 * only matched the bare form would read every templated brief as having no marker at
 * all and report a warning nobody could act on. The value stops at the closing
 * emphasis rather than swallowing it.
 *
 * LEADING WHITESPACE is tolerated for a sharper reason: `htmlToBrief` collapses runs of
 * spaces to one, so a marker coming back from the DA copy arrives as ` REQUIREMENTS
 * STATUS: DRAFT` — one leading space. Anchored with no allowance for it, the DA copy of
 * every brief silently had no marker, while the identical local file parsed fine. A
 * parser that disagrees with itself about the same document depending on which side of
 * a round trip it read is worse than one that never worked.
 */
export const REQ_MARKERS = {
  status: /^[ \t]*\**REQUIREMENTS STATUS:\**[ \t]*([^*\n]+)/im,
  scope: /^[ \t]*\**SCOPE:\**[ \t]*([^\n]+?)\**[ \t]*$/im,
  golden: /^[ \t]*\**Golden master:\**[ \t]*([^\n]+?)\**[ \t]*$/im,
};

/** `REQUIREMENTS STATUS:` values, and whether the brief claims to be finished. */
export const REQ_MARKER_READINESS = { DRAFT: false, READY: true };

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

/** Heading text with the decorative `Part N —` (or `-`, or `:`) prefix removed. */
const headingName = (raw) => String(raw || '')
  .replace(/^\s*part\s+\d+\s*[—–\-:]\s*/i, '')
  .trim();

/* --------------------------------------------------------------- section splitting */

/**
 * Split a brief into its `##` sections, keeping the raw text of each.
 *
 * Text before the first `##` is the preamble (title plus the markers) and is returned
 * under `preamble` rather than discarded — that is where `REQUIREMENTS STATUS:` lives.
 */
export function splitSections(md) {
  const lines = String(md || '').split('\n');
  const sections = [];
  const preamble = [];
  const known = (name) => REQ_SECTIONS
    .find((s) => s.heading.toLowerCase() === name.toLowerCase());
  let current = null;
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      const name = headingName(m[1]);
      const spec = known(name);
      current = {
        heading: m[1].trim(),
        name,
        lines: [],
        id: spec ? spec.id : null,
        forJudge: Boolean(spec?.forJudge),
      };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble: preamble.join('\n'), sections };
}

/**
 * One named section's body, or `null`.
 *
 * `null` for three distinct reasons, and a caller MUST treat all three as "no
 * contract": the section is absent, it is present but under `MIN_WORDS`, or the brief
 * itself is empty. A judge handed `null` must say so rather than judge — running with
 * no contract while believing it has one produces a confident pass on a page nobody
 * specified.
 */
function sectionBrief(md, pick) {
  /*
   * Matched by `id`, resolved from REQ_SECTIONS — not by reading a flag off the parsed
   * section. `splitSections` copies only `forJudge` onto what it returns, so a
   * predicate testing any other flag silently finds nothing: the EN section parsed
   * fine and `enJudgeBrief()` still returned null. Going through the registry means
   * adding a section needs no second edit in the splitter.
   */
  const wanted = REQ_SECTIONS.find(pick);
  const { sections } = splitSections(md);
  const hit = wanted ? sections.find((sec) => sec.id === wanted.id) : null;
  if (!hit) return null;
  const body = hit.lines.join('\n').trim();
  if (words(body) < MIN_WORDS) return null;
  return `## ${hit.heading}\n\n${body}\n`;
}

/**
 * The `## QA Requirements` section, verbatim, or `null`.
 *
 * `null` for three distinct reasons, and the caller MUST treat all three as "no
 * contract": the section is absent, it is present but under `MIN_WORDS`, or the brief
 * itself is empty. A judge handed `null` must escalate rather than judge — running with
 * no contract produces a confident pass on a page nobody specified.
 */
export function judgeBrief(md) {
  return sectionBrief(md, (s) => s.forJudge);
}

/**
 * The `## EN QA Requirements` section, verbatim, or `null`.
 *
 * `null` is a legitimate and common answer, and it must NOT fall back to the
 * translation section — see the note on `EN_JUDGE_SECTION`. A judge with no contract
 * that knows it has no contract is strictly better than a judge confidently applying
 * the wrong one.
 */
export function enJudgeBrief(md) {
  return sectionBrief(md, (s) => s.forEnJudge);
}

/* ----------------------------------------------------------------- table parsing */

const isSeparator = (cells) => cells.length && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));

/**
 * Split one markdown table row into trimmed cells.
 *
 * Exported so `filterBrief` classifies a row with the SAME splitter `parseRows` uses.
 * A second four-line copy of this is precisely how two functions come to disagree
 * about which cell held the glyph.
 */
export function cellsOf(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  return trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/**
 * The glyph a status cell carries.
 *
 * The FIRST non-space character, not the whole cell. `✓ (see note)` is a human being
 * conscientious, and a parser that reads it as "no status" turns conscientiousness into
 * a dropped requirement.
 *
 * @returns {{ glyph, id, label, resolved }|null} null when the cell names no glyph
 */
export function glyphOf(cell) {
  const first = String(cell || '').trim().charAt(0);
  return GLYPH_BY_CHAR.get(first) || null;
}

/**
 * Parse the requirement rows out of one section's text.
 *
 * Expects `| ID | Requirement | Status | Note |`. A row whose status names no glyph is
 * returned with `glyph: null` and reported by `requirementsReadiness` — never dropped,
 * because a mistyped glyph is indistinguishable from a missing requirement once the row
 * is gone.
 */
export function parseRows(sectionText) {
  const rows = [];
  let header = null;
  /*
   * Column by NAME where the header supplies one, by POSITION otherwise. A brief
   * hand-edited into a different column order must still parse — the glyph is the
   * load-bearing cell and losing it to a moved column is a silently unenforced
   * requirement.
   */
  const cellAt = (cells, name, fallback) => {
    const i = header.indexOf(name);
    return i >= 0 ? (cells[i] ?? '') : (cells[fallback] ?? '');
  };
  for (const line of String(sectionText || '').split('\n')) {
    const cells = cellsOf(line);
    if (cells) {
      if (!header) {
        header = cells.map((c) => c.toLowerCase());
      } else if (!isSeparator(cells)) {
        const at = (name, fallback) => cellAt(cells, name, fallback);
        const status = at('status', 2);
        const hit = glyphOf(status);
        rows.push({
          // `ref` and not `id`: the glyph classification is also called an id, and one
          // key meaning two things is how a row's own label came back as "must".
          ref: at('id', 0) || `row ${rows.length + 1}`,
          requirement: at('requirement', 1),
          status,
          note: at('note', 3),
          glyph: hit ? hit.glyph : null,
          kind: hit ? hit.id : 'unknown',
          resolved: Boolean(hit?.resolved),
        });
      }
    }
  }
  return rows;
}

/* -------------------------------------------------------------------- readiness */

/**
 * Is this brief fit to judge against, and if not, exactly why?
 *
 * @returns {{
 *   state: 'ready'|'blocked'|'empty'|'missing',
 *   marker: string, scope: string, golden: string,
 *   rows: object[], unresolved: object[], unknown: object[],
 *   counts: object, warnings: string[]
 * }}
 *
 * `state` is the whole answer and the four values are deliberately not collapsible:
 *
 *   missing  no `## QA Requirements` section at all
 *   empty    the section exists but has no requirement rows (a scaffold, untouched)
 *   blocked  at least one `?` row — the batch does not run
 *   ready    every row is decided
 *
 * `empty` and `missing` both mean the judge gets `null`, but they need different fixes
 * (author the section vs fill it in) and a tool that reports one number cannot say
 * which.
 */
export function requirementsReadiness(md, pick = (s) => s.forJudge) {
  const src = String(md || '');
  const { preamble, sections } = splitSections(src);
  const marker = (REQ_MARKERS.status.exec(src)?.[1] || '').trim();
  const scope = (REQ_MARKERS.scope.exec(src)?.[1] || '').trim();
  const golden = (REQ_MARKERS.golden.exec(src)?.[1] || '').trim();
  const warnings = [];

  const wanted = REQ_SECTIONS.find(pick);
  const qa = wanted ? sections.find((sec) => sec.id === wanted.id) : null;
  if (!qa) {
    return {
      state: 'missing',
      marker,
      scope,
      golden,
      rows: [],
      unresolved: [],
      unknown: [],
      counts: {
        rows: 0, must: 0, may: 0, removed: 0, unresolved: 0, unknown: 0,
      },
      warnings: [`no "## ${wanted.heading}" section — that judge would run with no contract`],
    };
  }

  const rows = parseRows(qa.lines.join('\n'));
  const unresolved = rows.filter((r) => r.kind === 'unresolved');
  const unknown = rows.filter((r) => r.kind === 'unknown');
  const counts = {
    rows: rows.length,
    must: rows.filter((r) => r.kind === 'must').length,
    may: rows.filter((r) => r.kind === 'may').length,
    removed: rows.filter((r) => r.kind === 'removed').length,
    unresolved: unresolved.length,
    unknown: unknown.length,
  };

  for (const r of unknown) {
    warnings.push(`${r.ref}: status ${JSON.stringify(r.status)} names no glyph — `
      + `expected one of ${GLYPHS.map((g) => g.glyph).join(' ')}`);
  }
  if (!sectionBrief(src, pick)) {
    warnings.push(`the "${wanted.heading}" section is under ${MIN_WORDS} words, so it `
      + 'resolves to null and that judge has no contract at all');
  }
  if (marker && !(marker.toUpperCase() in REQ_MARKER_READINESS)) {
    warnings.push(`REQUIREMENTS STATUS: ${JSON.stringify(marker)} is not `
      + `${Object.keys(REQ_MARKER_READINESS).join(' or ')}`);
  }
  if (!preamble.trim()) warnings.push('no preamble — the REQUIREMENTS STATUS / SCOPE markers are missing');

  let state = 'ready';
  if (!rows.length) state = 'empty';
  else if (unresolved.length) state = 'blocked';

  return {
    state, marker, scope, golden, rows, unresolved, unknown, counts, warnings,
  };
}

/* ------------------------------------------------------------------ the DA mirror */

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/** `code` spans and `**bold**`, and nothing else. A brief is prose plus tables. */
const inline = (s) => escapeHtml(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

/**
 * Render the brief as the DA document body.
 *
 * Deliberately a SMALL converter over the subset a brief uses — headings, paragraphs,
 * unordered lists, fenced code, and pipe tables. Anything it cannot classify becomes a
 * paragraph rather than being dropped: this document is a contract, and silently losing
 * a line of it is the one outcome worth avoiding. `jsdom` is not used because nothing
 * here needs a DOM; the output is asserted by the round-trip test instead.
 *
 * The envelope is the house one — `<body><header></header><main>…</main><footer></footer>`
 * — matching tools/da/push-*.js, so a brief opens in DA looking like every other doc.
 */
export function briefToHtml(md) {
  const out = [];
  const lines = String(md || '').split('\n');
  let table = null;
  let list = null;
  let fence = null;

  const closeTable = () => {
    if (table) {
      const [head, ...body] = table;
      out.push('<table>');
      out.push(`<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`);
      out.push('<tbody>');
      for (const r of body) out.push(`<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      out.push('</tbody></table>');
      table = null;
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`<ul>${list.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`);
      list = null;
    }
  };
  const closeAll = () => {
    closeTable();
    closeList();
  };

  for (const line of lines) {
    const fenced = /^```/.test(line.trim());
    if (fence !== null) {
      if (fenced) {
        out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else fence.push(line);
    } else if (fenced) {
      closeAll();
      fence = [];
    } else {
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      const cells = cellsOf(line);
      if (heading) {
        closeAll();
        out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      } else if (cells) {
        closeList();
        if (!isSeparator(cells)) {
          if (!table) table = [];
          table.push(cells);
        }
      } else if (bullet) {
        closeTable();
        if (!list) list = [];
        list.push(bullet[1]);
      } else if (!line.trim()) {
        closeAll();
      } else {
        closeAll();
        out.push(`<p>${inline(line.trim())}</p>`);
      }
    }
  }
  // An unterminated fence still has to survive: the content matters more than the syntax.
  if (fence !== null) out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
  closeAll();

  return `<body>\n  <header></header>\n  <main>\n    <div>\n${
    out.map((l) => `      ${l}`).join('\n')}\n    </div>\n  </main>\n  <footer></footer>\n</body>\n`;
}

/* ================================================================== the I/O layer */

/*
 * Everything above is a pure parser and stays that way — it is the half the browser
 * app and the tests exercise. Below is what the PIPELINE additionally needs: where a
 * brief is loaded from, what the model is allowed to see of it, and the two questions
 * the tiers ask of it.
 */

/**
 * Where a group's local brief lives.
 *
 * Committed (see .gitignore, which keeps `.tracker/qa-requirements/`): the brief is
 * the contract, so a second machine gets it from `git pull` rather than from whoever
 * remembered to preview the DA doc.
 */
export const localBriefPath = (group) => join(REPO_ROOT, CONFIG_DIR, 'qa-requirements', `${group}-brief.md`);

/**
 * True when the brief declares `JUDGE_MODE: audit`.
 *
 * In audit mode the judge evaluates a page against the brief's checklist instead of
 * comparing it to a counterpart — the right mode for an index or listing page, whose
 * visible content is assembled at runtime from a query index and is therefore absent
 * from the authored text BY DESIGN. Comparing it to anything produces nothing but
 * false positives, and a judge given only false positives is quickly ignored.
 */
export const isAuditMode = (md) => String(md || '')
  .split('\n')
  /*
   * Blockquote lines are EXCLUDED, for the same reason `filterBrief` drops them: a `> `
   * line is a note from one human to another, not a declaration. BRIEF-TEMPLATE.md
   * explains audit mode inside such a quote — so a grep over the whole document made
   * every freshly scaffolded brief silently claim `JUDGE_MODE: audit`, which switches
   * the judge from comparing a page against its source to auditing it against a
   * checklist. Observed the first time `group:requirements` scaffolded a new group.
   */
  .filter((line) => !/^\s*>/.test(line))
  .some((line) => /JUDGE_MODE:\s*audit/i.test(line));

/**
 * The brief as the MODEL should see it.
 *
 * compare mode (default): `✓` and `~` rows only. A `?` row is an unknown nobody has
 *   confirmed; showing it invites the model to treat an open question as either
 *   approved or required, and it has no basis for either. `✗` rows do not apply.
 * audit mode: `?` rows are KEPT, because in audit mode they ARE the work — "evaluate
 *   this and report what you find". `✗` rows are still dropped.
 *
 * Instruction blockquotes (`> …`) go in both modes: a reviewer's note to another
 * reviewer is not evidence, and a model will act on it as if it were.
 *
 * Section filtering is by NAME through `splitSections`, not by a hardwired
 * `## Part 4 — Visual` string. The upstream version matched that literal with an
 * em-dash, so a brief authored with a plain hyphen sent its visual criteria to a text
 * judge, which then reported confidently on layout it had never seen.
 */
export function filterBrief(md, auditMode = isAuditMode(md)) {
  const dropped = new Set(auditMode ? ['removed'] : ['removed', 'unresolved']);
  const HUMAN_ONLY = new Set(['visual', 'open']);
  const { sections } = splitSections(md);
  const out = [];
  for (const s of sections) {
    if (!HUMAN_ONLY.has(s.id)) {
      out.push(`## ${s.heading}`);
      for (const line of s.lines) {
        const cells = cellsOf(line);
        const kind = cells ? glyphOf(cells[2] ?? cells.at(-1))?.id : null;
        const drop = line.startsWith('> ') || (kind && dropped.has(kind));
        if (!drop) out.push(line);
      }
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Quoted strings inside resolved `✓` rows — the deterministic half of the brief.
 *
 * A reviewer who writes
 *   | Q3 | The date line must read "28-30 September 2026" | ✓ |
 * has stated something a string comparison can check for free and a 14B model can be
 * talked out of. This is the surviving REASON of a caption gate the upstream pipeline
 * hardcoded for one page template: a semantic judge proved unreliable at noticing one
 * dropped item among several similar ones, so anything declared verbatim gets an
 * exact-text check in tier 1 (see `missingVerbatim` in lib/extract.mjs).
 *
 * Only double quotes count, straight or curly. Single quotes appear inside ordinary
 * prose ("the page's date") far too often to read as a delimiter.
 *
 * THE REQUIREMENT CELL ONLY, NEVER THE NOTE. Measured, on the four real briefs in
 * .tracker/qa-requirements/: reading the Note cell too pulled `"Berlin"` out of the
 * meetups Q3 note — *The word "Berlin" appearing as "Berlin" in every locale is
 * correct* — and turned an ILLUSTRATION into a group-wide requirement, so tier 1
 * failed 12 of 14 meetup pages for not mentioning Berlin. The Note is where a human
 * explains and gives an example; the Requirement is where they state the obligation.
 * A check that reads the explanation as the obligation is not strict, it is wrong.
 */
export function verbatimRequirements(md) {
  const out = [];
  /*
   * `parseRows` on whatever text was handed in — NOT `requirementsReadiness`, which
   * goes looking for a named section. Callers pass an ALREADY-ISOLATED section
   * (`enJudgeBrief(...)` or `judgeBrief(...)`), so re-searching inside it found no
   * `## QA Requirements` heading and returned zero rows: every verbatim literal in an
   * EN brief was silently ignored, and the check reported `skip` as if the brief had
   * declared none. Caught by test, not by running it — which is the point, because
   * "no verbatim strings declared" is indistinguishable from working.
   */
  for (const row of parseRows(md)) {
    if (row.kind === 'must') {
      for (const m of String(row.requirement).matchAll(/[“"]([^”"]{3,})[”"]/g)) {
        out.push(m[1].trim());
      }
    }
  }
  return [...new Set(out)];
}

/**
 * The inverse of `briefToHtml`: a DA-served `.plain.html` back to the markdown the
 * parser above expects.
 *
 * Heading LEVEL is preserved — `h2` must come back as `##` exactly, because section
 * splitting keys on it. Flattening every level to `##` (the upstream bug) truncated
 * any section containing a subheading: a QA Requirements section with `h3`
 * subsections ended at the first one, and the judge brief came back empty while the
 * document plainly had content in it.
 *
 * Tables come back as pipe rows, because that is what `parseRows` reads and a brief's
 * requirement rows are all tables.
 */
export function htmlToBrief(html) {
  const rows = String(html)
    .replace(/<tr[^>]*>/gi, '\n|')
    .replace(/<\/(?:th|td)>\s*<(?:th|td)[^>]*>/gi, '|')
    .replace(/<(?:th|td)[^>]*>/gi, '')
    .replace(/<\/(?:th|td)>/gi, '|');
  return rows
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|div|ul|ol|table|tbody|thead|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Load a group's brief: the DA document first, then the local file.
 *
 * DA wins because that is where a human authors it and where the whole team can see
 * it. No token is needed to read one — `/tracker/**` is publicly readable once
 * previewed (scripts/tracker/paths.js says so out loud) — so a pipeline with no
 * credential still gets the contract.
 *
 * ONE DA path, from `requirementsPath()`. The upstream loader supported two layouts
 * and had to, because a scaffolder had already created empty docs at the wrong one and
 * every tool was reading those instead of the real content. There is one spelling here
 * and it lives in scripts/tracker/paths.js; a second candidate path invites that back.
 *
 * @returns {{exists, source, path, text, judgeBrief, readiness, auditMode}}
 *   `readiness.state` is the answer a gate acts on: 'missing' / 'empty' / 'blocked' /
 *   'ready'. They are not collapsible — see `requirementsReadiness`.
 */
export async function loadRequirements(group, { branch, fetchImpl = fetch } = {}) {
  const daPath = group ? requirementsPath(group) : null;
  const describe = (text, source, path) => ({
    exists: true,
    source,
    path,
    text,
    judgeBrief: judgeBrief(text),
    enJudgeBrief: enJudgeBrief(text),
    readiness: requirementsReadiness(text),
    enReadiness: requirementsReadiness(text, (sec) => sec.forEnJudge),
    auditMode: isAuditMode(text),
  });

  if (!group) {
    return {
      exists: false,
      source: null,
      path: null,
      text: null,
      judgeBrief: null,
      enJudgeBrief: null,
      readiness: requirementsReadiness(''),
      enReadiness: requirementsReadiness(''),
      auditMode: false,
    };
  }

  try {
    const res = await fetchImpl(`${previewUrl(daPath, branch)}.plain.html`);
    if (res.ok) {
      const text = htmlToBrief(await res.text());
      if (text.trim()) return describe(text, 'da', daPath);
    }
  } catch { /* fall through to the local brief */ }

  const local = localBriefPath(group);
  if (existsSync(local)) {
    const text = readFileSync(local, 'utf8');
    if (text.trim()) return describe(text, 'local', local);
  }
  return {
    exists: false,
    source: null,
    path: daPath,
    text: null,
    judgeBrief: null,
    enJudgeBrief: null,
    readiness: requirementsReadiness(''),
    enReadiness: requirementsReadiness(''),
    auditMode: false,
  };
}
