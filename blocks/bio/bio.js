/**
 * Bio — one person as structured content, and a page's roster of them.
 *
 * ─── one person ─────────────────────────────────────────────────────────────
 *
 * This is the payload the Bio Manager writes to `/en/fragments/bios/<slug>`,
 * so the authored shape is a two-column key/value table that a human can also
 * edit by hand in DA without knowing the tool exists:
 *
 *   | Bio      |                                  |
 *   | -------- | -------------------------------- |
 *   | Photo    | [image]                          |
 *   | Name     | Eric Van Geem                    |
 *   | Title    | Director, Technology              |
 *   | Company  | Huge                             |
 *   | LinkedIn | https://www.linkedin.com/in/…    |
 *   | Bio      | rich text, one or more paragraphs |
 *
 * Rows may appear in any order. Only Name is required; an unknown key is
 * ignored rather than rendered, and a missing photo falls back to initials so
 * a half-finished bio still looks deliberate.
 *
 * ─── a page's roster ────────────────────────────────────────────────────────
 *
 * A `bio` block with NO recognized field at all is not a broken bio, it is a
 * request for this page's bios. It renders the roster as bricks — one per
 * speaker, laid across the content column, stacking on narrow viewports:
 *
 *   | Bio |          →  the page's `speakers` metadata, as bricks
 *
 *   | Bio                      |
 *   | ------------------------ |
 *   | tad-reeves               |   →  those slugs, as bricks
 *   | greg-dimeris             |
 *
 * A row whose key IS a recognized field (`Title`, `Photo`, …) is an incomplete
 * bio and is left alone rather than silently reinterpreted as a roster — an
 * author mid-edit gets their draft back, not somebody else's speakers.
 *
 * `blocks/bios` is the same renderer under an unambiguous name, and
 * `blocks/speakers` renders the same roster as full-width rows on a carbon
 * panel. All three share `parseBio` / `buildBio` and `./roster.js`, so a bio
 * looks like itself wherever it lands.
 */

import { loadRoster, missingBio, rosterSlugs } from './roster.js';

const LABELS = ['photo', 'image', 'name', 'title', 'role', 'company', 'linkedin', 'link', 'bio'];

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function firstUrl(cell) {
  if (!cell) return '';
  const anchor = cell.querySelector('a[href]');
  if (anchor) return anchor.getAttribute('href');
  const text = cell.textContent.trim();
  return /^https?:\/\//.test(text) ? text : '';
}

/**
 * Read a key/value bio block into plain values.
 * @param {HTMLElement} block the `.bio` element
 * @returns {{name: string, title: string, company: string, link: string,
 *            picture: HTMLElement|null, body: HTMLElement|null}}
 */
export function parseBio(block) {
  const fields = {};
  [...(block?.children || [])].forEach((row) => {
    const [keyCell, valueCell] = row.children;
    if (!keyCell) return;
    const key = keyCell.textContent.trim().toLowerCase();
    if (!LABELS.includes(key)) return;
    fields[key] = valueCell || null;
  });

  const text = (cell) => (cell?.textContent || '').trim();
  return {
    name: text(fields.name),
    title: text(fields.title) || text(fields.role),
    company: text(fields.company),
    link: firstUrl(fields.linkedin || fields.link),
    picture: (fields.photo || fields.image)?.querySelector('picture, img') || null,
    body: fields.bio || null,
  };
}

/**
 * Does this block carry any recognized bio field?
 *
 * The question a roster fallback turns on, and it is NOT `parseBio(block).name`.
 * A block with a `Title` row and no `Name` is a bio somebody is still writing;
 * a block with no recognized key at all — the empty one an author drops under a
 * "Speakers" heading — is a roster. Conflating the two would replace a draft bio
 * with the page's speakers, which is the one failure an author cannot undo by
 * reloading.
 *
 * @param {HTMLElement} block the `.bio` element
 * @returns {boolean}
 */
export function hasBioFields(block) {
  return [...(block?.children || [])].some((row) => {
    const cells = [...row.children];
    if (cells.length < 2) return false;
    return LABELS.includes(cells[0].textContent.trim().toLowerCase());
  });
}

/**
 * Build the rendered bio. Returns a fragment so the caller decides where it
 * lands — the standalone block replaces itself with it, `speakers` appends it
 * as one row of a roster, `renderBricks` as the inside of one brick.
 *
 * `nameTag` defaults to `p`, which keeps the single-bio and `speakers` row paths
 * byte-identical. A roster of PEOPLE is a different thing from one bio on a page:
 * the brick grid passes `h3` so each person is reachable by heading, which is one
 * of the two ways a screen-reader user moves through a page. `.bio-name` already
 * sets margin, colour, line-height and letter-spacing, so it overrides every
 * property the global `h1..h6` rule contributes — the tag change is a visual
 * no-op, verified in the browser.
 *
 * @param {object} bio the shape returned by `parseBio`
 * @param {{nameTag?: string}} [opts] element name for the name line
 * @returns {DocumentFragment}
 */
export function buildBio(bio, { nameTag = 'p' } = {}) {
  const out = document.createDocumentFragment();

  const photo = document.createElement('div');
  photo.className = 'bio-photo';
  if (bio.picture) {
    photo.append(bio.picture);
    const img = photo.querySelector('img');
    if (img) {
      if (!img.getAttribute('alt')) img.setAttribute('alt', bio.name || '');
      if (!img.getAttribute('loading')) img.setAttribute('loading', 'lazy');
    }
  } else {
    photo.classList.add('bio-photo-initials');
    photo.setAttribute('aria-hidden', 'true');
    photo.textContent = initials(bio.name);
  }

  const copy = document.createElement('div');
  copy.className = 'bio-copy';

  const name = document.createElement(nameTag);
  name.className = 'bio-name';
  name.textContent = bio.name;
  copy.append(name);

  const roleText = [bio.title, bio.company].filter(Boolean).join(' · ');
  if (roleText) {
    const role = document.createElement('p');
    role.className = 'bio-role';
    role.textContent = roleText;
    copy.append(role);
  }

  if (bio.body && bio.body.textContent.trim()) {
    const body = document.createElement('div');
    body.className = 'bio-body';
    body.append(...bio.body.childNodes);
    copy.append(body);
  }

  if (bio.link) {
    // Rebuilt rather than moved: an authored anchor may already carry button
    // classes from the generic link decoration, and a bio link is not a button.
    const link = document.createElement('a');
    link.className = 'bio-link';
    link.href = bio.link;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'LinkedIn';
    // The accessible name of ten "LinkedIn" links on one page is ten identical
    // links. Whose profile it is lives in the label, not just the nearby text.
    if (bio.name) link.setAttribute('aria-label', `${bio.name} on LinkedIn`);
    copy.append(link);
  }

  out.append(photo, copy);
  return out;
}

/**
 * Render a page's roster as bricks and hand back the grid.
 *
 * Each brick is a `.bio` — the same anatomy `buildBio` produces for a row — so
 * the two layouts are one stylesheet and one set of `--bio-*` properties rather
 * than two renderers that drift. `.bio-brick` is what turns a row on its side.
 *
 * A `ul` of `li`, and `h3` per name: a roster of people has structure, and a
 * grid of divs holding paragraphs has none — no heading to jump to, no list to
 * enumerate, no announced boundary between one person and the next. `role="list"`
 * because `list-style: none` is enough for Safari to drop the list role.
 * Every other card collection in this repo (article-feed, insights, mtb-card,
 * dam-display) already builds real headings or a real list.
 *
 * @param {HTMLElement} block the host block, authored or empty
 * @returns {Promise<HTMLElement|null>} the grid, or null when there is no roster
 */
export async function renderBricks(block) {
  const slugs = rosterSlugs(block);
  if (!slugs.length) return null;

  const grid = document.createElement('ul');
  grid.className = 'bio-bricks';
  grid.setAttribute('role', 'list');

  const asBrick = { tag: 'li', nameTag: 'h3' };

  (await loadRoster(slugs)).forEach(({ slug, source }) => {
    const bio = source ? parseBio(source) : null;
    if (!bio?.name) {
      grid.append(missingBio(slug, 'bio-brick bio-missing', asBrick));
      return;
    }
    const brick = document.createElement(asBrick.tag);
    brick.className = 'bio bio-brick';
    brick.append(buildBio(bio, { nameTag: asBrick.nameTag }));
    grid.append(brick);
  });

  return grid;
}

export default async function decorate(block) {
  const bio = parseBio(block);
  if (bio.name) {
    block.replaceChildren(buildBio(bio));
    block.classList.add('bio-decorated');
    return;
  }

  // Authored but incomplete: leave the draft alone.
  if (hasBioFields(block)) return;

  const grid = await renderBricks(block);
  if (!grid) {
    block.remove();
    return;
  }
  // `bio-roster` neutralises the single-bio row layout on the host element; the
  // grid inside it does the laying out from here.
  block.classList.add('bio-roster');
  block.replaceChildren(grid);
}
