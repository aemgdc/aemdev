#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * visual-compare.mjs — screenshot two URLs at three widths, side by side, plus a diff.
 *
 * CLI SURFACE
 *   node tools/tracker/visual-compare.mjs [--a=<spec>] [--b=<spec>]
 *        [--path=<path>] [--locale=<code>] [--pair=<name>] [--branch=<ref>]
 *        [--selector=<css>]... [--b-selector=<css>]... [--full-page]
 *        [--widths=2360,1280,390] [--wait=<ms>] [--no-diff] [--diff-width=<px>]
 *        [--label-a=<text>] [--label-b=<text>] [--out=<dir>]
 *        [--dry-run] [--json] [--help]
 *
 *   npm run visual:compare -- --path=/en/meetups/aem-meetup-munich
 *        preview vs live, the default question: did publishing change the page?
 *   npm run visual:compare -- --path=/en/meetups/x --locale=de
 *        English preview vs the German preview of the same page
 *   npm run visual:compare -- --a=/en/meetups/x --b=/en/meetups/y --selector=main
 *        two different pages, one selector
 *   npm run visual:compare -- --pair=<name>
 *        a pair registered in .tracker/orchestrator.json under `visual.pairs`
 *
 * ─── What this tool is, and what it is not ──────────────────────────────────
 *
 * It PRODUCES EVIDENCE. It holds no opinion, so it never exits 1: deciding whether a
 * difference is damage is `visual-judge.mjs`'s job (feed it this run's manifest with
 * `--from=`), and on a translated pair it is `tx-visual.mjs`'s job. A capture tool that
 * also graded would be a pixel-diff gate, and a pixel-diff gate fails every translated
 * page by construction because the text is different by design.
 *
 * ─── No hardcoded hosts ─────────────────────────────────────────────────────
 *
 * The source carried a literal `LIVE_MAP` of production URLs in the file and told the
 * operator to edit the source to add a page. Here a side is a SPEC resolved through
 * scripts/tracker/paths.js:
 *
 *   https://…            a literal URL (an arbitrary external reference)
 *   preview:/en/x        previewUrl()  — <branch>--aemdev--aemgdc.aem.page
 *   live:/en/x           liveUrl()     — <branch>--aemdev--aemgdc.aem.live
 *   prod:/en/x           prodUrl()     — www.aemdev.org
 *   /en/x                bare path, = preview:
 *
 * and a reusable pair is a NAMED entry in config (`visual.pairs`), not an edit here.
 *
 * ─── The two defects documented in the source, and their fixes ──────────────
 *
 * 1. `--mobile` never applied the 390px width it documented. It set `isMobile: true`
 *    and left the viewport at `--width` (1280), so the "mobile" capture was a
 *    mobile-emulated page at a desktop width — a combination no real device produces,
 *    and the width where expansion breaks first was never actually photographed.
 *    FIX: widths are a LIST (`--widths=`, default 2360,1280,390) and every width gets
 *    its own browser context; phone emulation is derived from the width in
 *    `viewportFor()` rather than being a separate flag that can disagree with it.
 *
 * 2. `--out` was not width-namespaced, so a second width overwrote the first.
 *    Filenames were `local-<i>.png` / `live-<i>.png` / `compare-<i>.png` with no width
 *    and no page in them — which also meant two different PAGES overwrote each other,
 *    and the surviving files were indistinguishable.
 *    FIX: output is `visual-compare-out/<page-slug>/w<width>/<side>-<i>-<selector>.png`,
 *    plus a `manifest.json` recording every URL, selector, width and file. `--out`
 *    still overrides the root, and nothing inside it can collide.
 *
 * EXIT CODES  0 every requested capture was produced ·
 *             2 a page would not load, a selector was missing, or Chromium would not
 *               start — evidence is incomplete, so no caller may read the result as
 *               "no differences" ·
 *             3 usage or configuration error. Never 1: see above.
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import {
  basePath, locale, normalizePath, pathForLocale,
} from '../../scripts/tracker/locales.js';
import {
  liveUrl, previewUrl, prodUrl, slugOf,
} from '../../scripts/tracker/paths.js';
import { loadConfig, REPO_ROOT } from './config.mjs';
import {
  BrowserUnavailable, DEFAULT_WIDTHS, fileBytes, imageSize, launchBrowser,
  loadAndSettle, pixelDiff, shoot, sideBySide, viewportFor,
} from './lib/shots.mjs';

/** Gitignored (see .gitignore) — this is scratch evidence, not committed state. */
const OUT_ROOT = join(REPO_ROOT, 'visual-compare-out');

const SURFACES = {
  preview: (path, branch) => previewUrl(path, branch),
  live: (path, branch) => liveUrl(path, branch),
  prod: (path) => prodUrl(path),
};

const HELP = `visual-compare — two URLs, three widths, side-by-side and diff.

  --a=<spec>          left side.  <url> | preview:<path> | live:<path> | prod:<path> | <path>
  --b=<spec>          right side. same forms
  --path=<path>       shorthand: the same path on two surfaces (default preview vs live)
  --locale=<code>     with --path: EN preview (left) vs that locale's preview (right)
  --pair=<name>       a pair registered in .tracker/orchestrator.json → visual.pairs
  --branch=<ref>      build preview/live URLs against this ref (default: config publish.branch)
  --selector=<css>    element to capture; repeatable; default "main"
  --b-selector=<css>  index-matched selector for the right side (markup can differ)
  --full-page         capture the whole document instead of a selector
  --widths=<list>     default ${DEFAULT_WIDTHS.join(',')}
  --wait=<ms>         settle time after the lazy-load sweep (default 1200)
  --no-diff           skip the pixel diff (correct for a translated pair: every glyph
                      differs by design, so the map is solid and tells you nothing)
  --diff-width=<px>   common width the diff is computed at (default 1200)
  --label-a/--label-b caption text burnt into the side-by-side
  --out=<dir>         output root (default visual-compare-out/)
  --dry-run           print the full plan — every URL, width, selector and output
                      path — and capture nothing
  --json              print the manifest to stdout as well as writing it
  --help              this text

exit 0 all captures produced · 2 incomplete evidence · 3 usage/config error`;

function parseArgs(args) {
  const o = {
    a: null,
    b: null,
    path: null,
    locale: null,
    pair: null,
    branch: null,
    selectors: [],
    bSelectors: [],
    fullPage: false,
    widths: null,
    wait: 1200,
    diff: true,
    diffWidth: 1200,
    labelA: null,
    labelB: null,
    out: null,
    dryRun: false,
    json: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--full-page') o.fullPage = true;
    else if (a === '--no-diff') o.diff = false;
    else if (a.startsWith('--a=')) o.a = a.slice(4);
    else if (a.startsWith('--b-selector=')) o.bSelectors.push(a.slice(13));
    else if (a.startsWith('--b=')) o.b = a.slice(4);
    else if (a.startsWith('--path=')) o.path = a.slice(7);
    else if (a.startsWith('--locale=')) o.locale = a.slice(9).trim().toLowerCase();
    else if (a.startsWith('--pair=')) o.pair = a.slice(7);
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else if (a.startsWith('--selector=')) o.selectors.push(a.slice(11));
    else if (a.startsWith('--widths=')) o.widths = a.slice(9).split(',').map(Number).filter((n) => n > 0);
    else if (a.startsWith('--wait=')) o.wait = Number(a.slice(7));
    else if (a.startsWith('--diff-width=')) o.diffWidth = Number(a.slice(13));
    else if (a.startsWith('--label-a=')) o.labelA = a.slice(10);
    else if (a.startsWith('--label-b=')) o.labelB = a.slice(10);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else throw new Error(`unknown arg: ${a}`);
  }
  return o;
}

/**
 * Resolve one side spec to `{ url, path, surface, label }`.
 *
 * A literal URL keeps its own pathname as `path` so the output directory is still named
 * after the page even for an external reference — the whole point of the naming scheme
 * is that a human can find a page's images by slug.
 */
function resolveSide(spec, branch) {
  const s = String(spec || '').trim();
  if (!s) throw new Error('empty side spec');
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    return {
      url: s, path: normalizePath(u.pathname), surface: u.host, label: u.host,
    };
  }
  const m = /^([a-z]+):(\/.*)$/.exec(s);
  const surface = m ? m[1] : 'preview';
  const path = normalizePath(m ? m[2] : s);
  if (!path.startsWith('/')) throw new Error(`side spec must be a URL or an absolute path: "${s}"`);
  const build = SURFACES[surface];
  if (!build) {
    throw new Error(`unknown surface "${surface}" — use ${Object.keys(SURFACES).join(', ')}, or a full URL`);
  }
  return {
    url: build(path, branch), path, surface, label: surface,
  };
}

/**
 * Turn the shorthands into two side specs.
 *
 * `--path` alone means preview-vs-live, because that is the question this tool gets
 * asked most on an EDS site: the two hosts serve the same content from different
 * caches, and a page that renders on aem.page and not on aem.live is the failure a
 * human would otherwise find from a report.
 */
function sidesFrom(o, cfg) {
  if (o.pair) {
    const pairs = cfg.visual?.pairs || {};
    const p = pairs[o.pair];
    if (!p) {
      const known = Object.keys(pairs).filter((k) => !k.startsWith('$')).join(', ') || '(none registered)';
      throw new Error(
        `unknown --pair="${o.pair}". Registered under visual.pairs in .tracker/orchestrator.json: ${known}`,
      );
    }
    if (!p.a || !p.b) throw new Error(`visual.pairs.${o.pair} needs both "a" and "b"`);
    return { aSpec: p.a, bSpec: p.b, fromPair: p };
  }
  if (o.a && o.b) return { aSpec: o.a, bSpec: o.b };
  if (o.a || o.b) throw new Error('--a and --b go together; pass both, or use --path=');
  if (!o.path) throw new Error('nothing to compare — pass --path=, --a= and --b=, or --pair=');
  if (o.locale) {
    if (!locale(o.locale)) throw new Error(`unknown locale "${o.locale}"`);
    const enPath = pathForLocale(o.path, 'en') || normalizePath(o.path);
    const locPath = pathForLocale(o.path, o.locale);
    return { aSpec: `preview:${enPath}`, bSpec: `preview:${locPath}` };
  }
  return { aSpec: `preview:${normalizePath(o.path)}`, bSpec: `live:${normalizePath(o.path)}` };
}

/**
 * Output directory for a run.
 *
 * Keyed on the LOCALE-INDEPENDENT base path, so an EN-vs-de comparison of one page
 * lands in one directory rather than two half-directories named after each side. Two
 * genuinely different pages get both slugs, because that run is about the pair and
 * either slug is a reasonable thing to grep for.
 */
function runDir(a, b, override) {
  if (override) return isAbsolute(override) ? override : join(REPO_ROOT, override);
  const sa = slugOf(basePath(a.path));
  const sb = slugOf(basePath(b.path));
  return join(OUT_ROOT, sa === sb ? sa : `${sa}__vs__${sb}`);
}

/** Filesystem-safe form of a CSS selector, for a filename a human can read. */
const selSlug = (sel) => (sel || 'fullpage')
  .replace(/[^a-zA-Z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40) || 'sel';

/** Capture every selector from one side at one width. */
async function captureSide(browser, side, selectors, width, files, opts) {
  const context = await browser.newContext({
    ...viewportFor(width),
    // A translated page must be requested in a way that does not make the CDN
    // language-negotiate on our behalf; the path is the only thing that should decide
    // which locale we get.
    locale: 'en-US',
  });
  const page = await context.newPage();
  const out = { shots: [], load: null };
  try {
    out.load = await loadAndSettle(page, side.url, { wait: opts.wait, consent: true });
    if (out.load.ok) {
      for (let i = 0; i < selectors.length; i += 1) {
        const shot = await shoot(page, selectors[i], files[i], { fullPage: opts.fullPage });
        out.shots.push(shot);
      }
    }
  } finally {
    await context.close();
  }
  return out;
}

function planLines(a, b, selectors, bSelectors, widths, dir, opts) {
  const lines = [
    `  A  ${a.label.padEnd(10)} ${a.url}`,
    `  B  ${b.label.padEnd(10)} ${b.url}`,
    `  out ${dir}`,
    `  widths ${widths.join(', ')}   diff ${opts.diff ? `yes @${opts.diffWidth}px` : 'no'}`,
    '',
  ];
  for (const w of widths) {
    const v = viewportFor(w);
    lines.push(`  w${w}  viewport ${w}x${v.viewport.height} dsf${v.deviceScaleFactor}${v.isMobile ? ' (phone emulation)' : ''}`);
    for (let i = 0; i < selectors.length; i += 1) {
      const slug = selSlug(opts.fullPage ? null : selectors[i]);
      const wd = join(dir, `w${w}`);
      lines.push(`        A ${selectors[i]}  ->  ${join(wd, `a-${i}-${slug}.png`)}`);
      lines.push(`        B ${bSelectors[i]}  ->  ${join(wd, `b-${i}-${slug}.png`)}`);
      lines.push(`          side-by-side  ->  ${join(wd, `side-${i}-${slug}.png`)}`);
      if (opts.diff) lines.push(`          pixel diff    ->  ${join(wd, `diff-${i}-${slug}.png`)}`);
    }
  }
  return lines;
}

async function main() {
  const o = parseArgs(argv.slice(2));
  if (o.help) {
    console.log(HELP);
    return 0;
  }
  const cfg = loadConfig();
  const branch = o.branch || cfg.publish.branch;
  const { aSpec, bSpec, fromPair } = sidesFrom(o, cfg);
  const a = resolveSide(aSpec, branch);
  const b = resolveSide(bSpec, branch);
  if (o.labelA) a.label = o.labelA;
  if (o.labelB) b.label = o.labelB;

  const selectors = (o.selectors.length ? o.selectors : fromPair?.selectors) || ['main'];
  // The right-hand markup can differ (a live host, a different template), so the
  // right selector is index-matched and falls back to the left one.
  const bSelectors = selectors.map((s, i) => o.bSelectors[i] || s);
  const widths = o.widths || fromPair?.widths || cfg.visual?.widths || DEFAULT_WIDTHS;
  const dir = runDir(a, b, o.out);

  console.log(`visual-compare  ${selectors.length} selector(s) × ${widths.length} width(s)`);
  console.log(planLines(a, b, selectors, bSelectors, widths, dir, o).join('\n'));

  if (o.dryRun) {
    console.log('\nDRY RUN — nothing captured.');
    return 0;
  }

  let browser;
  try {
    browser = await launchBrowser();
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    return 2;
  }

  const manifest = {
    tool: 'visual-compare',
    generated: new Date().toISOString(),
    branch,
    a: {
      label: a.label, url: a.url, path: a.path, surface: a.surface,
    },
    b: {
      label: b.label, url: b.url, path: b.path, surface: b.surface,
    },
    widths,
    selectors,
    bSelectors,
    dir,
    shots: [],
    incomplete: [],
  };

  try {
    for (const width of widths) {
      const wd = join(dir, `w${width}`);
      mkdirSync(wd, { recursive: true });
      const slugs = selectors.map((s, i) => selSlug(o.fullPage ? null : s || bSelectors[i]));
      const aFiles = slugs.map((s, i) => join(wd, `a-${i}-${s}.png`));
      const bFiles = slugs.map((s, i) => join(wd, `b-${i}-${s}.png`));

      // Sequential, not parallel: two contexts at 2360px with full-page captures is
      // where Chromium runs out of shared memory, and the sweep is I/O bound anyway.
      const aRes = await captureSide(browser, a, selectors, width, aFiles, o);
      const bRes = await captureSide(browser, b, bSelectors, width, bFiles, o);

      for (const [side, res] of [['A', aRes], ['B', bRes]]) {
        if (!res.load.ok) manifest.incomplete.push(`w${width} side ${side}: ${res.load.error}`);
      }

      for (let i = 0; i < selectors.length; i += 1) {
        const aShot = aRes.shots[i];
        const bShot = bRes.shots[i];
        const entry = {
          width,
          index: i,
          selector: selectors[i],
          bSelector: bSelectors[i],
          a: aShot?.ok ? aShot.file : null,
          b: bShot?.ok ? bShot.file : null,
          aBox: aShot?.box || null,
          bBox: bShot?.box || null,
          side: null,
          diff: null,
        };
        if (!entry.a) manifest.incomplete.push(`w${width} A ${selectors[i]}: ${aShot?.reason || aRes.load.error || 'not captured'}`);
        if (!entry.b) manifest.incomplete.push(`w${width} B ${bSelectors[i]}: ${bShot?.reason || bRes.load.error || 'not captured'}`);

        if (entry.a && entry.b) {
          const sideFile = join(wd, `side-${i}-${slugs[i]}.png`);
          const [as, bs] = await Promise.all([imageSize(entry.a), imageSize(entry.b)]);
          await sideBySide(entry.a, entry.b, sideFile, {
            labelA: `${a.label}  ${as.width}x${as.height}`,
            labelB: `${b.label}  ${bs.width}x${bs.height}`,
            caption: `${selectors[i]} @ ${width}px`,
          });
          entry.side = sideFile;
          if (o.diff) {
            const d = await pixelDiff(entry.a, entry.b, join(wd, `diff-${i}-${slugs[i]}.png`), {
              maxWidth: o.diffWidth,
            });
            entry.diff = d.file;
            entry.diffPixels = d.diffPixels;
            entry.diffRatio = d.diffRatio;
          }
          console.log(
            `  w${width} ${selectors[i]}  ${as.width}x${as.height} vs ${bs.width}x${bs.height}`
            + `${o.diff ? `  diff ${(entry.diffRatio * 100).toFixed(2)}%` : ''}  ->  ${sideFile}`,
          );
        }
        manifest.shots.push(entry);
      }
    }
  } finally {
    await browser.close();
  }

  const manifestFile = join(dir, 'manifest.json');
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const produced = manifest.shots.filter((s) => s.side);
  console.log(`\n${produced.length} of ${manifest.shots.length} comparison(s) produced.`);
  for (const s of produced) {
    console.log(`  ${s.side}  ${fileBytes(s.side)} bytes`);
  }
  console.log(`manifest: ${manifestFile}`);
  console.log(`judge it:  npm run visual:judge -- --from=${manifestFile}`);
  if (o.json) console.log(JSON.stringify(manifest, null, 2));

  if (manifest.incomplete.length) {
    console.error(`\n✗ ${manifest.incomplete.length} capture(s) missing — this run is NOT evidence of "no differences":`);
    for (const m of manifest.incomplete) console.error(`    ${m}`);
    return 2;
  }
  return 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`ERROR: ${e.message}`);
      exit(e instanceof BrowserUnavailable ? 2 : 3);
    });
}

export { resolveSide, runDir, selSlug };
