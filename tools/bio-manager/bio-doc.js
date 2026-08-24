/**
 * The bio document format, in exactly one place.
 *
 * Imported by the browser app (tools/bio-manager/bio-manager.js) and by the
 * seed script (tools/da/push-bios.js), so a hand-seeded bio and an
 * author-created bio are byte-identical in shape. Pure string building — no
 * DOM, no fetch — so it runs unchanged in Node.
 *
 * The rendered shape is documented in blocks/bio/bio.js; the `speakers`
 * metadata contract it satisfies is in docs/adaptto-2026/content-model.md.
 *
 * NOTE: deliberately no `robots: noindex` here. The Helix indexer honours it and
 * refuses the document — `POST /index/...` answers "requested path has 'noindex'
 * property set" — so a noindex bio would never reach the aemdev-bios index. Search
 * engines are kept off /en/fragments/ by robots.txt instead, which is the right
 * layer for a path-wide rule and covers every fragment rather than just bios.
 * Bios are already absent from the sitemap, which is generated from
 * /en/query-index.json and excludes /en/fragments/**.
 */

/** Every site-specific path the Bio Manager touches. */
export const BIO_PATHS = {
  // Roster sheet. Root-level and never previewed, so it stays out of
  // /en/query-index.json and off the public site.
  sheet: '/bios',
  // Bio documents. `speakers` metadata resolves slugs against this.
  fragments: '/en/fragments/bios',
  // Headshots, following DA's documented "media folder" pattern.
  media: '/media/bios',
  // Created on demand; DA has no mkdir -p.
  folders: ['/en', '/en/fragments', '/en/fragments/bios', '/media', '/media/bios'],
};

/** Sheet column headers. Human-facing, so they are words, not keys. */
export const BIO_COLUMNS = {
  slug: 'Slug',
  name: 'Name',
  title: 'Title',
  company: 'Company',
  linkedin: 'LinkedIn',
  image: 'Image',
  path: 'Path',
  status: 'Status',
  updated: 'Updated',
};

export const BIO_STATUSES = ['placeholder', 'approved'];

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function slugify(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function roleLine(bio) {
  return [bio.title, bio.company].filter(Boolean).join(' · ');
}

export function bioPath(slug) {
  return `${BIO_PATHS.fragments}/${slug}`;
}

/** Sheet row -> bio object. Tolerates a hand-edited sheet with missing cells. */
export function bioFromRow(row) {
  const c = BIO_COLUMNS;
  return {
    slug: row?.[c.slug] ?? '',
    name: row?.[c.name] ?? '',
    title: row?.[c.title] ?? '',
    company: row?.[c.company] ?? '',
    linkedin: row?.[c.linkedin] ?? '',
    image: row?.[c.image] ?? '',
    path: row?.[c.path] ?? '',
    status: row?.[c.status] || 'placeholder',
    updated: row?.[c.updated] ?? '',
  };
}

/** Bio object -> sheet row. */
export function rowFromBio(bio) {
  const c = BIO_COLUMNS;
  return {
    [c.slug]: bio.slug,
    [c.name]: bio.name,
    [c.title]: bio.title,
    [c.company]: bio.company,
    [c.linkedin]: bio.linkedin,
    [c.image]: bio.image,
    [c.path]: bio.path || bioPath(bio.slug),
    [c.status]: BIO_STATUSES.includes(bio.status) ? bio.status : 'placeholder',
    [c.updated]: bio.updated,
  };
}

/**
 * Build the DA sheet payload. `envelope` is what a previous read observed, so a
 * multi-sheet file keeps its other tabs instead of being flattened.
 */
export function buildSheetPayload(bios, envelope) {
  const data = bios.map(rowFromBio);
  const block = { total: data.length, limit: data.length, offset: 0, data };
  if (envelope?.kind === 'multi') {
    return {
      ...envelope.raw,
      [envelope.primary]: block,
      ':type': 'multi-sheet',
      ':names': envelope.names,
    };
  }
  return { ...block, ':type': 'sheet' };
}

function metaRow(key, value) {
  return `        <div><div>${escapeHtml(key)}</div><div>${escapeHtml(value)}</div></div>`;
}

/**
 * Build the bio document.
 *
 * A two-column key/value block, so a human can hand-edit it in DA without
 * knowing this app exists and reading it back is unambiguous. The trailing
 * `metadata` block is what feeds the bios query index; the Edge Delivery
 * pipeline strips it from both `.plain.html` and the rendered body, so a bio
 * pulled into a host page cannot overwrite that page's own metadata.
 *
 * @param {object} bio slug/name/title/company/linkedin/image/status/body
 * @returns {string} the full DA document
 */
export function buildBioDoc(bio) {
  const alt = escapeHtml(bio.name);
  const rows = [];
  if (bio.image) {
    const src = escapeHtml(bio.image);
    rows.push(`        <div><div>Photo</div><div><picture><img src="${src}" alt="${alt}" /></picture></div></div>`);
  }
  rows.push(`        <div><div>Name</div><div>${escapeHtml(bio.name)}</div></div>`);
  rows.push(`        <div><div>Title</div><div>${escapeHtml(bio.title)}</div></div>`);
  if (bio.company) {
    rows.push(`        <div><div>Company</div><div>${escapeHtml(bio.company)}</div></div>`);
  }
  if (bio.linkedin) {
    const href = escapeHtml(bio.linkedin);
    rows.push(`        <div><div>LinkedIn</div><div><a href="${href}">${href}</a></div></div>`);
  }
  rows.push(`        <div><div>Bio</div><div>${bio.body}</div></div>`);

  const metas = [
    metaRow('title', bio.name),
    metaRow('description', roleLine(bio) || bio.name),
    metaRow('bio-name', bio.name),
    metaRow('bio-title', bio.title),
    metaRow('bio-company', bio.company),
    metaRow('bio-linkedin', bio.linkedin),
    metaRow('bio-image', bio.image),
    metaRow('bio-status', BIO_STATUSES.includes(bio.status) ? bio.status : 'placeholder'),
  ];

  return `<body>
  <header></header>
  <main>
    <div>
      <div class="bio">
${rows.join('\n')}
      </div>
      <div class="metadata">
${metas.join('\n')}
      </div>
    </div>
  </main>
  <footer></footer>
</body>
`;
}
