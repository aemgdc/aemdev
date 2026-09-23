// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import { BIO_PATHS, bioFromRow } from '/tools/bio-manager/bio-doc.js';
import { saveToDa } from '/tools/advanced-search/helper.js';

const DA_SOURCE = 'https://admin.da.live/source';

const searchInput = document.getElementById('bio-search');
const biosContainer = document.getElementById('bios-container');
const currentBioDisplay = document.getElementById('current-bio');
const selectedBiosList = document.getElementById('selected-bios');
const addBioButton = document.getElementById('addBio');
const resetButton = document.getElementById('resetSelection');
const insertBiosButton = document.getElementById('insertBios');

let allBios = [];
let currentBio = null;
const selectedBios = [];
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
  if (currentBio?.slug === bio.slug) {
    div.classList.add('selected');
  }
  div.innerHTML = `
    <div class="bio-name">${escapeHtml(bio.name)}</div>
    <div class="bio-role">${escapeHtml(roleLine(bio)) || '&nbsp;'}</div>
    <div class="bio-slug">${escapeHtml(bio.slug)}</div>
  `;
  div.addEventListener('click', () => {
    currentBio = bio;
    updateCurrentDisplay();
    renderBios(searchInput.value);
  });
  return div;
}

function updateCurrentDisplay() {
  if (currentBio) {
    currentBioDisplay.textContent = currentBio.name;
    addBioButton.disabled = false;
  } else {
    currentBioDisplay.textContent = '(none)';
    addBioButton.disabled = true;
  }
}

function addCurrentBio() {
  if (!currentBio) return;

  if (!selectedBios.find((b) => b.slug === currentBio.slug)) {
    selectedBios.push(currentBio);
  }

  renderSelectedBios();
  insertBiosButton.disabled = selectedBios.length === 0;
}

function renderSelectedBios() {
  selectedBiosList.replaceChildren();
  selectedBios.forEach((bio) => {
    const li = document.createElement('li');
    li.textContent = bio.name;
    li.addEventListener('click', () => {
      const index = selectedBios.indexOf(bio);
      if (index > -1) {
        selectedBios.splice(index, 1);
      }
      renderSelectedBios();
      insertBiosButton.disabled = selectedBios.length === 0;
    });
    selectedBiosList.appendChild(li);
  });
}

function resetSelection() {
  currentBio = null;
  selectedBios.length = 0;
  updateCurrentDisplay();
  renderSelectedBios();
  renderBios(searchInput.value);
  insertBiosButton.disabled = true;
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

async function insertBios() {
  if (selectedBios.length === 0) return;

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

    // Find the speakers row
    let speakersRow = null;
    [...metadataEl.childNodes].forEach((row) => {
      if (row.children) {
        const key = row.children[0]?.textContent?.trim().toLowerCase();
        if (key && key.startsWith('speakers')) {
          speakersRow = row;
        }
      }
    });

    // Create speakers row if it doesn't exist
    if (!speakersRow) {
      speakersRow = document.createElement('div');

      const keyCell = document.createElement('div');
      keyCell.textContent = 'speakers';
      speakersRow.appendChild(keyCell);

      const valueCell = document.createElement('div');
      speakersRow.appendChild(valueCell);

      metadataEl.appendChild(speakersRow);
    }

    // Update the speakers value
    if (speakersRow && speakersRow.children[1]) {
      const valueCell = speakersRow.children[1];
      const pElement = valueCell.querySelector('p') || (() => {
        const p = document.createElement('p');
        valueCell.appendChild(p);
        return p;
      })();

      pElement.textContent = selectedBios.map((bio) => bio.slug).join(', ');
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

  // Load existing speakers from the page
  try {
    const pageSourceUrl = `https://admin.da.live/source/${org}/${site}${context.path}.html?nocache=${Date.now()}`;
    const resp = await actions.daFetch(pageSourceUrl);
    if (resp.ok) {
      const text = await resp.text();
      const dom = new DOMParser().parseFromString(text, 'text/html');
      const metadataEl = dom.querySelector('.metadata');

      if (metadataEl) {
        [...metadataEl.childNodes].forEach((row) => {
          if (row.children) {
            const key = row.children[0]?.textContent?.trim().toLowerCase();
            if (key && key.startsWith('speakers')) {
              const valueCell = row.children[1];
              const pElement = valueCell?.querySelector('p');
              if (pElement) {
                const speakerSlugs = pElement.textContent
                  .trim()
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);

                speakerSlugs.forEach((slug) => {
                  const bio = allBios.find((b) => b.slug === slug);
                  if (bio && !selectedBios.find((b) => b.slug === slug)) {
                    selectedBios.push(bio);
                  }
                });
              }
            }
          }
        });
      }
    }
  } catch (error) {
    console.error('Failed to load existing speakers:', error);
  }

  renderBios('');
  updateCurrentDisplay();
  renderSelectedBios();

  searchInput.addEventListener('input', () => {
    renderBios(searchInput.value);
  });

  addBioButton.addEventListener('click', addCurrentBio);
  resetButton.addEventListener('click', resetSelection);
  insertBiosButton.addEventListener('click', insertBios);
  insertBiosButton.disabled = selectedBios.length === 0;
}

init();