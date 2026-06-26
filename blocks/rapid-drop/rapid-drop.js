/* Rapid Drop — the orange "Rapid Drop" panel, externalized from home-hero.
  Authored as key/value rows:
    badge | // Launching Soon
    title | The Rapid Drop.
    dek   | 60-second AEM and martech term definitions...
    platforms | <ul><li><a>...</a></li></ul>
    notify-placeholder | you@company.com
    notify-aria | Email
    notify-button | Notify me
    bg | <picture>...</picture>
    id | rapid-drop
*/

function getRowText(el) {
  return el?.textContent?.trim() || '';
}

function normalizeKey(key) {
  return key
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function getCellMedia(cell) {
  if (!cell) return null;
  const picture = cell.querySelector('picture');
  if (picture) return picture.cloneNode(true);
  const img = cell.querySelector('img');
  return img ? img.cloneNode(true) : null;
}

function getCellUrl(cell) {
  const link = cell?.querySelector('a[href]');
  if (link) return link.getAttribute('href');
  const text = getRowText(cell);
  return /^https?:\/\//.test(text) ? text : '';
}

function getPlatformEntries(cell) {
  if (!cell) return [];
  const entries = [];

  const listItems = [...cell.querySelectorAll('li')];
  if (listItems.length) {
    listItems.forEach((li) => {
      const link = li.querySelector('a[href]');
      if (link) {
        entries.push({ label: getRowText(link), href: link.getAttribute('href') || '' });
      } else {
        entries.push({ label: getRowText(li), href: '' });
      }
    });
    return entries.filter((entry) => entry.label);
  }

  const links = [...cell.querySelectorAll('a[href]')];
  if (links.length) {
    links.forEach((link) => {
      entries.push({ label: getRowText(link), href: link.getAttribute('href') || '' });
    });
    return entries.filter((entry) => entry.label);
  }

  const fallback = getRowText(cell);
  if (fallback) entries.push({ label: fallback, href: '' });
  return entries;
}

function parseModel(block) {
  const model = {
    id: 'rapid-drop',
    badge: '',
    title: '',
    dek: '',
    platforms: [],
    notifyPlaceholder: '',
    notifyAria: '',
    notifyButton: '',
    bgMedia: null,
    bgUrl: '',
  };

  const rows = [...block.querySelectorAll(':scope > div')];
  rows.forEach((row) => {
    const cells = [...row.children];
    const keyCell = cells[0] || null;
    const valueCell = cells[1] || keyCell;
    if (!keyCell) return;

    const key = normalizeKey(getRowText(keyCell));
    const value = getRowText(valueCell);

    switch (key) {
      case 'id':
      case 'rapid-id':
      case 'drop-id':
        model.id = value || model.id;
        break;
      case 'badge':
      case 'rapid-badge':
      case 'drop-badge':
        model.badge = value;
        break;
      case 'title':
      case 'rapid-title':
      case 'drop-title':
        model.title = value;
        break;
      case 'dek':
      case 'description':
      case 'rapid-dek':
      case 'drop-dek':
        model.dek = value;
        break;
      case 'platforms':
      case 'platform':
      case 'rapid-platform':
        model.platforms.push(...getPlatformEntries(valueCell));
        break;
      case 'notify-placeholder':
      case 'email-placeholder':
        model.notifyPlaceholder = value;
        break;
      case 'notify-aria':
      case 'email-aria':
        model.notifyAria = value;
        break;
      case 'notify-button':
      case 'notify-label':
      case 'email-button':
        model.notifyButton = value;
        break;
      case 'bg':
      case 'rapid-bg':
      case 'drop-bg':
      case 'rapid-image':
        model.bgMedia = getCellMedia(valueCell);
        model.bgUrl = getCellUrl(valueCell);
        break;
      default:
        break;
    }
  });

  return model;
}

function appendTextElement(parent, tagName, className, text) {
  if (!text) return null;
  const el = document.createElement(tagName);
  el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

export default function decorate(block) {
  const model = parseModel(block);
  block.innerHTML = '';
  if (model.id) block.id = model.id;

  const bg = document.createElement('div');
  bg.className = 'rapid-drop-bg';
  if (model.bgMedia) {
    bg.appendChild(model.bgMedia.cloneNode(true));
  } else if (model.bgUrl) {
    const img = document.createElement('img');
    img.src = model.bgUrl;
    img.alt = '';
    img.loading = 'lazy';
    bg.appendChild(img);
  }
  block.appendChild(bg);

  appendTextElement(block, 'div', 'rapid-drop-badge', model.badge);
  appendTextElement(block, 'h2', 'rapid-drop-title', model.title);
  appendTextElement(block, 'p', 'rapid-drop-dek', model.dek);

  if (model.platforms.length) {
    const platforms = document.createElement('div');
    platforms.className = 'rapid-drop-platforms';
    model.platforms.forEach((platformItem) => {
      const platform = platformItem.href ? document.createElement('a') : document.createElement('span');
      platform.textContent = platformItem.label;
      if (platformItem.href) {
        platform.href = platformItem.href;
        platform.target = '_blank';
        platform.rel = 'noopener noreferrer';
      }
      platforms.appendChild(platform);
    });
    block.appendChild(platforms);
  }

  if (model.notifyButton) {
    const form = document.createElement('form');
    form.className = 'rapid-drop-form';
    form.setAttribute('novalidate', '');

    const input = document.createElement('input');
    input.type = 'email';
    input.placeholder = model.notifyPlaceholder;
    input.setAttribute('aria-label', model.notifyAria || model.notifyPlaceholder || 'Email');

    const button = document.createElement('button');
    button.type = 'submit';
    button.textContent = model.notifyButton;

    form.append(input, button);
    block.appendChild(form);

    // Styled placeholder: no real submit.
    form.addEventListener('submit', (e) => e.preventDefault());
  }
}
