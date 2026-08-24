#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * structural-qa.mjs — TIER 1. Deterministic structural QA for one page. ZERO TOKENS.
 *
 * CLI SURFACE
 *   node tools/tracker/structural-qa.mjs --path=<page-path> [options]      baseline mode
 *   node tools/tracker/structural-qa.mjs --source=<url> --migrated=<url>   pair mode
 *   node tools/tracker/structural-qa.mjs --path=<p> --calibrate [--apply]  write a baseline
 *
 *   --path=<page-path>   the page under test, e.g. /en/meetups/adaptto-2026-berlin
 *   --url=<url>          the same, given as a full URL (branch inferred from the host)
 *   --source=<url>       PAIR MODE: the reference page (the English page)
 *   --migrated=<url>     PAIR MODE: the page under test (its translation)
 *   --group=<name>       which baseline and brief to judge against
 *                        (default: derived from the path by lib/group-map.mjs)
 *   --branch=<ref>       preview host to read (default: publish.branch, i.e. main)
 *   --calibrate          derive a baseline from THIS page and print it
 *   --apply              with --calibrate, actually write it (default is a dry run)
 *   --out=<file>         write the JSON report here
 *   --no-links           skip the internal-link reachability sweep (the slow check)
 *   --quiet              exit code and one summary line only
 *   --help
 *
 *   npm run qa:page -- --path=/en/meetups/adaptto-2026-berlin
 *
 * ─── WHAT THIS TIER IS, AFTER THE REPURPOSING ───────────────────────────────
 *
 * The tool this is ported from compared a legacy CMS page against its rebuilt EDS
 * replacement: every check was a DIFF, and the legacy page was the authority. Here
 * there is no legacy page. The English page is the original and it is already live.
 *
 * So tier 1 has two modes, and they share one battery:
 *
 *   BASELINE MODE  one page against its GROUP BASELINE
 *                  (.tracker/qa-baselines/<group>.json, written by --calibrate on a
 *                  blessed page) plus the group's REQUIREMENTS BRIEF. Answers: are
 *                  the headings this group's pages must carry present and in order,
 *                  is the text volume plausible, does every image carry alt text, do
 *                  the internal links and icons resolve, is every declared block one
 *                  this site can actually decorate, is the required metadata there,
 *                  and does every string a human declared must-survive-verbatim
 *                  appear.
 *
 *   PAIR MODE      the English page against a counterpart — used by the translation
 *                  tier (tools/tracker/tx-qa.mjs), which is why this file keeps the
 *                  `--source=`/`--migrated=` shape rather than growing a second copy
 *                  of the battery. In pair mode the reference is the EN page and the
 *                  checks become diffs again: headings, word ratio, the block set,
 *                  the icon set, and whether links were localised.
 *
 * ─── EXIT CODES — the one place this deviates from the source ───────────────
 *
 *   0 pass · 1 fail (a real defect) · 2 could not reach a verdict · 3 usage/config
 *
 * `report.fatal → 3` is kept, but only for what it should have meant: the tool could
 * not be CONFIGURED to run (unknown group, contradictory arguments). A page that does
 * not answer on the preview host is `unreachable → 2`, because data-contract.md §5
 * names "a missing page" as exit 2 explicitly — the page holds its status and the
 * batch continues. The source collapsed both into 3, which made an offline host look
 * like a broken command line and stopped resumable batches from resuming.
 *
 * `review → 2` for the same reason it did upstream: "the deterministic tier found
 * something it cannot adjudicate" IS "could not reach a verdict". The judge decides.
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  normalizePath, localeForPath, pathForLocale, isTargetLocale,
} from '../../scripts/tracker/locales.js';
import { previewUrl, plainPath, branchFromUrl, DEFAULT_BRANCH } from '../../scripts/tracker/paths.js';
import { loadConfig, REPO_ROOT, CONFIG_DIR } from './config.mjs';
import { groupForPath, pagetypeOf } from './lib/group-map.mjs';
import {
  loadRequirements, verbatimRequirements, JUDGE_SECTION, EN_JUDGE_SECTION,
} from './lib/requirements.mjs';
import {
  fetchHtml, extractContent, extractBlocks, extractSectionStyles, extractIconRefs,
  fetchIconShape, checkReachable, diffHeadings, headingSequence, missingVerbatim,
  normHeading, normText,
} from './lib/extract.mjs';

const HELP = `structural-qa — tier 1, deterministic, zero tokens.

  --path=<page-path>       the page under test (baseline mode)
  --url=<url>              the same, as a full URL
  --source=<url>           pair mode: the reference page
  --migrated=<url>         pair mode: the page under test
  --group=<name>           baseline + brief to use (default: derived from the path)
  --branch=<ref>           preview host to read (default: main)
  --calibrate [--apply]    derive a baseline from this page; --apply writes it
  --out=<file>             write the JSON report here
  --no-links               skip the internal-link reachability sweep
  --quiet                  summary line only
  --help                   this text

exit 0 pass · 1 fail · 2 no verdict (review, or the page does not answer) · 3 usage/config`;

/* ------------------------------------------------------------------- baselines */

/** Where a group's calibrated thresholds live. Committed — see .gitignore. */
export const baselinePath = (group) => join(REPO_ROOT, CONFIG_DIR, 'qa-baselines', `${group}.json`);

/**
 * A group baseline records the EXPECTED shape of that group's pages, calibrated on a
 * human-blessed page, so per-page QA flags DEVIATIONS rather than restating the
 * template. `{}` when there is none — every baselined check then reports `skip` and
 * says so, which is what makes `--calibrate` runnable on a group that has none yet.
 *
 * Keys, all optional:
 *   words.min          absolute floor. Below it the page is empty or truncated.
 *   words.reference    the blessed page's word count, for the ratio band.
 *   wordRatio          per-group override of cfg.qa.wordRatio.
 *   requiredHeadings   regexes. Every one must match a heading, in THIS ORDER.
 *   allowMissingHeadings  pair mode: headings approved to disappear in translation.
 *   headingsNeverFail  a missing heading warns instead of failing.
 *   requiredMetadata   `<meta name=>` keys that must be present and non-empty.
 *   knownBlocks        block names this group is allowed to declare beyond the ones
 *                      the repo can decorate (a CSS-only block in a template, say).
 *   requireAlt         a missing alt is an error rather than a warning.
 *   linkCheckLimit     cap on internal-link probes.
 *   maxH1              more than this many `h1`s is a structural defect.
 */
export function loadBaseline(group) {
  if (!group) return {};
  const f = baselinePath(group);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
}

/**
 * Every block name this site can actually DECORATE.
 *
 * Two sources, because EDS has two kinds of block and only one of them has a
 * directory:
 *   blocks/<name>/       a JS/CSS block
 *   a `.<name>` selector in styles/*.css or templates/**\/*.css — a CSS-ONLY block,
 *                        which is a legitimate pattern and has no directory at all
 *                        (`key-points` on this site is one).
 *
 * A declared block in NEITHER renders as an undecorated `<div>`: no CSS, no JS, the
 * authored content still visible, nothing in the console. It is the quietest way an
 * EDS page can be wrong, and no other check in this battery can see it — the text is
 * all present, the links resolve, the word count is right.
 */
function siteCss(root) {
  const files = [];
  const collect = (dir, depth) => {
    if (!existsSync(dir) || depth > 2) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) collect(join(dir, e.name), depth + 1);
      else if (e.name.endsWith('.css')) files.push(readFileSync(join(dir, e.name), 'utf8'));
    }
  };
  collect(join(root, 'styles'), 0);
  collect(join(root, 'templates'), 0);
  return files;
}

export function knownBlockNames(root = REPO_ROOT) {
  const names = new Set();
  const blocksDir = join(root, 'blocks');
  if (existsSync(blocksDir)) {
    for (const e of readdirSync(blocksDir, { withFileTypes: true })) {
      if (e.isDirectory()) names.add(e.name);
    }
  }
  /*
   * A bare `.<name>` selector anywhere in the site CSS counts, which is DELIBERATELY
   * permissive: class names share one namespace, so a rule written for something else
   * can happen to match a block name and wave a real defect through. That is the right
   * way to be wrong here. A false negative loses one finding; a false positive tells a
   * reviewer that a working page is broken, and a check that cries wolf gets switched
   * off. The baseline's `knownBlocks` is the explicit escape hatch for the rest.
   */
  for (const css of siteCss(root)) {
    for (const m of css.matchAll(/\.([a-z][a-z0-9-]*)\b/g)) names.add(m[1]);
  }
  return names;
}

/**
 * Every SECTION STYLE this site can render: the `.section.<name>` rules.
 *
 * Anchored on `.section.` rather than on a bare class, because that is exactly how EDS
 * renders a `section-metadata` `style` row and the anchor makes the check precise
 * instead of permissive — a misspelled section style genuinely has no matching rule.
 */
export function knownSectionStyles(root = REPO_ROOT) {
  const names = new Set();
  for (const css of siteCss(root)) {
    for (const m of css.matchAll(/\.section\.([a-z][a-z0-9-]*)\b/g)) names.add(m[1]);
  }
  return names;
}

/* ------------------------------------------------------------------ check records */

/**
 * The battery's output is a LIST of check records, not a bag of booleans.
 *
 * `{ check, verdict, detail, …facts }`, one per check that ran, `verdict: 'skip'`
 * for one that could not. A skipped check has to be visible: the source reported a
 * battery of nine checks whether or not the evidence for three of them existed, and
 * a reader counting nine green checks had no way to learn that three never looked.
 */
const VERDICTS = { pass: 0, warn: 1, fail: 2 };

class Report {
  constructor() {
    this.checks = [];
  }

  add(check, verdict, detail, facts = {}) {
    this.checks.push({ check, verdict, ...(detail ? { detail } : {}), ...facts });
    return this;
  }

  /** Roll a per-item finding list into one record, at the worst verdict present. */
  addMany(check, items, facts = {}) {
    const worst = items.reduce((w, i) => (VERDICTS[i.verdict] > VERDICTS[w] ? i.verdict : w), 'pass');
    this.checks.push({
      check,
      verdict: items.length ? worst : 'pass',
      ...(items.length ? { findings: items } : {}),
      ...facts,
    });
    return this;
  }

  skip(check, why) {
    return this.add(check, 'skip', why);
  }

  get errors() {
    return this.flatten('fail');
  }

  get warnings() {
    return this.flatten('warn');
  }

  flatten(verdict) {
    const out = [];
    for (const c of this.checks) {
      if (c.verdict === verdict && c.detail) out.push({ check: c.check, detail: c.detail });
      for (const f of c.findings || []) {
        if (f.verdict === verdict) out.push({ check: c.check, detail: f.detail });
      }
    }
    return out;
  }

  get verdict() {
    if (this.errors.length) return 'fail';
    return this.warnings.length ? 'review' : 'pass';
  }
}

/* --------------------------------------------------------------- the check battery */

/**
 * Fetch the two renditions a page is judged from.
 *
 * The `.plain.html` form comes from `plainPath()` in scripts/tracker/paths.js rather
 * than from string surgery here. It is the same derivation the source did inline
 * (`replace(/\/$/, '/index') + '.plain.html'`), moved into the module that owns every
 * URL this tracker points at — the whole point of that module is that the browser and
 * the pipeline cannot come to disagree about a path.
 */
async function fetchPage(pageUrl, fetchOpts) {
  const u = new URL(pageUrl);
  const plainTarget = `${u.origin}${plainPath(u.pathname)}`;
  const [rendered, authored] = await Promise.all([
    fetchHtml(pageUrl, fetchOpts),
    fetchHtml(plainTarget, fetchOpts),
  ]);
  return { rendered, authored, plainUrl: plainTarget };
}

function checkHeadings(report, headings, baseline) {
  const seq = headingSequence(headings);
  const h1s = headings.filter((h) => h.level === 1).length;
  const maxH1 = baseline.maxH1 ?? 1;
  if (h1s > maxH1) {
    report.add('headings-h1', 'fail', `${h1s} h1 headings (at most ${maxH1} expected)`, { h1s });
  }

  const required = baseline.requiredHeadings || [];
  if (!required.length) {
    report.skip('headings', 'no requiredHeadings in the group baseline');
    return;
  }
  /*
   * Present AND ORDERED, in one pass. Order is checked on the headings that were
   * FOUND rather than by index into the full list, so one missing heading reports
   * itself once and does not also report every heading after it as out of order.
   */
  const items = [];
  let cursor = -1;
  const facts = { required: required.length, found: 0 };
  for (const src of required) {
    const re = new RegExp(src, 'i');
    const at = seq.findIndex((h) => re.test(h));
    if (at < 0) {
      items.push({
        verdict: baseline.headingsNeverFail ? 'warn' : 'fail',
        detail: `no heading matches /${src}/`,
      });
    } else {
      facts.found += 1;
      if (at < cursor) {
        items.push({ verdict: 'warn', detail: `heading /${src}/ appears out of order (position ${at})` });
      }
      cursor = at;
    }
  }
  report.addMany('headings', items, facts);
}

function checkText(report, words, baseline, cfgRatio) {
  const min = baseline.words?.min;
  const reference = baseline.words?.reference;
  const band = { ...cfgRatio, ...baseline.wordRatio };
  const facts = { words, min: min ?? null, reference: reference ?? null };

  if (min == null && reference == null) {
    report.skip('text', 'no words.min or words.reference in the group baseline');
    return;
  }
  if (min != null && words < min) {
    report.add('text', 'fail', `${words} words, below the group floor of ${min} — the page is empty or truncated`, facts);
    return;
  }
  if (reference == null) {
    report.add('text', 'pass', '', facts);
    return;
  }
  /*
   * The ratio band WARNS and never fails in baseline mode.
   *
   * A group's pages legitimately differ in length by an order of magnitude — an
   * announcement of a future meetup is three paragraphs, its recap is two thousand
   * words — so a hard ratio band against one blessed page would fail most of a
   * healthy group. `words.min` is the check that catches a truncated page, because a
   * page with twelve words on it is broken whatever the reference says. The band's
   * job is only to say "this is unusual for the group; look".
   */
  const ratio = reference ? words / reference : 1;
  facts.ratio = Number(ratio.toFixed(3));
  if (ratio < band.warnMin || ratio > band.warnMax) {
    report.add('text', 'warn', `${words} words is ${facts.ratio}x the group reference of ${reference}`, facts);
  } else {
    report.add('text', 'pass', '', facts);
  }
}

function checkImages(report, images, baseline) {
  const facts = { count: images.length };
  if (!images.length) {
    report.add('image-alt', 'pass', '', facts);
    return;
  }
  const bad = images.filter((i) => i.alt == null || i.alt === '');
  const verdict = baseline.requireAlt ? 'fail' : 'warn';
  report.addMany('image-alt', bad.map((i) => ({
    verdict,
    /*
     * A missing attribute and an empty one are DIFFERENT findings. `alt=""` is a
     * deliberate "this image is decorative" and is valid; no attribute at all is an
     * authoring miss. EDS emits `alt=""` for an image a document gave no alt text,
     * so on this site the empty form is the common one and it is still worth saying.
     */
    detail: i.alt == null
      ? `image has no alt attribute: ${i.url}`
      : `image has an empty alt (decorative?): ${i.url}`,
  })), facts);
}

async function checkAssets(report, { images, links, icons }, opts) {
  const {
    origin, baseline, qa, skipLinks,
  } = opts;

  const imgReach = await checkReachable(images.map((i) => i.url), {
    limit: qa.imageCheckLimit, userAgent: qa.userAgent,
  });
  report.addMany('images', imgReach.unreachable.map((u) => ({
    verdict: 'fail', detail: `unreachable image (HTTP ${u.status}): ${u.url}`,
  })), { checked: imgReach.checked, skipped: imgReach.skipped });

  /*
   * INTERNAL links only. An external link that 404s is somebody else's site changing
   * under us — worth knowing, not a defect in this page, and checking a few hundred
   * of them per batch is how a QA run starts looking like a crawler to a third party.
   */
  const internal = links.filter((l) => l.startsWith(origin));
  const external = links.length - internal.length;
  if (skipLinks) {
    report.skip('links', `--no-links (${internal.length} internal, ${external} external)`);
  } else {
    const reach = await checkReachable(internal, {
      limit: baseline.linkCheckLimit ?? qa.imageCheckLimit, userAgent: qa.userAgent,
    });
    report.addMany('links', reach.unreachable.map((u) => ({
      verdict: 'fail', detail: `broken internal link (HTTP ${u.status}): ${u.url}`,
    })), { internal: internal.length, external, checked: reach.checked });
  }

  if (!icons.length) {
    report.add('icons', 'pass', '', { count: 0 });
    return;
  }
  const shapes = await Promise.all(icons.map(
    (n) => fetchIconShape(origin, n, { userAgent: qa.userAgent, timeoutMs: qa.fetchTimeoutMs }),
  ));
  report.addMany('icons', shapes.filter((s) => s.status !== 200 || s.unparseable).map((s) => ({
    verdict: 'fail',
    // An icon that 404s renders an EMPTY SLOT: silent on screen, and the exact
    // failure a page hits when its glyph was uploaded to DA but never previewed.
    detail: s.status === 200
      ? `icon /icons/${s.name}.svg is not parseable as SVG`
      : `icon /icons/${s.name}.svg unreachable (HTTP ${s.status})`,
  })), { count: icons.length, names: icons });
}

function checkSections(report, styles, baseline) {
  const known = knownSectionStyles();
  const allowed = new Set(baseline.knownSectionStyles || []);
  const unrecognised = styles.filter((n) => !known.has(n) && !allowed.has(n));
  report.addMany('sections-recognised', unrecognised.map((n) => ({
    verdict: 'fail',
    detail: `section style '${n}' has no .section.${n} CSS rule — the section renders unstyled`,
  })), { declared: styles });
}

function checkBlocks(report, declared, renderedHtml, baseline) {
  const known = knownBlockNames();
  const allowed = new Set([...(baseline.knownBlocks || [])]);
  const unrecognised = declared.filter((b) => !known.has(b) && !allowed.has(b));
  report.addMany('blocks-recognised', unrecognised.map((b) => ({
    verdict: 'fail',
    detail: `block '${b}' has no blocks/${b}/ implementation and no .${b} CSS rule `
      + '— it renders as an undecorated div',
  })), { declared });

  /*
   * A block declared in the authored body must reach the served DOM. The two ways it
   * does not are a section that failed to render at all and a name EDS decided was
   * not a block; both are invisible in `.plain.html`, which is why this is the one
   * check that reads the rendered page's markup.
   */
  const lc = renderedHtml.toLowerCase();
  const absent = declared.filter((b) => !['section-metadata', 'metadata'].includes(b)
    && !lc.includes(`class="${b}`) && !lc.includes(`"${b} `));
  report.addMany('blocks-rendered', absent.map((b) => ({
    verdict: 'fail', detail: `block '${b}' is declared in .plain.html but absent from the rendered page`,
  })));
}

function checkMetadata(report, rendered, authored, baseline) {
  const required = baseline.requiredMetadata || [];
  if (!rendered.title && !authored.title) {
    report.add('metadata-title', 'fail', 'the page has no <title>');
  }
  if (!required.length) {
    report.skip('metadata', 'no requiredMetadata in the group baseline');
    return;
  }
  const items = required
    .filter((k) => !(k === 'title' ? rendered.title : rendered.meta[k]))
    .map((k) => ({ verdict: 'fail', detail: `required metadata "${k}" is missing or empty` }));
  report.addMany('metadata', items, { required, present: required.length - items.length });
}

function checkVerbatim(report, text, strings, where) {
  if (!strings.length) {
    report.skip('verbatim', 'the requirements brief declares no verbatim strings');
    return;
  }
  const missing = missingVerbatim(text, strings);
  report.addMany('verbatim', missing.map((s) => ({
    verdict: 'fail', detail: `the brief requires "${s}" verbatim; it is not on the ${where}`,
  })), { declared: strings.length });
}

/* ------------------------------------------------------------------- pair-mode diffs */

function pairHeadings(report, source, target, baseline) {
  const diff = diffHeadings(source.headings, target.headings);
  const allow = (baseline.allowMissingHeadings || []).map((re) => new RegExp(re, 'i'));
  const targetLc = normText(target.text).toLowerCase();
  const items = [];
  for (const h of diff.missing) {
    const text = h.replace(/^h\d: /, '');
    if (allow.some((re) => re.test(text))) {
      // an approved transform for this group — expected drift, not a defect
    } else if (targetLc.includes(normHeading(text))) {
      // the text survived but not as a heading: an authoring choice, not lost content
      items.push({ verdict: 'warn', detail: `demoted ${h} (text present, not a heading)` });
    } else if (baseline.headingsNeverFail) {
      items.push({ verdict: 'warn', detail: `missing ${h} (heading→block drift, review)` });
    } else {
      items.push({
        verdict: h.startsWith('h1') || h.startsWith('h2') ? 'fail' : 'warn',
        detail: `missing ${h}`,
      });
    }
  }
  if (diff.extra.length) {
    items.push({
      verdict: 'warn',
      detail: `${diff.extra.length} heading(s) not in the reference: ${diff.extra.slice(0, 3).join(' | ')}`,
    });
  }
  report.addMany('headings', items, {
    sourceCount: source.headings.length, targetCount: target.headings.length, ...diff,
  });
}

function pairText(report, source, target, band) {
  const ratio = source.words ? target.words / source.words : 1;
  const facts = {
    sourceWords: source.words,
    targetWords: target.words,
    ratio: Number(ratio.toFixed(3)),
  };
  if (ratio < band.failMin) {
    report.add('text', 'fail', `word ratio ${facts.ratio} < ${band.failMin} — content was dropped`, facts);
  } else if (ratio < band.warnMin || ratio > band.warnMax) {
    report.add('text', 'warn', `word ratio ${facts.ratio} outside [${band.warnMin}, ${band.warnMax}]`, facts);
  } else {
    report.add('text', 'pass', '', facts);
  }
}

function pairSets(report, check, sourceList, targetList, noun) {
  const src = new Set(sourceList);
  const tgt = new Set(targetList);
  const items = [
    ...[...src].filter((b) => !tgt.has(b)).map((b) => ({
      verdict: 'fail', detail: `${noun} '${b}' is on the reference page but not on this one`,
    })),
    ...[...tgt].filter((b) => !src.has(b)).map((b) => ({
      verdict: 'warn', detail: `${noun} '${b}' is on this page but not on the reference`,
    })),
  ];
  report.addMany(check, items, { source: [...src], target: [...tgt] });
}

/**
 * Links that should have been localised and were not.
 *
 * A translated page linking into `/en/` is not a broken link — it resolves, which is
 * why nothing else here notices — it is an untranslated link, and it drops a reader
 * out of their language mid-journey. `unlocalized-links` is a real status in
 * scripts/tracker/stages.js precisely because this happens on every translation run.
 */
function pairLinks(report, source, target, code, origin) {
  /*
   * `isTargetLocale`, not merely "has a locale". An EN page under test returns the code
   * `en`, which is truthy — so a bare truth test let this check RUN on an
   * English-to-English pair, where "the link points into the English tree" is not a
   * finding, it is the correct state. It reported `pass` rather than `skip` there,
   * which is the difference between "we looked and it was fine" and "we did not look".
   */
  if (!isTargetLocale(code)) {
    report.skip('links-localised', `the page under test is not in a target locale (${code || 'none'})`);
    return;
  }
  const internal = target.links.filter((l) => l.startsWith(origin));
  const stillEnglish = internal.filter((l) => {
    const p = normalizePath(new URL(l).pathname);
    return localeForPath(p) === 'en' && pathForLocale(p, code);
  });
  report.addMany('links-localised', stillEnglish.slice(0, 20).map((l) => ({
    verdict: 'warn', detail: `link still points into the English tree: ${l}`,
  })), {
    internal: internal.length,
    stillEnglish: stillEnglish.length,
    sourceInternal: source.links.length,
  });
}

/* ------------------------------------------------------------------ the entry point */

/**
 * Run the battery. Pure of argv and of the filesystem except for the baseline and the
 * repo's block list, so a caller (qa-driver, tx-qa) drives it with its own config.
 */
export async function structuralQa({
  targetUrl, sourceUrl = null, cfg, baseline = {}, brief = null, skipLinks = false,
}) {
  const { qa } = cfg;
  const fetchOpts = { userAgent: qa.userAgent, timeoutMs: qa.fetchTimeoutMs };
  const report = new Report();

  const target = await fetchPage(targetUrl, fetchOpts);
  if (target.rendered.status !== 200 || target.authored.status !== 200) {
    return {
      verdict: 'unreachable',
      checks: [{
        check: 'serving',
        verdict: 'fail',
        detail: `page HTTP ${target.rendered.status}, .plain.html HTTP ${target.authored.status}`,
      }],
      errors: [{ check: 'serving', detail: `${targetUrl} does not answer (page ${target.rendered.status}, plain ${target.authored.status})` }],
      warnings: [],
      urls: { target: targetUrl, plain: target.plainUrl },
      evidence: {},
    };
  }

  const { origin } = new URL(targetUrl);
  const authored = extractContent(target.authored.html, targetUrl, 'body');
  const rendered = extractContent(target.rendered.html, targetUrl, 'main');
  const blocks = extractBlocks(target.authored.html);
  const sectionStyles = extractSectionStyles(target.authored.html);
  const icons = [...new Set(extractIconRefs(target.authored.html))];
  const verbatim = brief ? verbatimRequirements(brief) : [];

  let source = null;
  if (sourceUrl) {
    const ref = await fetchPage(sourceUrl, fetchOpts);
    if (ref.authored.status !== 200) {
      return {
        verdict: 'unreachable',
        checks: [{ check: 'serving', verdict: 'fail', detail: `reference .plain.html HTTP ${ref.authored.status}` }],
        errors: [{ check: 'serving', detail: `the reference page ${sourceUrl} does not answer (${ref.authored.status})` }],
        warnings: [],
        urls: { source: sourceUrl, target: targetUrl, plain: target.plainUrl },
        evidence: {},
      };
    }
    source = {
      ...extractContent(ref.authored.html, sourceUrl, 'body'),
      blocks: extractBlocks(ref.authored.html),
      icons: [...new Set(extractIconRefs(ref.authored.html))],
    };
  }

  if (source) {
    pairHeadings(report, source, authored, baseline);
    pairText(report, source, authored, { ...qa.wordRatio, ...baseline.wordRatio });
    pairSets(report, 'blocks', source.blocks, blocks, 'block');
    pairSets(report, 'icons-shared', source.icons, icons, 'icon');
    const code = localeForPath(normalizePath(new URL(targetUrl).pathname));
    pairLinks(report, source, authored, code, origin);
  } else {
    checkHeadings(report, authored.headings, baseline);
    checkText(report, authored.words, baseline, qa.wordRatio);
  }

  checkImages(report, authored.images, baseline);
  await checkAssets(report, { images: authored.images, links: authored.links, icons }, {
    origin, baseline, qa, skipLinks,
  });
  checkBlocks(report, blocks, target.rendered.html, baseline);
  checkSections(report, sectionStyles, baseline);
  checkMetadata(report, rendered, authored, baseline);
  checkVerbatim(report, authored.text, verbatim, source ? 'translated page' : 'page');

  const cap = (t) => t.split(' ').slice(0, qa.maxTextWords).join(' ');
  return {
    verdict: report.verdict,
    checks: report.checks,
    errors: report.errors,
    warnings: report.warnings,
    urls: {
      ...(sourceUrl ? { source: sourceUrl } : {}),
      target: targetUrl,
      plain: target.plainUrl,
    },
    // The text the JUDGE reads. Capped here rather than in the judge so the report
    // that gets committed is the evidence the verdict was actually reached on.
    evidence: {
      textSample: {
        ...(source ? { source: cap(source.text) } : {}),
        target: cap(authored.text),
      },
      blocks,
      sectionStyles,
      icons,
      words: authored.words,
      headings: authored.headings.map((h) => `h${h.level}: ${h.text}`),
      title: rendered.title || authored.title,
      description: rendered.description,
    },
  };
}

/* -------------------------------------------------------------------- calibration */

/**
 * Derive a baseline from the page just measured.
 *
 * What it can and cannot infer, stated in the file it writes: the reference word
 * count, the heading sequence and the block list are OBSERVED on a page a human
 * blessed. `words.min` is not observable from one page — a floor is a statement about
 * the whole group — so it is seeded low and the `$tune` note says so. A calibrator
 * that silently invents a floor is how a group ends up failing every short page.
 */
export function deriveBaseline(group, path, structural) {
  const {
    words = 0, headings = [], blocks = [], sectionStyles = [],
  } = structural.evidence;
  /*
   * Anchored, escaped regexes — `requiredHeadings` is a regex list, and seeding it
   * with raw heading text would turn every `(`, `?` or `.` a human typed into a
   * quantifier. The level prefix is dropped: a heading that moves from h2 to h3 in a
   * later revision is a template change, not a missing requirement.
   */
  const required = headings.map(
    (h) => `^${h.replace(/^h\d: /, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
  );
  return {
    $note: `Calibrated from ${path}. Tier-1 thresholds for the "${group}" group. `
      + 'Every key is optional; a missing key makes its check report `skip`, not `pass`.',
    $tune: 'words.min is a GROUP floor and cannot be inferred from one page — raise it '
      + 'once you know the shortest legitimate page in the group. requiredHeadings is '
      + 'seeded from the blessed page and is almost always too strict: delete the ones '
      + 'that are page-specific and keep the ones the template guarantees.',
    group,
    calibratedFrom: path,
    calibratedAt: new Date().toISOString(),
    words: { reference: words, min: 40 },
    requiredHeadings: required,
    allowMissingHeadings: [],
    headingsNeverFail: false,
    requiredMetadata: ['title', 'description'],
    knownBlocks: blocks,
    knownSectionStyles: sectionStyles,
    requireAlt: false,
    maxH1: 1,
  };
}

/* -------------------------------------------------------------------------- main */

function parseArgs(args) {
  const o = {
    path: null,
    url: null,
    source: null,
    migrated: null,
    group: null,
    branch: null,
    out: null,
    calibrate: false,
    apply: false,
    quiet: false,
    skipLinks: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--calibrate') o.calibrate = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--no-links') o.skipLinks = true;
    else if (a.startsWith('--path=')) o.path = a.slice(7);
    else if (a.startsWith('--url=')) o.url = a.slice(6);
    else if (a.startsWith('--source=')) o.source = a.slice(9);
    else if (a.startsWith('--migrated=')) o.migrated = a.slice(11);
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  const pairMode = Boolean(o.source || o.migrated);
  if (pairMode && (o.path || o.url)) {
    throw new Error('--source/--migrated is pair mode; --path/--url is baseline mode. Pick one.');
  }
  if (pairMode && !(o.source && o.migrated)) {
    throw new Error('pair mode needs BOTH --source= and --migrated=');
  }
  if (!pairMode && !o.path && !o.url) throw new Error('--path=<page-path> is required (or --source=/--migrated= for pair mode)');
  if (o.calibrate && pairMode) throw new Error('--calibrate derives a baseline from ONE page; it has no meaning in pair mode');
  return o;
}

/** One line per check, worst first, so the summary reads as a verdict and not a dump. */
function printChecks(checks) {
  const mark = {
    pass: '  ok  ', warn: ' warn ', fail: ' FAIL ', skip: ' skip ',
  };
  const order = { fail: 0, warn: 1, skip: 2, pass: 3 };
  for (const c of [...checks].sort((a, b) => order[a.verdict] - order[b.verdict])) {
    console.log(`  ${mark[c.verdict]} ${c.check}${c.detail ? ` — ${c.detail}` : ''}`);
    for (const f of c.findings || []) console.log(`         · ${f.verdict.toUpperCase()} ${f.detail}`);
  }
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const cfg = loadConfig();
  const branch = opts.branch
    || (opts.url && branchFromUrl(opts.url))
    || (opts.migrated && branchFromUrl(opts.migrated))
    || cfg.publish?.branch
    || DEFAULT_BRANCH;

  const targetUrl = opts.migrated
    || opts.url
    || previewUrl(opts.path, branch);
  const targetPath = normalizePath(new URL(targetUrl).pathname);
  // The group of the ENGLISH page, always: a locale row's group is its source's group,
  // and `groupForPath` refuses a locale path on purpose (it keys the master tab).
  const enPath = pathForLocale(targetPath, 'en') || targetPath;
  const group = opts.group || groupForPath(enPath);
  if (!group) {
    console.error(`ERROR: ${enPath} is in no tracked group — pass --group=<name> to judge it against one anyway`);
    return 3;
  }

  const baseline = loadBaseline(group);
  const req = await loadRequirements(group, { branch });
  /*
   * The brief this tier reads is the one written for the QUESTION being asked, exactly
   * as in judge.mjs: pair mode is the translation tier's question and gets
   * `QA Requirements`; baseline mode judges an English page on its own and gets
   * `EN QA Requirements`, or none. Never `req.text` — the whole document holds sections
   * for three audiences, and `verbatimRequirements` reading the translation rows is how
   * an ILLUSTRATION in a note ("the word \"Berlin\" stays \"Berlin\"") became a
   * group-wide requirement that failed 12 of 14 live pages.
   */
  const pairMode = Boolean(opts.source);
  const brief = pairMode ? req.judgeBrief : req.enJudgeBrief;
  const readiness = pairMode ? req.readiness : req.enReadiness;
  const briefSection = pairMode ? JUDGE_SECTION : EN_JUDGE_SECTION;

  const structural = await structuralQa({
    targetUrl,
    sourceUrl: opts.source,
    cfg,
    baseline,
    brief,
    skipLinks: opts.skipLinks,
  });

  /*
   * The report envelope is data-contract.md §4: one file per page, tier verdicts
   * written independently, a tier that did not run is `null` and never `"pass"`.
   * `qa:judge` rewrites `tiers.judge` and `verdict` in this same file.
   */
  const report = {
    'page-path': enPath,
    group,
    template: pagetypeOf(enPath),
    mode: opts.source ? 'pair' : 'baseline',
    urls: structural.urls,
    branch,
    generated: new Date().toISOString(),
    requirements: {
      exists: req.exists,
      source: req.source,
      path: req.path,
      section: briefSection,
      state: readiness.state,
      unresolved: readiness.unresolved.map((r) => r.ref),
      verbatim: brief ? verbatimRequirements(brief).length : 0,
      judgeBrief: Boolean(brief),
    },
    baseline: {
      exists: Object.keys(baseline).length > 0,
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

  if (opts.calibrate) {
    if (structural.verdict === 'unreachable') {
      console.error(`ERROR: cannot calibrate from a page that does not answer — ${targetUrl}`);
      return 2;
    }
    const next = deriveBaseline(group, enPath, structural);
    const file = baselinePath(group);
    console.log(`── calibrate · ${group} · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} ──`);
    console.log(`   from:  ${enPath}`);
    console.log(`   file:  ${file}${existsSync(file) ? '  (EXISTS — would be overwritten)' : ''}`);
    console.log('');
    console.log(JSON.stringify(next, null, 2));
    if (!opts.apply) {
      console.log('\n   Re-run with --apply to write it. Read the $tune note first.');
      return 0;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`\n   ✓ wrote ${file}`);
    return 0;
  }

  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (!opts.quiet) {
    console.log(`── structural · ${enPath} · ${report.mode} mode ──`);
    console.log(`   page:      ${targetUrl}`);
    if (opts.source) console.log(`   reference: ${opts.source}`);
    console.log(`   group:     ${group}   baseline: ${report.baseline.exists ? report.baseline.path : 'NONE (baselined checks skipped)'}`);
    console.log(`   brief:     ${req.exists ? `${req.source} ${req.path}` : 'NONE'}`);
    console.log(`              "${briefSection}": ${readiness.state}`
      + `${readiness.unresolved.length ? ` — ${readiness.unresolved.length} UNRESOLVED "?" row(s)` : ''}`);
    console.log('');
    printChecks(structural.checks);
    console.log('');
  }
  console.error(`STRUCTURAL: ${structural.verdict.toUpperCase()}`
    + `  (${structural.errors.length} error(s), ${structural.warnings.length} warning(s))`);
  return { pass: 0, fail: 1, review: 2, unreachable: 2 }[structural.verdict] ?? 3;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`ERROR: ${e.message}`);
      exit(3);
    });
}
