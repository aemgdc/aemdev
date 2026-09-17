/**
 * Roster resolution — the slug → bio-document half of a bio roster.
 *
 * Three blocks need the same four things: read slugs out of an authored block or
 * the page's `speakers` metadata, turn a slug into a document path, fetch that
 * document's `.bio` block with its images pointing somewhere that still resolves,
 * and render something visible for a slug that has no document. They live here
 * because a slug grammar or a media-URL rule that differs between `speakers`,
 * `bios` and `bio` means two blocks disagree about what a page's roster IS while
 * both look like they work.
 *
 * Deliberately does NOT import blocks/bio/bio.js. This module hands back the raw
 * `.bio` source element and the caller parses it, which keeps the dependency
 * one-way — bio.js imports this, never the reverse.
 *
 * The `speakers` metadata contract is in docs/adaptto-2026/content-model.md; the
 * document format it resolves to is in tools/bio-manager/bio-doc.js.
 */

import { getMetadata } from '../../scripts/ak.js';

/** Where a bare slug resolves. A token starting with `/` bypasses this. */
export const BIOS_PATH = '/en/fragments/bios';

/**
 * Cells that are a LABEL rather than a slug, so a single-column block can carry
 * a header row without "Speakers" being fetched as a person.
 */
const LABEL_CELLS = ['speakers', 'speaker', 'presenters', 'presenter', 'bios', 'bio', 'slugs'];

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Split one cell's text into tokens.
 *
 * Comma-separated is what an author writes and what `speakers` metadata carries.
 * The newline arm is for a cell whose text really does contain one — a
 * hand-written fixture, or a paste that survived as text — and NOT for a
 * multi-line cell in DA, which arrives as one `<p>` per line and therefore has no
 * newline in `textContent` at all. That shape is handled a row at a time by
 * `slugsFromBlock` instead.
 */
export function splitTokens(text) {
  return String(text || '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Read slugs out of the authored block: value cell when there is one, else the row. */
export function slugsFromBlock(block) {
  return [...(block?.children || [])].flatMap((row) => {
    const cells = [...row.children];
    if (!cells.length) return [];
    const source = cells.length > 1 ? cells[cells.length - 1] : cells[0];
    const label = cells[0].textContent.trim().toLowerCase();
    if (cells.length === 1 && LABEL_CELLS.includes(label)) return [];
    return splitTokens(source.textContent);
  });
}

/**
 * The roster this block should render: slugs authored in the block if there are
 * any, else the page's `speakers` metadata. Anything not slug- or path-shaped is
 * dropped, so `speakers: TBD` renders nothing rather than fetching `/TBD`.
 * @param {HTMLElement} block the authored block
 * @returns {string[]} tokens, in authored order
 */
export function rosterSlugs(block) {
  const authored = slugsFromBlock(block);
  const tokens = authored.length ? authored : splitTokens(getMetadata('speakers'));
  return tokens.filter((t) => t.startsWith('/') || SLUG_RE.test(t));
}

/** A bare slug resolves under BIOS_PATH; a path is used verbatim. */
export function toPath(token) {
  if (token.startsWith('/')) return token.replace(/\.plain\.html$/, '').replace(/\/$/, '');
  return `${BIOS_PATH}/${token}`;
}

/**
 * The pipeline rewrites a document's images to `./media_<hash>.jpg`, relative to
 * that document. Moving the markup onto a host page changes what "." means, so
 * every such URL has to be resolved against the bio's own path first — the same
 * job blocks/fragment does in `replaceDotMedia`. Without this every headshot
 * 404s against the host page's folder.
 */
export function resolveMediaUrls(root, docPath) {
  const base = new URL(`${docPath}.plain.html`, window.location.href);
  const resolve = (value) => value
    .split(',')
    .map((candidate) => {
      const [url, ...descriptors] = candidate.trim().split(/\s+/);
      if (!url.startsWith('./')) return candidate.trim();
      const abs = new URL(url, base);
      return [`${abs.pathname}${abs.search}`, ...descriptors].join(' ');
    })
    .join(', ');

  root.querySelectorAll('[src], [srcset]').forEach((el) => {
    ['src', 'srcset'].forEach((attr) => {
      const value = el.getAttribute(attr);
      if (value?.includes('./')) el.setAttribute(attr, resolve(value));
    });
  });
}

/** Fetch one bio document and hand back its `.bio` block, or null if absent. */
export async function fetchBioBlock(path) {
  try {
    const resp = await fetch(`${path}.plain.html`);
    if (!resp.ok) return null;
    const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
    const block = doc.querySelector('.bio');
    if (block) resolveMediaUrls(block, path);
    return block;
  } catch (e) {
    return null;
  }
}

/**
 * Resolve a whole roster, in authored order.
 *
 * `Promise.all` over the slugs rather than a loop: the fetches are independent and
 * a roster of six should cost one round trip, not six. The order comes from the
 * slug array and never from the order the fetches settle in.
 *
 * @param {string[]} slugs tokens from `rosterSlugs`
 * @returns {Promise<Array<{slug: string, source: HTMLElement|null}>>}
 */
export async function loadRoster(slugs) {
  const sources = await Promise.all(slugs.map((slug) => fetchBioBlock(toPath(slug))));
  return slugs.map((slug, i) => ({ slug, source: sources[i] }));
}

/**
 * A slug with no document renders a visible placeholder rather than vanishing —
 * the orphan rule from content-model.md. That is deliberate: a silently missing
 * speaker is the failure nobody notices before publish.
 *
 * `tag` / `nameTag` default to the row shape so `speakers` gets byte-identical
 * markup; the brick roster asks for `li` and `h3` so its placeholder is a list
 * item and a heading like every real brick beside it.
 *
 * @param {string} token the slug that did not resolve
 * @param {string} [extraClass] layout classes the host block wants on the row
 * @param {{tag?: string, nameTag?: string}} [opts] element names to build with
 * @returns {HTMLElement}
 */
export function missingBio(token, extraClass = '', { tag = 'div', nameTag = 'p' } = {}) {
  const row = document.createElement(tag);
  row.className = ['bio', extraClass].filter(Boolean).join(' ');
  row.innerHTML = `
    <div class="bio-photo bio-photo-initials" aria-hidden="true">?</div>
    <div class="bio-copy">
      <${nameTag} class="bio-name"></${nameTag}>
      <p class="bio-role">No bio yet</p>
      <div class="bio-body"><p>Add this bio in the Bio Manager and it appears here.</p></div>
    </div>
  `;
  row.querySelector('.bio-name').textContent = token;
  return row;
}
