/**
 * Bio — one person as structured content.
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
 * `parseBio` / `buildBio` are also used by blocks/speakers, which renders
 * several of these from a page's `speakers` metadata.
 */

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
 * Build the rendered bio. Returns a fragment so the caller decides where it
 * lands — the standalone block replaces itself with it, `speakers` appends it
 * as one row of a roster.
 * @param {object} bio the shape returned by `parseBio`
 * @returns {DocumentFragment}
 */
export function buildBio(bio) {
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

  const name = document.createElement('p');
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
    copy.append(link);
  }

  out.append(photo, copy);
  return out;
}

export default function decorate(block) {
  const bio = parseBio(block);
  if (!bio.name) return;
  block.replaceChildren(buildBio(bio));
  block.classList.add('bio-decorated');
}
