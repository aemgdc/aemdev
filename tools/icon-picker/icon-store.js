/* --------------------------------------------------------------------------
 * Icon Picker — data layer
 *
 * One site, two artefacts that must agree: the SVG files in /icons/ and the
 * manifest sheet docs/library/icons.json that names them. Everything here keeps
 * those two in step — a write that cannot finish is rolled back rather than
 * left half-applied, so an icon is either fully in the library or not in it.
 * ------------------------------------------------------------------------ */

import {
  ADMIN_SOURCE, ADMIN_LIST, ADMIN_AEM, ORG, REPO, CONTENT_REF, ICONS_DIR,
  SHEET_PATH, PUBLISH_LIVE, IMAGE_TYPES, iconRef, token,
} from './icon-config.js';

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

export function isAuthError(status) {
  return status === 401 || status === 403;
}

function contentTypeFor(file) {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_TYPES[ext] || 'application/octet-stream';
}

function fileFromRef(ref) {
  const m = String(ref).match(/([^/]+\.\w+)$/);
  return m ? m[1] : '';
}

/* ---- low-level DA source I/O ---- */

async function getSource(path) {
  const url = `${ADMIN_SOURCE}/${ORG}/${REPO}/${path}`;
  const resp = await fetch(url, { headers: authHeaders() });
  if (isAuthError(resp.status)) throw new Error(`Not authorized to read ${path} — refresh your DA session.`);
  return resp;
}

async function putSource(path, blob, fileName) {
  const url = `${ADMIN_SOURCE}/${ORG}/${REPO}/${path}`;
  const body = new FormData();
  body.append('data', blob, fileName);
  const resp = await fetch(url, { method: 'POST', headers: authHeaders(), body });
  if (isAuthError(resp.status)) throw new Error(`Not authorized to write ${path} — refresh your DA session.`);
  if (!resp.ok) throw new Error(`Failed to write ${path} (${resp.status}).`);
  return true;
}

async function deleteSource(path) {
  const url = `${ADMIN_SOURCE}/${ORG}/${REPO}/${path}`;
  const resp = await fetch(url, { method: 'DELETE', headers: authHeaders() });
  if (!resp.ok && resp.status !== 404) throw new Error(`Failed to delete ${path} (${resp.status}).`);
  return true;
}

// admin.hlx.page accepts preview/live on BOTH the manifest sheet and a raw .svg.
// Both need it: the sheet so the palette lists the icon, and the SVG so a
// published page — which fetches it from the aem.page/aem.live origin, not from
// the DA content origin — renders the icon instead of a dead image.
async function aemAction(action, path) {
  const url = `${ADMIN_AEM}/${action}/${ORG}/${REPO}/${CONTENT_REF}/${path}`;
  const resp = await fetch(url, { method: 'POST', headers: authHeaders() });
  if (!resp.ok) throw new Error(`${action} failed for ${path} (${resp.status}).`);
  return true;
}

// Best-effort removal from a tier; only used while rolling back, so a 404 is fine.
async function aemUnpublish(action, path) {
  const url = `${ADMIN_AEM}/${action}/${ORG}/${REPO}/${CONTENT_REF}/${path}`;
  const resp = await fetch(url, { method: 'DELETE', headers: authHeaders() });
  if (!resp.ok && resp.status !== 404) throw new Error(`un-${action} failed for ${path} (${resp.status}).`);
  return true;
}

async function publishPath(path) {
  await aemAction('preview', path);
  if (PUBLISH_LIVE) await aemAction('live', path);
}

/* ---- manifest sheet ---- */

function buildSheet(rows) {
  const len = rows.length;
  return JSON.stringify({
    total: len,
    limit: len,
    offset: 0,
    data: rows,
    ':colWidths': [175, 633],
    ':sheetname': 'data',
    ':type': 'sheet',
  });
}

export async function fetchManifestRows() {
  const resp = await getSource(SHEET_PATH);
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`Failed to read the icon manifest (${resp.status}).`);
  const json = await resp.json();
  return Array.isArray(json?.data) ? json.data : [];
}

async function putManifest(rows) {
  const blob = new Blob([buildSheet(rows)], { type: 'application/json' });
  return putSource(SHEET_PATH, blob, 'icons.json');
}

/* ---- reading the library ---- */

/** The image files actually present in /icons/. */
export async function listFiles() {
  const url = `${ADMIN_LIST}/${ORG}/${REPO}/${ICONS_DIR}`;
  const resp = await fetch(url, { headers: authHeaders() });
  if (isAuthError(resp.status)) throw new Error('Not authorized to list the icons folder — refresh your DA session.');
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`Failed to list the icons folder (${resp.status}).`);
  const items = await resp.json();
  return items
    .filter((i) => i.ext && IMAGE_TYPES[String(i.ext).toLowerCase()])
    .map((i) => ({ name: i.name, ext: i.ext, file: `${i.name}.${i.ext}` }));
}

/**
 * The library as the picker shows it: the /icons/ folder is the source of truth
 * for what EXISTS, the manifest supplies the key each file is inserted under.
 * A file with no manifest row still lists (keyed by its filename) so a
 * hand-dropped icon is usable, and is flagged so it can be repaired.
 */
export async function loadLibrary() {
  const [files, rows] = await Promise.all([listFiles(), fetchManifestRows()]);
  const keyByFile = new Map();
  rows.forEach((r) => {
    const f = fileFromRef(r.icon);
    if (f && !keyByFile.has(f)) keyByFile.set(f, String(r.key));
  });

  const icons = files.map((f) => ({
    key: keyByFile.get(f.file) || f.name,
    file: f.file,
    listed: keyByFile.has(f.file),
  })).sort((a, b) => a.key.localeCompare(b.key));

  // Manifest rows whose file has gone missing from the folder.
  const present = new Set(files.map((f) => f.file));
  const dangling = rows
    .filter((r) => !present.has(fileFromRef(r.icon)))
    .map((r) => String(r.key));

  return { icons, rows, dangling };
}

/** Undo the writes of a failed addIcon run, newest first. Best effort: the
 *  caller still sees the original failure, not whatever goes wrong in here. */
async function rollback(undo) {
  for (const step of undo.reverse()) {
    try {
      if (step.kind === 'manifest') {
        await putManifest(step.priorRows);
        await publishPath(SHEET_PATH);
      } else if (step.kind === 'file' && !step.existedBefore) {
        // Only remove a file this run created; never one that pre-existed.
        const svgPath = `${ICONS_DIR}/${step.file}`;
        await aemUnpublish('preview', svgPath);
        if (PUBLISH_LIVE) await aemUnpublish('live', svgPath);
        await deleteSource(svgPath);
      }
    } catch (e) { /* best effort — surface the original error instead */ }
  }
}

/* ---- writing ----
 *
 * Order matters: the file goes in first, then the manifest row that points at
 * it, then both are previewed/published. If any step throws, `rollback` undoes
 * the steps already taken this run and the original error surfaces.
 */
export async function addIcon({
  key, file, bytes, overwrite,
}) {
  const svgPath = `${ICONS_DIR}/${file}`;
  const blob = new Blob([bytes], { type: contentTypeFor(file) });
  const undo = [];

  try {
    const priorRows = await fetchManifestRows();
    const hadKey = priorRows.some((r) => String(r.key) === key);
    const hadFile = (await listFiles()).some((f) => f.file === file);
    if ((hadKey || hadFile) && !overwrite) {
      throw new Error(`"${key}" (or ${file}) is already in the library.`);
    }

    await putSource(svgPath, blob, file);
    undo.push({ kind: 'file', file, existedBefore: hadFile });

    const nextRows = priorRows.filter((r) => String(r.key) !== key);
    nextRows.push({ key, icon: iconRef(file) });
    await putManifest(nextRows);
    undo.push({ kind: 'manifest', priorRows });

    await publishPath(svgPath);
    await publishPath(SHEET_PATH);
    return { ok: true, key, file };
  } catch (err) {
    await rollback(undo);
    throw err;
  }
}

/** Remove an icon: drop its manifest row, then its file. */
export async function deleteIcon({ key, file }) {
  const svgPath = `${ICONS_DIR}/${file}`;
  const rows = await fetchManifestRows();
  await putManifest(rows.filter((r) => String(r.key) !== key));
  await publishPath(SHEET_PATH);
  await aemUnpublish('preview', svgPath);
  if (PUBLISH_LIVE) await aemUnpublish('live', svgPath);
  await deleteSource(svgPath);
  return { ok: true, key };
}
