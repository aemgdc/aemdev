/* --------------------------------------------------------------------------
 * Icon Picker — configuration (single source of truth)
 *
 * The icon library is DA CONTENT: the SVGs live in /icons/ and a manifest sheet
 * at docs/library/icons.json names them. Both sit on the SAME site the editor is
 * open on, so the palette renders every icon same-origin — no cross-site fetch,
 * no CORS.
 *
 * Authors insert an icon as the EDS token `:key:`, which publishes as
 * <span class="icon icon-key"> and is picked up by scripts/utils/icons.js.
 * ------------------------------------------------------------------------ */

import DA_SDK from 'https://da.live/nx/utils/sdk.js';

export const ADMIN_SOURCE = 'https://admin.da.live/source';
export const ADMIN_LIST = 'https://admin.da.live/list';
export const ADMIN_AEM = 'https://admin.hlx.page';

// The SDK hands us the IMS token plus the org/site of the editor context, so the
// tool always reads and writes the library belonging to the current site.
export const {
  context, token, actions,
} = await DA_SDK;
export const ORG = context?.org;
export const REPO = context?.repo;

// Content is shared across code branches; preview/publish always target `main`.
export const CONTENT_REF = 'main';

// Icon library location (content paths, no host).
export const ICONS_DIR = 'icons';
export const SHEET_PATH = 'docs/library/icons.json';

// Preview is always pushed. Going live as well keeps icons rendering on
// *.aem.live as well as *.aem.page; flip to false for a preview-only site.
export const PUBLISH_LIVE = true;

// Image types the library accepts. SVG is the norm; raster is tolerated so a
// legacy asset already sitting in the folder still lists.
export const IMAGE_TYPES = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// An absolute content.da.live reference, which is what the DA Library palette
// renders as an <img src>. It MUST be absolute: a root-relative path would
// resolve against da.live (→ https://da.live/{org}/… , a 404), so we pin the
// content host and let the editor's live IMS session authenticate the fetch.
export function iconRef(file) {
  return `https://content.da.live/${ORG}/${REPO}/${ICONS_DIR}/${file}`;
}

// The preview origin serves the previewed SVG without an auth header, which is
// what the tool's own grid uses — content.da.live would need the IMS session.
export function previewSrc(file) {
  return `https://${CONTENT_REF}--${REPO}--${ORG}.aem.page/${ICONS_DIR}/${file}`;
}

// What gets inserted into the document when an icon is picked.
export function iconToken(key) {
  return `:${key}:`;
}

// Slug-safe key check: letters, digits, hyphens. Mixed case is allowed so any
// existing key survives, but no spaces, slashes or dots.
export function isValidKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(key);
}

// Derive a default key + sanitized filename from an uploaded file name.
export function deriveNames(fileName) {
  const dot = fileName.lastIndexOf('.');
  const base = (dot > 0 ? fileName.slice(0, dot) : fileName)
    .trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const ext = (dot > 0 ? fileName.slice(dot + 1) : 'svg').toLowerCase();
  return { key: base, file: `${base}.${ext}`, ext };
}
