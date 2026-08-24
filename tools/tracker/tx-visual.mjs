#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * tx-visual.mjs — tier 3. Is the TRANSLATED page WORSE than the English one?
 *
 * CLI SURFACE
 *   node tools/tracker/tx-visual.mjs --locale=<code> (--path=<path>
 *        | --en=<url> --translated=<url>)
 *        [--branch=<ref>] [--widths=2360,1280,390] [--template=<name>]
 *        [--vision] [--out=<dir>] [--report=<path>] [--no-report]
 *        [--dry-run] [--json] [--quiet] [--help]
 *
 *   npm run tx:visual -- --locale=de --path=/en/meetups/aem-meetup-munich
 *   npm run tx:visual -- --locale=ja --path=/en/articles/x --vision
 *   npm run tx:visual -- --locale=de --path=/en/ --dry-run
 *
 * ─── THE QUESTION IS "WORSE", NOT "DIFFERENT" ───────────────────────────────
 *
 * This is the load-bearing idea of the whole tier and it is worth stating before any
 * code. `visual-compare` answers "do these two pages look alike", by putting two
 * screenshots side by side. Pointed at a translated pair that question is unanswerable
 * and the method is actively misleading: EVERY PIXEL CONTAINING TEXT IS DIFFERENT BY
 * DESIGN. A German page that renders perfectly differs from its English original in
 * essentially every glyph, so a pixel or vision diff reports a page full of
 * differences and the one that matters is invisible among them.
 *
 * So the question is reframed. What must be invariant across a translation is not
 * appearance, it is GEOMETRY:
 *
 *   - the same components, in the same order, at the same positions
 *   - each one's text FITTING INSIDE IT
 *   - nothing overflowing its container or the viewport
 *   - siblings that lined up still lining up
 *
 * All four are measurable in the DOM, on both pages, with no image comparison at all —
 * and unlike a pixel diff they are immune to the text differing. Every check below is
 * phrased as "worse than English", never as an absolute: a hero whose heading already
 * wraps to three lines in English is not a translation defect, and the same hero going
 * from three to five is. Anchoring on the English page as its own control is what stops
 * tier 3 re-reporting the site's existing layout debt on all ten locales.
 *
 * ─── Expansion is EXPECTED; clipping is the defect ──────────────────────────
 *
 * `expansion` in scripts/tracker/locales.js is the per-locale text-length multiplier
 * (de 1.3, fr/es/pt 1.25, ja 0.6, zh-* 0.5). It is not decoration here:
 *
 *   - German text 30% longer is EXPECTED GROWTH. The finding is when that growth
 *     CLIPS or OVERFLOWS something, so the height-growth threshold scales with the
 *     locale's expansion and a German card that got taller in proportion is silent.
 *   - A button gaining a line in an EXPANDING locale is a note; in a CONTRACTING one
 *     it is a warning, because shorter text needing more lines usually means an
 *     untranslated identifier or a broken word-break rather than reflow.
 *   - CJK at ~0.5x can leave a fixed container looking EMPTY. That is a NOTE, not a
 *     failure: it is a design conversation, not damage.
 *
 * ─── A page that is not there is exit 2, never exit 1 ───────────────────────
 *
 * The source recorded an HTTP failure as an `error` finding, which made a missing
 * translated page indistinguishable from a broken layout. Today every locale tree on
 * this site is EMPTY, so the common case is a page nobody has translated yet — and
 * "we could not look" must never be stored as "we looked and it is broken". A fetch
 * failure on either side returns `escalate` and exits 2.
 *
 * ─── What it writes ─────────────────────────────────────────────────────────
 *
 * `tiers.visual` of `.tracker/reports/tx/<code>--<slug>.json` (data-contract.md §4),
 * merged into whatever tiers 1 and 2 already wrote and leaving the top-level `verdict`
 * ALONE — merging the tiers is the driver's job, and a tier that overwrites the merged
 * verdict makes that merge unobservable. It never writes a sheet, a ledger or a status:
 * promotion to `visual-qa-ok` belongs to the driver.
 *
 * EXIT CODES  0 pass · 1 fail (layout damage) · 2 no verdict (page missing, browser
 *             unavailable, or warnings only — the page HOLDS its status) ·
 *             3 usage/config error
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  basePath, locale as localeFor, normalizePath, pathForLocale,
} from '../../scripts/tracker/locales.js';
import { previewUrl, slugOf } from '../../scripts/tracker/paths.js';
import { loadConfig } from './config.mjs';
import { groupForPath, pagetypeOf } from './lib/group-map.mjs';
import { LlmUnavailable, callVision } from './lib/llm.mjs';
import {
  BrowserUnavailable, DEFAULT_WIDTHS, launchBrowser, loadAndSettle, sideBySide, viewportFor,
} from './lib/shots.mjs';
import { VERDICT_SCHEMA, buildPrompt } from './visual-judge.mjs';

/*
 * Tolerances. Every one absorbs sub-pixel and font-metric noise rather than hiding
 * defects: two pages rendered with different text differ by a fraction of a pixel in a
 * dozen places, and a zero-tolerance comparison reports all of them.
 */
const TOL = {
  // px of horizontal content overflow before it counts. 1px is rounding.
  overflowX: 2,
  // px an element may exceed its parent's box by.
  escape: 2,
  // Floor for the height-growth check, used when the locale's own expansion is lower.
  // Prose reflows and gets legitimately taller, so this is generous by design.
  heightRatio: 1.5,
  // Slack ON TOP of the locale's expansion factor. A German block at exactly 1.3x is
  // the expected outcome, not a finding; 1.3 x 1.25 = 1.625x is where it stops being
  // proportional growth.
  growthSlack: 1.25,
  // px of sibling height difference that counts as misalignment.
  alignment: 8,
  // A contracting locale (CJK) whose block came in below this fraction of its expected
  // shrunk height is worth a NOTE — the container may now look empty.
  emptyFraction: 0.7,
};

/**
 * The height-growth ratio a locale is allowed before `grew` fires.
 *
 * One definition, read by the check, by the report and by the banner the operator sees,
 * because a tool that prints one tolerance and applies another is worse than one that
 * prints none.
 */
export const growthToleranceFor = (loc) => Math.max(
  TOL.heightRatio,
  loc.expansion * TOL.growthSlack,
);

/**
 * Measure every component on a page, in the page's own context.
 *
 * Keyed by a STABLE selector-ish path rather than by text, for the same reason the
 * structural tier addresses positionally: text is the thing that changed. The key is
 * `s<section>/block<n>:<firstClass>`, which survives translation and lines the two
 * pages up unambiguously.
 *
 * `lines` comes from `getClientRects().length` over a Range spanning the element's
 * contents — the only reliable way to count rendered line boxes, and the signal that
 * catches a button going from one line to two. `clipped` needs BOTH an overflow style
 * that hides AND content bigger than the box; either alone is normal.
 */
/* eslint-disable no-undef */
function measureInPage() {
  const out = [];
  const root = document.querySelector('main') || document.body;
  const sections = [...root.children].filter((e) => e.tagName === 'DIV');

  const lineCount = (el) => {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getClientRects().length;
    } catch {
      return null;
    }
  };

  const record = (el, key) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const parent = el.parentElement;
    const pr = parent ? parent.getBoundingClientRect() : null;
    const hides = /hidden|clip/.test(cs.overflow + cs.overflowX + cs.overflowY);
    out.push({
      key,
      tag: el.tagName.toLowerCase(),
      cls: el.className || '',
      text: (el.textContent || '').trim().slice(0, 80),
      chars: (el.textContent || '').trim().length,
      w: Math.round(r.width),
      h: Math.round(r.height),
      x: Math.round(r.left),
      y: Math.round(r.top + window.scrollY),
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
      hides,
      lines: lineCount(el),
      // How far the element escapes its parent's box on each side. Signed, so a
      // negative value (safely inside) is distinguishable from zero (flush).
      escapeRight: pr ? Math.round(r.right - pr.right) : null,
      escapeLeft: pr ? Math.round(pr.left - r.left) : null,
      fixedH: cs.height !== 'auto' && !cs.height.endsWith('%'),
    });
  };

  sections.forEach((sec, si) => {
    // Blocks (and the wrappers EDS decorates them into), plus the short-string elements
    // where expansion actually breaks things.
    const blocks = [...sec.querySelectorAll(':scope > div[class], :scope > div > div[class]')];
    blocks.forEach((b, bi) => record(b, `s${si}/block${bi}:${b.className.split(/\s+/)[0]}`));
    const bits = [...sec.querySelectorAll('h1, h2, h3, a.button, .button, button, li, p > strong')];
    bits.forEach((b, i) => record(b, `s${si}/${b.tagName.toLowerCase()}${i}`));
  });

  return {
    components: out,
    page: {
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      scrollH: document.documentElement.scrollHeight,
    },
  };
}
/* eslint-enable no-undef */

/** Load a page at one width and measure it. Keeps the context open for screenshots. */
async function measurePage(browser, url, width) {
  const context = await browser.newContext({ ...viewportFor(width), locale: 'en-US' });
  const page = await context.newPage();
  const load = await loadAndSettle(page, url, { wait: 1200 });
  if (!load.ok) {
    await context.close();
    return { error: load.error, status: load.status };
  }
  const data = await page.evaluate(measureInPage);
  return { context, page, data };
}

/**
 * Compare one width's measurements. Every check is "worse than English".
 *
 * Only components present on BOTH pages are compared. A key missing from one side means
 * the two DOMs decorated differently, which the structural tier owns and describes far
 * better than a geometry comparison could.
 */
export function compareGeometry(enData, locData, width, loc) {
  const out = [];
  const { name, expansion } = loc;
  const enBy = new Map(enData.components.map((c) => [c.key, c]));
  const growTol = growthToleranceFor(loc);
  const expanding = expansion >= 1;

  // Page-level horizontal overflow — the loudest and most common expansion break.
  const enOver = enData.page.scrollW - enData.page.clientW;
  const locOver = locData.page.scrollW - locData.page.clientW;
  if (locOver > TOL.overflowX && locOver > enOver + TOL.overflowX) {
    out.push({
      severity: 'error',
      check: 'page-overflow',
      width,
      detail: `at ${width}px the ${name} page scrolls ${locOver}px horizontally (English: `
        + `${enOver > 0 ? `${enOver}px` : 'none'}) — translated text pushed something past the `
        + 'viewport, which on mobile means the whole page can be dragged sideways.',
    });
  }

  for (const l of locData.components.filter((c) => enBy.has(c.key))) {
    const en = enBy.get(l.key);
    const where = `${l.cls || l.tag} (${l.key})`;

    // 1. CLIPPED — the box hides overflow and the content no longer fits. The text is
    //    invisible and the page looks intact, so nothing but this catches it. This is
    //    the finding expansion actually produces, which is why it is an error even
    //    though growth itself is expected.
    const clippedNow = l.hides && (l.scrollH > l.clientH + 2 || l.scrollW > l.clientW + 2);
    const clippedBefore = en.hides && (en.scrollH > en.clientH + 2 || en.scrollW > en.clientW + 2);
    if (clippedNow && !clippedBefore) {
      out.push({
        severity: 'error',
        check: 'clipped',
        width,
        key: l.key,
        detail: `at ${width}px "${l.text.slice(0, 48)}" in ${where} is CLIPPED — the element hides `
          + `overflow and its content needs ${l.scrollW}x${l.scrollH}px inside a `
          + `${l.clientW}x${l.clientH}px box (English fits). ${name} text is being cut off `
          + 'invisibly — the page still looks intact.',
      });
    }

    // 2. ESCAPED — the element's box now extends past its parent's.
    if (l.escapeRight > TOL.escape && l.escapeRight > (en.escapeRight ?? 0) + TOL.escape) {
      out.push({
        severity: 'error',
        check: 'escaped',
        width,
        key: l.key,
        detail: `at ${width}px ${where} extends ${l.escapeRight}px past its container `
          + `(English: ${en.escapeRight}px) — "${l.text.slice(0, 40)}" is overlapping whatever `
          + 'sits beside it.',
      });
    }

    // 3. REWRAPPED — more line boxes than English, in something that should be one
    //    line. Restricted to buttons and headings: a paragraph gaining lines is reflow,
    //    which is correct behaviour and not worth a word.
    const isShort = /button/i.test(l.cls) || l.tag === 'button'
      || (l.tag === 'a' && /button/i.test(l.cls)) || /^h[1-3]$/.test(l.tag);
    if (isShort && l.lines && en.lines && l.lines > en.lines) {
      const overflowing = l.fixedH && l.scrollH > l.clientH + 2;
      /*
       * Severity depends on the direction of the locale. An expanding locale needing
       * an extra line is the expected consequence of longer text and is only a defect
       * when the box cannot take it. A CONTRACTING locale needing an extra line is
       * suspicious in itself: shorter text should need fewer lines, so the usual cause
       * is an untranslated identifier or a string with no break opportunity.
       */
      let severity = 'note';
      let because = ` — expected for ${name} (${expansion}x text), and it reflows cleanly, so this `
        + 'is informational unless the design needs one line.';
      if (overflowing) {
        severity = 'error';
        because = ' AND the element has a fixed height it now overflows — this is clipping or spilling.';
      } else if (!expanding) {
        severity = 'warning';
        because = ` — unexpected for ${name}, whose text is normally ${expansion}x English: shorter `
          + 'text needing MORE lines usually means an untranslated string or one with no break '
          + 'opportunity.';
      }
      out.push({
        severity,
        check: 'rewrapped',
        width,
        key: l.key,
        detail: `at ${width}px ${where} wraps to ${l.lines} line(s) where English uses ${en.lines} `
          + `("${l.text.slice(0, 40)}")${because}`,
      });
    }

    // 4. GREW BEYOND ITS EXPANSION — taller than the locale's own text growth explains,
    //    in a context where siblings are expected to match. Blocks only: cards and
    //    columns are where this matters and a paragraph is where it does not.
    if (/^s\d+\/block/.test(l.key) && en.h > 40 && l.h > en.h * growTol) {
      out.push({
        severity: 'warning',
        check: 'grew',
        width,
        key: l.key,
        detail: `at ${width}px ${where} is ${l.h}px tall where English is ${en.h}px `
          + `(${(l.h / en.h).toFixed(2)}x). ${name} text runs about ${expansion}x English, so growth `
          + `up to ${growTol.toFixed(2)}x is expected and is not reported — this is beyond it, and `
          + 'enough to break alignment with anything beside it.',
      });
    }

    // 5. LOOKS EMPTY — a contracting locale in a box that did not contract with it.
    //    Explicitly a NOTE: a half-full container is a design conversation, not damage,
    //    and reporting it as a defect on every CJK page would make the tier ignorable.
    if (!expanding && /^s\d+\/block/.test(l.key) && en.h > 80 && l.chars > 0
      && l.h < en.h * expansion * TOL.emptyFraction) {
      out.push({
        severity: 'note',
        check: 'sparse',
        width,
        key: l.key,
        detail: `at ${width}px ${where} is ${l.h}px tall against English ${en.h}px — shorter even than `
          + `the ${expansion}x ${name} text predicts. Nothing is broken; the container may simply `
          + 'look empty, which is worth a designer\'s eye and is not a defect.',
      });
    }
  }

  /*
   * 6. SIBLING MISALIGNMENT — siblings equal in height in English and not now.
   * Computed across the set rather than per element, because "these three cards no
   * longer line up" is one defect and reporting it three times is noise.
   */
  const rows = new Map();
  for (const c of locData.components.filter((x) => /^s\d+\/block/.test(x.key))) {
    // Bucketed by section AND top offset: components sharing a y are on one visual row,
    // which is the only grouping in which "these should line up" is meaningful.
    const bucket = `${c.key.split('/')[0]}@${c.y}`;
    if (!rows.has(bucket)) rows.set(bucket, []);
    rows.get(bucket).push(c);
  }
  const comparable = [...rows].filter(([, sibs]) => sibs.length >= 2
    && sibs.every((s) => enBy.has(s.key)));
  for (const [bucket, sibs] of comparable) {
    const spread = (xs) => Math.max(...xs) - Math.min(...xs);
    const enSpread = spread(sibs.map((s) => enBy.get(s.key).h));
    const locSpread = spread(sibs.map((s) => s.h));
    if (enSpread <= TOL.alignment && locSpread > TOL.alignment) {
      out.push({
        severity: 'warning',
        check: 'misaligned',
        width,
        keys: sibs.map((s) => s.key),
        detail: `at ${width}px ${sibs.length} side-by-side components in ${bucket.split('@')[0]} that are `
          + `equal height in English (within ${enSpread}px) now differ by ${locSpread}px — ${name} text `
          + 'of unequal length broke the row.',
      });
    }
  }

  return out;
}

/**
 * Re-find a flagged block by its key and screenshot it on both pages.
 *
 * Re-found by the SAME key the measurement used, so the picture and the finding are
 * guaranteed to be about the same box. A screenshot of "roughly that area" is worse
 * than no screenshot: it invites the reviewer to explain away the wrong element.
 */
async function capturePair(pages, key, outDir, label, labels) {
  const files = [];
  for (const [side, page] of Object.entries(pages)) {
    const file = join(outDir, `${label}-${side}.png`);
    const handle = await page.evaluateHandle((k) => {
      const root = document.querySelector('main') || document.body;
      const [sPart, rest] = k.split('/');
      const sec = [...root.children].filter((e) => e.tagName === 'DIV')[Number(sPart.slice(1))];
      if (!sec) return null;
      const bi = Number((/block(\d+)/.exec(rest) || [])[1]);
      if (Number.isNaN(bi)) return null;
      return [...sec.querySelectorAll(':scope > div[class], :scope > div > div[class]')][bi] || null;
    }, key);
    const el = handle.asElement();
    if (el) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(300);
      await el.screenshot({ path: file }).catch(() => {});
      if (existsSync(file)) files.push(file);
    }
  }
  if (files.length === 2) {
    const composite = join(outDir, `${label}-side.png`);
    await sideBySide(files[0], files[1], composite, {
      labelA: labels.a, labelB: labels.b, caption: key,
    });
    return { files, composite };
  }
  return { files, composite: null };
}

/**
 * The vision residue.
 *
 * Called only on blocks geometry already flagged, and asked for what geometry CANNOT
 * see: overlap, occlusion, a heading colliding with an image, text over a background
 * that no longer contrasts. Deliberately not asked "what is different" — on a
 * translated pair the answer to that is "all the words", which is both true and
 * useless, and is what made the first attempt at this worthless. The prompt and the
 * schema are imported from visual-judge.mjs rather than restated, so the two tools
 * cannot come to mean two different things by "damaged".
 */
async function visionResidue(tier, composite, loc, findings) {
  const prompt = `${buildPrompt({
    labelA: 'English',
    labelB: loc.name,
    section: 'one component, English left and translated right',
    brief: null,
    tile: null,
    translated: true,
  })}\n\nGeometry measurement already flagged: ${
    findings.map((f) => f.check).join(', ') || 'nothing'
  }. Confirm or refute each, and add anything visible that measurement would miss.`;
  return callVision(tier, composite, prompt, { schema: VERDICT_SCHEMA });
}

/**
 * Run tier 3 for one (page, locale).
 *
 * Exported so `tx-driver` can call it in process and merge the verdict itself rather
 * than shelling out and parsing stdout.
 */
export async function txVisual(enUrl, locUrl, code, cfg, opts = {}) {
  const loc = localeFor(code);
  if (!loc) return { fatal: `unknown locale: ${code}`, verdict: 'escalate' };
  const widths = opts.widths || cfg.visual?.widths || DEFAULT_WIDTHS;
  const outDir = opts.out || join(cfg.state.localReportsDir, 'visual', code);
  mkdirSync(outDir, { recursive: true });

  let browser;
  try {
    browser = await launchBrowser();
  } catch (e) {
    return {
      verdict: 'escalate', fatal: e.message, unreachable: true, widths,
    };
  }

  const findings = [];
  const measured = {};
  const unreachable = [];
  let held = null;

  try {
    for (const width of widths) {
      const [en, tx] = await Promise.all([
        measurePage(browser, enUrl, width),
        measurePage(browser, locUrl, width),
      ]);
      if (en.error || tx.error) {
        /*
         * NOT a finding. A page that would not load is "we could not look", and the
         * source's habit of recording it as an `error` finding made a page nobody has
         * translated yet indistinguishable from a broken layout.
         */
        unreachable.push({ width, en: en.error || null, translated: tx.error || null });
        if (en.context) await en.context.close();
        if (tx.context) await tx.context.close();
      } else {
        findings.push(...compareGeometry(en.data, tx.data, width, loc));
        measured[width] = {
          components: tx.data.components.length,
          enComponents: en.data.components.length,
          page: tx.data.page,
          enPage: en.data.page,
        };
        // Hold the widest run's pages open for screenshots rather than reloading. Widths
        // are widest-first, and a component crop is most legible at the widest layout.
        if (!held) held = { en, tx };
        else {
          await en.context.close();
          await tx.context.close();
        }
      }
    }

    // Screenshot only what geometry flagged, and only blocks (a heading's box on its own
    // is not a useful picture). Capped: a page with twenty findings does not need twenty
    // screenshot pairs to make its point.
    const shots = [];
    const targets = [...new Set(findings.filter((f) => f.key && /block/.test(f.key)).map((f) => f.key))]
      .slice(0, 4);
    if (held) {
      for (const [i, key] of targets.entries()) {
        const pair = await capturePair(
          { en: held.en.page, [code]: held.tx.page },
          key,
          outDir,
          `cmp${i}`,
          { a: 'English', b: loc.name },
        );
        if (pair.composite) shots.push({ key, ...pair });
      }
    }

    let vision = null;
    if (opts.vision && shots.length) {
      try {
        vision = await visionResidue(
          cfg.llm.vision,
          shots[0].composite,
          loc,
          findings.filter((f) => f.key === shots[0].key),
        );
      } catch (e) {
        // A down vision tier does not invalidate the geometry verdict; it is recorded
        // as unavailable so nobody reads its silence as agreement.
        vision = {
          unavailable: e instanceof LlmUnavailable ? 'service' : 'answer',
          error: e.message,
        };
      }
    }

    const errors = findings.filter((f) => f.severity === 'error');
    const warnings = findings.filter((f) => f.severity === 'warning');
    const notes = findings.filter((f) => f.severity === 'note');
    const visionDamage = vision && vision.damaged === true;

    let verdict = 'pass';
    let why = `${Object.keys(measured).length} width(s) measured, nothing worse than English`;
    if (unreachable.length === widths.length) {
      verdict = 'escalate';
      why = 'neither page could be measured at any width — nothing was compared';
    } else if (errors.length || visionDamage) {
      verdict = 'fail';
      why = `${errors.length} layout defect(s)${visionDamage ? ' (vision confirms damage)' : ''}`;
    } else if (unreachable.length || warnings.length) {
      verdict = 'escalate';
      why = unreachable.length
        ? `${unreachable.length} of ${widths.length} width(s) could not be measured`
        : `${warnings.length} finding(s) that need a human`;
    }

    return {
      en: enUrl,
      translated: locUrl,
      locale: loc.code,
      localeName: loc.name,
      expansion: loc.expansion,
      script: loc.script,
      fetchedAt: new Date().toISOString(),
      widths,
      verdict,
      why,
      errors,
      warnings,
      notes,
      unreachable,
      checks: {
        measured,
        screenshots: shots.map((s) => s.composite),
        vision,
        growthTolerance: growthToleranceFor(loc),
      },
    };
  } finally {
    if (held) {
      await held.en.context.close().catch(() => {});
      await held.tx.context.close().catch(() => {});
    }
    await browser.close();
  }
}

/**
 * Merge tier 3 into the page's report without touching the other tiers.
 *
 * `tiers.structural` and `tiers.judge` stay exactly as found, and a tier that has not
 * run stays `null` — data-contract.md §4: "we did not look" and "we looked and it was
 * fine" must not be the same value. The top-level `verdict` is left as found (null on a
 * report this tool created), because merging the tiers is the driver's job.
 */
export function mergeReport(file, page) {
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const widths = Object.fromEntries((page.widths || []).map((w) => {
    const bad = (page.errors || []).some((f) => f.width === w);
    const soft = (page.warnings || []).some((f) => f.width === w);
    const missed = (page.unreachable || []).some((u) => u.width === w);
    if (missed) return [String(w), 'escalate'];
    if (bad) return [String(w), 'fail'];
    return [String(w), soft ? 'escalate' : 'pass'];
  }));
  const base = {
    'page-path': page.enPath,
    locale: page.locale,
    group: page.group,
    template: page.template ?? null,
    urls: { source: page.en, target: page.translated },
    branch: page.branch,
  };
  return {
    ...base,
    // Anything already in the file wins, including keys this tool does not know about:
    // the driver establishes the page's identity and tier 3 is a guest in its report.
    ...existing,
    // …except `generated`, which is when the report was last WRITTEN. Carrying the old
    // timestamp forward over a freshly changed tier is how a stale report reads as
    // current.
    generated: new Date().toISOString(),
    tiers: {
      structural: existing?.tiers?.structural ?? null,
      judge: existing?.tiers?.judge ?? null,
      visual: {
        verdict: page.verdict,
        why: page.why,
        widths,
        findings: [...(page.errors || []), ...(page.warnings || []), ...(page.notes || [])],
        unreachable: page.unreachable || [],
        images: page.checks?.screenshots || [],
        expansion: page.expansion,
        growthTolerance: page.checks?.growthTolerance ?? null,
        vision: page.checks?.vision ?? null,
      },
    },
    verdict: existing?.verdict ?? null,
  };
}

const HELP = `tx-visual — tier 3: is the translated page WORSE than the English one?

  --locale=<code>     required; a target locale
  --path=<path>       page path in any locale; both sides are derived from it
  --en=<url>          explicit English URL (with --translated=)
  --translated=<url>  explicit translated URL
  --branch=<ref>      preview host ref (default: config publish.branch)
  --widths=<list>     default ${DEFAULT_WIDTHS.join(',')}
  --template=<name>   recorded in the report; the driver normally supplies it
  --vision            ask the vision tier about the first flagged block as well
  --out=<dir>         screenshot directory (default .tracker/reports/qa-local/visual/<code>)
  --report=<path>     report file (default .tracker/reports/tx/<code>--<slug>.json)
  --no-report         measure and print, write nothing
  --dry-run           print the plan — both URLs, widths, report path — and measure nothing
  --json              print the full result JSON
  --quiet             only the one-line verdict
  --help              this text

exit 0 pass · 1 layout damage · 2 no verdict (page missing / browser down / warnings) · 3 usage`;

function parseArgs(args) {
  const o = {
    locale: null,
    path: null,
    en: null,
    translated: null,
    branch: null,
    widths: null,
    template: null,
    vision: false,
    out: null,
    report: null,
    noReport: false,
    dryRun: false,
    json: false,
    quiet: false,
    help: false,
  };
  for (const x of args) {
    if (x === '--help' || x === '-h') o.help = true;
    else if (x === '--vision') o.vision = true;
    else if (x === '--no-report') o.noReport = true;
    else if (x === '--dry-run') o.dryRun = true;
    else if (x === '--json') o.json = true;
    else if (x === '--quiet') o.quiet = true;
    else if (x.startsWith('--locale=')) o.locale = x.slice(9).trim().toLowerCase();
    else if (x.startsWith('--path=')) o.path = x.slice(7);
    else if (x.startsWith('--en=')) o.en = x.slice(5);
    else if (x.startsWith('--translated=')) o.translated = x.slice(13);
    else if (x.startsWith('--branch=')) o.branch = x.slice(9);
    else if (x.startsWith('--widths=')) o.widths = x.slice(9).split(',').map(Number).filter((n) => n > 0);
    else if (x.startsWith('--template=')) o.template = x.slice(11);
    else if (x.startsWith('--out=')) o.out = x.slice(6);
    else if (x.startsWith('--report=')) o.report = x.slice(9);
    else throw new Error(`unknown arg: ${x}`);
  }
  if (o.help) return o;
  if (!o.locale) throw new Error('--locale=<code> is required');
  if (!localeFor(o.locale)) throw new Error(`unknown locale "${o.locale}"`);
  if (o.locale === 'en') {
    throw new Error('--locale=en compares the English page with itself; pass a target locale');
  }
  if (!o.path && !(o.en && o.translated)) {
    throw new Error('pass --path=<path>, or both --en=<url> and --translated=<url>');
  }
  return o;
}

async function main() {
  const o = parseArgs(argv.slice(2));
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  const cfg = loadConfig();
  const branch = o.branch || cfg.publish.branch;
  const loc = localeFor(o.locale);
  const enPath = o.path ? (pathForLocale(o.path, 'en') || normalizePath(o.path)) : null;
  const locPath = o.path ? pathForLocale(o.path, o.locale) : null;
  const enUrl = o.en || previewUrl(enPath, branch);
  const locUrl = o.translated || previewUrl(locPath, branch);
  const widths = o.widths || cfg.visual?.widths || DEFAULT_WIDTHS;
  /*
   * `<code>--<slug>` where the slug is the LOCALE-INDEPENDENT path — data-contract.md §0
   * spells it `de--meetups--x.json`, not `de--en--meetups--x.json`. The locale appears
   * exactly once, for the same reason `txDocPath` stopped doubling it: a duplicated
   * segment ends up special-cased in every reader.
   */
  const slug = slugOf(basePath(enPath || new URL(enUrl).pathname));
  const reportFile = o.report || join(cfg.state.txReportsDir, `${o.locale}--${slug}.json`);

  console.log(`tx-visual  ${loc.name} (${loc.code}) · ${loc.expansion}x text · ${loc.script}`);
  console.log(`  English     ${enUrl}`);
  console.log(`  ${loc.code.padEnd(11)} ${locUrl}`);
  console.log(`  widths      ${widths.join(', ')}`);
  console.log(`  growth up to ${growthToleranceFor(loc).toFixed(2)}x is EXPECTED and not reported`);
  console.log(`  report      ${o.noReport ? '(none — --no-report)' : reportFile}`);
  console.log(`  vision      ${o.vision ? `${cfg.llm.vision.endpoint} ${cfg.llm.vision.model}` : 'off'}`);

  if (o.dryRun) {
    console.log('\nDRY RUN — nothing loaded, nothing written.');
    return 0;
  }

  const result = await txVisual(enUrl, locUrl, o.locale, cfg, {
    widths, out: o.out, vision: o.vision,
  });
  if (result.fatal && !result.widths) {
    console.error(`ERROR: ${result.fatal}`);
    return 3;
  }
  result.enPath = enPath;
  result.branch = branch;
  result.group = enPath ? groupForPath(enPath) : null;
  result.template = o.template ?? null;
  result.pagetype = enPath ? pagetypeOf(enPath) : null;

  if (!o.quiet) {
    for (const u of result.unreachable || []) {
      /*
       * The honest zero. Nothing is translated on this site yet, so this is the
       * expected outcome today and it must not read as a pass.
       */
      if (u.translated) {
        console.error(`\n  ⚠ at ${u.width}px the ${loc.name} page could not be loaded: ${u.translated}`);
        console.error(`    Nothing was compared at this width. This is NOT a pass — if /${o.locale} `
          + 'has not been translated yet, that is the answer, not a clean layout.');
      }
      if (u.en) console.error(`\n  ⚠ at ${u.width}px the ENGLISH page could not be loaded: ${u.en}`);
    }
    for (const f of [...result.errors, ...result.warnings, ...result.notes]) {
      console.log(`  [${f.severity}] ${f.check}: ${f.detail}`);
    }
    for (const s of result.checks?.screenshots || []) console.log(`  image ${s}`);
    if (result.checks?.vision?.unavailable) {
      console.log(`  vision unavailable (${result.checks.vision.unavailable}): ${result.checks.vision.error}`);
    } else if (result.checks?.vision) {
      console.log(`  vision: damaged=${result.checks.vision.damaged} — ${result.checks.vision.summary}`);
    }
  }

  if (!o.noReport) {
    const merged = mergeReport(reportFile, result);
    mkdirSync(dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, JSON.stringify(merged, null, 2));
    console.log(`  report written: ${reportFile}`);
    console.log('  (tiers.visual only — the driver merges the page verdict)');
  }
  if (o.json) console.log(JSON.stringify(result, null, 2));

  console.log(`\nLAYOUT (${loc.code}): ${result.verdict.toUpperCase()} — ${result.why}`);
  console.log(`  ${result.errors.length} error(s), ${result.warnings.length} warning(s), ${result.notes.length} note(s)`);
  return { pass: 0, fail: 1, escalate: 2 }[result.verdict] ?? 3;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`ERROR: ${e.message}`);
      exit(e instanceof BrowserUnavailable || e instanceof LlmUnavailable ? 2 : 3);
    });
}
