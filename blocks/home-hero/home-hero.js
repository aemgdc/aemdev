/* Home Hero — all user-facing content is authored in the document.
  Supports two authoring shapes:
  1) key/value rows (explicit tokens like slides, chip, rapid-title)
  2) two-column semantic content (preferred for DA): left hero / right rapid

  The right-hand "Rapid Drop" panel is externalized into a fragment and rendered
  by the standalone `rapid-drop` block. Reference it with a `rapid-fragment` row. */

import { loadFragment } from '../fragment/fragment.js';
import { loadStyle, getConfig } from '../../scripts/ak.js';

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

function collectMedia(container) {
  if (!container) return [];

  const pictures = [...container.querySelectorAll('picture')].map((p) => p.cloneNode(true));
  const standaloneImages = [...container.querySelectorAll('img')]
    .filter((img) => !img.closest('picture'))
    .map((img) => img.cloneNode(true));

  return [...pictures, ...standaloneImages];
}

function getCellUrl(cell) {
  const link = cell?.querySelector('a[href]');
  if (link) return link.getAttribute('href');

  const text = getRowText(cell);
  return /^https?:\/\//.test(text) ? text : '';
}

function getCellUrls(cell) {
  if (!cell) return [];

  const urls = [...cell.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href') || '')
    .filter((href) => /^https?:\/\//.test(href));

  const textUrls = getRowText(cell)
    .split(/\s+/)
    .filter((token) => /^https?:\/\//.test(token));

  return [...urls, ...textUrls];
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

  const paragraphs = [...cell.querySelectorAll(':scope > p')];
  if (paragraphs.length) {
    paragraphs.forEach((p) => {
      const link = p.querySelector('a[href]');
      if (link) {
        entries.push({ label: getRowText(link), href: link.getAttribute('href') || '' });
      } else {
        const text = getRowText(p);
        if (text) entries.push({ label: text, href: '' });
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

  const textLines = (cell.innerText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (textLines.length) {
    textLines.forEach((line) => entries.push({ label: line, href: '' }));
    return entries;
  }

  const fallback = getRowText(cell);
  if (fallback) entries.push({ label: fallback, href: '' });
  return entries;
}

function getCta(cell) {
  const link = cell?.querySelector('a[href]');
  if (!link) return null;

  const label = getRowText(link);
  const href = link.getAttribute('href') || '#';
  if (!label) return null;

  return { label, href };
}

function parseModel(block) {
  const model = {
    kicker: '',
    heading: '',
    dek: '',
    chips: [],
    chipsAlt: [],
    primaryCta: null,
    secondaryCta: null,
    slides: [],
    rapidFragment: '',
    rapidId: 'rapid-drop',
    rapidBadge: '',
    rapidTitle: '',
    rapidDek: '',
    platforms: [],
    notifyPlaceholder: '',
    notifyAria: '',
    notifyButton: '',
    rapidBgMedia: null,
    rapidBgUrl: '',
  };

  const rows = [...block.querySelectorAll(':scope > div')];
  rows.forEach((row) => {
    const cells = [...row.children];
    const keyCell = cells[0] || null;
    const valueCell = cells[1] || keyCell;
    if (!keyCell) return;

    // Back-compat: legacy one-cell rows that contain only a slide URL.
    if (cells.length === 1) {
      const legacyUrl = getRowText(keyCell);
      if (/^https?:\/\//.test(legacyUrl)) {
        model.slides.push({ media: null, url: legacyUrl });
        return;
      }
    }

    const key = normalizeKey(getRowText(keyCell));
    const value = getRowText(valueCell);

    switch (key) {
      case 'kicker':
      case 'hero-kicker':
        model.kicker = value;
        break;
      case 'heading':
      case 'title':
      case 'hero-title':
        model.heading = value;
        break;
      case 'dek':
      case 'description':
      case 'hero-dek':
        model.dek = value;
        break;
      case 'chip':
        if (value) model.chips.push(value);
        break;
      case 'chip-alt':
      case 'chip-secondary':
        if (value) model.chipsAlt.push(value);
        break;
      case 'primary-cta':
      case 'cta-primary':
        model.primaryCta = getCta(valueCell);
        break;
      case 'secondary-cta':
      case 'cta-secondary':
        model.secondaryCta = getCta(valueCell);
        break;
      case 'slides':
      case 'slide':
      case 'hero-slide': {
        const medias = collectMedia(valueCell);
        medias.forEach((media) => model.slides.push({ media, url: '' }));

        if (medias.length) break;

        const media = getCellMedia(valueCell);
        const url = getCellUrl(valueCell);
        if (media || url) model.slides.push({ media, url });

        if (!media && !url) {
          const urls = getCellUrls(valueCell);
          urls.forEach((href) => model.slides.push({ media: null, url: href }));
        }
        break;
      }
      case 'rapid-fragment':
      case 'fragment':
      case 'drop-fragment':
        model.rapidFragment = getCellUrl(valueCell) || value;
        break;
      case 'rapid-id':
      case 'drop-id':
        model.rapidId = value || model.rapidId;
        break;
      case 'rapid-badge':
      case 'drop-badge':
        model.rapidBadge = value;
        break;
      case 'rapid-title':
      case 'drop-title':
        model.rapidTitle = value;
        break;
      case 'rapid-dek':
      case 'drop-dek':
      case 'rapid-description':
        model.rapidDek = value;
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
      case 'rapid-bg':
      case 'drop-bg':
      case 'rapid-image': {
        model.rapidBgMedia = getCellMedia(valueCell);
        model.rapidBgUrl = getCellUrl(valueCell);
        break;
      }
      default:
        break;
    }
  });

  return model;
}

function getParagraphText(paragraph) {
  return getRowText(paragraph).replace(/\s+/g, ' ').trim();
}

function parseTwoColumnModel(block) {
  const model = {
    kicker: '',
    heading: '',
    dek: '',
    chips: [],
    chipsAlt: [],
    primaryCta: null,
    secondaryCta: null,
    slides: [],
    rapidFragment: '',
    rapidId: 'rapid-drop',
    rapidBadge: '',
    rapidTitle: '',
    rapidDek: '',
    platforms: [],
    notifyPlaceholder: '',
    notifyAria: '',
    notifyButton: '',
    rapidBgMedia: null,
    rapidBgUrl: '',
  };

  const firstRow = block.querySelector(':scope > div');
  const columns = firstRow ? [...firstRow.children] : [];
  const leftCol = columns[0] || null;
  const rightCol = columns[1] || null;
  if (!leftCol || !rightCol) return model;

  model.slides = collectMedia(leftCol).map((media) => ({ media, url: '' }));

  model.kicker = getRowText(leftCol.querySelector('em'));
  model.heading = getRowText(leftCol.querySelector('h1, h2, h3'));

  const leftParagraphs = [...leftCol.querySelectorAll(':scope > p')]
    .filter((p) => !p.querySelector('a') && !p.querySelector('picture, img') && !p.querySelector('em'));
  model.dek = getParagraphText(leftParagraphs[0]);

  model.chips = [...leftCol.querySelectorAll(':scope > ul li')]
    .map((li) => getRowText(li))
    .filter(Boolean);

  const leftLinks = [...leftCol.querySelectorAll(':scope > p a[href], :scope > a[href]')];
  if (leftLinks[0]) {
    model.primaryCta = {
      label: getRowText(leftLinks[0]),
      href: leftLinks[0].getAttribute('href') || '#',
    };
  }
  if (leftLinks[1]) {
    model.secondaryCta = {
      label: getRowText(leftLinks[1]),
      href: leftLinks[1].getAttribute('href') || '#',
    };
  }

  const rapidMedia = collectMedia(rightCol)[0] || null;
  if (rapidMedia) model.rapidBgMedia = rapidMedia;

  model.rapidBadge = getRowText(rightCol.querySelector('em'));
  const rightHeading = rightCol.querySelector('h1, h2, h3');
  model.rapidTitle = getRowText(rightHeading);
  if (rightHeading?.id) model.rapidId = rightHeading.id;

  const rightParagraphs = [...rightCol.querySelectorAll(':scope > p')];
  const rightDekParagraph = rightParagraphs.find((p) => !p.querySelector('a') && !p.querySelector('picture, img') && !p.querySelector('em'));
  model.rapidDek = getParagraphText(rightDekParagraph);

  model.platforms = [...rightCol.querySelectorAll(':scope > ul li')]
    .map((li) => {
      const link = li.querySelector('a[href]');
      if (link) {
        return { label: getRowText(link), href: link.getAttribute('href') || '' };
      }
      return { label: getRowText(li), href: '' };
    })
    .filter((entry) => entry.label);

  const notifyCandidates = rightParagraphs
    .filter((p) => !p.querySelector('a') && !p.querySelector('picture, img') && !p.querySelector('em'))
    .map((p) => getParagraphText(p))
    .filter(Boolean);
  if (notifyCandidates.length >= 2) {
    model.notifyPlaceholder = notifyCandidates[notifyCandidates.length - 2];
    model.notifyButton = notifyCandidates[notifyCandidates.length - 1];
  }

  return model;
}

function mergeModels(primary, fallback) {
  return {
    ...primary,
    kicker: primary.kicker || fallback.kicker,
    heading: primary.heading || fallback.heading,
    dek: primary.dek || fallback.dek,
    chips: primary.chips.length ? primary.chips : fallback.chips,
    chipsAlt: primary.chipsAlt.length ? primary.chipsAlt : fallback.chipsAlt,
    primaryCta: primary.primaryCta || fallback.primaryCta,
    secondaryCta: primary.secondaryCta || fallback.secondaryCta,
    slides: primary.slides.length ? primary.slides : fallback.slides,
    rapidFragment: primary.rapidFragment || fallback.rapidFragment,
    rapidId: primary.rapidId || fallback.rapidId,
    rapidBadge: primary.rapidBadge || fallback.rapidBadge,
    rapidTitle: primary.rapidTitle || fallback.rapidTitle,
    rapidDek: primary.rapidDek || fallback.rapidDek,
    platforms: primary.platforms.length ? primary.platforms : fallback.platforms,
    notifyPlaceholder: primary.notifyPlaceholder || fallback.notifyPlaceholder,
    notifyAria: primary.notifyAria || fallback.notifyAria,
    notifyButton: primary.notifyButton || fallback.notifyButton,
    rapidBgMedia: primary.rapidBgMedia || fallback.rapidBgMedia,
    rapidBgUrl: primary.rapidBgUrl || fallback.rapidBgUrl,
  };
}

function appendTextElement(parent, tagName, className, text) {
  if (!text) return null;
  const el = document.createElement(tagName);
  el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function createCtaLink(cta, className) {
  if (!cta?.label || !cta?.href) return null;
  const link = document.createElement('a');
  link.className = className;
  link.href = cta.href;
  link.textContent = cta.label;
  return link;
}

function createSlideMedia(slide) {
  if (slide.media) return slide.media.cloneNode(true);
  if (!slide.url) return null;

  const img = document.createElement('img');
  img.src = slide.url;
  img.alt = '';
  img.loading = 'lazy';
  return img;
}

function buildLegacyRight(model) {
  const hasContent = model.rapidBadge || model.rapidTitle || model.rapidDek
    || model.platforms.length || model.notifyButton || model.rapidBgMedia || model.rapidBgUrl;
  if (!hasContent) return null;

  const right = document.createElement('div');
  right.className = 'rapid-drop';
  if (model.rapidId) right.id = model.rapidId;

  const rightBg = document.createElement('div');
  rightBg.className = 'rapid-drop-bg';
  if (model.rapidBgMedia) {
    rightBg.appendChild(model.rapidBgMedia.cloneNode(true));
  } else if (model.rapidBgUrl) {
    const img = document.createElement('img');
    img.src = model.rapidBgUrl;
    img.alt = '';
    img.loading = 'lazy';
    rightBg.appendChild(img);
  }
  right.appendChild(rightBg);

  appendTextElement(right, 'div', 'rapid-drop-badge', model.rapidBadge);
  appendTextElement(right, 'h2', 'rapid-drop-title', model.rapidTitle);
  appendTextElement(right, 'p', 'rapid-drop-dek', model.rapidDek);

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
    right.appendChild(platforms);
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
    right.appendChild(form);

    // Styled placeholder: no real submit.
    form.addEventListener('submit', (e) => e.preventDefault());
  }

  return right;
}

async function buildRight(model) {
  let right = null;
  if (model.rapidFragment) {
    try {
      const fragment = await loadFragment(model.rapidFragment);
      const panel = fragment?.querySelector('.rapid-drop');
      if (panel) right = panel;
    } catch {
      // Fall back to legacy inline rendering below.
    }
  }
  if (!right) right = buildLegacyRight(model);
  // The right panel reuses the standalone `rapid-drop` block styles. When the
  // panel is rendered inline (legacy) the block's CSS would not otherwise load.
  if (right) loadStyle(`${getConfig().codeBase}/blocks/rapid-drop/rapid-drop.css`);
  return right;
}

export default async function decorate(block) {
  const keyValueModel = parseModel(block);
  const twoColumnModel = parseTwoColumnModel(block);
  const model = mergeModels(keyValueModel, twoColumnModel);
  block.innerHTML = '';

  const left = document.createElement('div');
  left.className = 'home-hero-left';

  const stage = document.createElement('div');
  stage.className = 'home-hero-stage';
  stage.setAttribute('aria-hidden', 'true');

  model.slides.forEach((slide, i) => {
    const s = document.createElement('div');
    s.className = 'home-hero-slide';
    s.style.animationDelay = `${i * 6}s`;

    const media = createSlideMedia(slide);
    if (media) s.appendChild(media);

    stage.appendChild(s);
  });
  left.appendChild(stage);

  const dots = document.createElement('div');
  dots.className = 'home-hero-dots';
  dots.setAttribute('aria-hidden', 'true');
  model.slides.forEach((_, i) => {
    const d = document.createElement('span');
    if (i === 0) d.classList.add('on');
    dots.appendChild(d);
  });
  left.appendChild(dots);

  appendTextElement(left, 'div', 'home-hero-kicker', model.kicker);
  appendTextElement(left, 'h1', 'home-hero-h1', model.heading);
  appendTextElement(left, 'p', 'home-hero-dek', model.dek);

  const hasChips = model.chips.length || model.chipsAlt.length;
  if (hasChips) {
    const chips = document.createElement('div');
    chips.className = 'home-hero-chips';
    model.chips.forEach((label) => {
      const chip = document.createElement('span');
      chip.className = 'home-hero-chip';
      chip.textContent = label;
      chips.appendChild(chip);
    });
    model.chipsAlt.forEach((label) => {
      const chip = document.createElement('span');
      chip.className = 'home-hero-chip home-hero-chip--alt';
      chip.textContent = label;
      chips.appendChild(chip);
    });
    left.appendChild(chips);
  }

  const primaryCta = createCtaLink(model.primaryCta, 'home-hero-btn home-hero-btn--primary');
  const secondaryCta = createCtaLink(model.secondaryCta, 'home-hero-btn home-hero-btn--ghost');
  if (primaryCta || secondaryCta) {
    const ctas = document.createElement('div');
    ctas.className = 'home-hero-ctas';
    if (primaryCta) ctas.appendChild(primaryCta);
    if (secondaryCta) ctas.appendChild(secondaryCta);
    left.appendChild(ctas);
  }

  const right = await buildRight(model);

  block.appendChild(left);
  if (right) block.appendChild(right);

  // Section opts in to full-bleed via the home-template CSS hooks.
  const section = block.closest('.section');
  if (section) section.classList.add('home-hero-section');
}
