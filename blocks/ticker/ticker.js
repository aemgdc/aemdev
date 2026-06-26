/* Ticker — animated marquee configurable from block rows:
   - source: link/path to a brands fragment
   - mode: names | logos
   If source is not set, falls back to inline text split by | or ·. */

const DEFAULT_ITEMS = [
  'AEM Champion',
  '15+ Years',
  'Featured Speaker',
  'Edge Delivery',
  'AEM 6.5 LTS',
  'AEMaaCS',
  'Hard Problems Welcome',
  'Mountain Biker',
];

const DEFAULT_SOURCE = '/fragments/brands/aem-brands';

function normalizeKey(key) {
  return key
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function getCellText(cell) {
  return cell?.textContent?.trim() || '';
}

function getCellPath(cell) {
  const link = cell?.querySelector('a[href]');
  if (link) return link.getAttribute('href') || '';
  return getCellText(cell);
}

function normalizeMode(value) {
  const mode = value.toLowerCase().trim();
  return mode === 'logos' ? 'logos' : 'names';
}

function parseConfig(block) {
  const rows = [...block.querySelectorAll(':scope > div')];
  const config = {
    source: DEFAULT_SOURCE,
    mode: block.classList.contains('logos') ? 'logos' : 'names',
  };

  rows.forEach((row) => {
    const cells = [...row.children];
    if (cells.length < 2) return;

    const key = normalizeKey(getCellText(cells[0]));
    const valueCell = cells[1];

    if (['source', 'fragment', 'brands', 'data-source'].includes(key)) {
      config.source = getCellPath(valueCell);
    }

    if (['mode', 'display', 'ticker-mode'].includes(key)) {
      config.mode = normalizeMode(getCellText(valueCell));
    }
  });

  return config;
}

function resolveUrl(path) {
  try {
    return new URL(path, window.location.href).href;
  } catch {
    return path;
  }
}

async function loadBrands(path) {
  const url = resolveUrl(path);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Unable to load ticker source: ${path}`);

  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const tableRows = [...doc.querySelectorAll('main table tr')];
  if (tableRows.length) {
    return tableRows
      .map((row) => {
        const cells = [...row.children];
        if (cells.length < 2) return null;

        const name = getCellText(cells[0]);
        if (!name || name.toLowerCase() === 'brand') return null;

        const logoImg = cells[1].querySelector('picture img, img');
        if (logoImg) {
          return {
            name,
            logo: resolveUrl(logoImg.getAttribute('src') || ''),
          };
        }

        const logoLink = cells[1].querySelector('a[href]');
        const href = logoLink?.getAttribute('href') || '';
        return {
          name,
          logo: href ? resolveUrl(href) : '',
        };
      })
      .filter(Boolean);
  }

  const brandRows = [...doc.querySelectorAll('main .brand > div')];
  if (brandRows.length) {
    return brandRows
      .map((row) => {
        const cells = [...row.children];
        if (cells.length < 2) return null;

        const name = getCellText(cells[0]);
        if (!name) return null;

        const logoImg = cells[1].querySelector('picture img, img');
        if (logoImg) {
          return {
            name,
            logo: resolveUrl(logoImg.getAttribute('src') || ''),
          };
        }

        const logoLink = cells[1].querySelector('a[href]');
        const href = logoLink?.getAttribute('href') || '';
        return {
          name,
          logo: href ? resolveUrl(href) : '',
        };
      })
      .filter(Boolean);
  }

  const rows = [...doc.querySelectorAll('main > div > div')];
  return rows
    .map((row) => {
      const cells = [...row.children];
      if (cells.length < 2) return null;

      const name = getCellText(cells[0]);
      if (!name) return null;

      const logoImg = cells[1].querySelector('picture img, img');
      if (logoImg) {
        return {
          name,
          logo: resolveUrl(logoImg.getAttribute('src') || ''),
        };
      }

      const logoLink = cells[1].querySelector('a[href]');
      const href = logoLink?.getAttribute('href') || '';
      return {
        name,
        logo: href ? resolveUrl(href) : '',
      };
    })
    .filter(Boolean);
}

function readInlineItems(block) {
  const text = block.textContent.trim();
  if (!text) return DEFAULT_ITEMS;
  return text.split(/\s*[|·]\s*/).filter(Boolean);
}

function createNameNode(label) {
  const el = document.createElement('em');
  el.className = 'ticker-item';
  el.textContent = label;
  return el;
}

function createLogoNode(entry) {
  if (!entry.logo) return createNameNode(entry.name);

  const wrap = document.createElement('span');
  wrap.className = 'ticker-logo-item';

  const img = document.createElement('img');
  img.className = 'ticker-logo';
  img.src = entry.logo;
  img.alt = `${entry.name} logo`;
  img.loading = 'lazy';

  wrap.appendChild(img);
  return wrap;
}

function appendDot(parent) {
  const dot = document.createElement('em');
  dot.className = 'ticker-dot';
  dot.setAttribute('aria-hidden', 'true');
  dot.textContent = '●';
  parent.appendChild(dot);
}

export default async function decorate(block) {
  const inlineItems = readInlineItems(block);
  const config = parseConfig(block);
  let brands = [];

  if (config.source) {
    try {
      brands = await loadBrands(config.source);
    } catch (e) {
      // Keep ticker functional even if source fails.
      console.warn(e.message);
    }
  }

  block.innerHTML = '';
  block.classList.toggle('ticker--logos', config.mode === 'logos');
  block.classList.toggle('ticker--names', config.mode !== 'logos');

  const track = document.createElement('div');
  track.className = 'ticker-track';

  const hasBrands = brands.length > 0;

  for (let copy = 0; copy < 2; copy += 1) {
    const line = document.createElement('span');

    if (hasBrands) {
      brands.forEach((entry) => {
        const node = config.mode === 'logos' ? createLogoNode(entry) : createNameNode(entry.name);
        line.appendChild(node);
        appendDot(line);
      });
    } else {
      inlineItems.forEach((item) => {
        line.appendChild(createNameNode(item));
        appendDot(line);
      });
    }

    track.appendChild(line);
  }

  block.appendChild(track);

  const section = block.closest('.section');
  if (section) section.classList.add('ticker-section');
}
