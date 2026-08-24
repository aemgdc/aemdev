#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * tx-qa.mjs — TIER 1 translation QA for one (page, locale). Deterministic, ZERO tokens.
 *
 * CLI SURFACE
 *   node tools/tracker/tx-qa.mjs --locale=<code> --path=<page-path>
 *        [--group=<name>] [--branch=<ref>] [--out=<file>] [--quiet] [--json] [--help]
 *   node tools/tracker/tx-qa.mjs --locale=<code> --en=<url> --translated=<url>
 *        [--out=<file>] [--quiet] [--json] [--help]
 *
 *   npm run tx:page -- --locale=de --path=/en/meetups/aem-meetup-munich
 *   npm run tx:page -- --locale=en --en=<urlA> --translated=<urlB>   # pair mode
 *
 * ─── What this tier checks, and why it is these things ──────────────────────
 *
 * Translation destroys prose and preserves STRUCTURE. So every check here is a fact
 * about structure, computed from two documents, with no model involved and nothing to
 * escalate:
 *
 *   skeleton       same sections, same blocks, same order
 *   headings       same count, same depth sequence
 *   keys / DNT     everything `custom-doc-rules` protects is BYTE-IDENTICAL
 *   code           an inline <code> identifier is byte-identical
 *   terms          every `dnt-content-rules` literal survives verbatim
 *   assets         image / link / icon parity, and every internal link localized
 *   anchors        in-page #links still resolve after headings were renamed
 *   untranslated   is the page ACTUALLY in the target language
 *   numbers/dates  figures compared as VALUES; ISO dates byte-identical
 *   expansion      length ratios, normalized by the locale's own expansion factor
 *
 * ─── Why this is not the English structural tier with a flag ────────────────
 *
 * `structural-qa.mjs` compares a page against its own previous revision, where the two
 * sides are expected to AGREE in text. Here the two sides must agree in structure
 * precisely and are expected to differ in text everywhere. Pointing the English checks
 * at a translated page inverts every threshold: the word-ratio check fails German for
 * being German, and a content-fidelity judge flags `176.000` as an altered figure when
 * it is the correct localization of `176,000`. Separate engine, separate thresholds.
 *
 * ─── The single most common real failure ────────────────────────────────────
 *
 * A page that came back still in English. Its structure is perfect, so every other
 * check on this list passes it. `translationVerdict()` from scripts/tracker/detect.js is
 * the only thing that sees it, which is why it is not optional and why its verdict is
 * three-way — a proper noun that is identical in ten locales must not read as a defect.
 *
 * EXIT CODES (data-contract.md §5)
 *   0 pass · 1 fail (a real defect) · 2 could not reach a verdict (review verdict, an
 *   unreachable page, a locale page that does not exist yet) · 3 usage/config error
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  locale as localeFor, normalizePath, pathForLocale, basePath, localeForPath,
} from '../../scripts/tracker/locales.js';
import { previewUrl, daSourceUrl, slugOf } from '../../scripts/tracker/paths.js';
import { translationVerdict, extractNumbers, spelledOut, quoteStyleCheck } from '../../scripts/tracker/detect.js';
import { loadConfig, groupConfig, REPO_ROOT } from './config.mjs';
import { groupForPath, pagetypeOf } from './lib/group-map.mjs';
import { verdictExit } from './lib/exit.mjs';
import {
  fetchHtml, normText, parseHtml, extractIconRefs,
} from './lib/extract.mjs';
import {
  loadDntContract, ruleFor, permitsTranslation, logicalKeys, isIdentifier,
} from './lib/dnt.mjs';

const HELP = `tx-qa — tier 1 translation QA for one (page, locale). Deterministic, no LLM.

  --locale=<code>       required. The language the target page is supposed to be in.
  --path=<page-path>    the EN page path; the target is pathForLocale(path, locale)
  --en=<url>            explicit URLs instead of --path (PAIR MODE)
  --translated=<url>
  --group=<name>        recorded in the report; inferred from the path when omitted
  --branch=<ref>        build the URLs against this ref (default: main)
  --out=<file>          write the JSON report (default .tracker/reports/tx/<code>--<slug>.json)
  --json                print the full report to stdout
  --quiet               print nothing but the one-line verdict
  --help                this text

  PAIR MODE with --locale=en compares two pages and expects ENGLISH on both sides.
  That is the only way to exercise this tier before any locale tree exists: a page
  against itself must come back clean, a page against a different page must not.

exit 0 pass · 1 fail · 2 review / nothing to judge · 3 usage or config error`;

/* ------------------------------------------------------------------ the document model */

/*
 * Every finding is anchored to a POSITION — section 3, block 1, row 2, cell 0 — and
 * never to text, because text is what changed. It also means a skeleton mismatch is one
 * finding that short-circuits the positional checks, instead of a cascade of nonsense
 * differences between two documents that were never lined up.
 */

const BLOCK_CLASS_RE = /^[a-z][a-z0-9-]*$/;

/** Inline tags whose arrangement inside a paragraph is load-bearing. */
const INLINE_TAGS = ['A', 'STRONG', 'EM', 'B', 'I', 'SUB', 'SUP', 'CODE', 'BR', 'SPAN'];

/** Elements a reader sees as prose. */
const PROSE_TAGS = ['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TD', 'TH', 'FIGCAPTION'];

const HEADING_TAGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];

const cellText = (el) => normText(el?.textContent || '');

/** The ordered inline-tag signature of an element: ['A','SUB','STRONG']. */
const inlineSignature = (el) => [...el?.querySelectorAll?.('*') || []]
  .filter((n) => INLINE_TAGS.includes(n.tagName))
  .map((n) => n.tagName);

/**
 * Inline `<code>` texts, in order.
 *
 * Its own field because it is the sharpest DNT case on a developer site and no rule in
 * `custom-doc-rules` reaches it: the `code` BLOCK is protected, but an identifier inside
 * a sentence — `blocks/article-feed/article-feed.js`, `helix-query.yaml`, `mvn clean
 * install` — is inline markup in a prose node the contract quite correctly permits
 * translating. A translated identifier there is not a worse translation, it is a broken
 * instruction, and technical-articles is the group where it appears most.
 */
const codeSpans = (el) => [...el?.querySelectorAll?.('code') || []].map((c) => cellText(c));

/**
 * Internal content paths an element references — hrefs plus the bare-path TEXT the
 * fragment block is authored with.
 *
 * Reading only hrefs would still catch a linked fragment, but reading both means a
 * fragment authored as plain text (which DA also accepts) is not invisible.
 */
function internalPaths(el) {
  const out = new Set();
  for (const a of el?.querySelectorAll?.('a[href]') || []) {
    const href = a.getAttribute('href');
    if (href?.startsWith('/')) out.add(normalizePath(href));
  }
  const text = (el?.textContent || '').trim();
  if (/^\/[a-z]{2}(-[a-z]{2})?\/[\w/-]+$/i.test(text)) out.add(normalizePath(text));
  return [...out];
}

/**
 * Parse a `.plain.html` into a positional skeleton.
 *
 * Block rows keep the raw cell ELEMENTS, not just their text, because several checks
 * (inline markup, code spans, paths) need the markup.
 */
export function parseDoc(html) {
  const document = parseHtml(html);
  const sections = [];

  const sectionEls = [...document.body.children].filter((e) => e.tagName === 'DIV');
  for (const [si, sectionEl] of sectionEls.entries()) {
    const nodes = [];
    for (const child of [...sectionEl.children]) {
      const cls = child.getAttribute('class') || '';
      const first = cls.trim().split(/\s+/)[0];
      if (child.tagName === 'DIV' && BLOCK_CLASS_RE.test(first)) {
        const rows = [...child.children].map((rowEl) => [...rowEl.children].map((c) => ({
          text: cellText(c),
          el: c,
          inline: inlineSignature(c),
          code: codeSpans(c),
          paths: internalPaths(c),
        })));
        nodes.push({
          kind: 'block', name: first, classes: cls.trim(), rows, el: child,
        });
      } else if (PROSE_TAGS.includes(child.tagName) || child.tagName === 'UL' || child.tagName === 'OL') {
        /*
         * Lists are flattened one level so each item is addressable on its own. A
         * translation that drops one bullet of three is a real defect, and comparing
         * the <ul> as one element would only ever see "the text changed".
         */
        const leaves = child.tagName === 'UL' || child.tagName === 'OL' ? [...child.children] : [child];
        for (const leaf of leaves) {
          nodes.push({
            kind: 'prose',
            tag: leaf.tagName,
            text: cellText(leaf),
            id: leaf.getAttribute('id') || null,
            inline: inlineSignature(leaf),
            code: codeSpans(leaf),
            paths: internalPaths(leaf),
            el: leaf,
          });
        }
      }
    }
    sections.push({ index: si, nodes });
  }

  return {
    sections,
    ids: [...document.querySelectorAll('[id]')].map((e) => e.getAttribute('id')),
    anchors: [...document.querySelectorAll('a[href^="#"]')]
      .map((a) => a.getAttribute('href').slice(1)).filter(Boolean),
    links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
    images: [...document.querySelectorAll('img[src]')].map((i) => i.getAttribute('src')),
    headings: [...document.querySelectorAll(HEADING_TAGS.join(','))]
      .map((h) => ({ level: Number(h.tagName[1]), text: cellText(h) }))
      .filter((h) => h.text),
    icons: extractIconRefs(html),
    document,
  };
}

/**
 * One finding.
 *
 * An object rather than positional arguments purely for legibility: each `detail` runs
 * to several lines of prose, and a four-argument call with a multi-line template in the
 * middle cannot be wrapped into anything readable.
 */
const finding = (f) => f;

/** Prose nodes, flattened with their position. */
const proseNodes = (doc) => doc.sections.flatMap((sec, si) => sec.nodes
  .map((node, ni) => ({ si, ni, node }))
  .filter(({ node }) => node.kind === 'prose' && node.text));

/**
 * Node pairs the two documents agree on, flattened with their position.
 *
 * A pair is yielded only when both sides exist and are the same KIND, so a document
 * whose skeleton drifted produces FEWER pairs rather than a stream of comparisons
 * between a block and a paragraph. `checkSkeleton` has already reported that drift.
 */
const alignedPairs = (en, loc) => en.sections.flatMap((enSec, si) => enSec.nodes
  .map((enNode, ni) => ({
    si, ni, enNode, locNode: loc.sections[si]?.nodes[ni],
  }))
  .filter(({ enNode, locNode }) => locNode && enNode.kind === locNode.kind));

/* ------------------------------------------------------------------ skeleton */

/**
 * Skeleton parity — the gate every positional check depends on.
 *
 * Returns `aligned: false` when the two documents cannot be compared position by
 * position. Everything downstream then reports nothing rather than garbage: a page that
 * gained a section produces ONE honest finding here instead of forty spurious ones
 * about blocks that merely moved.
 */
function checkSkeleton(en, loc, { name }) {
  const out = [];
  if (en.sections.length !== loc.sections.length) {
    out.push(finding({
      severity: 'error',
      check: 'skeleton',
      detail: `section count differs — English has ${en.sections.length}, ${name} has `
        + `${loc.sections.length}. Translation must not change document structure; a section `
        + 'was added or lost in the round trip.',
    }));
    return { findings: out, aligned: false };
  }
  const shapeOf = (sec) => sec.nodes.map((n) => (n.kind === 'block' ? `block:${n.name}` : `prose:${n.tag}`));
  const differing = [];
  for (const [si, enSec] of en.sections.entries()) {
    const enShape = shapeOf(enSec);
    const locShape = shapeOf(loc.sections[si]);
    if (enShape.join('|') !== locShape.join('|')) differing.push({ si, enShape, locShape });
  }

  /*
   * ONE finding for the whole document, not one per section.
   *
   * Two structurally different documents are usually different EVERYWHERE, and five
   * findings describing five symptoms of one cause reads as five problems. Measured
   * upstream: one page produced 5 section findings x 9 locales = 45 errors for a single
   * underlying fact.
   *
   * And the fact is usually diagnosable. Blocks present on one side and absent from the
   * other are the signal: if the ENGLISH page uses a block the translation does not, the
   * English page is the odd one out — the translation came from a source with the current
   * block conventions and the English page has changed since. That is a defect in the
   * English content, which this check is not looking for and finds anyway.
   */
  if (differing.length) {
    const blocksOf = (shape) => shape.filter((x) => x.startsWith('block:')).map((x) => x.slice(6));
    const enBlocks = new Set(differing.flatMap((d) => blocksOf(d.enShape)));
    const locBlocks = new Set(differing.flatMap((d) => blocksOf(d.locShape)));
    const enOnly = [...enBlocks].filter((b) => !locBlocks.has(b));
    const locOnly = [...locBlocks].filter((b) => !enBlocks.has(b));
    const list = (xs) => xs.map((b) => `\`${b}\``).join(', ');
    let diagnosis = '';
    if (enOnly.length && locOnly.length) {
      diagnosis = ` The English page uses ${list(enOnly)} where the ${name} page uses `
        + `${list(locOnly)} — the two were built from different block conventions. The ENGLISH `
        + 'page is the one to check: if those blocks have been renamed since it was translated, '
        + 'no amount of re-translating will align them.';
    } else if (enOnly.length) {
      diagnosis = ` The English page has ${list(enOnly)} and the ${name} page does not — either `
        + 'the translation dropped a section, or the English page has changed since.';
    } else if (locOnly.length) {
      diagnosis = ` The ${name} page has ${list(locOnly)} and the English page does not.`;
    }
    out.push(finding({
      severity: 'error',
      check: 'skeleton',
      detail: `${differing.length} of ${en.sections.length} sections differ in structure.${diagnosis} `
        + 'Every positional check (keys, DNT, code, inline markup, expansion) is SKIPPED for this '
        + 'page — the two documents cannot be lined up, so any comparison would be between '
        + `unrelated elements.${differing.slice(0, 3).map((d) => `\n  section ${d.si}: EN `
          + `[${d.enShape.join(', ')}] vs [${d.locShape.join(', ')}]`).join('')}`,
      sections: differing.map((d) => d.si),
      enOnlyBlocks: enOnly,
      translatedOnlyBlocks: locOnly,
    }));
  }
  return { findings: out, aligned: differing.length === 0 };
}

/**
 * Heading count and depth sequence.
 *
 * Separate from the skeleton check because a heading can survive as an element and stop
 * being a heading: EDS derives an `id` from heading text, and an authoring round trip
 * that turns an `h2` into an `h3` changes the document outline, the in-page navigation
 * and the anchor targets while leaving the section shape identical. The depth SEQUENCE
 * is the invariant — the text is supposed to change.
 */
function checkHeadings(en, loc, { name }) {
  const enSeq = en.headings.map((h) => h.level);
  const locSeq = loc.headings.map((h) => h.level);
  if (enSeq.join('.') === locSeq.join('.')) return [];
  if (enSeq.length !== locSeq.length) {
    return [finding({
      severity: 'error',
      check: 'headings',
      detail: `heading count differs — English has ${enSeq.length}, ${name} has ${locSeq.length}. `
        + 'A dropped heading takes its anchor and its place in the outline with it.',
      en: enSeq,
      translated: locSeq,
    })];
  }
  return [finding({
    severity: 'error',
    check: 'headings',
    detail: `heading depth sequence differs — English [h${enSeq.join(', h')}] vs ${name} `
      + `[h${locSeq.join(', h')}]. The outline changed even though the section shape did not.`,
    en: enSeq,
    translated: locSeq,
  })];
}

/* ------------------------------------------------------------------ cells and the DNT contract */

/**
 * Is this row's first cell a logical KEY, or is it content?
 *
 * The contract itself answers for every rule-bearing block: `logicalKeys()` returns the
 * col-1 keys the rules match on, which is exactly the set the connector protects. That
 * removes the hand-maintained block registry the upstream pipeline needed and the drift
 * that came with it — a key added to a rule was protected by the connector and still
 * unknown to the checker.
 *
 * For a block with no rule it has to be inferred, and the inference is conservative in
 * the direction of "content", because the cost of the two mistakes is not symmetric.
 * Calling a key `content` loses one finding. Calling content a `key` produces a finding
 * on every correctly-translated paragraph in every unaudited block — which is most of
 * them. Two structural signals rule it out: a key/value row needs at least two cells to
 * be a key/value row at all, and no authoring key is a sentence.
 */
function isKeyCell(rule, row, text) {
  const known = logicalKeys(rule);
  const t = String(text || '').trim();
  if (known.size) return known.has(t.toLowerCase());
  if (row.length < 2) return false;
  return t.length > 0 && t.length <= 40 && !/[.!?,;:]/.test(t) && t.split(/\s+/).length <= 4;
}

/**
 * Compare one cell.
 *
 * Split out rather than nested four deep, so every guard is an early return and the
 * whole DNT decision reads top to bottom in one place.
 */
function cellFindings(c) {
  const {
    enCell, locCell, enRow, ci, ri, si, block, rule, where, code, name, contract, rowCount,
  } = c;
  const out = [];
  const changed = enCell.text !== locCell.text;
  const keyText = enRow[0]?.text ?? '';
  const cellCtx = {
    rowIndex: ri,
    colIndex: ci,
    rowLength: enRow.length,
    rowCount,
    cells: enRow.map((x) => x.text),
  };
  const permitted = permitsTranslation(rule, cellCtx);
  const at = {
    section: si, block: block.name, row: ri, col: ci, key: keyText,
  };
  const cell = `${where} row ${ri} col ${ci + 1}`;

  /*
   * Is this cell LOGICAL — a key the block matches on? Asked INDEPENDENTLY of the
   * contract, because the two can disagree and the disagreement is the point:
   *
   *   logical + contract protects it  → a VIOLATION. The translator ignored the rule.
   *   logical + contract permits it   → a GAP. The rule is missing, and the translator
   *                                     did exactly as it was told.
   *
   * Upstream only had the violation branch, so a block with no rule produced nothing at
   * all: the translator was permitted, so there was no violation to report — and the
   * actual defect, that the block has no rule, went unmentioned. A permissive contract
   * cannot be violated; it has to be reported as the thing that is wrong. The two route
   * to different people: a violation is fixed by re-translating, a gap by editing
   * .tracker/da-translate.json and THEN re-translating.
   */
  const logical = ci === 0 && isKeyCell(rule, enRow, enCell.text);

  if (changed && logical) {
    out.push(finding({
      severity: 'error',
      check: 'translated-key',
      detail: `${cell}: "${enCell.text}" → "${locCell.text}". The block matches on this key, so a `
        + `translated one silently drops the field.${permitted
          ? ` NO rule protects this cell (${block.name} rule: ${rule.mode}), so the translator was `
            + 'permitted to change it — the missing rule is the defect.'
          : ''}`,
      ...at,
      en: enCell.text,
      translated: locCell.text,
      ruleMode: rule.mode,
      dntViolation: !permitted,
      dntGap: permitted,
    }));
  } else if (changed && !permitted) {
    out.push(finding({
      severity: 'error',
      check: 'translated-value',
      detail: `${cell}: "${enCell.text}" → "${locCell.text}" — the rule for this block `
        + `(${rule.mode}) does not permit this cell to be translated.`,
      ...at,
      en: enCell.text,
      translated: locCell.text,
      ruleMode: rule.mode,
      dntViolation: true,
    }));
  } else if (!changed && permitted) {
    /*
     * The inverse defect: the contract says translate this and it came back identical.
     * Gated on the ENGLISH side carrying real language evidence, because the commonest
     * reason a permitted cell is unchanged is that it holds a proper noun ("adaptTo()")
     * or a product name ("Edge Delivery Services") — identical in all ten locales by
     * design, and the fastest way to bury this check in false positives.
     */
    const v = translationVerdict({ text: enCell.text, expected: 'en' });
    /*
     * Skipped when the target locale IS English. That only happens in the pair mode this
     * tier is exercised with before any locale tree exists, and there the finding says
     * "this English cell should have been translated to English" — a sentence with no
     * meaning, which would make the one runnable self-check permanently dirty.
     */
    if (code !== 'en' && v.verdict === 'translated' && v.confidence >= 0.3) {
      out.push(finding({
        severity: 'warning',
        check: 'untranslated-cell',
        detail: `${cell}: "${enCell.text}" is unchanged, but the rule for this block says it `
          + `should have been translated to ${name}.`,
        ...at,
        en: enCell.text,
      }));
    }
  }

  /*
   * Identifier-shaped values, from `dnt-sheet-rules`. A URL, a root-relative path, a
   * taxonomy id (`aemdev:topic/edge-delivery`) or one of this site's hash directives
   * (`#_blank`) must survive byte-identical wherever it appears — and unlike the
   * per-block rules this is a rule about the VALUE, so it catches the same defect in a
   * block nobody has written a rule for.
   */
  if (changed && isIdentifier(contract.identifiers, enCell.text)) {
    out.push(finding({
      severity: 'error',
      check: 'dnt-identifier',
      detail: `${cell}: identifier "${enCell.text}" came back as "${locCell.text}". `
        + 'dnt-sheet-rules protects anything beginning '
        + `${contract.identifiers.map((p) => `\`${p}\``).join(', ')} — these are addresses, not text.`,
      ...at,
      en: enCell.text,
      translated: locCell.text,
      dntViolation: true,
    }));
  }

  // Runtime placeholders the block substitutes. A lost one renders as raw text.
  const missing = [...enCell.text.matchAll(/\{[a-z][a-z0-9_]*\}/gi)]
    .map((m) => m[0]).filter((p) => !locCell.text.includes(p));
  if (missing.length) {
    out.push(finding({
      severity: 'error',
      check: 'placeholder',
      detail: `${cell}: placeholder(s) ${missing.join(', ')} did not survive — the block `
        + 'substitutes these at runtime and will render the raw text instead.',
      ...at,
      missing,
    }));
  }
  return out;
}

/** Compare one aligned block pair: row shape first, then every cell. */
function blockFindings(enNode, locNode, si, ctx) {
  const where = `${enNode.classes} (section ${si})`;
  const rule = ruleFor(ctx.contract.rules, enNode.classes);
  if (enNode.rows.length !== locNode.rows.length) {
    return [finding({
      severity: 'error',
      check: 'block-rows',
      detail: `${where}: row count differs — English ${enNode.rows.length}, translated `
        + `${locNode.rows.length}. A dropped row means a dropped field.`,
      section: si,
      block: enNode.name,
    })];
  }
  return enNode.rows.flatMap((enRow, ri) => {
    const locRow = locNode.rows[ri];
    if (enRow.length !== locRow.length) {
      return [finding({
        severity: 'error',
        check: 'block-rows',
        detail: `${where} row ${ri}: cell count differs — English ${enRow.length}, translated `
          + `${locRow.length}`,
        section: si,
        block: enNode.name,
        row: ri,
      })];
    }
    return enRow.flatMap((enCell, ci) => cellFindings({
      enCell,
      locCell: locRow[ci],
      enRow,
      ci,
      ri,
      si,
      block: enNode,
      rule,
      where,
      rowCount: enNode.rows.length,
      code: ctx.code,
      name: ctx.name,
      contract: ctx.contract,
    }));
  });
}

const checkCells = (en, loc, ctx) => en.sections.flatMap((enSec, si) => enSec.nodes
  .flatMap((enNode, ni) => {
    const locNode = loc.sections[si].nodes[ni];
    if (enNode.kind !== 'block' || locNode?.kind !== 'block') return [];
    return blockFindings(enNode, locNode, si, ctx);
  }));

/**
 * Inline `<code>` spans, compared as byte-identical text.
 *
 * The sharpest DNT case on a developer site, and the one no `custom-doc-rules` row can
 * reach: the `code` BLOCK is protected, but `blocks/article-feed/article-feed.js`
 * written inline inside a sentence lives in a prose node the contract quite correctly
 * permits translating. A translated flag, path or shell command is not a lower-quality
 * translation — it is an instruction that no longer works.
 */
function checkCodeSpans(en, loc) {
  return alignedPairs(en, loc).flatMap(({ si, enNode, locNode }) => {
    const enCode = enNode.kind === 'prose' ? enNode.code : enNode.rows.flat().flatMap((c) => c.code);
    const locCode = locNode.kind === 'prose' ? locNode.code : locNode.rows.flat().flatMap((c) => c.code);
    if (!enCode.length) return [];
    const lost = enCode.filter((t) => t && !locCode.includes(t));
    if (!lost.length) return [];
    return [finding({
      severity: 'error',
      check: 'translated-code',
      detail: `section ${si}: inline <code> identifier(s) did not survive verbatim — `
        + `${lost.slice(0, 5).map((t) => `\`${t}\``).join(', ')}. A translated identifier, flag or `
        + 'command is a broken instruction, not a weaker translation.',
      section: si,
      lost: lost.slice(0, 20),
      dntViolation: true,
    })];
  });
}

/**
 * The `dnt-content-rules` literals — product names, event names, people's names.
 *
 * Checked per aligned node so a finding can say WHERE. Case-sensitive substring, which
 * is both what the connector's XPath `contains()` does and what the requirement is:
 * byte-identity, not approximate survival. A transliterated speaker name in a CJK locale
 * is exactly the defect this catches, and it is both wrong and very hard to spot in
 * review.
 */
function checkProtectedTerms(en, loc, { name, contract }) {
  const textOf = (node) => (node.kind === 'prose' ? node.text : node.rows.flat().map((c) => c.text).join(' '));
  return alignedPairs(en, loc).flatMap(({ si, enNode, locNode }) => {
    const enText = textOf(enNode);
    const locText = textOf(locNode);
    const lost = contract.literals.filter((lit) => enText.includes(lit) && !locText.includes(lit));
    if (!lost.length) return [];
    return [finding({
      severity: 'error',
      check: 'dnt-term',
      detail: `section ${si}: protected term(s) ${lost.map((l) => `"${l}"`).join(', ')} appear on `
        + `the English page and not on the ${name} page. dnt-content-rules lists these as `
        + 'never-translate — a product, event or person name.',
      section: si,
      terms: lost,
      dntViolation: true,
    })];
  });
}

/* ------------------------------------------------------------------ language */

/**
 * Is the page ACTUALLY in the target language?
 *
 * Prose nodes only. Block cells were already decided by the DNT contract above, and
 * running a detector over a protected cell would report every correctly-preserved key as
 * untranslated English.
 *
 * `coverage` is the number a reviewer actually reads: "38 of 41 prose nodes verified as
 * German" says something a bare "3 findings" does not — it distinguishes a page with
 * three English paragraphs from a page that is entirely English with three detectable
 * paragraphs.
 */
function checkProseLanguage(en, loc, { code, name }) {
  const out = [];
  const coverage = {
    total: 0, translated: 0, untranslated: 0, uncertain: 0,
  };
  for (const { si, ni, node } of proseNodes(loc)) {
    coverage.total += 1;
    const v = translationVerdict({ text: node.text, expected: code });
    coverage[v.verdict] += 1;
    const excerpt = `${node.text.slice(0, 120)}${node.text.length > 120 ? '…' : ''}`;
    if (v.verdict === 'untranslated') {
      const identical = en.sections[si]?.nodes[ni]?.text === node.text;
      out.push(finding({
        severity: 'error',
        check: 'untranslated-text',
        detail: `section ${si} ${node.tag}: ${v.detail}`
          + `${identical ? ' and is byte-identical to the English page' : ''} `
          + `(confidence ${v.confidence}) — "${excerpt}"`,
        section: si,
        node: ni,
        tag: node.tag,
        confidence: v.confidence,
        identical,
      }));
    } else if (v.verdict === 'uncertain' && (v.reason === 'other-language' || v.reason === 'han-variant')) {
      /*
       * A THIRD language is `uncertain`, never `untranslated`, and it is a warning.
       * Spanish, Portuguese and Italian share so much function-word mass that "reads as
       * Portuguese on a Spanish page" is more often a limit of the detector than a defect
       * in the page, and a human has to say which.
       */
      out.push(finding({
        severity: 'warning',
        check: 'wrong-language',
        detail: `section ${si} ${node.tag}: ${v.detail} — "${excerpt}"`,
        section: si,
        node: ni,
        tag: node.tag,
        detected: v.detected,
        confidence: v.confidence,
      }));
    }
  }
  /*
   * A page with NO decidable prose is not a passing page, it is an unverified one. Said
   * once, as a warning, rather than silently contributing a clean language check — the
   * bios group is full of pages like this (a name, a title, a LinkedIn URL) and reporting
   * them as verified German would be a lie the whole tier gets judged on.
   */
  if (coverage.total && coverage.translated === 0 && coverage.untranslated === 0) {
    out.push(finding({
      severity: 'warning',
      check: 'wrong-language',
      detail: `none of the ${coverage.total} prose node(s) carry enough language evidence to `
        + `confirm this page is in ${name} — proper nouns, identifiers or very short strings `
        + 'only. The page is UNVERIFIED, not verified clean.',
      unverified: true,
    }));
  }
  return { findings: out, coverage };
}

/* ------------------------------------------------------------------ links, paths, assets */

/**
 * Internal paths still pointing at the English tree.
 *
 * Only `/en/` counts. A path already in this locale is correct, and a path in some THIRD
 * locale is a different bug (a bad rollout target) that this check would only describe
 * misleadingly.
 *
 * Reads BOTH prose paths and BLOCK CELL paths. Reading only `node.paths` was a real
 * upstream bug: it silently skipped every block, which is where the paths that matter
 * live. The fragment block IS a path in a cell, so the check that exists to catch
 * `/en/fragments/…` on a German page was looking everywhere except at fragments.
 */
function leakedEnglishPaths(loc, code) {
  const seen = new Set();
  return loc.sections.flatMap((sec, si) => sec.nodes
    .flatMap((node) => (node.kind === 'block'
      ? node.rows.flat().flatMap((c) => c.paths || [])
      : node.paths || []))
    .filter((p) => /^\/en(?:\/|$)/i.test(p))
    /*
     * A path already in the TARGET locale is correct. For a real locale that filter never
     * fires, because `/en/...` is never `/de/...`; it exists for the pair mode where the
     * target locale is `en` itself, where the check would otherwise compare every path to
     * itself and report the whole page as unlocalized.
     */
    .filter((p) => localeForPath(p) !== code)
    .filter((p) => {
      const key = `${si}:${p}`;
      const fresh = !seen.has(key);
      seen.add(key);
      return fresh;
    })
    .map((p) => ({ si, path: p })));
}

/**
 * The severity split is the point.
 *
 * If the localized counterpart EXISTS, the page is pointing away from real translated
 * content and readers see English inside a translated page — an error. If it does not,
 * pointing at `/en/` is the only thing that could work today, so it is a warning naming
 * the missing document rather than a defect in this page.
 *
 * Existence is asked of DA, not of the preview host. The first upstream version fetched
 * `.plain.html` from preview, which conflates "exists" with "has been previewed" — and
 * since the DA translation connector previews nothing, those are routinely different.
 * Measured consequence: every `unlocalized-path` finding across nine locales was
 * downgraded to "the rollout is incomplete" when the rollout was in fact complete.
 */
async function checkPaths(loc, { code, name }, probe) {
  const out = [];
  for (const { si, path } of leakedEnglishPaths(loc, code)) {
    const wanted = pathForLocale(path, code);
    const exists = await probe(wanted);
    out.push(finding({
      severity: exists ? 'error' : 'warning',
      check: 'unlocalized-path',
      detail: exists
        ? `section ${si}: references ${path} but ${wanted} exists — this ${name} page pulls in `
          + 'English content that has already been translated.'
        : `section ${si}: references ${path}, and ${wanted} does not exist yet — the ${name} `
          + 'rollout is incomplete rather than mis-linked.',
      section: si,
      path,
      expected: wanted,
      targetExists: exists,
    }));
  }
  return out;
}

/**
 * In-page anchors whose target the translation renamed.
 *
 * EDS derives a heading's `id` from its text, so translating a heading changes its id —
 * correctly. What does not change is a link elsewhere on the page pointing at the OLD
 * id, and the result is a table-of-contents entry that silently does nothing. Nothing in
 * the translation flow can notice, because both sides are individually valid.
 */
const checkAnchors = (loc) => {
  const ids = new Set(loc.ids);
  return loc.anchors.filter((a) => !ids.has(a)).map((a) => finding({
    severity: 'error',
    check: 'broken-anchor',
    detail: `in-page link #${a} has no matching id on the translated page — translating the `
      + 'target heading changed its generated id and the link was not updated.',
    anchor: a,
  }));
};

/**
 * Image, link and icon parity.
 *
 * Compared as COUNTS plus set difference, and internal links are compared by their
 * locale-independent `basePath` so `/en/x` → `/de/x` is parity and not a difference.
 * An external link, an image and an icon are the same asset in every locale, so any
 * difference there is a lost or invented reference.
 */
function checkAssets(en, loc, { name }) {
  const out = [];
  const external = (hrefs) => hrefs.filter((h) => /^https?:\/\//i.test(h)).sort();
  const internal = (hrefs) => hrefs.filter((h) => h.startsWith('/')).map((h) => basePath(h)).sort();
  const compare = (kind, a, b, severity) => {
    const lost = a.filter((x) => !b.includes(x));
    const added = b.filter((x) => !a.includes(x));
    if (!lost.length && !added.length) return;
    out.push(finding({
      severity,
      check: 'assets',
      detail: `${kind}: ${lost.length} missing from the ${name} page`
        + `${added.length ? `, ${added.length} not on the English page` : ''}`
        + `${lost.length ? ` — missing ${lost.slice(0, 5).map((x) => `\`${x}\``).join(', ')}` : ''}`
        + `${added.length ? ` — extra ${added.slice(0, 5).map((x) => `\`${x}\``).join(', ')}` : ''}. `
        + 'An asset reference is the same in every locale, so a difference here is a lost or '
        + 'invented reference rather than a translation choice.',
      kind,
      lost: lost.slice(0, 20),
      added: added.slice(0, 20),
    }));
  };
  compare('images', en.images.slice().sort(), loc.images.slice().sort(), 'error');
  compare('icons', en.icons.slice().sort(), loc.icons.slice().sort(), 'error');
  compare('external links', external(en.links), external(loc.links), 'error');
  /*
   * Internal links are a WARNING, not an error, and only after `basePath` folding: this
   * check would otherwise duplicate `unlocalized-path`, which says the same thing with a
   * localized-counterpart probe behind it. What is left here is the case that probe
   * cannot see — an internal link that vanished entirely.
   */
  compare('internal links', internal(en.links), internal(loc.links), 'warning');
  return out;
}

/* ------------------------------------------------------------------ inline markup */

/** Does an element have whitespace immediately before it, or is it glued on? */
function hasGapBefore(el) {
  const prev = el.previousSibling;
  return !(prev?.nodeType === 3 && /\S$/.test(prev.textContent));
}

/**
 * Compare one inline tag against its English counterpart.
 *
 * Per-tag thresholds, because the tags carry different kinds of content and one number
 * cannot serve both.
 *
 * SUB/SUP wrap a TOKEN, essentially always: a digit in a formula, ®, a footnote marker.
 * So the rule is absolute rather than a ratio — a sub/sup that comes back holding a word
 * has moved, and a ratio test cannot see it because the English side is one character
 * long. Upstream this was `CO<sub>2</sub>` arriving as `die<sub>CO2-Reduzierung</sub>`,
 * rendering as "dieCO2" with a subscripted noun.
 *
 * A/STRONG/EM wrap phrases that legitimately get much longer, so a length ratio alone
 * cannot work — German compounds routinely double a single word. `analytics` →
 * `Analysetechnologie` is 2.0x and correct; `AEM GDC` → `zum Beispiel AEM GDC` is 1.9x
 * and is a moved boundary. The ratio does not separate them; CONTAINMENT does. A moved
 * boundary leaves the original content in place and adds words around it, so the English
 * text is still there verbatim — which is also why it happens most to proper nouns, the
 * anchors a translator has nothing to change inside. A genuine translation REPLACES.
 *
 * Containment is the ONLY test here, deliberately. A token-growth fallback was tried
 * upstream, to catch a boundary that moved on an anchor whose text was also translated,
 * and it fired on every German CTA in the corpus — "Request a Demo" → "Fordern Sie eine
 * Demo an" is +2 tokens and 1.7x and completely correct. This knowingly misses that case
 * rather than warning on every button on the site.
 */
function tagFindings(enTag, locTag, where, at) {
  const out = [];
  const tag = enTag.tagName;
  const lower = tag.toLowerCase();
  const enText = cellText(enTag);
  const locText = cellText(locTag);
  const toks = (s) => s.split(/\s+/).filter(Boolean).length;
  const moved = ['SUB', 'SUP'].includes(tag)
    ? locText.length > 4 && locText.length > enText.length + 3
    : enText.length >= 4
      && locText.toLowerCase().includes(enText.toLowerCase())
      && toks(locText) > toks(enText);

  if (moved) {
    out.push(finding({
      severity: 'warning',
      check: 'markup-drift',
      detail: `${where}: <${lower}> grew from ${enText.length} to ${locText.length} characters `
        + `("${enText.slice(0, 40)}" → "${locText.slice(0, 60)}") — the tag boundary moved and now `
        + 'wraps text it should not.',
      ...at,
      tag: lower,
      enLength: enText.length,
      length: locText.length,
    }));
  }
  // A sub/sup that lost the whitespace in front of it renders as one word. Compared
  // against the English side, because `CO<sub>2</sub>` legitimately has no space before
  // it and a bare "no space" test would flag every chemical formula on the site.
  if (['SUB', 'SUP'].includes(tag) && hasGapBefore(enTag) && !hasGapBefore(locTag)) {
    out.push(finding({
      severity: 'warning',
      check: 'markup-drift',
      detail: `${where}: <${lower}> lost the space before it — renders as `
        + `"…${(locTag.previousSibling?.textContent || '').slice(-12)}${locText.slice(0, 20)}".`,
      ...at,
      tag: lower,
    }));
  }
  return out;
}

const INLINE_SELECTOR = 'a, strong, em, sub, sup';

/** Compare the inline markup of one aligned element pair. */
function compareInline(enEl, locEl, enSig, locSig, where, at) {
  if (enSig.join('|') !== locSig.join('|')) {
    return [finding({
      severity: 'warning',
      check: 'markup-drift',
      detail: `${where}: inline markup sequence differs — English [${enSig.join(', ') || 'none'}] `
        + `vs translated [${locSig.join(', ') || 'none'}].`,
      ...at,
      enSignature: enSig,
      signature: locSig,
    })];
  }
  const enInline = [...enEl?.querySelectorAll?.(INLINE_SELECTOR) || []];
  const locInline = [...locEl?.querySelectorAll?.(INLINE_SELECTOR) || []];
  return enInline.flatMap((enTag, k) => (locInline[k]
    ? tagFindings(enTag, locInline[k], where, at)
    : []));
}

function checkInlineMarkup(en, loc) {
  return alignedPairs(en, loc).flatMap(({
    si, ni, enNode, locNode,
  }) => {
    const at = { section: si, node: ni };
    if (enNode.kind === 'prose') {
      const where = `section ${si} ${enNode.tag}`;
      return compareInline(enNode.el, locNode.el, enNode.inline, locNode.inline, where, at);
    }
    return enNode.rows.flatMap((enRow, ri) => enRow.flatMap((enCell, ci) => {
      const locCell = locNode.rows[ri]?.[ci];
      const where = `${enNode.classes} (section ${si}) row ${ri} col ${ci + 1}`;
      return locCell
        ? compareInline(enCell.el, locCell.el, enCell.inline, locCell.inline, where, at)
        : [];
    }));
  });
}

/* ------------------------------------------------------------------ numbers and dates */

/** Prose text of a document, joined. Prose only — see `checkNumbers`. */
const proseText = (doc) => doc.sections
  .flatMap((s) => s.nodes.filter((n) => n.kind === 'prose').map((n) => n.text))
  .join(' ');

/**
 * Figures, compared as VALUES rather than as text.
 *
 * `176,000` → `176.000` and `1.5` → `1,5` are correct German localizations and must
 * pass; `1.5` → `15` must not. Normalizing each side with its OWN locale's separators is
 * the only way to tell those apart, and it is why this check exists separately from
 * anything a fidelity judge does — a judge built to flag digit-level changes fails every
 * well-localized statistic.
 *
 * PROSE ONLY. Block cells are full of digits that are not figures: media ids, `limit`,
 * `page size`, and above all section-metadata values like `columns-10-90`, which upstream
 * made this check report "the figure 10 is missing" on a page whose only 10 was a CSS
 * class name. A reader's figures live in paragraphs, headings and list items.
 */
function checkNumbers(en, loc, { code }) {
  const out = [];
  const collect = (doc, c) => doc.sections.flatMap((sec) => sec.nodes
    .filter((n) => n.kind === 'prose')
    .flatMap((n) => extractNumbers(n.text, c).map((x) => x.value)));
  const enVals = collect(en, 'en');
  const locVals = collect(loc, code);
  const locSet = new Map();
  for (const v of locVals) locSet.set(v, (locSet.get(v) || 0) + 1);
  const unmatched = [];
  for (const v of enVals) {
    const n = locSet.get(v) || 0;
    if (n === 0) unmatched.push(v);
    else locSet.set(v, n - 1);
  }

  /*
   * A small figure the translator SPELLED OUT is not a missing figure, it is house style.
   * Every one of these languages writes numbers under twelve as words and translators
   * apply it. Reported as a note so it is visible and verifiable, never as a warning,
   * because there is nothing to fix — and a reviewer who chases one of these learns to
   * skip the rest.
   */
  const locText = proseText(loc);
  const words = [];
  const missing = [];
  for (const v of unmatched) {
    const word = spelledOut(v, locText, code);
    if (word) words.push({ value: v, word });
    else missing.push(v);
  }

  // ONE finding listing the values, not one per value: a page whose figures genuinely
  // got mangled produces a dozen, and a dozen findings reads as a dozen problems.
  if (missing.length) {
    out.push(finding({
      severity: 'warning',
      check: 'numbers',
      detail: `${missing.length} figure(s) on the English page have no equal-valued counterpart on `
        + `the translated page: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}. `
        + 'Values are compared after normalizing each side to its own locale conventions, so this '
        + 'is not a formatting difference.',
      missing: missing.slice(0, 20),
    }));
  }
  if (words.length) {
    out.push(finding({
      severity: 'note',
      check: 'numbers',
      detail: `${words.length} small figure(s) are spelled out rather than written as digits `
        + `(${words.map((w) => `${w.value} → "${w.word}"`).join(', ')}) — normal house style in this `
        + 'language, listed only so the figure comparison is fully accounted for.',
      spelledOut: words,
    }));
  }
  return out;
}

/**
 * Dates.
 *
 * An ISO-8601 date is an IDENTIFIER on this site, not prose: `event-date` and
 * `publication-date` feed the query index and the lifecycle model, and a machine
 * translation of `2026-10-02` is unparseable rather than localized. So it must survive
 * byte-identical, and the contract already says so for the metadata block — this check
 * catches the same value wherever else it appears.
 *
 * A date written in words is the opposite: `2 October 2026` → `2. Oktober 2026` is
 * exactly what a localized page should say. The year is already covered by the value
 * comparison in `checkNumbers`, so there is nothing left to check and nothing is
 * reported. A month name is never a finding here — the judge's SUPPRESS list says the
 * same thing from the other side.
 */
function checkDates(en, loc) {
  const iso = (text) => [...String(text).matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((m) => m[0]);
  const enIso = [...new Set(iso(proseText(en)))];
  const locIso = new Set(iso(proseText(loc)));
  const lost = enIso.filter((d) => !locIso.has(d));
  if (!lost.length) return [];
  return [finding({
    severity: 'error',
    check: 'dates',
    detail: `ISO date(s) ${lost.join(', ')} did not survive verbatim. An ISO-8601 date is an `
      + 'identifier here — it feeds the query index and the meetup lifecycle — so a translated or '
      + 'reformatted one is unparseable rather than localized.',
    lost,
    dntViolation: true,
  })];
}

/**
 * Quote conventions. A NOTE, never worse.
 *
 * It is a typographic polish issue, and ranking it with a deleted heading is exactly the
 * kind of severity inflation that gets a report skimmed instead of read.
 */
function checkTypography(loc, { code, name }) {
  const r = quoteStyleCheck(proseText(loc), code);
  if (!r || !r.straight) return [];
  return [finding({
    severity: 'note',
    check: 'typography',
    detail: `${r.straight} quoted passage(s) use straight ASCII quotes; ${name} convention is `
      + `${r.expected}${r.inconsistent ? ` (${r.correct} passage(s) do use it, so the page is inconsistent)` : ''}.`,
    straight: r.straight,
    correct: r.correct,
    inconsistent: r.inconsistent,
  })];
}

/* ------------------------------------------------------------------ expansion */

/**
 * Per-component length ratios, NORMALIZED BY THE LOCALE'S OWN EXPANSION FACTOR.
 *
 * This is the whole reason the English tier's word-ratio check cannot be reused: German
 * running 1.3x longer than English is what German does, and an absolute band fails every
 * German page for being German. So the ratio is divided by `expansion` from
 * scripts/tracker/locales.js and the RESULT is compared against `qa.wordRatio` — the same
 * configured band, applied to a number that has had the expected growth taken out of it.
 * Registry and config each keep the half they own: the registry knows what a language
 * does, the config knows how much deviation is tolerable.
 *
 * The component outliers are not a defect on their own. Their job is to TARGET tier 3:
 * a hero heading that grew far beyond its locale's norm is where a layout break will be,
 * and screenshotting that component beats screenshotting the page. The filter is
 * deliberately narrow — short strings only, which is where fixed-size components live —
 * because a long paragraph growing 1.6x just reflows.
 */
function measureExpansion(en, loc, { expansion, name, wordRatio }) {
  const components = [];
  let enTotal = 0;
  let locTotal = 0;
  const chars = (node) => (node.kind === 'prose'
    ? node.text.length
    : node.rows.flat().reduce((n, c) => n + c.text.length, 0));
  for (const {
    si, ni, enNode, locNode,
  } of alignedPairs(en, loc)) {
    const enLen = chars(enNode);
    const locLen = chars(locNode);
    enTotal += enLen;
    locTotal += locLen;
    // Sub-4-character components carry no meaningful ratio: a 1-character cell that
    // becomes 2 is a 2x "expansion" and tells a reviewer nothing.
    if (enLen >= 4) {
      components.push({
        section: si,
        node: ni,
        what: enNode.kind === 'block' ? enNode.classes : enNode.tag,
        enChars: enLen,
        chars: locLen,
        ratio: Number((locLen / enLen).toFixed(2)),
        normalized: Number((locLen / enLen / expansion).toFixed(2)),
      });
    }
  }
  components.sort((a, b) => b.normalized - a.normalized);

  const overall = enTotal ? locTotal / enTotal : null;
  const normalized = overall === null ? null : overall / expansion;
  const findings = components
    .filter((c) => c.normalized >= 1.5 && c.enChars <= 120)
    .slice(0, 12)
    .map((c) => finding({
      severity: 'note',
      check: 'expansion',
      detail: `${c.what} (section ${c.section}) grew ${c.ratio}x on a short string `
        + `(${c.enChars} → ${c.chars} chars) — ${c.normalized}x after allowing for ${name}'s `
        + `normal ${expansion}x expansion. A likely layout break; tier 3 should capture it.`,
      ...c,
    }));

  /*
   * The whole-page band. Below `failMin` the translated page is materially SHORTER than
   * the locale should produce, which is content dropped in the round trip — the one
   * direction of this ratio that is a defect rather than a note.
   */
  /*
   * A FLOOR, and 600 characters rather than a token one.
   *
   * Below roughly a screenful the whole-page ratio is dominated by a single sentence's
   * word choice: measured on a 233-character meetup page a correct German translation
   * came out at 84% of expected and earned a warning nobody could act on. The band is a
   * statement about a page's worth of prose, so it is only asked of a page that has one.
   */
  if (normalized !== null && enTotal >= 600) {
    const pct = (x) => `${Math.round(x * 100)}%`;
    if (normalized < wordRatio.failMin) {
      findings.push(finding({
        severity: 'error',
        check: 'expansion',
        detail: `the ${name} page is ${pct(normalized)} of the length it should be `
          + `(${enTotal} → ${locTotal} chars, ${overall.toFixed(2)}x raw against an expected `
          + `${expansion}x). Content was dropped in the round trip.`,
        normalized: Number(normalized.toFixed(3)),
        ratio: Number(overall.toFixed(3)),
      }));
    } else if (normalized < wordRatio.warnMin || normalized > wordRatio.warnMax) {
      findings.push(finding({
        severity: 'warning',
        check: 'expansion',
        detail: `the ${name} page is ${pct(normalized)} of its expected length `
          + `(${enTotal} → ${locTotal} chars, ${overall.toFixed(2)}x raw against an expected `
          + `${expansion}x) — outside the ${pct(wordRatio.warnMin)}–${pct(wordRatio.warnMax)} band.`,
        normalized: Number(normalized.toFixed(3)),
        ratio: Number(overall.toFixed(3)),
      }));
    }
  }

  return {
    findings,
    expansion: {
      factor: expansion,
      overallRatio: overall === null ? null : Number(overall.toFixed(3)),
      normalizedRatio: normalized === null ? null : Number(normalized.toFixed(3)),
      enChars: enTotal,
      chars: locTotal,
      components: components.slice(0, 40),
    },
  };
}

/* ------------------------------------------------------------------ evidence for tier 2 */

/**
 * Aligned EN→target text pairs — the highest-value field in the whole report.
 *
 * Tier 1 has already lined the two sides up position by position, so handing the judge
 * two prose blobs throws away the one thing this stage knows and asks a 14B model to
 * redo the part it is worst at. The errors it makes reconstructing the correspondence
 * (comparing the target hero against the English disclaimer) look exactly like real
 * defects.
 *
 * `pairs` includes translatable BLOCK CELLS, not just prose. Excluding them was a real
 * upstream bug: a quote block's `position` cell rendered "Director" as "Regisseur" (a
 * film director) and the judge could not see it, on the theory that the DNT contract had
 * settled block cells. The contract settles WHETHER a cell should be translated; it says
 * nothing about whether the translation is any good. And these cells carry the
 * highest-visibility copy on the page — the H1, the eyebrow, the CTA, the pull quote.
 */
function buildPairs(en, loc, { contract }) {
  return alignedPairs(en, loc).flatMap(({ si, enNode, locNode }) => {
    if (enNode.kind === 'prose') {
      return enNode.text
        ? [{ where: `section ${si} ${enNode.tag}`, en: enNode.text, translated: locNode.text }]
        : [];
    }
    const rule = ruleFor(contract.rules, enNode.classes);
    return enNode.rows.flatMap((enRow, ri) => enRow.flatMap((enCell, ci) => {
      const locCell = locNode.rows[ri]?.[ci];
      const cellCtx = {
        rowIndex: ri,
        colIndex: ci,
        rowLength: enRow.length,
        rowCount: enNode.rows.length,
        cells: enRow.map((x) => x.text),
      };
      // Only cells the contract permits translating. A protected cell that is identical
      // is not evidence of anything, and one that CHANGED is already a tier-1 finding the
      // judge is explicitly told not to repeat.
      if (!locCell || !permitsTranslation(rule, cellCtx)) return [];
      if (!enCell.text || enCell.text.length < 2) return [];
      /*
       * Drop cells with nothing to judge. Necessary because a block with NO rule permits
       * everything, so upstream a share-link block contributed three percent-encoded URLs
       * as "translatable text" — 400 characters that push real copy out of the token
       * budget and invite the judge to opine on a URL.
       */
      if (/^(https?:\/\/|\/[a-z]{2}(-[a-z]{2})?\/|aemdev:|#|\d[\d\s.,]*$)/i.test(enCell.text)) return [];
      /*
       * A cell that is identical AND carries no language evidence is a proper noun
       * ("adaptTo()"), correctly unchanged in all ten locales. Showing it to the judge as
       * an EN/DE pair that did not change is an invitation to report it as untranslated.
       */
      if (enCell.text === locCell.text
        && translationVerdict({ text: enCell.text, expected: 'en' }).verdict !== 'translated') {
        return [];
      }
      /*
       * A key/value row's col-0 cell is a KEY, so it is excluded: tier 1 owns keys
       * deterministically and there is nothing for a judge or a reviewer to say about
       * one. A SINGLE-cell row is different — that cell is the block's whole content — so
       * it stays, and labelling the pair with its own text would produce a 70-character
       * heading repeating the value beneath it, so it gets the block name instead.
       */
      if (ci === 0 && enRow.length > 1) return [];
      const key = enRow.length > 1 ? enRow[0]?.text : null;
      const label = key
        ? `${enNode.classes} / ${key.length > 28 ? `${key.slice(0, 28)}…` : key}`
        : enNode.classes;
      return [{ where: label, en: enCell.text, translated: locCell.text }];
    }));
  });
}

/* ------------------------------------------------------------------ the run */

/** The default report path for a (locale, page) pair. Contract §0. */
export const reportPathFor = (cfg, code, pagePath) => join(cfg.state.txReportsDir, `${code}--${slugOf(pagePath)}.json`);

/**
 * Does a document exist in DA at this path?
 *
 * DA is the source of truth for existence everywhere else in this system, so the probe
 * asks DA and not the preview host — see `checkPaths` for the measured consequence of
 * getting that backwards. Without a token it answers `false` for everything, which
 * downgrades `unlocalized-path` from error to warning; that is the honest degradation
 * (we cannot tell whether the counterpart exists) and it is reported in `checks.probe`.
 */
export function daProbe(token) {
  const seen = new Map();
  const probed = { attempted: 0, authorized: Boolean(token) };
  const probe = async (p) => {
    if (seen.has(p)) return seen.get(p);
    let ok = false;
    if (token) {
      probed.attempted += 1;
      const res = await fetch(daSourceUrl(p, 'html'), { headers: { Authorization: `Bearer ${token}` } })
        .catch(() => ({ ok: false }));
      ok = Boolean(res.ok);
    }
    seen.set(p, ok);
    return ok;
  };
  return { probe, probed };
}

/**
 * Run every tier-1 check on one English/target pair.
 *
 * Returns a report in the shape data-contract.md §4 defines, with `tiers.judge` and
 * `tiers.visual` NULL — "we did not look" and "we looked and it was fine" must never be
 * the same value. tx-judge fills its own slot in the same file, and tx-driver merges the
 * top-level `verdict` once.
 */
export async function txQa({
  enUrl, targetUrl, code, cfg, contract, pagePath = null, group = null, template = null,
  branch = null, probe = null,
}) {
  const loc = localeFor(code);
  if (!loc) return { fatal: `unknown locale: ${code}`, usage: true };
  const fetchOpts = { userAgent: cfg.qa.userAgent, timeoutMs: cfg.qa.fetchTimeoutMs };
  const plain = (u) => `${u.replace(/\/$/, '/index')}.plain.html`;
  const generated = new Date().toISOString();

  const [enPlain, locPlain, locRendered] = await Promise.all([
    fetchHtml(plain(enUrl), fetchOpts),
    fetchHtml(plain(targetUrl), fetchOpts),
    fetchHtml(targetUrl, fetchOpts),
  ]);

  const envelope = (tier, verdict) => ({
    'page-path': pagePath,
    locale: loc.code,
    group,
    template,
    urls: { source: enUrl, target: targetUrl },
    branch,
    generated,
    tiers: { structural: tier, judge: null, visual: null },
    verdict,
  });

  if (enPlain.status !== 200) {
    return {
      fatal: `English source fetch ${enPlain.status} ${plain(enUrl)}`
        + `${enPlain.error ? ` (${enPlain.error})` : ''}`,
    };
  }

  /*
   * No document at the target path is NOT a defect. It is the normal state of every
   * locale on this site today, and calling it a failure would write a defect record for
   * a page nobody has claimed to have translated. Upstream did exactly that: one run
   * created 164 review docs for 13 translated pages.
   *
   * So it is a `review` verdict with a warning — "there is nothing here to judge" — and
   * exit 2. Deciding that a page was SENT and never arrived is `classifyTranslation`'s
   * job, from `sent-at` plus an observed preview, not this tier's.
   */
  if (locPlain.status !== 200) {
    const f = finding({
      severity: 'warning',
      check: 'not-translated',
      detail: `no document at ${plain(targetUrl)} (HTTP ${locPlain.status}) — this page has not `
        + `been translated into ${loc.name} yet. Nothing to judge; the pair holds its status.`,
      status: locPlain.status,
    });
    return envelope({
      verdict: 'review',
      fatal: null,
      errors: [],
      warnings: [f],
      notes: [],
      checks: { rendered: { status: locRendered.status }, translated: false },
    }, 'review');
  }

  const en = parseDoc(enPlain.html);
  const target = parseDoc(locPlain.html);
  const ctx = { code: loc.code, name: loc.name, contract };
  const { probe: doProbe, probed } = probe ? { probe, probed: { supplied: true } } : daProbe(null);

  const all = [];
  const skeleton = checkSkeleton(en, target, ctx);
  all.push(...skeleton.findings);
  all.push(...checkHeadings(en, target, ctx));

  let exp = { findings: [], expansion: null };
  if (skeleton.aligned) {
    all.push(...checkCells(en, target, ctx));
    all.push(...checkCodeSpans(en, target));
    all.push(...checkProtectedTerms(en, target, ctx));
    all.push(...checkInlineMarkup(en, target));
    exp = measureExpansion(en, target, {
      expansion: loc.expansion, name: loc.name, wordRatio: cfg.qa.wordRatio,
    });
    all.push(...exp.findings);
  }
  const prose = checkProseLanguage(en, target, ctx);
  all.push(...prose.findings);
  all.push(...await checkPaths(target, ctx, doProbe));
  all.push(...checkAnchors(target));
  all.push(...checkAssets(en, target, ctx));
  all.push(...checkNumbers(en, target, ctx));
  all.push(...checkDates(en, target));
  all.push(...checkTypography(target, ctx));

  const errors = all.filter((f) => f.severity === 'error');
  const warnings = all.filter((f) => f.severity === 'warning');
  const notes = all.filter((f) => f.severity === 'note');
  let verdict = 'pass';
  if (errors.length) verdict = 'fail';
  else if (warnings.length) verdict = 'review';

  const cap = (t) => t.split(' ').slice(0, cfg.qa.maxTextWords).join(' ');
  const report = envelope({
    verdict,
    fatal: null,
    errors,
    warnings,
    notes,
    checks: {
      translated: true,
      skeleton: {
        aligned: skeleton.aligned,
        sections: en.sections.length,
        blocks: en.sections.flatMap((s) => s.nodes.filter((n) => n.kind === 'block').map((n) => n.classes)),
      },
      headings: { en: en.headings.length, translated: target.headings.length },
      dnt: {
        contract: contract.source,
        rulesLoaded: contract.rules.size,
        literals: contract.literals.length,
        // Split, because they route to different people: a violation means the translator
        // ignored a rule (re-translate), a gap means there is no rule to ignore (edit the
        // contract, THEN re-translate — re-translating first reproduces the defect).
        violations: all.filter((f) => f.dntViolation).length,
        gaps: all.filter((f) => f.dntGap).length,
        unruledBlocks: [...new Set(en.sections
          .flatMap((s) => s.nodes.filter((n) => n.kind === 'block'))
          .filter((n) => ruleFor(contract.rules, n.classes).mode === 'all')
          .map((n) => n.name))],
      },
      language: prose.coverage,
      anchors: { ids: target.ids.length, links: target.anchors.length },
      assets: {
        images: { en: en.images.length, translated: target.images.length },
        icons: { en: en.icons.length, translated: target.icons.length },
        links: { en: en.links.length, translated: target.links.length },
      },
      expansion: exp.expansion,
      probe: probed,
      rendered: { status: locRendered.status },
    },
  }, verdict);
  report.textSample = {
    en: cap(proseText(en)),
    translated: cap(proseText(target)),
    pairs: buildPairs(en, target, ctx),
  };
  return report;
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(args) {
  const o = {
    locale: null,
    path: null,
    en: null,
    translated: null,
    group: null,
    branch: null,
    out: null,
    json: false,
    quiet: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a.startsWith('--locale=')) o.locale = a.slice(9).trim().toLowerCase();
    else if (a.startsWith('--path=')) o.path = a.slice(7);
    else if (a.startsWith('--en=')) o.en = a.slice(5);
    else if (a.startsWith('--translated=')) o.translated = a.slice(13);
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  if (!o.locale) throw new Error('--locale=<code> is required');
  if (!localeFor(o.locale)) throw new Error(`--locale="${o.locale}" is not a known locale`);
  const pairMode = Boolean(o.en && o.translated);
  if (!o.path && !pairMode) {
    throw new Error('need --path=<page-path>, or both --en=<url> and --translated=<url>');
  }
  /*
   * `en` is the SOURCE locale. Asked for with `--path=`, the request is "translate this
   * page into itself", and answering it would look like it worked. In PAIR MODE it is
   * allowed and is the only way to exercise this tier before a locale tree exists: two
   * URLs, both expected to be English.
   */
  if (o.locale === 'en' && !pairMode) {
    throw new Error('--locale=en is the source; pass explicit --en= and --translated= URLs '
      + 'to run this tier in pair mode against two English pages');
  }
  return o;
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const cfg = loadConfig();
  const contract = loadDntContract();
  for (const e of contract.errors) {
    console.error(`⚠ custom-doc-rules row ${e.row} (${e.block}) did not parse: ${e.detail}`);
    console.error('  Those blocks are treated as FULLY PROTECTED until the rule is fixed.');
  }

  const pagePath = opts.path ? normalizePath(opts.path) : null;
  const group = opts.group || (pagePath ? groupForPath(pagePath) : null);
  const branch = opts.branch || (group ? groupConfig(cfg, group).branch : cfg.publish.branch);
  const enPath = pagePath ? pathForLocale(pagePath, 'en') || pagePath : null;
  const enUrl = opts.en || previewUrl(enPath, branch);
  const targetUrl = opts.translated || previewUrl(pathForLocale(enPath, opts.locale), branch);

  const { probe } = daProbe(null);
  const report = await txQa({
    enUrl,
    targetUrl,
    code: opts.locale,
    cfg,
    contract,
    pagePath: enPath,
    group,
    template: pagePath ? pagetypeOf(pagePath) : null,
    branch,
    probe,
  });
  if (report.fatal) {
    console.error(`✗ tx-qa: ${report.fatal}`);
    return report.usage ? 3 : 2;
  }

  const tier = report.tiers.structural;
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!opts.quiet) {
    for (const f of [...tier.errors, ...tier.warnings, ...tier.notes]) {
      const mark = { error: '✗', warning: '!', note: '·' }[f.severity];
      console.log(`${mark} [${f.check}] ${f.detail}`);
    }
    console.log(`\n  ${enUrl}\n  ${targetUrl}`);
    if (tier.checks.language) {
      const l = tier.checks.language;
      console.log(`  language: ${l.translated} confirmed / ${l.untranslated} untranslated / `
        + `${l.uncertain} undecidable of ${l.total} prose node(s), expected `
        + `${localeFor(opts.locale).name}`);
    }
    if (tier.checks.expansion) {
      const x = tier.checks.expansion;
      console.log(`  expansion: ${x.overallRatio}x raw / ${x.normalizedRatio}x after allowing for `
        + `the locale's ${x.factor}x norm`);
    }
    if (tier.checks.dnt) {
      console.log(`  dnt: ${tier.checks.dnt.rulesLoaded} block rule(s), `
        + `${tier.checks.dnt.violations} violation(s), ${tier.checks.dnt.gaps} gap(s)`);
    }
  }

  const explicitOut = opts.out && (isAbsolute(opts.out) ? opts.out : join(REPO_ROOT, opts.out));
  const defaultOut = pagePath ? reportPathFor(cfg, opts.locale, enPath) : null;
  const outPath = explicitOut || defaultOut;
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    if (!opts.quiet) console.log(`  report: ${outPath}`);
  }

  console.error(`TX-QA (${report.locale}): ${tier.verdict.toUpperCase()} — `
    + `${tier.errors.length} error(s), ${tier.warnings.length} warning(s), ${tier.notes.length} note(s)`);
  return verdictExit(tier.verdict);
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ tx-qa: ${e.message}`);
      exit(/^unknown arg|is required|is not a known locale|need --path|is the source|no DNT contract|unknown group/.test(e.message) ? 3 : 2);
    });
}
