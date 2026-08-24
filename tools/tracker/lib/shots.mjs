/**
 * shots.mjs — browser capture and image composition for the visual/layout QA tier.
 *
 * Node-side only (`.mjs`, so it must never appear in a browser import graph — see
 * tools/tracker/check-browser-modules.mjs).
 *
 * Three tools need the same four things: a settled page at a given width, an element
 * screenshot, a labelled side-by-side, and tall pages cut into model-sized tiles. They
 * live here because a width list or a settle procedure that differs between
 * `visual-compare` and `tx-visual` means the two tools are looking at different pages
 * and reporting on them as if they were the same one.
 *
 * ─── playwright, not puppeteer ──────────────────────────────────────────────
 *
 * The source pipeline used puppeteer. `playwright` is already a dependency here and
 * puppeteer is not, and a repo with two browser drivers downloads two Chromiums and
 * grows two settle procedures. The API differences that matter:
 *
 *   puppeteer                          playwright
 *   page.setViewport({isMobile})       browser.newContext({viewport, isMobile})
 *   waitUntil: 'networkidle2'          waitUntil: 'networkidle'
 *   handle.screenshot()                locator.screenshot()   (both scroll into view
 *                                      and both capture an element taller than the
 *                                      viewport, so element-scoped capture survives)
 *
 * Viewport is per-CONTEXT in playwright, not per-page, which is why every width opens
 * its own context rather than resizing one page. Resizing after load leaves lazy
 * blocks decorated for the old width.
 *
 * ─── sharp, not a headless page, for composition ────────────────────────────
 *
 * The source composed its side-by-side by loading two data-URI `<img>`s into a third
 * headless page and screenshotting the wrapper div, with `setViewport({width: 2600})`.
 * That works up to ~1280 per side and silently squeezes anything wider: at the 2360
 * width this project uses, two 2360px captures are 4728px side by side inside a 2600px
 * layout viewport, so flex shrinks both and the "comparison" is two rescaled images.
 * `sharp` is already a dependency, has no viewport, and gives exact pixel geometry.
 */
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PROD_HOST } from '../../../scripts/tracker/paths.js';

/**
 * The three widths, and why these three.
 *
 * 390 is where text expansion breaks first and worst — the narrower the column, the
 * sooner a longer string wraps or overflows — and it is also the width most likely to
 * be skipped in review. 1280 is the design target. 2360 catches the opposite failure,
 * a component that centres or stretches wrongly when there is too much room, which a
 * translation can trigger by changing a flex item's intrinsic width.
 *
 * Widest first, deliberately: a run that is going to be interrupted should have
 * produced the desktop evidence a human actually looks at. The source justified three
 * widths in a thirty-line comment and then shipped an array with two.
 */
export const DEFAULT_WIDTHS = [2360, 1280, 390];

/**
 * Below this, emulate a phone rather than just narrowing the window.
 *
 * A narrow desktop viewport and a phone are not the same page: `isMobile` changes the
 * user-agent, enables touch, and makes `meta viewport` apply, and EDS blocks branch on
 * all three. The source's `--mobile` flag set `isMobile` but left the width at 1280,
 * so its "mobile" capture was a mobile-emulated DESKTOP-width page — a width nothing
 * ever renders at. Deriving the emulation from the width instead makes that
 * unreachable.
 */
export const MOBILE_MAX_WIDTH = 768;

/** Hosts that go quiet after load, so `networkidle` is safe on them. */
const EDS_HOST_RE = new RegExp(
  `(^|\\.)(aem\\.page|aem\\.live|preview\\.da\\.live)$|^localhost$|^127\\.0\\.0\\.1$|^${
    PROD_HOST.replace(/\./g, '\\.')}$`,
);

/**
 * A browser that could not be started, as distinct from a page that would not load.
 *
 * Same reasoning as `LlmUnavailable` in lib/llm.mjs: "the tool could not look" is exit
 * 2 and the page holds its status, while "the tool looked and the page is broken" is
 * exit 1. A missing Chromium download reported as a layout defect fails every page in
 * a batch with a fabricated finding.
 */
export class BrowserUnavailable extends Error {}

/**
 * Launch Chromium.
 *
 * `playwright` is a declared dependency, so the realistic failure is not a missing
 * package but a missing browser BINARY — playwright downloads those out of band, and
 * the message it throws for that ("Executable doesn't exist at …") is easy to misread
 * as a code bug. Named here so the operator gets the one command that fixes it.
 */
export async function launchBrowser({ headless = true } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    throw new BrowserUnavailable(`playwright is not installed: ${e.message}`);
  }
  try {
    // --disable-dev-shm-usage: containers and small VMs give /dev/shm 64 MB, and a
    // 2360px full-page capture exceeds it — Chromium then dies mid-screenshot.
    return await chromium.launch({
      headless,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    throw new BrowserUnavailable(
      `could not launch Chromium: ${e.message}\n  install the browser binaries with:  npx playwright install chromium`,
    );
  }
}

/** Viewport + emulation for one width. See MOBILE_MAX_WIDTH. */
export function viewportFor(width, { height = 1000, dsf = null } = {}) {
  const mobile = width < MOBILE_MAX_WIDTH;
  return {
    viewport: { width, height },
    // 2x on phones because that is what a phone is; 1x on desktop because a 2360px
    // capture at 2x is a 4720px PNG that no reviewer and no vision model benefits from.
    deviceScaleFactor: dsf ?? (mobile ? 2 : 1),
    isMobile: mobile,
    hasTouch: mobile,
  };
}

/**
 * Which `waitUntil` a host can be held to.
 *
 * `networkidle` is the strongest settle signal and the only one that reliably catches
 * lazily decorated EDS blocks — but it never fires on a site with analytics or chat
 * beacons that poll forever, so on an arbitrary reference host it turns every capture
 * into a 90-second timeout followed by a screenshot of a half-built page. Per-host
 * rather than a global compromise.
 */
export function defaultWaitUntil(url) {
  try {
    return EDS_HOST_RE.test(new URL(url).hostname) ? 'networkidle' : 'domcontentloaded';
  } catch {
    return 'domcontentloaded';
  }
}

/**
 * Dismiss a consent banner if one is in the way.
 *
 * aemdev.org has none. This exists because the tool accepts an arbitrary reference
 * URL, and a consent overlay does not merely dirty the screenshot — it suppresses
 * scrolling, so the lazy-load sweep below silently does nothing and every capture
 * lands on the hero.
 */
export async function dismissConsent(page) {
  try {
    await page.evaluate(() => {
      const wanted = /required only|accept all|accept cookies|allow all|i agree/i;
      const btn = [...document.querySelectorAll('button, a[role="button"]')]
        .find((b) => wanted.test(b.textContent || ''));
      if (btn) btn.click();
    });
  } catch {
    // A page that refuses evaluation (navigating, cross-origin frame) is not a
    // consent problem; the capture below reports its own failure.
  }
}

/**
 * Load a URL, trigger every lazy block, and come back to the top.
 *
 * The scroll sweep is not optional on EDS: blocks below the fold are decorated by an
 * IntersectionObserver, so a page screenshotted without scrolling is a page with
 * undecorated blocks — and it looks like missing content rather than like a capture
 * artefact.
 *
 * Returning to `scrollY = 0` before measuring is what makes two pages' `y` offsets
 * comparable at all. Without it every offset is relative to wherever the sweep
 * stopped, which differs between two pages of different height.
 */
export async function loadAndSettle(page, url, opts = {}) {
  const {
    wait = 1200, sweepTo = 20000, step = 800, timeout = 90000, consent = false,
  } = opts;
  let res;
  try {
    res = await page.goto(url, { waitUntil: defaultWaitUntil(url), timeout });
  } catch (e) {
    // A networkidle timeout on a page that DID render is still usable evidence, but
    // treating it as success would let a genuinely dead host pass as "loaded". So the
    // failure is reported and the caller decides.
    return { ok: false, status: 0, error: `${e.message.split('\n')[0]} (${url})` };
  }
  if (!res) return { ok: false, status: 0, error: `no response from ${url}` };
  if (!res.ok()) return { ok: false, status: res.status(), error: `HTTP ${res.status()} ${url}` };

  if (consent) await dismissConsent(page);
  for (let y = 0; y < sweepTo; y += step) {
    await page.evaluate((s) => window.scrollTo(0, s), y);
    await page.waitForTimeout(60);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(wait);
  return { ok: true, status: res.status() };
}

/**
 * Screenshot one selector, or the full page.
 *
 * Element-scoped rather than offset-scoped on purpose: an element screenshot scrolls
 * its own target into view, so it cannot land on the hero because a reference host
 * resisted scripted `window.scrollTo` (which is exactly what the source ran into).
 * A missing selector is reported, never silently skipped — "the block is not there" is
 * the finding, and a tool that answers it with a missing file makes the reviewer guess.
 */
export async function shoot(page, selector, file, { fullPage = false } = {}) {
  if (fullPage || !selector) {
    await page.screenshot({ path: file, fullPage: true });
    return { file, ok: true, selector: null };
  }
  const loc = page.locator(selector).first();
  if (await loc.count() === 0) {
    return { file: null, ok: false, selector, reason: `selector not found: ${selector}` };
  }
  const box = await loc.boundingBox();
  if (!box || box.width < 1 || box.height < 1) {
    return { file: null, ok: false, selector, reason: `selector has no rendered box: ${selector}` };
  }
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await loc.screenshot({ path: file });
  return {
    file, ok: true, selector, box: { w: Math.round(box.width), h: Math.round(box.height) },
  };
}

/* --------------------------------------------------------------- composition */

const sharpModule = async () => (await import('sharp')).default;

/** XML-escape a caption. A selector can contain `&`, `<` and quotes. */
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[c]));

export async function imageSize(file) {
  const sharp = await sharpModule();
  const { width, height } = await sharp(file).metadata();
  return { width, height };
}

const WHITE = {
  r: 255, g: 255, b: 255, alpha: 1,
};

/**
 * Two images side by side under a caption bar.
 *
 * Captions are burnt in rather than left to the filename because the image is the
 * artefact that gets pasted into a ticket, and a side-by-side whose sides are not
 * labelled is one where the reviewer has a 50% chance of reporting the defect
 * backwards. The bar is an SVG composite — librsvg ships inside sharp, so this needs
 * no font handling of its own.
 */
export async function sideBySide(aFile, bFile, outFile, opts = {}) {
  const {
    labelA = 'A', labelB = 'B', caption = '', gap = 8, bar = 30,
  } = opts;
  const sharp = await sharpModule();
  const [a, b] = await Promise.all([imageSize(aFile), imageSize(bFile)]);
  const h = Math.max(a.height, b.height);
  const width = a.width + gap + b.width;
  const height = bar + h;
  const font = 'font-family="sans-serif"';
  const svg = Buffer.from([
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${bar}">`,
    `<rect width="${width}" height="${bar}" fill="#1d1d1f"/>`,
    `<text x="8" y="20" ${font} font-size="14" fill="#7ee787">${xml(labelA)}</text>`,
    `<text x="${a.width + gap + 8}" y="20" ${font} font-size="14" fill="#79c0ff">${xml(labelB)}</text>`,
    caption
      ? `<text x="${width - 8}" y="20" text-anchor="end" ${font} font-size="12" fill="#8b949e">${xml(caption)}</text>`
      : '',
    '</svg>',
  ].join(''));
  await sharp({
    create: {
      width, height, channels: 4, background: { r: 29, g: 29, b: 31, alpha: 1 },
    },
  })
    .composite([
      { input: svg, top: 0, left: 0 },
      { input: aFile, top: bar, left: 0 },
      { input: bFile, top: bar, left: a.width + gap },
    ])
    .png()
    .toFile(outFile);
  return { file: outFile, width, height };
}

/**
 * A pixel diff, and an explicit warning about what it is worth.
 *
 * On a PREVIEW-vs-LIVE pair of the same page this is the fastest way to see that a
 * block moved. On a TRANSLATED pair it is worthless and actively misleading: every
 * pixel containing text differs by design, so the map is solid magenta and the one
 * real defect is invisible inside it. That is the whole reason tier 3 is geometry plus
 * a vision model rather than a pixel diff — `visual-compare --no-diff` and
 * `tx-visual` never produce one.
 *
 * Both sides are scaled to a common width before comparing, because two captures of
 * different width have no corresponding pixels at all and a naive diff of them reports
 * 100% difference. `maxWidth` then caps the raw buffers: a 2360x9000 pair is 85 MB per
 * side of RGBA for a picture that answers the same question at 1200px.
 */
export async function pixelDiff(aFile, bFile, outFile, opts = {}) {
  const { maxWidth = 1200, threshold = 24 } = opts;
  const sharp = await sharpModule();
  const [a, b] = await Promise.all([imageSize(aFile), imageSize(bFile)]);
  const width = Math.min(maxWidth, Math.max(a.width, b.width));
  const scaledH = (m) => Math.max(1, Math.round((m.height * width) / m.width));
  const height = Math.max(scaledH(a), scaledH(b));

  const raw = async (file, meta) => sharp(file)
    .resize({ width })
    // Pad the shorter side with white rather than stretching it: a stretched page
    // misaligns every row below the first difference and reports the whole tail as
    // changed.
    .extend({ bottom: height - scaledH(meta), background: WHITE })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const [pa, pb] = await Promise.all([raw(aFile, a), raw(bFile, b)]);

  const px = width * height;
  const out = Buffer.alloc(px * 3);
  let diffPixels = 0;
  for (let i = 0; i < px; i += 1) {
    const p = i * 4;
    const o = i * 3;
    const d = Math.max(
      Math.abs(pa[p] - pb[p]),
      Math.abs(pa[p + 1] - pb[p + 1]),
      Math.abs(pa[p + 2] - pb[p + 2]),
    );
    if (d > threshold) {
      diffPixels += 1;
      out[o] = 255;
      out[o + 1] = 0;
      out[o + 2] = 255;
    } else {
      // Ghost of the A side, washed out, so a magenta patch can be located on the
      // page. A pure white background makes the map unreadable.
      const g = 205 + Math.round(((pa[p] + pa[p + 1] + pa[p + 2]) / 3) * 0.2);
      out[o] = g;
      out[o + 1] = g;
      out[o + 2] = g;
    }
  }
  await sharp(out, { raw: { width, height, channels: 3 } }).png().toFile(outFile);
  return {
    file: outFile,
    width,
    height,
    diffPixels,
    totalPixels: px,
    diffRatio: Number((diffPixels / px).toFixed(6)),
  };
}

/* ---------------------------------------------------------------- tiling */

/** A blank tile, for the side that ran out of page. */
async function blank(width, height) {
  const sharp = await sharpModule();
  return sharp({
    create: {
      width, height, channels: 4, background: WHITE,
    },
  }).png().toBuffer();
}

/** One `height`-tall slice of `buf` starting at `top`, padded if the page ends first. */
async function slice(buf, top, height, width) {
  const sharp = await sharpModule();
  const meta = await sharp(buf).metadata();
  const avail = Math.max(0, meta.height - top);
  if (avail <= 0) return blank(width, height);
  const h = Math.min(height, avail);
  let img = sharp(buf).extract({
    left: 0, top, width: Math.min(width, meta.width), height: h,
  });
  if (h < height) img = img.extend({ bottom: height - h, background: WHITE });
  return img.png().toBuffer();
}

/**
 * Cut a pair of full-page captures into aligned side-by-side tiles.
 *
 * Why tile at all: a 7B VL model resizes its input to a few hundred pixels on the long
 * edge, so a 9000px-tall page arrives as an unreadable smear and the model answers
 * about a picture it cannot see. Cutting the page into viewport-ish bands keeps the
 * text legible at the resolution the model actually gets.
 *
 * Why tile BEFORE compositing, per side, at the same `top`: the two pages are
 * different heights, so a tile cut out of an already-composited image shows band N of
 * the left page beside band N of the right page only by luck. Slicing each side at the
 * same y and joining them keeps the comparison honest — and it is the reason a finding
 * can name its tile at all.
 */
export async function tilePair(aFile, bFile, outDir, opts = {}) {
  const {
    prefix = 'tile', tileHeight = 1200, maxTiles = 4, tileWidth = 1600,
    labelA = 'A', labelB = 'B',
  } = opts;
  const sharp = await sharpModule();
  await mkdir(outDir, { recursive: true });

  const sideWidth = Math.max(200, Math.floor((tileWidth - 8) / 2));
  const prep = async (f) => {
    const buf = await sharp(f)
      .resize({ width: sideWidth, withoutEnlargement: true }).png().toBuffer();
    const meta = await sharp(buf).metadata();
    return { buf, meta };
  };
  const [a, b] = await Promise.all([prep(aFile), prep(bFile)]);
  const tall = Math.max(a.meta.height, b.meta.height);
  const wanted = Math.max(1, Math.ceil(tall / tileHeight));
  const count = Math.min(wanted, maxTiles);

  const tiles = [];
  for (let i = 0; i < count; i += 1) {
    const top = i * tileHeight;
    const [sa, sb] = await Promise.all([
      slice(a.buf, top, tileHeight, a.meta.width),
      slice(b.buf, top, tileHeight, b.meta.width),
    ]);
    const file = join(outDir, `${prefix}-${i + 1}of${count}.png`);
    const caption = `tile ${i + 1}/${count} · y ${top}-${top + tileHeight} of ${tall}px`;
    /*
     * The per-side bands are KEPT, not deleted: when a verdict is disputed the useful
     * artefact is the exact band each side contributed, and re-deriving it means
     * re-running the capture. Dot-prefixed so a glob for tiles picks up only the
     * composites the model was actually shown.
     */
    const aTmp = join(outDir, `.${prefix}-${i}-a.png`);
    const bTmp = join(outDir, `.${prefix}-${i}-b.png`);
    await sharp(sa).toFile(aTmp);
    await sharp(sb).toFile(bTmp);
    await sideBySide(aTmp, bTmp, file, {
      labelA, labelB, caption, gap: 8,
    });
    tiles.push({
      index: i + 1, of: count, top, height: tileHeight, file, caption,
    });
  }
  return {
    tiles,
    truncated: wanted > count,
    // Clamped to the page: a 1200px tile over a 265px page examined 265px, and claiming
    // 1200 makes a fully-inspected short page look like it was over-scanned.
    scannedPx: Math.min(count * tileHeight, tall),
    pagePx: tall,
  };
}

/** Cut ONE image (an already-composited side-by-side) into vertical tiles. */
export async function tileImage(file, outDir, opts = {}) {
  const {
    prefix = 'tile', tileHeight = 1200, maxTiles = 4, tileWidth = 1600,
  } = opts;
  const sharp = await sharpModule();
  await mkdir(outDir, { recursive: true });
  const buf = await sharp(file)
    .resize({ width: tileWidth, withoutEnlargement: true }).png().toBuffer();
  const meta = await sharp(buf).metadata();
  const wanted = Math.max(1, Math.ceil(meta.height / tileHeight));
  const count = Math.min(wanted, maxTiles);
  const tiles = [];
  for (let i = 0; i < count; i += 1) {
    const top = i * tileHeight;
    const out = join(outDir, `${prefix}-${basename(file, '.png')}-${i + 1}of${count}.png`);
    const s = await slice(buf, top, tileHeight, meta.width);
    await sharp(s).toFile(out);
    tiles.push({
      index: i + 1,
      of: count,
      top,
      height: tileHeight,
      file: out,
      caption: `tile ${i + 1}/${count} · y ${top}-${top + tileHeight} of ${meta.height}px`,
    });
  }
  return {
    tiles,
    truncated: wanted > count,
    scannedPx: Math.min(count * tileHeight, meta.height),
    pagePx: meta.height,
  };
}

/** Byte size of a produced file, for the report line a human reads. */
export const fileBytes = (f) => readFileSync(f).length;
