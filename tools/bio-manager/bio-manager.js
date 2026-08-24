/*
 * Bio Manager — structured speaker/author bios for aemgdc/aemdev.
 *
 * Runs in two DA surfaces from one codebase:
 *   - fullscreen app    https://da.live/app/aemgdc/aemdev/tools/bio-manager
 *   - library plugin    registered in tools/sidekick/config.json
 * In plugin mode the roster grows an "Insert" action that drops a fragment
 * reference into the open document; `linkBlocks` in scripts/scripts.js
 * auto-blocks any href containing `/fragments/`, so a plain anchor is enough.
 *
 * Provenance: forked from arbory-da @ origin/bio-list. Deliberately NOT kept
 * in sync — headshots live in DA here (not AEM Assets), the schema carries
 * title/company/linkedin/status, and every site-specific path is in CONFIG.
 */

/* The roster and the editor call each other by design — renderRoster builds
   cards that open the editor, and a successful save re-renders the roster — so
   a strict definition-before-use order is not achievable in one module. */
/* eslint-disable no-use-before-define */

import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  BIO_PATHS,
  bioFromRow,
  buildBioDoc,
  buildSheetPayload,
  escapeHtml,
  roleLine,
  slugify,
} from './bio-doc.js';

/* ---------------------------------------------------------------- config */

/* Every path and the document format itself live in bio-doc.js, which the
   seed script imports too — so a hand-seeded bio and an author-created one
   cannot drift apart. */
const CONFIG = BIO_PATHS;

const DA_SOURCE = 'https://admin.da.live/source';
const DA_CONTENT = 'https://content.da.live';
const DA_EDIT = 'https://da.live/edit#';
const DA_SHEET_UI = 'https://da.live/sheet#';
const AEM_ADMIN = 'https://admin.hlx.page';
const BRANCH = 'main';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

// Tags the bio body is allowed to carry into the fragment. Anything else is
// unwrapped, so a paste from LinkedIn or Word cannot smuggle markup into a
// published document.
const ALLOWED_TAGS = ['P', 'BR', 'STRONG', 'B', 'EM', 'I', 'U', 'A', 'UL', 'OL', 'LI'];

const STATUSES = [
  { value: 'placeholder', label: 'Placeholder — needs review' },
  { value: 'approved', label: 'Approved by the person' },
];

/* ----------------------------------------------------------------- state */

const state = {
  org: '',
  site: '',
  token: '',
  actions: null,
  isPlugin: false,
  tab: 'roster',
  rows: [],
  envelope: null,
  search: '',
  editingSlug: null,
  photo: null,
  saving: false,
};

const els = {};

/* --------------------------------------------------------------- helpers */

function authHeaders() {
  return { Authorization: `Bearer ${state.token}` };
}

function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function sourceUrl(path) {
  return `${DA_SOURCE}/${state.org}/${state.site}${path}`;
}

function editUrl(path) {
  return `${DA_EDIT}/${state.org}/${state.site}${path}`;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/**
 * content.da.live requires auth — an unauthenticated GET is a 401 — and this
 * app runs on aem.live, a different origin, so a plain <img src> can never
 * load a headshot. Pull the bytes through the Source API with the token we
 * already hold and hand back a blob URL. Cached: the roster re-renders on
 * every keystroke in the search box.
 *
 * (`actions.daFetch` from the SDK would also work, but it is an undocumented
 * member of a hosted dependency — see R5 — and this is three lines.)
 */
const imageCache = new Map();

async function displayableImage(url) {
  if (!url || !url.startsWith(DA_CONTENT)) return url;
  if (imageCache.has(url)) return imageCache.get(url);
  const prefix = `${DA_CONTENT}/${state.org}/${state.site}`;
  if (!url.startsWith(prefix)) return url;
  const resp = await fetch(sourceUrl(url.slice(prefix.length)), { headers: authHeaders() });
  if (!resp.ok) throw new Error(`Headshot fetch failed (${resp.status})`);
  const objectUrl = URL.createObjectURL(await resp.blob());
  imageCache.set(url, objectUrl);
  return objectUrl;
}

/* --------------------------------------------------------------- banner */

function hideBanner() {
  els.banner.className = 'bm-banner';
  els.banner.replaceChildren();
}

/**
 * @param {'success'|'warning'|'error'} type
 * @param {string} message
 * @param {Array<{label: string, handler: Function}>} [actions]
 */
function showBanner(type, message, actions) {
  els.banner.className = `bm-banner is-visible is-${type}`;
  const text = document.createElement('div');
  text.className = 'bm-banner-text';
  text.textContent = message;
  els.banner.replaceChildren(text);
  if (actions?.length) {
    const wrap = document.createElement('div');
    wrap.className = 'bm-banner-actions';
    actions.forEach((action) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bm-banner-action';
      btn.textContent = action.label;
      btn.addEventListener('click', action.handler);
      wrap.append(btn);
    });
    els.banner.append(wrap);
  }
  els.banner.scrollIntoView({ block: 'nearest' });
}

/* ---------------------------------------------------------------- DA I/O */

async function ensureFolders() {
  for (let i = 0; i < CONFIG.folders.length; i += 1) {
    const resp = await fetch(sourceUrl(CONFIG.folders[i]), {
      method: 'POST',
      headers: authHeaders(),
    });
    // 409/400 mean "already there", which is the normal case after the first run.
    if (!resp.ok && ![400, 409].includes(resp.status)) {
      throw new Error(`Could not create ${CONFIG.folders[i]} in DA (${resp.status}).`);
    }
  }
}

async function fetchSheet() {
  const resp = await fetch(`${sourceUrl(CONFIG.sheet)}.json`, { headers: authHeaders() });
  if (resp.status === 404) {
    state.envelope = { kind: 'single' };
    return [];
  }
  if (!resp.ok) throw new Error(`Could not read the bios sheet (${resp.status}).`);
  const json = await resp.json();

  if (Array.isArray(json?.data)) {
    state.envelope = { kind: 'single' };
    return json.data.map(bioFromRow);
  }
  if (Array.isArray(json?.[':names'])) {
    const names = json[':names'];
    const primary = names.includes('data') ? 'data' : names[0];
    state.envelope = { kind: 'multi', names, primary, raw: json };
    const rows = Array.isArray(json[primary]?.data) ? json[primary].data : [];
    return rows.map(bioFromRow);
  }
  state.envelope = { kind: 'single' };
  return [];
}

async function saveSheet(bios) {
  const payload = buildSheetPayload(bios, state.envelope);
  const body = new FormData();
  body.append('data', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  const resp = await fetch(`${sourceUrl(CONFIG.sheet)}.json`, {
    method: 'POST',
    headers: authHeaders(),
    body,
  });
  if (!resp.ok) throw new Error(`Could not save the bios sheet (${resp.status}).`);
}

async function uploadPhoto(file, slug) {
  const ext = IMAGE_EXT[file.type];
  if (!ext) throw new Error('Headshots must be JPG, PNG, GIF or SVG.');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Headshot must be under 8 MB.');
  const path = `${CONFIG.media}/${slug}.${ext}`;
  const body = new FormData();
  body.append('data', file);
  const resp = await fetch(sourceUrl(path), { method: 'POST', headers: authHeaders(), body });
  if (!resp.ok) throw new Error(`Headshot upload failed (${resp.status}).`);
  const json = await resp.json().catch(() => null);
  // DA returns the content-bus URL; that is exactly what DA itself writes into
  // documents, and the Edge Delivery pipeline rewrites it on preview.
  const url = json?.source?.contentUrl;
  if (!url) throw new Error('DA did not return a URL for the uploaded headshot.');
  return { url, path };
}

/**
 * Ask the AEM admin API to act on a path. Uses the same IMS token DA itself
 * uses for admin.hlx.page. Non-fatal by design: a saved-but-unpublished bio is
 * recoverable, a failed save is not.
 *
 * NOTE the method matters. `POST /live/` publishes; unpublishing is
 * `DELETE /live/`. Getting that backwards leaves a deleted bio still public.
 */
async function aemAction(action, path, method = 'POST') {
  const url = `${AEM_ADMIN}/${action}/${state.org}/${state.site}/${BRANCH}${path}`;
  try {
    const resp = await fetch(url, { method, headers: authHeaders() });
    if (resp.ok || resp.status === 204) return { ok: true };
    return { ok: false, status: resp.status, detail: resp.headers.get('x-error') || '' };
  } catch (e) {
    return { ok: false, status: 0, detail: e.message };
  }
}

/* ----------------------------------------------------- fragment (DA doc) */

function sanitiseBodyHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;

  // Unwrap anything not on the allowlist, and strip every attribute except
  // href on anchors. Deepest-first so nested junk collapses cleanly.
  const walk = (node) => {
    [...node.children].forEach(walk);
    if (node === root) return;
    if (!ALLOWED_TAGS.includes(node.tagName)) {
      node.replaceWith(...node.childNodes);
      return;
    }
    [...node.attributes].forEach((attr) => {
      const keep = node.tagName === 'A' && attr.name === 'href' && isHttpUrl(attr.value);
      if (!keep) node.removeAttribute(attr.name);
    });
    if (node.tagName === 'A') node.setAttribute('href', node.getAttribute('href') || '#');
  };
  walk(root);

  // Loose text nodes become paragraphs so the fragment is always block-level.
  [...root.childNodes].forEach((node) => {
    if (node.nodeType !== Node.TEXT_NODE) return;
    if (!node.textContent.trim()) {
      node.remove();
      return;
    }
    const p = doc.createElement('p');
    p.textContent = node.textContent.trim();
    node.replaceWith(p);
  });

  [...root.querySelectorAll('p, li')].forEach((el) => {
    if (!el.textContent.trim() && !el.querySelector('br')) el.remove();
  });

  return root.innerHTML.trim();
}

async function saveFragment(slug, html) {
  const body = new FormData();
  body.append('data', new Blob([html], { type: 'text/html' }));
  const resp = await fetch(`${sourceUrl(`${CONFIG.fragments}/${slug}`)}.html`, {
    method: 'POST',
    headers: authHeaders(),
    body,
  });
  if (!resp.ok) throw new Error(`Could not save the bio document (${resp.status}).`);
}

async function fragmentExists(slug) {
  const resp = await fetch(`${sourceUrl(`${CONFIG.fragments}/${slug}`)}.html`, {
    headers: authHeaders(),
  });
  if (resp.status === 404) return false;
  if (resp.ok) return true;
  throw new Error(`Could not check ${CONFIG.fragments}/${slug} (${resp.status}).`);
}

async function resolveFreeSlug(base) {
  let candidate = base;
  let n = 2;
  while (await fragmentExists(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
    if (n > 50) throw new Error('Could not find a free slug for that name.');
  }
  return candidate;
}

/** Read a bio document back into the editor's shape. */
async function fetchBio(slug) {
  const resp = await fetch(`${sourceUrl(`${CONFIG.fragments}/${slug}`)}.html`, {
    headers: authHeaders(),
  });
  if (!resp.ok) throw new Error(`Could not open ${CONFIG.fragments}/${slug} (${resp.status}).`);
  const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');

  const readKeyed = (root) => [...(root?.children || [])].reduce((acc, row) => {
    const [keyCell, valueCell] = row.children;
    const key = keyCell?.textContent.trim().toLowerCase();
    if (key) acc[key] = valueCell;
    return acc;
  }, {});

  const fields = readKeyed(doc.querySelector('.bio'));
  const metas = readKeyed(doc.querySelector('.metadata'));
  const text = (cell) => (cell?.textContent || '').trim();

  return {
    slug,
    name: text(fields.name) || text(metas['bio-name']),
    title: text(fields.title) || text(metas['bio-title']),
    company: text(fields.company) || text(metas['bio-company']),
    linkedin: fields.linkedin?.querySelector('a')?.getAttribute('href')
      || text(fields.linkedin) || text(metas['bio-linkedin']),
    image: fields.photo?.querySelector('img')?.getAttribute('src')
      || text(metas['bio-image']),
    status: text(metas['bio-status']) || 'placeholder',
    body: fields.bio?.innerHTML.trim() || '',
  };
}

/* ----------------------------------------------------------------- shell */

function buildShell() {
  const app = document.createElement('div');
  app.className = 'bm-app';
  app.innerHTML = `
    <div class="bm-head">
      <p class="bm-eyebrow">AEM Global Developer Collective</p>
      <h1 class="bm-title">Bio Manager</h1>
      <p class="bm-lede">
        Speaker and author bios as structured content. Each bio is a DA document
        under <code>${CONFIG.fragments}</code> — reference it on any page, or list
        a slug in a meetup's <code>speakers</code> metadata and it renders itself.
      </p>
    </div>
    <div class="bm-tabs" role="tablist">
      <button type="button" class="bm-tab is-active" data-tab="roster" role="tab">
        Roster<span class="bm-tab-count" data-roster-count></span>
      </button>
      <button type="button" class="bm-tab" data-tab="editor" role="tab" data-editor-tab>
        New bio
      </button>
    </div>
    <div class="bm-banner" role="status" aria-live="polite"></div>
    <section class="bm-panel is-active" data-panel="roster"></section>
    <section class="bm-panel" data-panel="editor"></section>
  `;
  document.body.replaceChildren(app);

  els.app = app;
  els.banner = app.querySelector('.bm-banner');
  els.tabs = [...app.querySelectorAll('.bm-tab')];
  els.editorTab = app.querySelector('[data-editor-tab]');
  els.rosterCount = app.querySelector('[data-roster-count]');
  els.rosterPanel = app.querySelector('[data-panel="roster"]');
  els.editorPanel = app.querySelector('[data-panel="editor"]');

  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.dataset.tab === 'editor' && state.tab !== 'editor') openEditor(null);
      else setTab(tab.dataset.tab);
    });
  });
}

function setTab(tab) {
  state.tab = tab;
  els.tabs.forEach((t) => t.classList.toggle('is-active', t.dataset.tab === tab));
  els.rosterPanel.classList.toggle('is-active', tab === 'roster');
  els.editorPanel.classList.toggle('is-active', tab === 'editor');
  window.scrollTo({ top: 0 });
}

function showFatal(message, detail) {
  const box = document.createElement('div');
  box.className = 'bm-fatal';
  box.innerHTML = `
    <h1>Bio Manager can't start</h1>
    <p>${escapeHtml(message)}</p>
    ${detail ? `<p><code>${escapeHtml(detail)}</code></p>` : ''}
    <p>Open it from inside DA — as an app at
      <code>da.live/apps</code>, or from the Library panel while editing a document.</p>
  `;
  document.body.replaceChildren(box);
}

/* ---------------------------------------------------------------- roster */

function filteredRows() {
  const q = state.search.trim().toLowerCase();
  const rows = q
    ? state.rows.filter((r) => [r.name, r.title, r.company, r.slug]
      .some((v) => String(v).toLowerCase().includes(q)))
    : [...state.rows];
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function avatarEl(bio) {
  // Initials render immediately; the headshot replaces them once its
  // authenticated fetch lands, so a slow or failed image never blocks or
  // breaks the roster.
  const holder = avatarFallback(bio);
  if (!bio.image) return holder;
  displayableImage(bio.image).then((src) => {
    if (!src || !holder.isConnected) return;
    const img = document.createElement('img');
    img.className = 'bm-avatar';
    img.src = src;
    img.alt = '';
    holder.replaceWith(img);
  }).catch(() => { /* keep the initials */ });
  return holder;
}

function avatarFallback(bio) {
  const div = document.createElement('div');
  div.className = 'bm-avatar bm-avatar--empty';
  div.setAttribute('aria-hidden', 'true');
  div.textContent = initials(bio.name);
  return div;
}

function insertBio(bio) {
  const href = `${CONFIG.fragments}/${bio.slug}`;
  state.actions.sendHTML(`<p><a href="${href}">${escapeHtml(bio.name)}</a></p>`);
  if (typeof state.actions.closeLibrary === 'function') state.actions.closeLibrary();
}

function bioCard(bio) {
  const card = document.createElement('div');
  card.className = 'bm-card';

  const top = document.createElement('div');
  top.className = 'bm-card-top';
  const id = document.createElement('div');
  id.className = 'bm-card-id';
  id.innerHTML = `
    <h2 class="bm-card-name">${escapeHtml(bio.name)}</h2>
    <p class="bm-card-role">${escapeHtml(roleLine(bio)) || '&nbsp;'}</p>
    <p class="bm-card-slug">
      <span class="bm-chip bm-chip--${bio.status === 'approved' ? 'approved' : 'placeholder'}">
        ${escapeHtml(bio.status)}
      </span>
      ${escapeHtml(bio.slug)}
    </p>
  `;
  top.append(avatarEl(bio), id);

  const actions = document.createElement('div');
  actions.className = 'bm-card-actions';

  const add = (label, cls, handler) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `bm-btn bm-btn--sm ${cls}`;
    btn.textContent = label;
    btn.addEventListener('click', handler);
    actions.append(btn);
    return btn;
  };

  if (state.isPlugin) add('Insert', '', () => insertBio(bio));
  add('Edit', 'bm-btn--ghost', () => openEditor(bio.slug));
  add('Open in DA', 'bm-btn--ghost', () => {
    window.open(editUrl(`${CONFIG.fragments}/${bio.slug}`), '_blank', 'noopener');
  });
  add('Remove', 'bm-btn--danger', () => confirmRemove(bio));

  card.append(top, actions);
  return card;
}

function renderRoster() {
  const rows = filteredRows();
  els.rosterCount.textContent = state.rows.length ? ` (${state.rows.length})` : '';

  const panel = els.rosterPanel;
  panel.replaceChildren();

  const toolbar = document.createElement('div');
  toolbar.className = 'bm-toolbar';
  toolbar.innerHTML = `
    <div class="bm-search">
      <label class="bm-sr" for="bm-search">Search bios</label>
      <input id="bm-search" type="search" placeholder="Search name, title, company or slug…"
        autocomplete="off" />
    </div>
    <span class="bm-count" data-count></span>
  `;
  const search = toolbar.querySelector('input');
  search.value = state.search;
  search.addEventListener('input', () => {
    state.search = search.value;
    renderRoster();
    const next = els.rosterPanel.querySelector('#bm-search');
    if (!next) return;
    next.focus();
    next.setSelectionRange(next.value.length, next.value.length);
  });
  toolbar.querySelector('[data-count]').textContent = state.search.trim()
    ? `${rows.length} of ${state.rows.length}`
    : `${state.rows.length} ${state.rows.length === 1 ? 'bio' : 'bios'}`;

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'bm-btn';
  newBtn.textContent = 'New bio';
  newBtn.addEventListener('click', () => openEditor(null));
  toolbar.append(newBtn);
  panel.append(toolbar);

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'bm-empty';
    empty.innerHTML = state.rows.length
      ? '<strong>No matches</strong><p>Nothing in the roster matches that search.</p>'
      : `<strong>No bios yet</strong>
         <p>Create the first one and it lands at <code>${CONFIG.fragments}</code>.</p>`;
    panel.append(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'bm-grid';
  rows.forEach((bio) => grid.append(bioCard(bio)));
  panel.append(grid);

  const sheetLink = document.createElement('p');
  sheetLink.className = 'bm-hint';
  sheetLink.style.marginTop = '16px';
  sheetLink.innerHTML = `Roster data: <a href="${DA_SHEET_UI}/${state.org}/${state.site}${
    CONFIG.sheet}" target="_blank" rel="noopener"><code>${CONFIG.sheet}.json</code></a>`;
  panel.append(sheetLink);
}

async function loadRoster() {
  try {
    state.rows = await fetchSheet();
  } catch (e) {
    state.rows = [];
    showBanner('error', e.message, [{
      label: 'Retry',
      handler: () => {
        hideBanner();
        loadRoster();
      },
    }]);
  }
  renderRoster();
}

/* ---------------------------------------------------------------- editor */

function setFieldError(name, message) {
  const err = els.editorPanel.querySelector(`[data-error="${name}"]`);
  const field = els.editorPanel.querySelector(`[data-field="${name}"]`);
  if (err) {
    err.textContent = message || '';
    err.classList.toggle('is-visible', !!message);
  }
  if (field) field.classList.toggle('is-error', !!message);
}

function clearFieldErrors() {
  ['name', 'title', 'photo', 'body'].forEach((n) => setFieldError(n, ''));
}

function currentDraft() {
  return {
    name: els.name.value.trim(),
    title: els.title.value.trim(),
    company: els.company.value.trim(),
    linkedin: els.linkedin.value.trim(),
    status: els.status.value,
    // Two different URLs on purpose: `image` is what belongs in the document
    // (a content.da.live URL), `preview` is one the browser can actually load
    // — often a local blob. Rendering the stored URL in the preview panel is a
    // guaranteed 401.
    image: state.photo?.stored || state.photo?.url || '',
    preview: state.photo?.url || state.photo?.stored || '',
    // Sanitised here, not at save time, so the preview shows exactly what the
    // document will contain — including anything a paste just lost.
    body: sanitiseBodyHtml(els.body.innerHTML),
  };
}

function renderPreview() {
  const draft = currentDraft();
  const photo = draft.preview
    ? `<img class="bm-preview-photo" src="${escapeHtml(draft.preview)}" alt="" />`
    : '<div class="bm-preview-photo"></div>';
  const link = draft.linkedin
    ? `<a class="bm-preview-link" href="${escapeHtml(draft.linkedin)}"
         target="_blank" rel="noopener">LinkedIn &rarr;</a>`
    : '';
  els.preview.innerHTML = `
    <p class="bm-preview-label">Live preview</p>
    <div class="bm-preview-row">
      ${photo}
      <div class="bm-preview-copy">
        <p class="bm-preview-name">${escapeHtml(draft.name) || 'Name'}</p>
        <p class="bm-preview-role">${escapeHtml(roleLine(draft)) || 'Title · Company'}</p>
        <div class="bm-preview-bio">${draft.body || '<p>Bio copy appears here.</p>'}</div>
        ${link}
      </div>
    </div>
    <p class="bm-preview-note">
      ${escapeHtml(CONFIG.fragments)}/${escapeHtml(slugify(draft.name) || '…')}
    </p>
  `;
}

function setPhoto(photo) {
  state.photo = photo;
  const has = !!photo;
  els.photoThumb.className = has ? 'bm-photo-thumb' : 'bm-photo-thumb bm-photo-thumb--empty';
  if (has) els.photoThumb.src = photo.url;
  else els.photoThumb.removeAttribute('src');
  els.photoName.textContent = has ? (photo.name || 'Headshot selected') : 'No headshot yet';
  if (!has) els.photoPath.textContent = `Uploads to ${CONFIG.media}/`;
  else if (photo.file) els.photoPath.textContent = `Uploads to ${CONFIG.media}/ on save`;
  else els.photoPath.textContent = photo.path || 'Already in DA';
  els.photoClear.hidden = !has;
  if (has) setFieldError('photo', '');
  renderPreview();
}

function acceptPhotoFile(file) {
  if (!file) return;
  if (!IMAGE_EXT[file.type]) {
    setFieldError('photo', 'Headshots must be JPG, PNG, GIF or SVG.');
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    setFieldError('photo', 'Headshot must be under 8 MB.');
    return;
  }
  // Preview locally; the upload happens on save, once the slug is settled.
  setPhoto({
    url: URL.createObjectURL(file), stored: '', name: file.name, file, path: '',
  });
}

/**
 * Small in-app dialog. `window.prompt` is unreliable inside DA's iframe (a
 * sandbox without `allow-modals` swallows it and returns null), so ask here.
 */
function askForUrl(onConfirm) {
  const bg = document.createElement('div');
  bg.className = 'bm-modal-bg';
  bg.innerHTML = `
    <div class="bm-modal" role="dialog" aria-modal="true" aria-labelledby="bm-link-title">
      <h2 id="bm-link-title">Add a link</h2>
      <div class="bm-field">
        <label class="bm-label" for="bm-link-url">URL</label>
        <input id="bm-link-url" class="bm-input" type="url" placeholder="https://" />
      </div>
      <div class="bm-modal-actions">
        <button type="button" class="bm-btn bm-btn--ghost" data-cancel>Cancel</button>
        <button type="button" class="bm-btn" data-confirm>Add link</button>
      </div>
    </div>
  `;
  const input = bg.querySelector('input');
  const close = () => bg.remove();
  const confirm = () => {
    const url = input.value.trim();
    if (!isHttpUrl(url)) {
      input.classList.add('is-error');
      return;
    }
    close();
    onConfirm(url);
  };
  bg.addEventListener('click', (ev) => {
    if (ev.target === bg) close();
  });
  bg.querySelector('[data-cancel]').addEventListener('click', close);
  bg.querySelector('[data-confirm]').addEventListener('click', confirm);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') confirm();
    if (ev.key === 'Escape') close();
  });
  document.body.append(bg);
  input.focus();
}

function rteCommand(cmd) {
  els.body.focus();
  if (cmd === 'createLink') {
    // Selection is lost when focus moves to the dialog, so capture it first.
    const range = window.getSelection()?.rangeCount
      ? window.getSelection().getRangeAt(0).cloneRange()
      : null;
    askForUrl((url) => {
      els.body.focus();
      if (range) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      document.execCommand('createLink', false, url);
      renderPreview();
    });
    return;
  }
  document.execCommand(cmd, false, null);
}

function syncRteButtons() {
  els.rteBar.querySelectorAll('[data-cmd]').forEach((btn) => {
    const { cmd } = btn.dataset;
    if (cmd === 'createLink') return;
    let active = false;
    try {
      active = document.queryCommandState(cmd);
    } catch (e) {
      active = false;
    }
    btn.classList.toggle('is-active', active);
  });
}

function buildEditor(bio) {
  const isNew = !bio;
  const panel = els.editorPanel;
  panel.innerHTML = `
    <div class="bm-editor">
      <div class="bm-form">
        <div class="bm-field">
          <label class="bm-label" for="bm-name">
            Name<span class="bm-req">*</span>
            <span class="bm-hint" data-slug-note></span>
          </label>
          <input id="bm-name" class="bm-input" data-field="name" type="text"
            placeholder="Eric Van Geem" autocomplete="off" />
          <div class="bm-error" data-error="name"></div>
        </div>

        <div class="bm-row">
          <div class="bm-field">
            <label class="bm-label" for="bm-title">Title<span class="bm-req">*</span></label>
            <input id="bm-title" class="bm-input" data-field="title" type="text"
              placeholder="Director, Technology" autocomplete="off" />
            <div class="bm-error" data-error="title"></div>
          </div>
          <div class="bm-field">
            <label class="bm-label" for="bm-company">Company</label>
            <input id="bm-company" class="bm-input" type="text"
              placeholder="Huge" autocomplete="off" />
          </div>
        </div>

        <div class="bm-field">
          <label class="bm-label">Headshot<span class="bm-req">*</span>
            <span class="bm-hint">Stored in DA at <code>${CONFIG.media}/</code></span>
          </label>
          <div class="bm-photo" data-field="photo" data-drop>
            <img class="bm-photo-thumb bm-photo-thumb--empty" data-photo-thumb alt="" />
            <div class="bm-photo-body">
              <div class="bm-photo-name" data-photo-name>No headshot yet</div>
              <div class="bm-photo-path" data-photo-path>Uploads to ${CONFIG.media}/</div>
              <div class="bm-photo-actions">
                <button type="button" class="bm-btn bm-btn--sm bm-btn--ghost" data-photo-pick>
                  Choose file
                </button>
                <button type="button" class="bm-btn bm-btn--sm bm-btn--danger"
                  data-photo-clear hidden>Remove</button>
              </div>
              <input type="file" accept="image/jpeg,image/png,image/gif,image/svg+xml"
                data-photo-input hidden />
            </div>
          </div>
          <div class="bm-error" data-error="photo"></div>
        </div>

        <div class="bm-row">
          <div class="bm-field">
            <label class="bm-label" for="bm-linkedin">LinkedIn</label>
            <input id="bm-linkedin" class="bm-input" type="url"
              placeholder="https://www.linkedin.com/in/…" autocomplete="off" />
          </div>
          <div class="bm-field">
            <label class="bm-label" for="bm-status">Review status</label>
            <select id="bm-status" class="bm-select">
              ${STATUSES.map((s) => `<option value="${s.value}">${s.label}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="bm-field">
          <label class="bm-label" for="bm-body">Bio<span class="bm-req">*</span></label>
          <div class="bm-rte" data-field="body">
            <div class="bm-rte-bar" data-rte-bar>
              <button type="button" class="bm-rte-btn" data-cmd="bold" title="Bold">
                <strong>B</strong></button>
              <button type="button" class="bm-rte-btn" data-cmd="italic" title="Italic">
                <em>I</em></button>
              <button type="button" class="bm-rte-btn" data-cmd="underline" title="Underline">
                <u>U</u></button>
              <button type="button" class="bm-rte-btn" data-cmd="insertUnorderedList"
                title="Bulleted list">&bull;</button>
              <button type="button" class="bm-rte-btn" data-cmd="insertOrderedList"
                title="Numbered list">1.</button>
              <button type="button" class="bm-rte-btn" data-cmd="createLink"
                title="Link">Link</button>
            </div>
            <div id="bm-body" class="bm-rte-body" contenteditable="true"
              data-placeholder="Two or three sentences on what they build and what they'll talk about."></div>
          </div>
          <div class="bm-error" data-error="body"></div>
        </div>

        <div class="bm-actions">
          <button type="button" class="bm-btn" data-save>
            <span data-save-label>${isNew ? 'Create bio' : 'Save changes'}</span>
          </button>
          <button type="button" class="bm-btn bm-btn--ghost" data-cancel>Cancel</button>
        </div>
      </div>
      <aside class="bm-preview" data-preview></aside>
    </div>
  `;

  els.name = panel.querySelector('#bm-name');
  els.title = panel.querySelector('#bm-title');
  els.company = panel.querySelector('#bm-company');
  els.linkedin = panel.querySelector('#bm-linkedin');
  els.status = panel.querySelector('#bm-status');
  els.body = panel.querySelector('#bm-body');
  els.rteBar = panel.querySelector('[data-rte-bar]');
  els.preview = panel.querySelector('[data-preview]');
  els.slugNote = panel.querySelector('[data-slug-note]');
  els.photoThumb = panel.querySelector('[data-photo-thumb]');
  els.photoName = panel.querySelector('[data-photo-name]');
  els.photoPath = panel.querySelector('[data-photo-path]');
  els.photoClear = panel.querySelector('[data-photo-clear]');
  els.photoInput = panel.querySelector('[data-photo-input]');
  els.photoDrop = panel.querySelector('[data-drop]');
  els.saveBtn = panel.querySelector('[data-save]');
  els.saveLabel = panel.querySelector('[data-save-label]');

  const updateSlugNote = () => {
    const slug = state.editingSlug || slugify(els.name.value) || '…';
    els.slugNote.innerHTML = `&rarr; <code>${escapeHtml(CONFIG.fragments)}/${escapeHtml(slug)}</code>`;
  };

  ['input', 'change'].forEach((evt) => {
    [els.name, els.title, els.company, els.linkedin, els.status].forEach((el) => {
      el.addEventListener(evt, () => {
        updateSlugNote();
        renderPreview();
        if (el === els.name) setFieldError('name', '');
        if (el === els.title) setFieldError('title', '');
      });
    });
  });

  els.body.addEventListener('input', () => {
    setFieldError('body', '');
    renderPreview();
  });
  els.body.addEventListener('keyup', syncRteButtons);
  els.body.addEventListener('mouseup', syncRteButtons);
  els.rteBar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-cmd]');
    if (!btn) return;
    ev.preventDefault();
    rteCommand(btn.dataset.cmd);
    syncRteButtons();
    renderPreview();
  });

  panel.querySelector('[data-photo-pick]').addEventListener('click', () => els.photoInput.click());
  els.photoInput.addEventListener('change', () => acceptPhotoFile(els.photoInput.files[0]));
  els.photoClear.addEventListener('click', () => {
    els.photoInput.value = '';
    setPhoto(null);
  });
  ['dragenter', 'dragover'].forEach((evt) => els.photoDrop.addEventListener(evt, (ev) => {
    ev.preventDefault();
    els.photoDrop.classList.add('is-drag');
  }));
  ['dragleave', 'drop'].forEach((evt) => els.photoDrop.addEventListener(evt, (ev) => {
    ev.preventDefault();
    els.photoDrop.classList.remove('is-drag');
    if (evt === 'drop') acceptPhotoFile(ev.dataTransfer?.files?.[0]);
  }));

  els.saveBtn.addEventListener('click', handleSave);
  panel.querySelector('[data-cancel]').addEventListener('click', () => {
    hideBanner();
    setTab('roster');
  });

  if (bio) {
    els.name.value = bio.name;
    els.title.value = bio.title;
    els.company.value = bio.company;
    els.linkedin.value = bio.linkedin;
    els.status.value = bio.status === 'approved' ? 'approved' : 'placeholder';
    els.body.innerHTML = bio.body;
    if (bio.image) {
      const path = bio.image.replace(/^https?:\/\/[^/]+\/[^/]+\/[^/]+/, '');
      setPhoto({
        url: bio.image, stored: bio.image, name: bio.image.split('/').pop(), path, file: null,
      });
      // Swap the un-loadable content.da.live URL for a blob the browser can show.
      displayableImage(bio.image)
        .then((src) => {
          if (state.photo?.stored !== bio.image) return;
          setPhoto({ ...state.photo, url: src });
        })
        .catch(() => { /* thumbnail stays blank; the stored value is still right */ });
    } else {
      setPhoto(null);
    }
  } else {
    setPhoto(null);
  }
  updateSlugNote();
  renderPreview();
}

async function openEditor(slug) {
  hideBanner();
  state.editingSlug = slug;
  els.editorTab.textContent = slug ? 'Edit bio' : 'New bio';
  setTab('editor');
  if (!slug) {
    buildEditor(null);
    els.name.focus();
    return;
  }
  els.editorPanel.innerHTML = '<div class="bm-empty"><strong>Loading</strong></div>';
  try {
    buildEditor(await fetchBio(slug));
  } catch (e) {
    setTab('roster');
    showBanner('error', e.message);
  }
}

function setSaving(saving) {
  state.saving = saving;
  els.saveBtn.disabled = saving;
  if (saving) {
    els.saveLabel.innerHTML = '<span class="bm-spinner"></span> Saving…';
  } else {
    els.saveLabel.textContent = state.editingSlug ? 'Save changes' : 'Create bio';
  }
}

function validateDraft(draft) {
  clearFieldErrors();
  let first = null;
  if (!draft.name) {
    setFieldError('name', 'A name is required.');
    first = first || els.name;
  }
  if (!draft.title) {
    setFieldError('title', 'A title is required.');
    first = first || els.title;
  }
  if (!state.photo) {
    setFieldError('photo', 'A headshot is required.');
    first = first || els.photoDrop;
  }
  if (!els.body.textContent.trim()) {
    setFieldError('body', 'Write a sentence or two.');
    first = first || els.body;
  }
  if (draft.linkedin && !isHttpUrl(draft.linkedin)) {
    setFieldError('name', '');
    showBanner('error', 'The LinkedIn value must be a full https:// URL.');
    first = first || els.linkedin;
  }
  return first;
}

async function handleSave() {
  if (state.saving) return;
  hideBanner();
  const draft = currentDraft();
  const invalid = validateDraft(draft);
  if (invalid) {
    if (typeof invalid.focus === 'function') invalid.focus();
    return;
  }

  setSaving(true);
  try {
    await ensureFolders();

    const slug = state.editingSlug || await resolveFreeSlug(slugify(draft.name));

    let { image } = draft;
    if (state.photo?.file) {
      const uploaded = await uploadPhoto(state.photo.file, slug);
      image = uploaded.url;
      setPhoto({
        ...state.photo, stored: uploaded.url, path: uploaded.path, file: null,
      });
    }

    const bio = {
      slug,
      name: draft.name,
      title: draft.title,
      company: draft.company,
      linkedin: draft.linkedin,
      status: draft.status,
      image,
      body: draft.body,
      path: `${CONFIG.fragments}/${slug}`,
      updated: new Date().toISOString().slice(0, 10),
    };

    await saveFragment(slug, buildBioDoc(bio));

    const rows = await fetchSheet();
    const next = rows.filter((r) => r.slug !== slug);
    next.push(bio);
    try {
      await saveSheet(next);
    } catch (e) {
      setSaving(false);
      const retry = [{
        label: 'Retry roster',
        handler: async () => {
          hideBanner();
          try {
            await saveSheet(next);
            await finishSave(bio);
          } catch (again) {
            showBanner('error', `Roster still failing: ${again.message}`);
          }
        },
      }];
      const partial = `The bio document saved at ${bio.path}, but the roster `
        + `sheet did not update: ${e.message}`;
      showBanner('error', partial, retry);
      return;
    }

    await finishSave(bio);
  } catch (e) {
    setSaving(false);
    showBanner('error', e.message || 'Save failed.');
  }
}

async function finishSave(bio) {
  const preview = await aemAction('preview', bio.path);
  const live = preview.ok ? await aemAction('live', bio.path) : { ok: false };

  state.rows = state.rows.filter((r) => r.slug !== bio.slug).concat(bio);
  setSaving(false);
  state.editingSlug = null;
  els.editorTab.textContent = 'New bio';
  renderRoster();
  setTab('roster');

  const actions = [];
  if (state.isPlugin) {
    actions.push({ label: 'Insert on page', handler: () => insertBio(bio) });
  }
  actions.push({
    label: 'Open in DA',
    handler: () => window.open(editUrl(bio.path), '_blank', 'noopener'),
  });

  if (!preview.ok) {
    const why = preview.detail ? `: ${preview.detail}` : '';
    const message = `Saved ${bio.path}, but it is not previewed yet `
      + `(${preview.status || 'network'}${why}) — preview it from DA before it will render.`;
    showBanner('warning', message, actions);
    return;
  }
  const where = live.ok
    ? 'saved, previewed and published.'
    : 'saved and previewed — publish it from DA.';
  showBanner('success', `${bio.name} ${where}`, actions);
}

/* --------------------------------------------------------------- removal */

function confirmRemove(bio) {
  const bg = document.createElement('div');
  bg.className = 'bm-modal-bg';
  bg.innerHTML = `
    <div class="bm-modal" role="dialog" aria-modal="true" aria-labelledby="bm-rm-title">
      <h2 id="bm-rm-title">Remove ${escapeHtml(bio.name)}?</h2>
      <p>This unpublishes <code>${escapeHtml(bio.path || `${CONFIG.fragments}/${bio.slug}`)}</code>,
        then deletes the document, its headshot and the roster row. Pages listing
        <code>${escapeHtml(bio.slug)}</code> as a speaker will show a missing-bio notice.</p>
      <div class="bm-modal-actions">
        <button type="button" class="bm-btn bm-btn--ghost" data-cancel>Keep it</button>
        <button type="button" class="bm-btn bm-btn--danger" data-confirm>Remove</button>
      </div>
    </div>
  `;
  const close = () => bg.remove();
  bg.addEventListener('click', (ev) => { if (ev.target === bg) close(); });
  bg.querySelector('[data-cancel]').addEventListener('click', close);
  bg.querySelector('[data-confirm]').addEventListener('click', () => {
    close();
    removeBio(bio);
  });
  document.body.append(bg);
}

async function daDelete(path) {
  const resp = await fetch(`${sourceUrl(path)}`, { method: 'DELETE', headers: authHeaders() });
  if (resp.ok || resp.status === 204 || resp.status === 404) return true;
  throw new Error(`Delete failed for ${path} (${resp.status}).`);
}

async function removeBio(bio) {
  hideBanner();
  const path = bio.path || `${CONFIG.fragments}/${bio.slug}`;
  try {
    // Unpublish first. Deleting the source while the page is still published
    // leaves it publicly reachable with nothing behind it.
    await aemAction('live', path, 'DELETE');
    await aemAction('preview', path, 'DELETE');
    await daDelete(`${path}.html`);

    // The headshot is ours too; leaving it behind orphans media in DA.
    if (bio.image?.startsWith(DA_CONTENT)) {
      const prefix = `${DA_CONTENT}/${state.org}/${state.site}`;
      if (bio.image.startsWith(prefix)) {
        await daDelete(bio.image.slice(prefix.length)).catch(() => {});
      }
    }

    const rows = await fetchSheet();
    await saveSheet(rows.filter((r) => r.slug !== bio.slug));
    state.rows = state.rows.filter((r) => r.slug !== bio.slug);
    renderRoster();
    showBanner('success', `${bio.name} removed and unpublished.`);
  } catch (e) {
    showBanner('error', e.message, [{
      label: 'Retry',
      handler: () => { hideBanner(); removeBio(bio); },
    }]);
  }
}

/* ------------------------------------------------------------------ init */

(async function init() {
  let sdk;
  try {
    sdk = await DA_SDK;
  } catch (e) {
    showFatal('The DA SDK did not hand over a session.', e?.message);
    return;
  }
  const { context, token, actions } = sdk || {};
  const org = context?.org || context?.organization || context?.owner;
  const site = context?.site || context?.repo || context?.repository;
  if (!token || !org || !site) {
    showFatal('No DA org, site or token in the SDK context.');
    return;
  }

  state.org = org;
  state.site = site;
  state.token = token;
  state.actions = actions || null;
  // The SDK builds `actions` itself and always provides it, for apps as well
  // as plugins, so its presence proves nothing. DA's library palette posts
  // `view: 'edit'` (blocks/edit/da-library/da-library.js); the fullscreen app
  // host does not. Insert only makes sense when a document is open.
  state.isPlugin = context.view === 'edit' && typeof actions?.sendHTML === 'function';
  if (state.isPlugin) document.body.classList.add('is-plugin');

  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* ok */ }

  buildShell();
  await loadRoster();
}());
