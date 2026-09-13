/* --------------------------------------------------------------------------
 * Icon Picker — UI (web component)
 *
 * Two jobs, picking first: browse the site's icon library and drop an icon into
 * the document, and — behind the Manage toggle — add or remove the icons that
 * library offers. Picking inserts the EDS token `:key:`, which publishes as
 * <span class="icon icon-key"> for scripts/utils/icons.js to render.
 * ------------------------------------------------------------------------ */

import {
  ORG, REPO, ICONS_DIR, actions, isValidKey, deriveNames, previewSrc, iconToken,
} from './icon-config.js';
import { loadLibrary, addIcon, deleteIcon } from './icon-store.js';

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

const STYLES = `
  :host { display:block; font-family:-apple-system,system-ui,"Segoe UI",roboto,sans-serif; color:#1a1a1a; }
  .wrap { max-width:1100px; margin:0 auto; padding:16px; }
  h1 { font-size:18px; margin:0; }
  h2 { font-size:14px; margin:0 0 10px; }
  .head-row { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .sub { color:#666; margin:4px 0 14px; font-size:13px; }
  code { background:#f0f0f0; padding:1px 5px; border-radius:4px; font-size:12px; }
  .manage-toggle { padding:6px 14px; border-radius:8px; border:1px solid #ccc; background:#fff; font-size:13px; cursor:pointer; }
  .manage-toggle.on { border-color:#1473e6; color:#1473e6; background:#f0f6ff; }
  section { background:#fff; border:1px solid #e6e6e6; border-radius:10px; padding:14px; margin-bottom:14px; }
  .toolbar { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
  .search { flex:1; padding:8px 10px; border:1px solid #ccc; border-radius:8px; font-size:14px; }
  .count { color:#888; font-size:12px; white-space:nowrap; }
  .add-row { display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:end; }
  .filebtn { position:relative; overflow:hidden; display:flex; }
  .filebtn input { position:absolute; inset:0; opacity:0; cursor:pointer; }
  .filebtn span, .submit { display:flex; align-items:center; justify-content:center; padding:8px 16px; border-radius:8px; border:1px solid #ccc; background:#f6f6f6; font-size:13px; cursor:pointer; white-space:nowrap; }
  .submit { background:#1473e6; color:#fff; border-color:#1473e6; }
  .submit:disabled { background:#b9d4f5; border-color:#b9d4f5; cursor:not-allowed; }
  .keyfield { display:flex; flex-direction:column; font-size:12px; color:#666; gap:4px; }
  .key { padding:8px 10px; border:1px solid #ccc; border-radius:8px; font-size:14px; width:100%; }
  .key.invalid { border-color:#d7373f; }
  .preview { margin-top:12px; }
  .chip { display:inline-flex; align-items:center; gap:10px; background:#f6f6f6; border:1px solid #e6e6e6; border-radius:8px; padding:6px 10px; }
  .swatch { width:24px; height:24px; display:inline-flex; align-items:center; justify-content:center; }
  .swatch svg, .swatch img { width:100%; height:100%; }
  .hint { color:#888; font-size:12px; margin:10px 0 0; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(84px,1fr)); gap:8px; }
  .cell { position:relative; margin:0; display:flex; flex-direction:column; align-items:center; gap:4px; }
  .pick { width:100%; display:flex; align-items:center; justify-content:center; padding:14px 8px; border:1px solid #eee; border-radius:8px; background:#fff; cursor:pointer; }
  .pick:hover { border-color:#1473e6; background:#f0f6ff; }
  .pick img { width:32px; height:32px; object-fit:contain; }
  .pick img.broken { opacity:0.25; }
  .cell.unlisted .pick { border-style:dashed; border-color:#e6a817; }
  figcaption { font-size:11px; color:#555; text-align:center; word-break:break-word; line-height:1.3; }
  .del { position:absolute; top:-6px; right:-6px; width:20px; height:20px; border-radius:50%; border:1px solid #d7373f; background:#fff; color:#d7373f; font-size:14px; line-height:1; cursor:pointer; padding:0; }
  .empty { color:#888; font-size:13px; margin:8px 2px; grid-column:1/-1; }
  .banner { padding:9px 12px; border-radius:8px; margin-bottom:12px; font-size:13px; }
  .banner.info { background:#eef4ff; color:#1a4b8c; }
  .banner.success { background:#e7f6ec; color:#1b7a3d; }
  .banner.error { background:#fdecec; color:#b3261e; }
`;

class IconPicker extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.library = { icons: [], rows: [], dangling: [] };
    this.filter = '';
    this.pending = null; // { key, file, ext, bytes }
  }

  async connectedCallback() {
    if (!ORG || !REPO) {
      this.renderShell();
      this.banner('error', 'No DA context (org/site) was handed to this tool.');
      return;
    }
    this.renderShell();
    await this.refresh();
  }

  async refresh() {
    try {
      this.library = await loadLibrary();
      this.renderGrid();
      if (this.library.dangling.length) {
        this.banner('info', `${this.library.dangling.length} manifest entr${this.library.dangling.length === 1 ? 'y has' : 'ies have'} no file in /${ICONS_DIR}/: ${this.library.dangling.join(', ')}`);
      }
    } catch (err) {
      this.banner('error', err.message);
    }
  }

  /* ---- rendering ---- */

  renderShell() {
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="wrap">
        <header>
          <div class="head-row">
            <h1>Icon Picker</h1>
            <button class="manage-toggle" type="button">Manage</button>
          </div>
          <p class="sub">Click an icon to insert it as <code>:key:</code>. Library: <code>/${ICONS_DIR}/</code> on <code>${REPO}</code>.</p>
        </header>

        <div class="banner" hidden></div>

        <section class="manage" hidden>
          <h2>Add an icon</h2>
          <div class="add-row">
            <label class="filebtn">
              <input type="file" accept=".svg,.png,image/svg+xml,image/png" />
              <span>Choose SVG…</span>
            </label>
            <label class="keyfield">Key
              <input type="text" class="key" placeholder="e.g. calendar" disabled />
            </label>
            <button class="submit" type="button" disabled>Add to library</button>
          </div>
          <div class="preview" hidden>
            <div class="chip"><span class="swatch"></span><code class="fname"></code></div>
          </div>
          <p class="hint">The key is how the icon is referenced in content (<code>:key:</code> → <code>icon-key</code>). Lowercase letters, digits and hyphens.</p>
        </section>

        <div class="toolbar">
          <input type="search" class="search" placeholder="Filter icons…" aria-label="Filter icons" />
          <span class="count"></span>
        </div>

        <section class="lib">
          <div class="grid"></div>
        </section>
      </div>`;

    const $ = (s) => this.shadowRoot.querySelector(s);
    $('.search').addEventListener('input', (e) => {
      this.filter = e.target.value.trim().toLowerCase();
      this.renderGrid();
    });
    $('.manage-toggle').addEventListener('click', () => this.toggleManage());
    $('input[type=file]').addEventListener('change', (e) => this.onFile(e));
    $('.key').addEventListener('input', () => this.validate());
    $('.submit').addEventListener('click', () => this.onSubmit());
  }

  toggleManage() {
    const panel = this.shadowRoot.querySelector('.manage');
    const btn = this.shadowRoot.querySelector('.manage-toggle');
    panel.hidden = !panel.hidden;
    btn.classList.toggle('on', !panel.hidden);
    this.shadowRoot.querySelector('.grid').classList.toggle('managing', !panel.hidden);
    this.renderGrid();
  }

  visibleIcons() {
    if (!this.filter) return this.library.icons;
    return this.library.icons.filter((i) => i.key.toLowerCase().includes(this.filter));
  }

  renderGrid() {
    const grid = this.shadowRoot.querySelector('.grid');
    const managing = !this.shadowRoot.querySelector('.manage').hidden;
    const icons = this.visibleIcons();
    const total = this.library.icons.length;

    this.shadowRoot.querySelector('.count').textContent = this.filter
      ? `${icons.length} of ${total}`
      : `${total} icon${total === 1 ? '' : 's'}`;

    if (!icons.length) {
      grid.innerHTML = `<p class="empty">${total
        ? 'No icon matches that filter.'
        : `No icons yet — add one, or drop SVGs into /${ICONS_DIR}/ in DA.`}</p>`;
      return;
    }

    grid.innerHTML = icons.map((i) => `
      <figure class="cell${i.listed ? '' : ' unlisted'}" data-key="${esc(i.key)}" data-file="${esc(i.file)}"
              title="${esc(i.key)}${i.listed ? '' : ' — not in the manifest yet'}">
        <button class="pick" type="button" aria-label="Insert ${esc(i.key)}">
          <img loading="lazy" src="${esc(previewSrc(i.file))}" alt=""
               onerror="this.classList.add('broken')" />
        </button>
        <figcaption>${esc(i.key)}</figcaption>
        ${managing ? '<button class="del" type="button" aria-label="Delete">&times;</button>' : ''}
      </figure>`).join('');

    grid.querySelectorAll('.pick').forEach((btn) => {
      btn.addEventListener('click', () => this.onPick(btn.closest('.cell').dataset.key));
    });
    grid.querySelectorAll('.del').forEach((btn) => {
      btn.addEventListener('click', () => {
        const { key, file } = btn.closest('.cell').dataset;
        this.onDelete(key, file);
      });
    });
  }

  /* ---- pick ---- */

  onPick(key) {
    actions.sendText(iconToken(key));
    actions.closeLibrary();
  }

  /* ---- add ---- */

  async onFile(e) {
    const file = e.target.files?.[0];
    const previewEl = this.shadowRoot.querySelector('.preview');
    const keyInput = this.shadowRoot.querySelector('.key');
    if (!file) {
      previewEl.hidden = true;
      keyInput.disabled = true;
      this.pending = null;
      this.validate();
      return;
    }

    const { key, file: fname, ext } = deriveNames(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.pending = {
      key, file: fname, ext, bytes,
    };

    keyInput.value = key;
    keyInput.disabled = false;
    previewEl.hidden = false;
    this.shadowRoot.querySelector('.fname').textContent = fname;

    const swatch = this.shadowRoot.querySelector('.swatch');
    if (ext === 'svg') {
      // Inline so the swatch reflects the actual artwork, not a re-fetch.
      swatch.innerHTML = new TextDecoder().decode(bytes);
    } else {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      swatch.innerHTML = `<img src="${url}" alt="" />`;
    }
    this.validate();
  }

  validate() {
    const keyInput = this.shadowRoot.querySelector('.key');
    const key = keyInput.value.trim();
    const ok = !!this.pending && isValidKey(key);
    this.shadowRoot.querySelector('.submit').disabled = !ok;
    keyInput.classList.toggle('invalid', !!key && !isValidKey(key));
    if (this.pending) {
      this.pending.key = key;
      // Keep filename and key in lockstep so the library stays predictable.
      this.pending.file = `${key}.${this.pending.ext}`;
    }
  }

  async onSubmit() {
    if (!this.pending) return;
    const { key, file, bytes } = this.pending;

    const clash = this.library.icons.find((i) => i.key === key || i.file === file);
    let overwrite = false;
    if (clash) {
      overwrite = window.confirm(
        `"${key}" is already in the library.\n\nReplacing it updates every page that uses :${key}:. Continue?`,
      );
      if (!overwrite) return;
    }

    this.setBusy(true);
    this.banner('info', `Adding "${key}"…`);
    try {
      await addIcon({
        key, file, bytes, overwrite,
      });
      this.banner('success', `"${key}" is in the library — insert it with :${key}:`);
      this.resetForm();
      await this.refresh();
    } catch (err) {
      this.banner('error', `Add failed — rolled back, nothing changed. ${err.message}`);
    } finally {
      this.setBusy(false);
    }
  }

  async onDelete(key, file) {
    if (!window.confirm(`Remove "${key}" from the library?\n\nPages still using :${key}: will show a missing icon.`)) return;
    this.setBusy(true);
    this.banner('info', `Removing "${key}"…`);
    try {
      await deleteIcon({ key, file });
      this.banner('success', `"${key}" removed.`);
      await this.refresh();
    } catch (err) {
      this.banner('error', `Remove failed: ${err.message}`);
    } finally {
      this.setBusy(false);
    }
  }

  /* ---- helpers ---- */

  setBusy(busy) {
    this.shadowRoot.querySelectorAll('input, button').forEach((el) => { el.disabled = busy; });
    if (!busy) this.validate();
  }

  resetForm() {
    this.pending = null;
    const $ = (s) => this.shadowRoot.querySelector(s);
    $('input[type=file]').value = '';
    $('.key').value = '';
    $('.key').disabled = true;
    $('.preview').hidden = true;
    $('.submit').disabled = true;
  }

  banner(kind, msg) {
    const el = this.shadowRoot.querySelector('.banner');
    el.className = `banner ${kind}`;
    el.textContent = msg;
    el.hidden = false;
  }
}

customElements.define('icon-picker', IconPicker);
