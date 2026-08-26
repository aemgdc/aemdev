/* Home Hero — all user-facing content is authored in the document.
  Supports two authoring shapes:
  1) key/value rows (explicit tokens like slides, chip, rapid-title)
  2) two-column semantic content (preferred for DA): left hero / right rapid

  The right-hand "Rapid Drop" panel is externalized into a fragment and rendered
  by the standalone `rapid-drop` block. Reference it with a `rapid-fragment` row.

  NEXT-MEETUP PROMO
  A promo panel sits to the right of the hero copy on desktop and stacks under it
  on mobile. Authored rows win; with none, the panel finds the soonest event in
  the query index itself, so the hero never promotes a meetup that has already
  happened. Optional rows:

    event-kicker   | Next AEM Meetup        (label on the red bar)
    event-title    | ...                    (the meetup's headline)
    event-dek      | ...                    (one supporting line)
    event-date     | 2026-08-27             (ISO is formatted; any other text
                                             is printed verbatim)
    event-location | Washington, DC
    event-image    | <picture> or a URL     (event artwork / poster)
    event-link     | /en/meetups/...        (where the artwork + headline go)
    event-cta      | [Register free →](...) (the red button)
    event-index    | /en/query-index.json   (index used to find the next event)
    event-auto     | off                    (never auto-fill; authored rows only)
*/

import { loadFragment } from '../fragment/fragment.js';
import { loadStyle, getConfig } from '../../scripts/ak.js';
import { dateValue, parseDate } from '../../scripts/utils/date.js';

/* Statuses the meetup pages use for an event that has not happened yet — the
   same pair the `insights` block badges as UPCOMING EVENT. */
const UPCOMING_STATUSES = ['upcoming', 'announced'];
const DEFAULT_EVENT_INDEX = '/en/query-index.json';
const DEFAULT_EVENT_KICKER = 'Next AEM Meetup';
const DEFAULT_EVENT_CTA = 'Event details →';
/* DA-hosted assets are indexed as bare paths and need their host back. */
const DA_HOST = 'https://content.da.live';

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

/* Like getCellUrl, but also accepts a site-relative path (/en/meetups/...),
   which is what an author reaches for when linking to one of our own pages. */
function getCellHref(cell) {
  const link = cell?.querySelector('a[href]');
  if (link) return link.getAttribute('href');

  const text = getRowText(cell);
  return /^(https?:\/\/|\/)/.test(text) ? text : '';
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
    eventKicker: '',
    eventTitle: '',
    eventDek: '',
    eventDate: '',
    eventLocation: '',
    eventMedia: null,
    eventImageUrl: '',
    eventLink: '',
    eventCta: null,
    eventIndex: '',
    eventAuto: true,
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
      case 'event-kicker':
      case 'next-event-kicker':
        model.eventKicker = value;
        break;
      case 'event':
      case 'event-title':
      case 'next-event':
        model.eventTitle = value;
        break;
      case 'event-dek':
      case 'event-description':
        model.eventDek = value;
        break;
      case 'event-date':
      case 'event-when':
        model.eventDate = value;
        break;
      case 'event-location':
      case 'event-where':
        model.eventLocation = value;
        break;
      case 'event-image':
      case 'event-art':
      case 'event-poster':
        model.eventMedia = getCellMedia(valueCell);
        model.eventImageUrl = getCellHref(valueCell);
        break;
      case 'event-link':
      case 'event-url':
        model.eventLink = getCellHref(valueCell);
        break;
      case 'event-cta':
      case 'event-button':
        model.eventCta = getCta(valueCell);
        break;
      case 'event-index':
        if (value.startsWith('/')) model.eventIndex = value;
        break;
      case 'event-auto':
        model.eventAuto = !/^(off|false|no|none)$/i.test(value);
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
    eventKicker: '',
    eventTitle: '',
    eventDek: '',
    eventDate: '',
    eventLocation: '',
    eventMedia: null,
    eventImageUrl: '',
    eventLink: '',
    eventCta: null,
    eventIndex: '',
    eventAuto: true,
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

/* ---------------------------------------------------------------------------
   Next-meetup promo panel
   --------------------------------------------------------------------------- */

/* An ISO date becomes "Thu, Aug 27, 2026". Anything else — "27 Aug, 6–9PM ET" —
   is the author's own wording and is printed untouched. */
function formatEventDate(raw, locale = 'en-US') {
  const text = raw ? String(raw).trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = parseDate(text);
  if (!date) return text;
  return date.toLocaleDateString(locale, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

/* Index rows carry DA asset paths; absolute URLs and site paths pass through. */
function resolveEventImage(src) {
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('/aemgdc/')) return `${DA_HOST}${src}`;
  return src;
}

/* `reserve` keeps the empty frame for the pending placeholder, whose whole job
   is to hold the column's height. A finished card with no artwork drops the
   frame instead of showing a poster-sized hole. */
function createEventMedia(event, reserve) {
  const media = document.createElement('div');
  media.className = 'home-hero-event-media';

  if (event.media) {
    media.appendChild(event.media.cloneNode(true));
    return media;
  }

  const src = resolveEventImage(event.imageUrl);
  if (!src) {
    if (!reserve) return null;
    media.classList.add('home-hero-event-media-empty');
    return media;
  }

  const img = document.createElement('img');
  img.src = src;
  /* The poster repeats the headline as pixels, so the headline below it is the
     accessible copy — an alt that repeats it would be read twice. */
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  media.appendChild(img);
  return media;
}

function createEventPanel(event, { reserveMedia = false } = {}) {
  const panel = document.createElement('aside');
  panel.className = 'home-hero-event';
  panel.setAttribute('aria-label', event.kicker || DEFAULT_EVENT_KICKER);

  appendTextElement(panel, 'p', 'home-hero-event-kicker', event.kicker || DEFAULT_EVENT_KICKER);

  const hasLink = Boolean(event.link);
  const main = document.createElement(hasLink ? 'a' : 'div');
  main.className = 'home-hero-event-main';
  if (hasLink) main.href = event.link;
  const media = createEventMedia(event, reserveMedia);
  if (media) main.appendChild(media);
  appendTextElement(main, 'h2', 'home-hero-event-title', event.title);
  panel.appendChild(main);

  appendTextElement(panel, 'p', 'home-hero-event-dek', event.dek);

  const when = formatEventDate(event.date);
  if (when || event.location) {
    const meta = document.createElement('p');
    meta.className = 'home-hero-event-meta';
    [when, event.location].filter(Boolean).forEach((part) => {
      const span = document.createElement('span');
      span.textContent = part;
      meta.appendChild(span);
    });
    panel.appendChild(meta);
  }

  const cta = createCtaLink(event.cta, 'home-hero-event-cta');
  if (cta) {
    /* A registration link leaves the site; an internal event page does not. */
    if (/^https?:\/\//i.test(event.cta.href)) {
      cta.target = '_blank';
      cta.rel = 'noopener noreferrer';
    }
    panel.appendChild(cta);
  }

  return panel;
}

function authoredEvent(model) {
  if (!model.eventTitle) return null;
  const link = model.eventLink || model.eventCta?.href || '';
  return {
    kicker: model.eventKicker,
    title: model.eventTitle,
    dek: model.eventDek,
    date: model.eventDate,
    location: model.eventLocation,
    media: model.eventMedia,
    imageUrl: model.eventImageUrl,
    link,
    cta: model.eventCta || (link ? { label: DEFAULT_EVENT_CTA, href: link } : null),
  };
}

function isUpcoming(row) {
  return UPCOMING_STATUSES.includes((row.status || '').trim().toLowerCase());
}

/* Soonest first. An `announced` event with no date yet sorts last within the
   group rather than jumping the queue ahead of a dated meetup. */
function byEventDate(a, b) {
  const da = dateValue(a.eventDate) || Number.MAX_SAFE_INTEGER;
  const db = dateValue(b.eventDate) || Number.MAX_SAFE_INTEGER;
  return da - db;
}

function pickNextEvent(rows, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return rows
    .filter(isUpcoming)
    .filter((row) => {
      const date = parseDate(row.eventDate);
      /* A dateless `announced` event is still ahead of us; a dated one is only
         worth promoting up to and including the day it happens. */
      return !date || date.getTime() >= today;
    })
    .sort(byEventDate)[0] || null;
}

function eventFromIndexRow(row, model) {
  return {
    kicker: model.eventKicker,
    title: row.title || '',
    dek: model.eventDek || row.description || '',
    date: row.eventDate || '',
    location: row.location || '',
    media: null,
    imageUrl: row.image || '',
    link: row.path || '',
    cta: model.eventCta || (row.path ? { label: DEFAULT_EVENT_CTA, href: row.path } : null),
  };
}

async function fetchNextEvent(indexPath) {
  const resp = await fetch(indexPath);
  if (!resp.ok) return null;
  const json = await resp.json();
  return pickNextEvent(Array.isArray(json?.data) ? json.data : []);
}

/* Renders the panel now when it can, and reserves its column while the index is
   in flight — the hero must not wait on a network round trip to paint. */
function attachEventPanel(inner, model) {
  const authored = authoredEvent(model);
  if (authored) {
    inner.classList.add('home-hero-inner-split');
    inner.appendChild(createEventPanel(authored));
    return;
  }
  if (!model.eventAuto) return;

  const placeholder = createEventPanel({ kicker: model.eventKicker }, { reserveMedia: true });
  placeholder.classList.add('home-hero-event-pending');
  inner.classList.add('home-hero-inner-split');
  inner.appendChild(placeholder);

  /* Nothing to promote, or the index is unreachable: leave the hero as it was
     rather than sitting on an empty box. */
  const drop = () => {
    placeholder.remove();
    inner.classList.remove('home-hero-inner-split');
  };

  fetchNextEvent(model.eventIndex || DEFAULT_EVENT_INDEX)
    .then((row) => {
      if (!row) return drop();
      return placeholder.replaceWith(createEventPanel(eventFromIndexRow(row, model)));
    })
    .catch(drop);
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

  /* `inner` carries the centred content column so the hero copy and the
     next-meetup promo can sit side by side; the rapid-drop panel stays a
     full-bleed sibling of it, exactly as before. */
  const inner = document.createElement('div');
  inner.className = 'home-hero-inner';
  inner.appendChild(left);
  attachEventPanel(inner, model);

  block.appendChild(inner);
  if (right) block.appendChild(right);

  // Section opts in to full-bleed via the home-template CSS hooks.
  const section = block.closest('.section');
  if (section) section.classList.add('home-hero-section');
}
