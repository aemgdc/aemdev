function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function getDirectPicture(cell) {
  if (!cell) return null;
  const picture = cell.querySelector('picture');
  if (picture) return picture.cloneNode(true);

  const img = cell.querySelector('img');
  if (!img) return null;

  return img.cloneNode(true);
}

function prepareImage(image) {
  const img = image?.querySelector ? image.querySelector('img') : image;
  if (img) {
    img.loading = img.loading || 'lazy';
    img.decoding = 'async';
  }
  return image;
}

function createCaption(cell) {
  const caption = document.createElement('figcaption');
  caption.className = 'carousel-caption';
  if (cell) caption.innerHTML = cell.innerHTML;
  return caption;
}

function createTrigger(item, index, openLightbox) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'carousel-media-button';
  button.setAttribute('aria-label', item.captionText ? `Open image ${index + 1}: ${item.captionText}` : `Open image ${index + 1}`);
  button.append(prepareImage(item.picture.cloneNode(true)));
  button.addEventListener('click', () => openLightbox(index));
  return button;
}

function createItem(row, index, openLightbox, variant) {
  const cells = [...row.children];
  const mediaCell = cells.find((cell) => cell.querySelector('picture, img')) || cells[0] || null;
  const captionCell = cells.find((cell) => cell !== mediaCell) || null;
  const picture = mediaCell ? getDirectPicture(mediaCell) : null;
  if (!picture) return null;

  const figure = document.createElement('figure');
  figure.className = 'carousel-item';
  if (variant === 'collage') {
    const layoutClasses = [
      'carousel-item--feature',
      'carousel-item--portrait',
      'carousel-item--landscape',
      'carousel-item--square',
      'carousel-item--portrait',
      'carousel-item--wide',
    ];
    figure.classList.add(layoutClasses[index % layoutClasses.length]);
  }

  const captionText = normalizeText(captionCell?.textContent || '');
  figure.append(createTrigger({ picture, captionText }, index, openLightbox));

  if (captionCell) {
    const caption = createCaption(captionCell);
    if (caption.childNodes.length) figure.append(caption);
  }

  return {
    figure,
    picture,
    captionText,
    captionNode: captionCell,
  };
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
  closeButton.textContent = 'Close';

  const counter = document.createElement('div');
  counter.className = 'carousel-lightbox-counter';

  const imageFrame = document.createElement('div');
  imageFrame.className = 'carousel-lightbox-image';

  const caption = document.createElement('div');
  caption.className = 'carousel-lightbox-caption';

  const prevButton = document.createElement('button');
  prevButton.type = 'button';
  prevButton.className = 'carousel-lightbox-nav carousel-lightbox-prev';
  prevButton.setAttribute('aria-label', 'Previous image');
  prevButton.textContent = 'Previous';

  const nextButton = document.createElement('button');
  nextButton.type = 'button';
  nextButton.className = 'carousel-lightbox-nav carousel-lightbox-next';
  nextButton.setAttribute('aria-label', 'Next image');
  nextButton.textContent = 'Next';

  const nav = document.createElement('div');
  nav.className = 'carousel-lightbox-navs';
  nav.append(prevButton, nextButton);

  shell.append(closeButton, counter, imageFrame, caption, nav);
  dialog.append(shell);

  let currentIndex = 0;

  const render = (index) => {
    currentIndex = (index + items.length) % items.length;
    const item = items[currentIndex];
    const image = item.picture.cloneNode(true);
    const img = image.querySelector ? image.querySelector('img') : image;
    if (img) {
      img.loading = 'eager';
      img.decoding = 'async';
    }

    imageFrame.replaceChildren(image);
    caption.replaceChildren();
    if (item.captionNode) caption.innerHTML = item.captionNode.innerHTML;
    counter.textContent = `${currentIndex + 1} / ${items.length}`;
  };

  const move = (delta) => render(currentIndex + delta);

  closeButton.addEventListener('click', () => dialog.close());
  prevButton.addEventListener('click', () => move(-1));
  nextButton.addEventListener('click', () => move(1));
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('keydown', (event) => {
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
  });

  document.body.append(dialog);

  return {
    open(index) {
      if (!items.length) return;
      render(index);
      document.body.classList.add('carousel-lightbox-open');
      dialog.showModal();
    },
  };
}

function createCarousel(block, items, lightbox) {
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
    const total = slides.length;
    if (!total) return;
    const realIndex = (index + total) % total;
    slides[realIndex].scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  };

  items.forEach((item, index) => {
    const slide = document.createElement('figure');
    slide.className = 'carousel-slide';

    const trigger = createTrigger(item, index, lightbox.open);
    trigger.classList.add('carousel-slide-trigger');
    slide.append(trigger);

    if (item.captionText) {
      const caption = createCaption(item.captionNode);
      if (caption.childNodes.length) slide.append(caption);
    }

    const slideWrap = document.createElement('div');
    slideWrap.className = 'carousel-slide-wrap';
    slideWrap.append(slide);
    rail.append(slideWrap);
    slides.push(slideWrap);

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
  const variant = block.classList.contains('collage') ? 'collage' : 'carousel';
  const rows = [...block.querySelectorAll(':scope > div')];
  const items = [];

  block.textContent = '';

  rows.forEach((row, index) => {
    const item = createItem(row, index, () => {}, variant);
    if (item) items.push(item);
  });

  if (!items.length) return;

  const lightbox = createLightbox(items);
  items.forEach((item, index) => {
    const openButton = item.figure.querySelector('.carousel-media-button');
    if (openButton) openButton.addEventListener('click', () => lightbox.open(index));
  });

  if (variant === 'collage') {
    const collage = document.createElement('div');
    collage.className = 'carousel-collage';
    items.forEach((item) => collage.append(item.figure));
    block.append(collage);
    return;
  }

  createCarousel(block, items, lightbox);
}
