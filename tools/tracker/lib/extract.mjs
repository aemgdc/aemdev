/**
 * extract.mjs — fetching, text normalization and page-content extraction, shared by
 * every QA tier.
 *
 * Node-only (see ../README notes: everything under tools/tracker is Node-only and must
 * never be reachable from a browser entry point).
 *
 * Two layers, and the split is deliberate. The top is what EVERY tier needs — a fetch
 * that reports HTTP failure as data, and the punctuation folding both sides of any
 * comparison must go through. The bottom is the STRUCTURAL tier's battery: the
 * signatures a page can be judged on without a model.
 *
 * The upstream pipeline's equivalent grew into a grab bag of migration-specific
 * extractors — title shelves, customer-name folding, `<small>` caption scraping,
 * inline-SVG comparison against a legacy page's own glyphs — because it had a legacy
 * CMS page on the other side of every diff. There is no legacy page here, so those
 * are gone: a check that cannot run is worse than a missing one, because the report
 * still lists it and a reader still counts it.
 *
 * Two things survive from that set, for their reasons rather than their code.
 * `svgShape` fingerprints what an icon DRAWS rather than how it is spelled, which is
 * still the only way to tell a resolving icon from the RIGHT icon. `missingVerbatim`
 * keeps the caption gate's lesson without its content: a semantic judge proved
 * unreliable at noticing one dropped item among several similar ones, so anything a
 * human declared must-survive-verbatim gets an exact-text check that costs nothing
 * and cannot be talked out of its answer.
 */
/*
 * jsdom is a devDependency, not a dependency, and that is correct: nothing a visitor
 * loads imports this file. The pipeline is an ops tool. The lint rule cannot know the
 * difference, so it is silenced here rather than by promoting the package.
 */
// eslint-disable-next-line import/no-extraneous-dependencies
import { JSDOM } from 'jsdom';

/**
 * GET a document. Returns `{ status, html }` and NEVER throws on an HTTP error.
 *
 * A 404 on a locale page is not an exception, it is the single most common answer this
 * function gives — nothing is translated yet — and the caller has to be able to turn it
 * into a finding rather than a stack trace. `status: 0` means the transport failed
 * (DNS, reset, timeout), which is a different fact and maps to a different exit code.
 */
export async function fetchHtml(url, { userAgent, timeoutMs = 30000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': userAgent || 'Mozilla/5.0' },
      signal: ctl.signal,
      redirect: 'follow',
    });
    const html = res.ok ? await res.text() : '';
    return { status: res.status, html };
  } catch (e) {
    return { status: 0, html: '', error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalize text for comparison.
 *
 * Folds the punctuation variants that differ between what DA stores and what a
 * translation service returns — curly vs straight quotes, en/em dashes, NBSP — plus
 * whitespace runs. Without this a correctly translated paragraph differs from itself
 * because the round trip swapped an apostrophe, and every such difference lands on a
 * reviewer's desk as a finding.
 *
 * NOTE what it does NOT fold: case. A translated key `facebook` → `Facebook` is a real
 * defect (blocks look keys up case-sensitively), so case has to survive into the
 * comparison.
 *
 * It has to be applied to BOTH sides or to neither. Folding one side only reports a
 * difference the check introduced itself — the source pipeline flagged "Italy's
 * Ministry" as differing from "Italy’s Ministry" on a page that was correct.
 */
export const normText = (s) => (s || '')
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-')
  .replace(/ /g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Heading text, folded for comparison across a translation boundary. */
export const normHeading = (s) => normText(s).toLowerCase().replace(/[.:]$/, '');

/** Parse an HTML string and hand back its `document`. One place, one jsdom import. */
export const parseHtml = (html) => new JSDOM(html || '').window.document;

/* ============================================================ structural battery */

/*
 * Which rendition answers which question:
 *
 *   `.plain.html`   the authored body EDS serves — the basis for any content
 *                   comparison, because it holds no nav, no footer and no injected
 *                   markup. Scope `body`.
 *   rendered page   used ONLY for what `.plain.html` cannot answer: the `<head>`
 *                   metadata EDS hoists out of the `metadata` block, and whether a
 *                   declared block survived into the served DOM. Scope `main`.
 */

function absUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * Extract a comparable content signature from a document.
 *
 * `scope` is the CSS selector for the content root. It falls back to `body` rather
 * than throwing: a page whose `<main>` never rendered is a finding for the caller,
 * not a crash here.
 *
 * `meta` carries EVERY `name=`/`property=` tag rather than a fixed three, because
 * required metadata is a per-group question — a meetup must state its `event-date`
 * and `location`, an article its `author` — and the group's baseline is where that
 * list belongs.
 *
 * `drop` REMOVES matching elements before anything is read, and its default is not
 * cosmetic. In a `.plain.html` the `metadata` and `section-metadata` blocks are
 * two-column key/value tables: `textContent` reads them, and the rendered page does
 * not show them at all. Left in, they inflate the word count, add phantom "headings"
 * worth of text, and — the expensive one — reach the judge as prose. The pipeline
 * this is ported from fought that with a growing pile of regexes guessing at the
 * TEXT form of those rows (`/\blayout\s+[\w-]+/`, `/\bstyle\s+[\w-]+/`, …), which
 * mis-fired on real content and needed a new rule per block. Removing the elements
 * is exact, and it cannot rot.
 */
export function extractContent(html, baseUrl, scope = 'body', {
  drop = ['.metadata', '.section-metadata'],
} = {}) {
  const doc = parseHtml(html);
  for (const sel of drop) {
    for (const el of doc.querySelectorAll(sel)) el.remove();
  }
  const root = doc.querySelector(scope) || doc.body;

  const headings = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .map((h) => ({ level: Number(h.tagName[1]), text: normText(h.textContent) }))
    .filter((h) => h.text);

  const links = [...new Set(
    [...root.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter((h) => h && !/^(#|mailto:|tel:|javascript:)/i.test(h))
      .map((h) => absUrl(h, baseUrl))
      .filter(Boolean),
  )];

  /*
   * Images as `{ url, alt }`, not as bare URLs.
   *
   * `alt` is a check in its own right here — the source had a legacy page to diff
   * against and so never had to judge an image on its own terms — and the difference
   * between a MISSING `alt` attribute and an EMPTY one is not recoverable once the URL
   * is all that was kept. `alt: null` means the attribute is absent (an authoring
   * miss); `alt: ''` means someone declared the image decorative.
   *
   * Deduped by URL, because a `<picture>` names the same asset in several `<source>`
   * elements and only the `<img>` carries the alt.
   */
  const seen = new Map();
  for (const el of root.querySelectorAll('img[src]')) {
    const src = el.getAttribute('src');
    if (src && !src.startsWith('data:')) {
      const url = absUrl(src, baseUrl);
      if (url && !seen.has(url)) {
        seen.set(url, { url, alt: el.hasAttribute('alt') ? normText(el.getAttribute('alt')) : null });
      }
    }
  }
  const images = [...seen.values()];

  const text = normText(root.textContent);

  const meta = {};
  for (const el of doc.querySelectorAll('meta[name][content], meta[property][content]')) {
    const key = el.getAttribute('name') || el.getAttribute('property');
    if (key && !(key in meta)) meta[key] = normText(el.getAttribute('content'));
  }

  return {
    title: normText(doc.querySelector('title')?.textContent || ''),
    description: meta.description || meta['og:description'] || '',
    ogImage: meta['og:image'] || '',
    meta,
    headings,
    links,
    images,
    text,
    words: text ? text.split(' ').length : 0,
  };
}

/** Just the comparison forms of a heading list, in document order. */
export const headingSequence = (headings) => headings.map((h) => normHeading(h.text));

/**
 * Block declarations in a `.plain.html`: the first class token of every block-level
 * div (a direct child of a section div).
 *
 * The `^[a-z][a-z0-9-]*$` test separates a BLOCK name from an authoring artifact — a
 * class with a capital, an underscore or a dot is not something `blocks/<name>/
 * <name>.js` could ever be named, so counting it as a declared block would report a
 * missing implementation for a thing that is not a block.
 */
export function extractBlocks(plainHtml) {
  const names = new Set();
  for (const el of parseHtml(plainHtml).querySelectorAll('body > div div[class]')) {
    const cls = el.getAttribute('class').split(/\s+/)[0];
    if (cls && /^[a-z][a-z0-9-]*$/.test(cls)) names.add(cls);
  }
  return [...names];
}

/**
 * Section STYLE names in a `.plain.html`: the first class token of each top-level div.
 *
 * A different mechanism from a block, and worth its own check because the markup looks
 * identical at a glance. In a `.plain.html` the top-level divs are SECTIONS, and a
 * class on one comes from a `section-metadata` `style` row — EDS renders it as
 * `.section.<name>` and the CSS lives in `styles/sections.css` or a template. A block
 * is one level deeper (`body > div div[class]`) and has a `blocks/<name>/` directory.
 *
 * The source's extractor used only the block selector, so a section style was invisible
 * to it entirely. On this site that is not hypothetical: `key-points` and `related` are
 * both section styles on the meetup recap page and neither was reported at all — and a
 * misspelled one renders with no styling and no error, exactly like a misspelled block.
 */
export function extractSectionStyles(plainHtml) {
  const names = new Set();
  for (const el of parseHtml(plainHtml).querySelectorAll('body > div[class]')) {
    const cls = el.getAttribute('class').split(/\s+/)[0];
    if (cls && /^[a-z][a-z0-9-]*$/.test(cls)) names.add(cls);
  }
  return [...names];
}

/**
 * The icon names a `.plain.html` references — EDS renders a `:name:` token as
 * `<span class="icon icon-name">` and swaps in `/icons/name.svg` at runtime.
 *
 * Icons are invisible to every other check in the battery: they are not `<img>`, so
 * the image check never sees them, and they carry no text, so the heading, word-ratio
 * and judge checks never see them either. In the pipeline this is ported from that
 * blind spot shipped 100 pages rendering the wrong story's glyphs, through a QA pass
 * that was otherwise working.
 */
export function extractIconRefs(plainHtml) {
  const names = [];
  for (const el of parseHtml(plainHtml).querySelectorAll('span.icon, svg.icon')) {
    const cls = [...el.classList].find((c) => c.startsWith('icon-'));
    if (cls) names.push(cls.slice('icon-'.length));
  }
  return names;
}

/** Elements whose attributes describe a shape rather than its presentation. */
const SHAPE_ATTRS = {
  path: ['d'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polygon: ['points'],
  polyline: ['points'],
};

/**
 * A comparable fingerprint of what an `<svg>` actually draws.
 *
 * Two renditions of one glyph are never byte-identical — ids, wrapper `<g>`s, and a
 * hardcoded fill versus `currentColor` all differ — so comparing markup flags every
 * icon on the site. Compare the geometry instead: the viewBox plus each shape's own
 * coordinates, in order, and let presentation fall away.
 */
export function svgShape(svgEl) {
  const viewBox = normText(svgEl.getAttribute('viewBox') || '');
  const shapes = [];
  for (const el of svgEl.querySelectorAll(Object.keys(SHAPE_ATTRS).join(','))) {
    const attrs = SHAPE_ATTRS[el.tagName.toLowerCase()] || [];
    const vals = attrs.map((a) => normText(el.getAttribute(a) || '')).join(' ');
    if (vals.trim()) shapes.push(`${el.tagName.toLowerCase()}:${vals}`);
  }
  if (!shapes.length) return null;
  return `${viewBox}|${shapes.join('|')}`;
}

/** Fetch an `/icons/<name>.svg` and fingerprint it. */
export async function fetchIconShape(origin, name, { userAgent, timeoutMs } = {}) {
  const url = `${origin}/icons/${name}.svg`;
  const res = await fetchHtml(url, { userAgent, timeoutMs });
  if (res.status !== 200) return { name, url, status: res.status };
  const svgEl = parseHtml(res.html).querySelector('svg');
  if (!svgEl) return { name, url, status: 200, unparseable: true };
  return { name, url, status: 200, shape: svgShape(svgEl) };
}

/**
 * HEAD-check a list of URLs with limited concurrency; returns unreachable entries.
 *
 * The 405/403 retry as a GET is not defensive coding: plenty of hosts in front of
 * asset paths refuse HEAD outright, and treating that refusal as "the asset is
 * missing" would report every image on such a host as broken.
 */
export async function checkReachable(urls, { limit = 40, concurrency = 6, userAgent } = {}) {
  const list = urls.slice(0, limit);
  const bad = [];
  let i = 0;
  const headers = { 'user-agent': userAgent || 'Mozilla/5.0' };
  async function worker() {
    while (i < list.length) {
      const url = list[i]; i += 1;
      try {
        let res = await fetch(url, { method: 'HEAD', headers });
        if (res.status === 405 || res.status === 403) res = await fetch(url, { headers });
        if (res.status !== 200) bad.push({ url, status: res.status });
      } catch (e) {
        bad.push({ url, status: 0, error: e.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return {
    checked: list.length,
    skipped: Math.max(0, urls.length - list.length),
    unreachable: bad,
  };
}

/** Diff two heading lists by comparison form. */
export function diffHeadings(source, migrated) {
  const migSet = new Set(migrated.map((h) => normHeading(h.text)));
  const srcSet = new Set(source.map((h) => normHeading(h.text)));
  return {
    missing: source.filter((h) => !migSet.has(normHeading(h.text))).map((h) => `h${h.level}: ${h.text}`),
    extra: migrated.filter((h) => !srcSet.has(normHeading(h.text))).map((h) => `h${h.level}: ${h.text}`),
  };
}

/**
 * Which of `strings` do NOT appear verbatim in `text`?
 *
 * Comparison is on the folded form of both sides (see `normText`) and
 * case-insensitive, so a curly apostrophe or a capitalised heading is not a defect —
 * but nothing else is forgiven, because the whole point is that a human wrote these
 * strings down as must-survive-verbatim.
 */
export function missingVerbatim(text, strings) {
  const hay = normText(text).toLowerCase();
  return strings.filter((s) => {
    const needle = normText(s).toLowerCase();
    return needle.length > 0 && !hay.includes(needle);
  });
}
