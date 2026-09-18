// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import { BIO_PATHS, bioFromRow } from '/tools/bio-manager/bio-doc.js';
import { saveToDa } from '/tools/advanced-search/helper.js';

const DA_SOURCE = 'https://admin.da.live/source';
const DA_CONTENT = 'https://content.da.live';

const searchInput = document.getElementById('bio-search');
const biosContainer = document.getElementById('bios-container');
const selectedBioDisplay = document.getElementById('selected-bio');
const insertBioButton = document.getElementById('insertBio');

let allBios = [];
let selectedBio = null;
let state = {
  org: '',
  site: '',
  token: '',
  path: '',
  actions: null,
};

function authHeaders() {
  return { Authorization: `Bearer ${state.token}` };
}

function sourceUrl(path) {
  return `${DA_SOURCE}/${state.org}/${state.site}${path}`;
}

function escapeHtml(value) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return String(value ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

function roleLine(bio) {
  const parts = [bio.title, bio.company].filter(Boolean);
  return parts.join(' · ');
}

async function fetchBios() {
  try {
    const resp = await fetch(`${sourceUrl(BIO_PATHS.sheet)}.json?nocache=${Date.now()}`, { headers: authHeaders() });
    if (resp.status === 404) return [];
    if (!resp.ok) throw new Error(`Could not read the bios sheet (${resp.status}).`);
    const json = await resp.json();

    if (Array.isArray(json?.data)) {
      return json.data.filter((row) => row.Slug).map(bioFromRow);
    }
    if (Array.isArray(json?.[':names'])) {
      const names = json[':names'];
      const primary = names.includes('data') ? 'data' : names[0];
      const rows = Array.isArray(json[primary]?.data) ? json[primary].data : [];
      return rows.filter((row) => row.Slug).map(bioFromRow);
    }
    return [];
  } catch (error) {
    console.error('Failed to fetch bios:', error);
    return [];
  }
}

function filterBios(query) {
  if (!query.trim()) return allBios;
  const q = query.trim().toLowerCase();
  return allBios.filter((bio) =>
    bio.name.toLowerCase().includes(q)
    || bio.title.toLowerCase().includes(q)
    || bio.company.toLowerCase().includes(q)
    || bio.slug.toLowerCase().includes(q),
  );
}

function createBioElement(bio) {
  const div = document.createElement('div');
  div.className = 'bio-item';
  if (selectedBio?.slug === bio.slug) {
    div.classList.add('selected');
  }
  div.innerHTML = `
    <div class="bio-name">${escapeHtml(bio.name)}</div>
    <div class="bio-role">${escapeHtml(roleLine(bio)) || '&nbsp;'}</div>
    <div class="bio-slug">${escapeHtml(bio.slug)}</div>
  `;
  div.addEventListener('click', () => {
    selectedBio = bio;
    updateSelectedDisplay();
    renderBios(searchInput.value);
  });
  return div;
}

function updateSelectedDisplay() {
  if (selectedBio) {
    selectedBioDisplay.textContent = selectedBio.name;
    selectedBioDisplay.classList.add('bio-added');
    insertBioButton.disabled = false;
  } else {
    selectedBioDisplay.textContent = '(none)';
    selectedBioDisplay.classList.remove('bio-added');
    insertBioButton.disabled = true;
  }
}

function renderBios(query) {
  const filtered = filterBios(query);
  biosContainer.replaceChildren();

  if (!allBios.length) {
    biosContainer.className = 'loading';
    biosContainer.textContent = 'Loading bios…';
    return;
  }

  if (!filtered.length) {
    biosContainer.className = 'empty';
    biosContainer.textContent = query.trim()
      ? 'No bios match your search.'
      : 'No bios found.';
    return;
  }

  biosContainer.className = '';
  filtered.forEach((bio) => {
    biosContainer.append(createBioElement(bio));
  });
}

async function insertBio() {
  if (!selectedBio) return;

  try {
    // Fetch the source document
    const pageSourceUrl = `https://admin.da.live/source/${state.org}/${state.site}${state.path}.html?nocache=${Date.now()}`;
    const resp = await state.actions.daFetch(pageSourceUrl);
    if (!resp.ok) {
      console.error('Failed to fetch source document');
      state.actions.closeLibrary?.();
      return;
    }

    const text = await resp.text();
    const dom = new DOMParser().parseFromString(text, 'text/html');
    const metadataEl = dom.querySelector('.metadata');

    // Throw error if metadata block doesn't exist
    if (!metadataEl) {
      console.error('Metadata block not found on page. Please add a metadata block before using the bio picker.');
      state.actions.closeLibrary?.();
      return;
    }

    // Find or create the speakers row
    let speakersRow = null;
    [...metadataEl.childNodes].forEach((row) => {
      if (row.children) {
        const key = row.children[0]?.textContent?.trim().toLowerCase();
        if (key && key.startsWith('speakers')) {
          speakersRow = row;
        }
      }
    });

    if (!speakersRow) {
      console.error('No speakers row found in metadata. Please add a speakers row to the metadata block first.');
      state.actions.closeLibrary?.();
      return;
    }

    // Update the speakers value
    if (speakersRow && speakersRow.children[1]) {
      const valueCell = speakersRow.children[1];
      const pElement = valueCell.querySelector('p') || (() => {
        const p = document.createElement('p');
        valueCell.appendChild(p);
        return p;
      })();

      const currentValue = pElement.textContent.trim();
      const speakers = currentValue
        ? currentValue.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      if (!speakers.includes(selectedBio.slug)) {
        speakers.push(selectedBio.slug);
      }

      pElement.textContent = speakers.join(', ');
    }

    // Get the main content and save back to document
    const main = dom.querySelector('main');
    if (main) {
      await saveToDa(main.innerHTML, state.path, state.token);
    }
  } catch (error) {
    console.error('Failed to update speakers:', error);
  }

  state.actions.closeLibrary?.();
}

async function init() {
  let sdk;
  try {
    sdk = await DA_SDK;
  } catch (e) {
    biosContainer.className = 'empty';
    biosContainer.textContent = 'Failed to initialize DA SDK.';
    console.error('DA SDK initialization failed:', e);
    return;
  }

  const { context, token, actions } = sdk || {};
  const org = context?.org || context?.organization || context?.owner;
  const site = context?.site || context?.repo || context?.repository;

  if (!token || !org || !site) {
    biosContainer.className = 'empty';
    biosContainer.textContent = 'No DA org, site or token in the SDK context.';
    return;
  }

  state.org = org;
  state.site = site;
  state.token = token;
  state.path = context?.path || '';
  state.actions = actions || null;

  allBios = await fetchBios();
  renderBios('');
  updateSelectedDisplay();

  searchInput.addEventListener('input', () => {
    renderBios(searchInput.value);
  });

  insertBioButton.addEventListener('click', insertBio);
}

init();
