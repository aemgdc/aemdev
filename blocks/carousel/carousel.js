/*
 * carousel — a scroll-snap image rail, plus two collage layouts.
 *
 * Variants
 *   carousel                       scroll-snap rail (unchanged)
 *   carousel (collage)             justified collage; captions hidden on the page
 *   carousel (collage, captions)   two-column list — image one side, caption the other
 *
 * Every variant reads the same rows: `| image | caption |`, caption optional. Clicking
 * any image opens the dark lightbox, which is the ONLY place a collage caption is shown.
 *
 * Where the images come from
 *   The collage's intended source is the page's DA dot-folder — for
 *   /en/meetups/aem-meetup-washington-dc that is /en/meetups/.aem-meetup-washington-dc.
 *   That folder cannot be listed from the browser: admin.da.live/list and
 *   content.da.live both require a bearer token, so an anonymous visitor gets 401 and
 *   there is no public listing endpoint to fall back to. The folder is therefore
 *   resolved at authoring time by tools/da/collage-from-folder.js, which lists it and
 *   writes one row per image into the document. That is also the better trade: authored
 *   rows go through Media Bus, so the delivered page gets responsive <picture> sources
 *   AND intrinsic width/height — which is exactly what the justified layout below needs
 *   to place every image before a single byte of image data has loaded.
 *
 * The justified layout
 *   Images keep their true aspect ratio and are packed into rows that each fill the
 *   container, the way Facebook or Flickr pack a photo set. Widths are emitted as
 *   percentages and heights come from `aspect-ratio`, so a row stays correct between
 *   resizes; only the row GROUPING is recomputed, and only when the width changes.
 */

const FALLBACK_RATIO = 3 / 2;

/*
 * Target row height by container width. These are targets, not rules — the packer
 * lands near them and lets the real aspect ratios decide the rest, which is what keeps
 * a collage from looking like a grid.
 */
const ROW_HEIGHT_STEPS = [
  { upTo: 599, height: 190 },
  { upTo: 999, height: 260 },
  { upTo: Infinity, height: 330 },
];

/* How far past the target a final short row may stretch before it is capped instead. */
const LAST_ROW_STRETCH = 2;

function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function targetRowHeight(width) {
  return ROW_HEIGHT_STEPS.find((step) => width <= step.upTo).height;
}

function getDirectPicture(cell) {
  if (!cell) return null;
  const picture = cell.querySelector('picture');
  if (picture) return picture.cloneNode(true);
  const img = cell.querySelector('img');
  return img ? img.cloneNode(true) : null;
}

function getImg(node) {
  if (!node) return null;
  return node.tagName === 'IMG' ? node : node.querySelector('img');
}

/*
 * Intrinsic ratio, cheapest source first. Media Bus stamps width/height onto every
 * <img> it serves, so on a real page this resolves synchronously and nothing shifts.
 * `naturalWidth` covers an already-cached image; null means "ask again after load".
 */
function readRatio(picture) {
  const img = getImg(picture);
  if (!img) return null;
  const w = Number(img.getAttribute('width'));
  const h = Number(img.getAttribute('height'));
  if (w > 0 && h > 0) return w / h;
  if (img.naturalWidth > 0 && img.naturalHeight > 0) return img.naturalWidth / img.naturalHeight;
  return null;
}

function prepareImage(picture, altFallback) {
  const img = getImg(picture);
  if (img) {
    // getAttribute, not `img.loading` — the property reports 'auto' when the attribute
    // is absent, and writing that back is an invalid value that falls back to EAGER,
    // quietly un-lazying every image in the block.
    if (!img.getAttribute('loading')) img.setAttribute('loading', 'lazy');
    img.decoding = 'async';
    if (!img.getAttribute('alt') && altFallback) img.setAttribute('alt', altFallback);
  }
  return picture;
}

function createCaption(item) {
  const caption = document.createElement('figcaption');
  caption.className = 'carousel-caption';
  if (item.captionHTML) caption.innerHTML = item.captionHTML;
  return caption;
}

function createTrigger(item, index, total, open) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'carousel-media-button';
  const position = `${index + 1} of ${total}`;
  button.setAttribute(
    'aria-label',
    item.captionText ? `${item.captionText} — open image ${position}` : `Open image ${position}`,
  );
  button.append(prepareImage(item.picture.cloneNode(true), item.captionText));
  button.addEventListener('click', () => open(index, button));
  return button;
}

/* One row per block row: the first cell holding an image is the media, the next is the caption. */
function readItems(block) {
  return [...block.querySelectorAll(':scope > div')].reduce((items, row) => {
    const cells = [...row.children];
    const mediaCell = cells.find((cell) => cell.querySelector('picture, img')) || cells[0];
    const captionCell = cells.find((cell) => cell !== mediaCell) || null;
    const picture = getDirectPicture(mediaCell);
    if (!picture) return items;
    const ratio = readRatio(picture);
    items.push({
      picture,
      captionHTML: captionCell ? captionCell.innerHTML : '',
      captionText: normalizeText(captionCell?.textContent),
      ratio: ratio || FALLBACK_RATIO,
      ratioKnown: ratio !== null,
    });
    return items;
  }, []);
}

/*
 * Pack items into rows that each fill `width`. When adding an item overshoots the
 * target height, keep it only if that lands CLOSER to the target than stopping short —
 * without that check a single wide panorama can flatten the row it lands in.
 */
function packRows(items, width, height) {
  const targetAspect = width / height;
  const rows = [];
  let current = [];
  let sum = 0;
  let i = 0;

  while (i < items.length) {
    const item = items[i];
    current.push(item);
    sum += item.ratio;
    i += 1;

    if (sum >= targetAspect) {
      const withItem = Math.abs(width / sum - height);
      const withoutItem = current.length > 1
        ? Math.abs(width / (sum - item.ratio) - height)
        : Infinity;
      if (withoutItem < withItem) {
        current.pop();
        sum -= item.ratio;
        i -= 1;
      }
      rows.push({ items: current, sum });
      current = [];
      sum = 0;
    }
  }

  if (current.length) rows.push({ items: current, sum, last: true });
  return rows;
}

/*
 * Emit the packing as CSS custom properties. Widths are fractions of the container, so
 * the browser re-derives real pixels on every reflow and a resize between recomputes
 * still renders a correct row.
 */
function paintRows(container, rows) {
  const width = container.clientWidth;
  const height = targetRowHeight(width);
  const targetAspect = width / height;

  container.replaceChildren(...rows.map((row) => {
    // A short final row fills the width only if that keeps it near the other rows;
    // otherwise it holds the target height and simply ends early.
    const stretches = !row.last || width / row.sum <= height * LAST_ROW_STRETCH;
    const divisor = stretches ? row.sum : targetAspect;

    const el = document.createElement('div');
    el.className = 'carousel-collage-row';
    el.style.setProperty('--collage-row-gaps', String(row.items.length - 1));
    row.items.forEach((item) => {
      item.figure.style.setProperty('--collage-w', (item.ratio / divisor).toFixed(6));
      item.figure.style.setProperty('--collage-ar', item.ratio.toFixed(6));
      el.append(item.figure);
    });
    return el;
  }));
}

function layoutCollage(container, items) {
  const width = container.clientWidth;
  if (!width) return;
  paintRows(container, packRows(items, width, targetRowHeight(width)));
}

/*
 * Re-pack when the width changes. This is not only for resizes — EDS hides a section
 * (`main > div { display: none }`) while its blocks decorate, so the FIRST useful width
 * usually arrives here rather than during decorate. Height is ignored on purpose: the
 * container's own height moves as a result of packing, and reacting to that is how you
 * build a loop.
 */
function observeWidth(container, onChange) {
  let last = container.clientWidth;
  let frame = 0;
  const observer = new ResizeObserver(() => {
    const width = container.clientWidth;
    if (width === last || !width) return;
    last = width;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(onChange);
  });
  observer.observe(container);
}

/*
 * Images whose intrinsic size was not in the markup: measure once they decode, then
 * re-pack. One re-pack for the whole batch, not one per image.
 */
function refineRatios(items, relayout) {
  const pending = items.filter((item) => !item.ratioKnown);
  if (!pending.length) return;

  Promise.allSettled(pending.map((item) => {
    const img = getImg(item.figure.querySelector('picture, img'));
    if (!img) return Promise.reject();
    const done = img.complete ? Promise.resolve() : img.decode();
    return done.then(() => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      item.ratio = img.naturalWidth / img.naturalHeight;
      item.ratioKnown = true;
    });
  })).then(relayout);
}

function createLightbox(items) {
  const dialog = document.createElement('dialog');
  dialog.className = 'carousel-lightbox';

  const shell = document.createElement('div');
  shell.className = 'carousel-lightbox-shell';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'carousel-lightbox-close';
  closeButton.setAttribute('aria-label', 'Close image viewer');

  const stage = document.createElement('div');
  stage.className = 'carousel-lightbox-stage';

  const figure = document.createElement('figure');
  figure.className = 'carousel-lightbox-figure';

  const imageFrame = document.createElement('div');
  imageFrame.className = 'carousel-lightbox-image';

  // The caption lives inside the figure so it tracks the image's width, not the viewport's.
  const caption = document.createElement('figcaption');
  caption.className = 'carousel-lightbox-caption';

  const counter = document.createElement('p');
  counter.className = 'carousel-lightbox-counter';

  const prevButton = document.createElement('button');
  prevButton.type = 'button';
  prevButton.className = 'carousel-lightbox-nav carousel-lightbox-prev';
  prevButton.setAttribute('aria-label', 'Previous image');

  const nextButton = document.createElement('button');
  nextButton.type = 'button';
  nextButton.className = 'carousel-lightbox-nav carousel-lightbox-next';
  nextButton.setAttribute('aria-label', 'Next image');

  figure.append(imageFrame, caption, counter);
  stage.append(prevButton, figure, nextButton);
  shell.append(closeButton, stage);
  dialog.append(shell);

  const single = items.length < 2;
  prevButton.hidden = single;
  nextButton.hidden = single;

  let currentIndex = 0;
  let opener = null;

  const render = (index) => {
    currentIndex = (index + items.length) % items.length;
    const item = items[currentIndex];
    const picture = item.picture.cloneNode(true);
    const img = getImg(picture);
    if (img) {
      img.loading = 'eager';
      img.decoding = 'async';
      if (!img.getAttribute('alt') && item.captionText) img.setAttribute('alt', item.captionText);
    }
    imageFrame.replaceChildren(picture);
    caption.innerHTML = item.captionHTML || '';
    caption.hidden = !item.captionText;
    counter.textContent = single ? '' : `${currentIndex + 1} / ${items.length}`;
    dialog.setAttribute('aria-label', item.captionText || `Image ${currentIndex + 1}`);
  };

  const move = (delta) => render(currentIndex + delta);

  closeButton.addEventListener('click', () => dialog.close());
  prevButton.addEventListener('click', () => move(-1));
  nextButton.addEventListener('click', () => move(1));

  // Backdrop click closes; a click on the shell's empty margin counts as backdrop.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog || event.target === shell || event.target === stage) dialog.close();
  });

  dialog.addEventListener('keydown', (event) => {
    if (single) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      move(1);
    }
  });

  dialog.addEventListener('close', () => {
    document.body.classList.remove('carousel-lightbox-open');
    imageFrame.replaceChildren();
    opener?.focus();
    opener = null;
  });

  document.body.append(dialog);

  return {
    dialog,
    open(index, trigger) {
      if (!items.length) return;
      opener = trigger || null;
      render(index);
      document.body.classList.add('carousel-lightbox-open');
      dialog.showModal();
    },
  };
}

function buildCollage(block, items, open) {
  const container = document.createElement('div');
  container.className = 'carousel-collage';

  items.forEach((item, index) => {
    const fig = document.createElement('figure');
    fig.className = 'carousel-item';
    fig.append(createTrigger(item, index, items.length, open));
    // Kept in the DOM but visually hidden: the caption still reaches assistive tech and
    // crawlers, it just never draws over the picture.
    const caption = createCaption(item);
    if (caption.childNodes.length) fig.append(caption);
    item.figure = fig;
  });

  block.append(container);

  const relayout = () => layoutCollage(container, items);
  relayout();
  observeWidth(container, relayout);
  refineRatios(items, relayout);
}

function buildCaptionList(block, items, open) {
  const list = document.createElement('div');
  list.className = 'carousel-caption-list';

  items.forEach((item, index) => {
    const fig = document.createElement('figure');
    fig.className = 'carousel-item carousel-item-split';
    // Only when it is the image's REAL ratio — a guessed one would size the box wrong
    // and then visibly correct itself once the image lands.
    if (item.ratioKnown) fig.style.setProperty('--collage-ar', item.ratio.toFixed(6));
    fig.append(createTrigger(item, index, items.length, open), createCaption(item));
    item.figure = fig;
    list.append(fig);
  });

  block.append(list);
}

function buildRail(block, items, open) {
  const shell = document.createElement('div');
  shell.className = 'carousel-shell';

  const rail = document.createElement('div');
  rail.className = 'carousel-rail';

  const indicators = document.createElement('div');
  indicators.className = 'carousel-indicators';

  const nav = document.createElement('div');
  nav.className = 'carousel-nav';

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.className = 'carousel-nav-button carousel-nav-button-prev';
  prev.setAttribute('aria-label', 'Previous image');
  prev.textContent = 'Previous';

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'carousel-nav-button carousel-nav-button-next';
  next.setAttribute('aria-label', 'Next image');
  next.textContent = 'Next';

  nav.append(prev, next);

  const slides = [];
  let activeIndex = 0;

  const scrollToIndex = (index) => {
    if (!slides.length) return;
    const real = (index + slides.length) % slides.length;
    slides[real].scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  };

  items.forEach((item, index) => {
    const slide = document.createElement('figure');
    slide.className = 'carousel-slide';
    slide.append(createTrigger(item, index, items.length, open));

    if (item.captionText) slide.append(createCaption(item));

    const wrap = document.createElement('div');
    wrap.className = 'carousel-slide-wrap';
    wrap.append(slide);
    rail.append(wrap);
    slides.push(wrap);

    const indicator = document.createElement('button');
    indicator.type = 'button';
    indicator.className = 'carousel-indicator';
    indicator.setAttribute('aria-label', `Show image ${index + 1} of ${items.length}`);
    indicator.addEventListener('click', () => scrollToIndex(index));
    indicators.append(indicator);
  });

  const updateActive = (index) => {
    activeIndex = index;
    [...indicators.children].forEach((button, idx) => {
      if (idx === activeIndex) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
      button.disabled = idx === activeIndex;
    });
  };

  prev.addEventListener('click', () => scrollToIndex(activeIndex - 1));
  next.addEventListener('click', () => scrollToIndex(activeIndex + 1));

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const index = slides.indexOf(entry.target);
      if (index >= 0) updateActive(index);
    });
  }, { threshold: 0.6 });

  slides.forEach((slide) => observer.observe(slide));
  updateActive(0);

  shell.append(nav, rail, indicators);
  block.append(shell);
}

export default function decorate(block) {
  const items = readItems(block);
  block.textContent = '';
  if (!items.length) return;

  const collage = block.classList.contains('collage');
  const split = block.classList.contains('captions');
  const lightbox = createLightbox(items);

  if (split) buildCaptionList(block, items, lightbox.open);
  else if (collage) buildCollage(block, items, lightbox.open);
  else buildRail(block, items, lightbox.open);
}
