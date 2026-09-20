/* --------------------------------------------------------------------------
 * Splitforms Picker — a DA library palette for placing a `splitforms` block.
 *
 * Pick a form, set the options that form offers, see the table you are about to
 * get, insert it. Everything author-facing is declared in form-catalog.js; this
 * file only knows how to render option TYPES, so adding a form type is a change
 * to the catalog and nothing else.
 *
 * What gets inserted is a TABLE, not the nested divs DA stores on disk. Those
 * two are different shapes and it matters:
 *
 *   on disk   <div class="splitforms"><div><div>form</div>…
 *   in the    <table><tr><td colspan="2"><p>splitforms</p></td></tr>
 *   editor          <tr><td><p>form</p></td><td><p>contact</p></td></tr>…
 *
 * The editor converts between them on load and save, but its paste parser only
 * recognises the table. Sending the div form inserts nothing at all — silently,
 * with the palette closing as though it had worked. Verified by reading the
 * shape of a block already in a document, which is what this now mirrors:
 * the name row spans both columns, config rows are two cells, and every cell's
 * text sits in a <p>.
 *
 * Every row of that table is configuration. The block's teaser copy is not in
 * it: the panel floats right inside its section and the section's own copy
 * flows beside it, so the copy is ordinary page text. That is what lets a form
 * drop into paragraphs an author has already written. The optional placeholder
 * teaser is therefore sent as a heading and a paragraph BEFORE the table —
 * section content, a sibling of the block, not a cell inside it.
 * ------------------------------------------------------------------------ */

import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  FORMS, byName, defaultValue, isMeaningful, cellValue,
} from './form-catalog.js';

const { context, actions } = await DA_SDK;

/**
 * Placeholder teaser copy, inserted into the section above the block.
 *
 * Off by default. The case this palette is built around is a form dropped into
 * copy that already exists, where placeholder prose is something to delete
 * rather than something to fill in; a blank page is the case that wants it.
 */
const TEASER = {
  heading: 'Tell them why they should',
  body: 'Replace this with the reason someone should fill the form in — or delete it, and put the form in copy you have already written.',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

const state = {
  form: FORMS[0]?.name,
  values: {},
  teaser: false,
};

/** Reset every option to its catalog default. Called on load and on form change. */
function resetValues(name) {
  const form = byName(name);
  state.values = {};
  (form?.options || []).forEach((opt) => { state.values[opt.key] = defaultValue(opt); });
}

/** The `key | value` rows this selection implies, in catalog order. */
function configRows() {
  const form = byName(state.form);
  if (!form) return [];
  const rows = [['form', form.name]];
  form.options.forEach((opt) => {
    const value = state.values[opt.key];
    if (isMeaningful(opt, value)) rows.push([opt.key, cellValue(opt, value)]);
  });
  return rows;
}

/* ---------- what gets inserted ---------- */

function blockHTML() {
  const rows = ['<tr><td colspan="2"><p>splitforms</p></td></tr>'];

  configRows().forEach(([key, value]) => {
    rows.push(`<tr><td><p>${esc(key)}</p></td><td><p>${esc(value)}</p></td></tr>`);
  });

  const table = `<table><tbody>${rows.join('')}</tbody></table>`;
  if (!state.teaser) return table;

  // Section content, ahead of the block rather than inside it. Order in the
  // document does not decide where the form lands — the block hoists itself to
  // the top of its section — but copy before form is how the page reads.
  return `<h2>${esc(TEASER.heading)}</h2><p>${esc(TEASER.body)}</p>${table}`;
}

/* ---------- rendering ---------- */

function renderForms() {
  return FORMS.map((f) => `
    <li>
      <button class="sfp-form" type="button" data-form="${esc(f.name)}"
              aria-pressed="${f.name === state.form}">
        <span class="sfp-form-name">${esc(f.label)}</span>
        <span class="sfp-form-blurb">${esc(f.blurb)}</span>
      </button>
    </li>`).join('');
}

function renderOption(opt) {
  const value = state.values[opt.key];
  const id = `opt-${opt.key}`;
  const hint = opt.hint ? `<p class="sfp-hint">${esc(opt.hint)}</p>` : '';

  if (opt.type === 'switch') {
    return `
      <div class="sfp-opt sfp-switch-wrap">
        <div class="sfp-switch">
          <input type="checkbox" id="${id}" data-key="${esc(opt.key)}" ${value ? 'checked' : ''}>
          <label for="${id}">${esc(opt.label)}</label>
        </div>
        ${hint}
      </div>`;
  }

  if (opt.type === 'choice') {
    const buttons = opt.choices.map((c) => `
      <button type="button" data-key="${esc(opt.key)}" data-choice="${esc(c)}"
              aria-pressed="${c === value}">${esc(c)}</button>`).join('');
    return `
      <div class="sfp-opt">
        <span class="sfp-label">${esc(opt.label)}</span>
        <div class="sfp-choice" role="group" aria-label="${esc(opt.label)}">${buttons}</div>
        ${hint}
      </div>`;
  }

  const type = opt.type === 'number' ? 'number' : 'text';
  return `
    <div class="sfp-opt">
      <label class="sfp-label" for="${id}">${esc(opt.label)}</label>
      <input class="sfp-input" type="${type}" id="${id}" data-key="${esc(opt.key)}"
             value="${esc(value)}" placeholder="${esc(opt.placeholder || '')}">
      ${hint}
    </div>`;
}

function renderPreview() {
  const rows = configRows().map(([k, v]) => `
    <tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  const teaser = state.teaser
    ? `<p class="sfp-preview-copy">${esc(TEASER.heading)} — placeholder copy in the section, above the block</p>`
    : '';
  return `
    ${teaser}
    <table>
      <thead><tr><th colspan="2">splitforms</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderDetail() {
  const form = byName(state.form);
  if (!form) return '<p class="sfp-hint">Pick a form on the left.</p>';

  return `
    <p class="sfp-section-label">Fields this form renders</p>
    <ul class="sfp-fields">${form.fields.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>

    <p class="sfp-section-label">Options</p>
    <div class="sfp-opts">
      <div class="sfp-opt sfp-switch-wrap">
        <div class="sfp-switch">
          <input type="checkbox" id="opt-teaser" data-teaser ${state.teaser ? 'checked' : ''}>
          <label for="opt-teaser">Add placeholder teaser copy</label>
        </div>
        <p class="sfp-hint">A heading and a paragraph in the section above the block, for a
          page with nothing on it yet. Leave it off to drop the form into copy that is
          already there — the form floats right and that copy flows beside it.</p>
      </div>
      ${form.options.map(renderOption).join('')}
    </div>

    <p class="sfp-section-label">What gets inserted</p>
    <div class="sfp-preview">${renderPreview()}</div>`;
}

function paintDetail() {
  document.querySelector('#sfp-detail').innerHTML = renderDetail();
}

function paintForms() {
  document.querySelectorAll('.sfp-form').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.form === state.form));
  });
}

function render() {
  document.body.innerHTML = `
    <div class="sfp-app">
      <header class="sfp-head">
        <p class="sfp-eyebrow">Splitforms</p>
        <h1 class="sfp-title">Form picker</h1>
        <p class="sfp-lede">Choose a form, set its options, and drop a
          <code>splitforms</code> block into the page at the cursor.</p>
      </header>

      <div class="sfp-banner" id="sfp-banner" role="status"></div>

      <div class="sfp-body">
        <div>
          <p class="sfp-section-label">Form</p>
          <ul class="sfp-forms">${renderForms()}</ul>
        </div>
        <div id="sfp-detail">${renderDetail()}</div>
      </div>

      <div class="sfp-foot">
        <button class="sfp-btn" type="button" id="sfp-insert">Insert form</button>
        <button class="sfp-btn sfp-btn-ghost" type="button" id="sfp-reset">Reset options</button>
        <p class="sfp-note">Inserts at the cursor${context?.repo ? ` on <strong>${esc(context.repo)}</strong>` : ''}.</p>
      </div>
    </div>`;
}

function banner(kind, message) {
  const el = document.querySelector('#sfp-banner');
  if (!el) return;
  el.className = `sfp-banner sfp-banner-${kind}`;
  el.textContent = message;
}

/* ---------- events ---------- */

function wire() {
  document.body.addEventListener('click', (e) => {
    const formBtn = e.target.closest('.sfp-form');
    if (formBtn) {
      state.form = formBtn.dataset.form;
      resetValues(state.form);
      paintForms();
      paintDetail();
      return;
    }

    const choice = e.target.closest('.sfp-choice button');
    if (choice) {
      state.values[choice.dataset.key] = choice.dataset.choice;
      paintDetail();
      return;
    }

    if (e.target.closest('#sfp-reset')) {
      resetValues(state.form);
      state.teaser = false;
      paintDetail();
      return;
    }

    if (e.target.closest('#sfp-insert')) {
      actions.sendHTML(blockHTML());
      actions.closeLibrary();
    }
  });

  document.body.addEventListener('change', (e) => {
    const el = e.target;
    if (el.matches('[data-teaser]')) {
      state.teaser = el.checked;
      paintDetail();
      return;
    }
    if (el.matches('input[type="checkbox"][data-key]')) {
      state.values[el.dataset.key] = el.checked;
      paintDetail();
    }
  });

  // Text inputs repaint the preview live, but repainting on every keystroke
  // would take the focus out of the field the author is typing in — so update
  // the state and the preview only, leaving the inputs where they are.
  document.body.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.matches('.sfp-input[data-key]')) return;
    state.values[el.dataset.key] = el.value;
    const preview = document.querySelector('.sfp-preview');
    if (preview) preview.innerHTML = renderPreview();
  });
}

/**
 * Does the catalog still match the block? A form the block knows about but the
 * catalog does not is invisible to authors, which is exactly the kind of gap
 * nobody notices, so it is said out loud rather than logged.
 */
async function checkCatalogDrift() {
  try {
    const mod = await import('../../blocks/splitforms/splitforms.js');
    const blockNames = mod.FORM_NAMES;
    if (!Array.isArray(blockNames)) return;

    const listed = FORMS.map((f) => f.name);
    const missing = blockNames.filter((n) => !listed.includes(n));
    const unknown = listed.filter((n) => !blockNames.includes(n));

    if (unknown.length) {
      banner('error', `This picker offers ${unknown.join(', ')}, which the block does not implement — `
        + 'inserting one falls back to the contact form.');
    } else if (missing.length) {
      banner('warn', `The block also implements ${missing.join(', ')}. `
        + 'Add them to tools/splitforms-picker/form-catalog.js to offer them here.');
    }
  } catch {
    // The block not being reachable is not a reason to withhold the picker.
  }
}

resetValues(state.form);
render();
wire();
checkCatalogDrift();
