/*
 * Signal buttons — the loud call to action, authored with double brackets.
 *
 * Wrap a link that stands on its own line in two square brackets and it renders as
 * the big red Signal button (`.btn-signal` in styles.css):
 *
 *   [[RSVP for the Meetup]]        (the words inside the brackets are the link)
 *
 * The brackets can sit inside the link or outside it, or split across both, since
 * that depends on exactly what the author selected before pressing the link button.
 * The rule is the same either way: the paragraph (or list item, or single-paragraph
 * block cell) holds that one link and nothing else but the brackets. A `[[link]]`
 * in the middle of a sentence stays plain text, brackets and all.
 *
 * Bold, italic, underline and strikethrough are stripped: in ak.js they pick the
 * small button styles, and a Signal button has only one look. A line break the
 * author typed inside the label (Shift+Enter) is kept.
 *
 * Runs from `decorateArea` in scripts.js, ahead of ak.js's `decorateButton`. Once
 * the formatting is gone, that pass leaves the link alone, and ak.js stays pristine
 * for Author Kit syncs.
 */

import { getConfig } from '../ak.js';

// Formatting an author can put around (or inside) the link without it stopping
// being "a link on its own line".
const FORMATTING = new Set(['STRONG', 'EM', 'B', 'I', 'U', 'DEL', 'S']);
const CONTAINERS = new Set(['P', 'LI', 'DIV']);

/**
 * The element whose whole content has to be `[[link]]`: the nearest p, li or
 * div above the link, skipping any formatting it is wrapped in.
 * @param {HTMLAnchorElement} a the link
 * @returns {Element|null} the container, or null if the link sits somewhere else
 */
function containerOf(a) {
  let el = a.parentElement;
  while (el && FORMATTING.has(el.nodeName)) el = el.parentElement;
  return el && CONTAINERS.has(el.nodeName) ? el : null;
}

/**
 * The text of a container on one side of the link.
 * @param {Element} container the container
 * @param {HTMLAnchorElement} a the link inside it
 * @param {'before'|'after'} side which side to read
 * @returns {string} that side's text
 */
function textBeside(container, a, side) {
  const range = document.createRange();
  range.selectNodeContents(container);
  if (side === 'before') range.setEndBefore(a);
  else range.setStartAfter(a);
  return range.toString();
}

/**
 * Is this link authored as `[[link]]`?
 * @param {HTMLAnchorElement} a the link
 * @param {Element} container its container
 * @returns {boolean} true when the container holds the link, two brackets
 *   either side of its label, and nothing else
 */
function isBracketed(a, container) {
  if (container.querySelectorAll('a').length !== 1) return false;
  if (a.querySelector('img, picture, svg, video, iframe')) return false;
  // Nothing but formatting and line breaks outside the link: a second block,
  // an image or an icon beside it means this is not a standalone link.
  const stray = [...container.querySelectorAll('*')].some((el) => !a.contains(el)
    && el !== a && !FORMATTING.has(el.nodeName) && el.nodeName !== 'BR');
  if (stray) return false;
  // Text outside the link can only be brackets and whitespace, and the whole thing
  // has to read `[[label]]` with a real label in the middle.
  const before = textBeside(container, a, 'before');
  const after = textBeside(container, a, 'after');
  if (!/^[\s[]*$/.test(before) || !/^[\s\]]*$/.test(after)) return false;
  const whole = `${before}${a.textContent}${after}`.trim();
  return /^\[\[(?!\[)[\s\S]*?[^\s[\]][\s\S]*?(?<!\])\]\]$/.test(whole);
}

/**
 * Remove up to `count` bracket characters from one end of the link's label.
 * @param {HTMLAnchorElement} a the link
 * @param {string} bracket '[' to trim the start, ']' to trim the end
 * @param {number} count how many brackets are still to remove
 */
function trimBrackets(a, bracket, count) {
  const atStart = bracket === '[';
  const trim = (text) => (atStart ? text.trimStart() : text.trimEnd());
  const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  if (!atStart) nodes.reverse();

  let left = count;
  for (const node of nodes) {
    let text = trim(node.data);
    while (left > 0 && text.at(atStart ? 0 : -1) === bracket) {
      text = trim(atStart ? text.slice(1) : text.slice(0, -1));
      left -= 1;
    }
    node.data = text;
    // The label starts (or ends) in the first node with words left in it; a node
    // the brackets emptied means they carry on in the next one.
    if (text || left === 0) break;
  }
}

/**
 * Does this link leave the site? Then its arrow points up and out instead of along.
 * The site is the page's own host plus aemdev.org, which authors paste in full.
 * @param {HTMLAnchorElement} a the link
 * @returns {boolean} true for an http(s) link to another site
 */
function isOffSite(a) {
  try {
    const { protocol, hostname } = new URL(a.getAttribute('href'), window.location.href);
    if (!protocol.startsWith('http')) return false;
    return hostname !== window.location.hostname && !/(^|\.)aemdev\.org$/.test(hostname);
  } catch (e) {
    return false;
  }
}

/**
 * Turn one bracketed link into a Signal button.
 * @param {HTMLAnchorElement} a the link
 * @param {Element} container its container
 */
function decorate(a, container) {
  const count = (text, bracket) => [...text].filter((c) => c === bracket).length;
  trimBrackets(a, '[', 2 - count(textBeside(container, a, 'before'), '['));
  trimBrackets(a, ']', 2 - count(textBeside(container, a, 'after'), ']'));

  // Flatten the label to its words and line breaks, then drop everything around
  // the link: the brackets outside it and any bold or italic it was wrapped in.
  a.querySelectorAll('*').forEach((el) => {
    if (FORMATTING.has(el.nodeName)) el.replaceWith(...el.childNodes);
  });
  const label = document.createElement('span');
  label.className = 'btn-signal-label';
  label.append(...a.childNodes);
  a.replaceChildren(label);
  container.replaceChildren(a);

  a.classList.add('btn', 'btn-signal');
  if (isOffSite(a)) a.classList.add('btn-signal-external');
  // Always a button, never an embed: `[[Watch it on YouTube]]` must not auto-block
  // into a player. `#_dnb` is ak.js's own do-not-block hash, and ak.js eats it. Only
  // links that would block get it, because ak.js puts the hash back on a link it
  // localizes, and a stray `#_dnb` in a URL is worse than none.
  const href = a.getAttribute('href');
  const linkBlocks = getConfig()?.linkBlocks || [];
  if (linkBlocks.some((pattern) => href.includes(Object.values(pattern)[0]))) {
    a.setAttribute('href', `${href}#_dnb`);
  }
}

/**
 * Find every `[[link]]` in an area and make it a Signal button.
 * @param {Element|Document} area the area to decorate
 */
export default function decorateSignalButtons(area) {
  for (const a of area.querySelectorAll('a[href]')) {
    const container = containerOf(a);
    if (container && isBracketed(a, container)) decorate(a, container);
  }
}
