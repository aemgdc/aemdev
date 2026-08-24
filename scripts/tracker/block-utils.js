/*
 * block-utils.js — the helpers every tracker block needs, defined once.
 *
 * Browser + Node. Zero dependencies, no DOM GLOBALS. See ./README.md.
 *
 * ─── Why this file exists ───────────────────────────────────────────────────
 *
 * In the tracker this is ported from, `el()` and `readConfig()` were copy-pasted into
 * every block — six copies of each — and they drifted in the one way that matters:
 * `el` is also the obvious name for the block element, so half the blocks named the
 * factory `el` and their init parameter `block`, and half did the reverse. One of them
 * carries a four-line comment explaining that its factory had to be renamed `node`
 * because `el` was taken by the parameter every call site sits inside. Six copies of
 * nine lines is not a saving; it is six chances to make that mistake.
 *
 * So there is one copy, and one naming rule that comes with it:
 *
 *   export default function init(block) {
 *     const { el } = dom(block);
 *
 * A tracker block names its parameter `block`, not `el`. The site's own blocks
 * (`blocks/card/card.js`, `blocks/table/table.js`) call it `el` because they decorate
 * authored markup and create almost none; these blocks build entire boards, so the
 * name is worth more to the factory. `const { el } = dom(el)` is a redeclaration and
 * will not even parse, which is the good kind of enforcement.
 *
 * ─── Why `dom(block)` and not a bare `el()` ─────────────────────────────────
 *
 * This directory's second hard rule is no DOM globals: a module here must be
 * importable in Node, where `document` does not exist, so anything DOM-needing takes
 * its Document from the caller (`qa-doc.js` and `tx-doc.js` do the same). A free
 * `el()` cannot exist without reaching for a global. `dom(block)` reads the Document
 * off the element it is given, and hands back helpers whose call sites read exactly
 * as they did before. Node tests pass a jsdom element and get the same behaviour.
 */

import { statusClass } from './stages.js';

/**
 * Read a block's authored key/value rows into an object.
 *
 * EDS delivers an authored block as div-per-row/div-per-cell. A row with fewer than
 * two cells is prose or a heading, not config, and is skipped. Keys are lower-cased
 * and trimmed because an author types them into a table cell and " Group " is the same
 * key as "group"; cells beyond the second are ignored.
 *
 * Reads only — the caller clears the block. A helper that both read config and emptied
 * the block would be impossible to use twice on one element, which is what a test of a
 * board does.
 *
 * @param {Element} block
 * @returns {Record<string, string>}
 */
export function readConfig(block) {
  const cfg = {};
  for (const row of block.querySelectorAll(':scope > div')) {
    const cells = row.querySelectorAll(':scope > div');
    if (cells.length >= 2) {
      cfg[cells[0].textContent.trim().toLowerCase()] = cells[1].textContent.trim();
    }
  }
  return cfg;
}

/**
 * Thousands-separated integer. `null`, `''` and `undefined` all read as 0.
 *
 * Fixed to `en-US` rather than the reader's locale: these boards are read alongside
 * DA sheets and pipeline logs that print raw numbers, and a figure that changes
 * grouping with the browser's locale cannot be diffed against either.
 *
 * @param {number|string} n
 * @returns {string}
 */
export const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * `n` as a percentage of `d`, zero-safe. The raw number, for a bar width or a
 * threshold — `fmtPct` is what a reader sees.
 *
 * @returns {number} 0 when `d` is 0, absent or not a number
 */
export const pctOf = (n, d) => (Number(d) ? (Number(n || 0) / Number(d)) * 100 : 0);

/**
 * `n` of `d` as a percentage a human reads.
 *
 * A non-zero that would round to `0%` renders as `<1%` instead. During a rollout
 * almost every locale sits under one percent for weeks, and `0%` is indistinguishable
 * from nothing translated at all — which is a different fact and the one thing this
 * figure exists to tell them apart. An empty denominator gives `—`, not `0%`: no pages
 * is not zero progress.
 *
 * @param {number|string} n
 * @param {number|string} d
 * @param {number} [digits] decimal places, for a figure that needs them
 * @returns {string}
 */
export function fmtPct(n, d, digits = 0) {
  if (!Number(d)) return '—';
  const p = pctOf(n, d);
  const rounded = Number(p.toFixed(digits));
  if (p > 0 && rounded === 0) return '<1%';
  return `${rounded.toFixed(digits)}%`;
}

/**
 * DOM helpers bound to the Document that owns `block`.
 *
 * @param {Element|Document} block the block element (or a Document)
 * @returns {{ el: Function, statusChip: Function }}
 */
export function dom(block) {
  const doc = block.ownerDocument || block;

  /**
   * Create an element. `text` is set as TEXT, never HTML — every string on these
   * boards comes from a sheet a human types into or from a judge's prose, and both
   * reach the page through here.
   *
   * @param {string} tag
   * @param {string} [cls] class name(s)
   * @param {string} [text] text content; `null`/`undefined` leaves the node empty
   */
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  /**
   * A status chip: one stored status value, rendered.
   *
   * The class comes from `statusClass()` in `stages.js`, so the CSS hook and the enum
   * cannot drift — a status added to the model arrives here already named. The raw
   * stored value goes in the `title` whenever a label replaces it on screen, because
   * the value is what somebody has to grep the sheet for.
   *
   * @param {string} value the stored status (`auto-qa-fail`, `TRANSLATION OK`, …)
   * @param {string} [label] display text; defaults to the value itself
   */
  const statusChip = (value, label) => {
    const shown = label != null && label !== '' ? label : String(value ?? '');
    const chip = el('span', 'tracker-chip', shown);
    chip.dataset.status = statusClass(value);
    if (value && shown !== String(value)) chip.title = String(value);
    return chip;
  };

  return { el, statusChip };
}
