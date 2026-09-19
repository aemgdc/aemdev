/* --------------------------------------------------------------------------
 * Splitforms Picker — a DA library palette for placing a `splitforms` block.
 *
 * Pick a form, set the options that form offers, see the table you are about to
 * get, insert it. Everything author-facing is declared in form-catalog.js; this
 * file only knows how to render option TYPES, so adding a form type is a change
 * to the catalog and nothing else.
 *
 * What gets inserted is the block's DA source shape — nested divs, the same
 * markup DA stores when the block is authored by hand:
 *
 *   <div class="splitforms">
 *     <div><div>…content…</div></div>          one cell  -> the pane beside the form
 *     <div><div>form</div><div>contact</div></div>   two cells -> configuration
 *   </div>
 * ------------------------------------------------------------------------ */

import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  FORMS, byName, defaultValue, isMeaningful, cellValue,
} from './form-catalog.js';

const { context, actions } = await DA_SDK;

/** Placeholder copy for the content pane, so an inserted block shows the split. */
const CONTENT_PLACEHOLDER = {
  heading: 'Tell them why they should',
  body: 'Replace this with the reason someone should fill the form in. Delete the whole left cell to run the form on its own.',
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[c]));

const state = {
  form: FORMS[0]?.name,
  values: {},
  contentPane: true,
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
  const parts = [];
  if (state.contentPane) {
    parts.push('<div><div>'
      + `<h2>${esc(CONTENT_PLACEHOLDER.heading)}</h2>`
      + `<p>${esc(CONTENT_PLACEHOLDER.body)}</p>`
      + '</div></div>');
  }
  configRows().forEach(([key, value]) => {
    parts.push(`<div><div>${esc(key)}</div><div>${esc(value)}</div></div>`);
  });
  return `<div class="splitforms">${parts.join('')}</div>`;
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
  const content = state.contentPane
    ? `<tr><td colspan="2" class="sfp-content-cell">${esc(CONTENT_PLACEHOLDER.heading)} — placeholder copy you replace in the document</td></tr>`
    : '';
  return `
    <table>
      <thead><tr><th colspan="2">splitforms</th></tr></thead>
      <tbody>${content}${rows}</tbody>
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
          <input type="checkbox" id="opt-content-pane" data-content-pane ${state.contentPane ? 'checked' : ''}>
          <label for="opt-content-pane">Include a content pane beside the form</label>
        </div>
        <p class="sfp-hint">The split the block is named for. Off inserts the form on its own.</p>
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
      state.contentPane = true;
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
    if (el.matches('[data-content-pane]')) {
      state.contentPane = el.checked;
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
