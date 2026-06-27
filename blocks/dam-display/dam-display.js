/**
 * DAM Display Block
 * Fetches DAM asset metadata from the DAM servlet and renders content
 * based on the configured mode.
 *
 * Content model (key-value rows):
 *   | filepath | /content/dam/...         |
 *   | mode     | pdf | images             |
 *
 * Modes:
 *   - pdf    : renders a styled card grid of PDF documents (default)
 *   - images : renders an image grid with lightbox gallery
 *
 * @param {HTMLElement} block The block element
 */

const SERVLET_PATH = '/services/damservlet?path=';
const RENDITION_NAME = 'cq5dam.web.1280.1280.jpeg';

// AEM origin that hosts the DAM servlet and assets. The EDS frontends
// (localhost, *.aem.page, www.aemdev.org) do not consistently proxy
// /services/* to this AEM, so the block always calls it directly. The
// servlet returns permissive CORS headers, so cross-origin fetches work
// from every environment.
const AEM_ORIGIN = 'https://blog.arborydigital.com';

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the full servlet URL against the AEM origin.
 * @param {string} filepath DAM path (e.g. /content/dam/meetup/pdf)
 * @returns {string}
 */
function getServletUrl(filepath) {
  return `${AEM_ORIGIN}${SERVLET_PATH}${encodeURIComponent(filepath)}`;
}

/**
 * Extract key-value parameters from the authored block rows.
 * Each row is expected as: | key | value |
 * @param {HTMLElement} block
 * @returns {Object} Map of lowercase key → trimmed value
 */
function getBlockParams(block) {
  const params = {};
  [...block.children].forEach((row) => {
    const cells = [...row.children];
    if (cells.length >= 2) {
      const key = cells[0].textContent.trim().toLowerCase();
      const value = cells[1].textContent.trim();
      params[key] = value;
    }
  });
  return params;
}

/**
 * Find the web rendition image path from an asset's renditions array.
 * @param {Array} renditions
 * @returns {string|null}
 */
function getImagePath(renditions) {
  if (!renditions || !Array.isArray(renditions)) return null;
  const rendition = renditions.find((r) => r.name === RENDITION_NAME);
  return rendition ? rendition.path : null;
}

/**
 * Render error state.
 * @param {HTMLElement} block
 * @param {string} message
 */
function renderError(block, message) {
  const errorEl = document.createElement('div');
  errorEl.className = 'dam-display-error';
  errorEl.textContent = message;
  block.replaceChildren(errorEl);
}

/**
 * Render empty state.
 * @param {HTMLElement} block
 * @param {string} label Asset type label for the message
 */
function renderEmpty(block, label = 'assets') {
  const emptyEl = document.createElement('div');
  emptyEl.className = 'dam-display-empty';
  emptyEl.textContent = `No ${label} found.`;
  block.replaceChildren(emptyEl);
}

/* ------------------------------------------------------------------ */
/*  PDF mode                                                           */
/* ------------------------------------------------------------------ */

/**
 * Format file size in bytes to megabytes with single-digit precision.
 * @param {string|number} bytes
 * @returns {string} e.g. "19.7 MB"
 */
function formatSizeInMB(bytes) {
  const numBytes = Number(bytes);
  if (Number.isNaN(numBytes) || numBytes <= 0) return '';
  const mb = numBytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

/**
 * Create a single PDF card element.
 * @param {Object} pdf - PDF metadata object from the servlet
 * @returns {HTMLElement}
 */
function createPdfCard(pdf) {
  const li = document.createElement('li');
  li.className = 'dam-display-item';

  const card = document.createElement('article');
  card.className = 'dam-display-card';

  // Image / thumbnail
  const imagePath = getImagePath(pdf.renditions);
  if (imagePath) {
    const imageLink = document.createElement('a');
    imageLink.className = 'dam-display-image-link';
    imageLink.href = pdf.path;
    imageLink.target = '_blank';
    imageLink.rel = 'noopener noreferrer';
    imageLink.title = pdf.title || 'Download PDF';

    const img = document.createElement('img');
    img.src = imagePath;
    img.alt = pdf.title || 'PDF preview';
    img.loading = 'lazy';
    imageLink.append(img);
    card.append(imageLink);
  }

  // Content container
  const content = document.createElement('div');
  content.className = 'dam-display-content';

  // Title
  if (pdf.title) {
    const titleLink = document.createElement('a');
    titleLink.className = 'dam-display-title-link';
    titleLink.href = pdf.path;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener noreferrer';

    const title = document.createElement('h3');
    title.className = 'dam-display-title';
    title.textContent = pdf.title;
    titleLink.append(title);
    content.append(titleLink);
  }

  // Description
  const description = pdf['dc:description'];
  if (description) {
    const desc = document.createElement('p');
    desc.className = 'dam-display-description';
    desc.textContent = description;
    content.append(desc);
  }

  // PDF badge
  const badge = document.createElement('span');
  badge.className = 'dam-display-badge';
  const sizeStr = formatSizeInMB(pdf['dam:size']);
  badge.textContent = sizeStr ? `PDF | ${sizeStr}` : 'PDF';
  content.append(badge);

  card.append(content);
  li.append(card);
  return li;
}

/**
 * Render PDF card grid.
 * @param {HTMLElement} block
 * @param {Array} data - Array of PDF metadata objects
 */
function renderPdfMode(block, data) {
  if (!Array.isArray(data) || data.length === 0) {
    renderEmpty(block, 'PDF files');
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'dam-display-list';
  data.forEach((pdf) => ul.append(createPdfCard(pdf)));
  block.replaceChildren(ul);
}

/* ------------------------------------------------------------------ */
/*  Images mode (lightbox gallery)                                     */
/* ------------------------------------------------------------------ */

/**
 * Create a single image card element for the grid.
 * @param {Object} asset - Image metadata from the servlet
 * @returns {HTMLElement}
 */
function createImageCard(asset) {
  const li = document.createElement('li');
  li.className = 'dam-display-item';

  const card = document.createElement('article');
  card.className = 'dam-display-card dam-display-card-image';

  const imagePath = getImagePath(asset.renditions);
  const src = imagePath || asset.path;

  const imgWrapper = document.createElement('div');
  imgWrapper.className = 'dam-display-image-wrapper';

  const img = document.createElement('img');
  img.src = src;
  img.alt = asset.title || 'Image';
  img.loading = 'lazy';
  img.dataset.fullSrc = asset.path; // original for lightbox
  imgWrapper.append(img);
  card.append(imgWrapper);

  // Caption / title below the image
  if (asset.title) {
    const caption = document.createElement('div');
    caption.className = 'dam-display-caption';
    caption.textContent = asset.title;
    card.append(caption);
  }

  li.append(card);
  return li;
}

/**
 * Build and attach the lightbox overlay to the document body.
 * Returns an API object with show/hide helpers.
 * @param {NodeList|Array} images - The grid <img> elements
 * @returns {Object} { show(index), hide() }
 */
function createLightbox(images) {
  const lightbox = document.createElement('div');
  lightbox.className = 'dam-display-lightbox';

  const content = document.createElement('div');
  content.className = 'dam-display-lightbox-content';

  const lightboxImg = document.createElement('img');
  content.append(lightboxImg);

  const lightboxCaption = document.createElement('div');
  lightboxCaption.className = 'dam-display-lightbox-caption';
  content.append(lightboxCaption);

  lightbox.append(content);

  // Navigation
  const closeBtn = document.createElement('button');
  closeBtn.className = 'dam-display-lightbox-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.setAttribute('aria-label', 'Close');
  lightbox.append(closeBtn);

  const prevBtn = document.createElement('button');
  prevBtn.className = 'dam-display-lightbox-nav dam-display-lightbox-prev';
  prevBtn.innerHTML = '&#8249;';
  prevBtn.setAttribute('aria-label', 'Previous image');
  lightbox.append(prevBtn);

  const nextBtn = document.createElement('button');
  nextBtn.className = 'dam-display-lightbox-nav dam-display-lightbox-next';
  nextBtn.innerHTML = '&#8250;';
  nextBtn.setAttribute('aria-label', 'Next image');
  lightbox.append(nextBtn);

  document.body.append(lightbox);

  let currentIndex = 0;

  function show(index) {
    currentIndex = index;
    const img = images[index];
    const fullSrc = img.dataset.fullSrc || img.src;

    lightboxImg.style.opacity = '0';
    lightboxCaption.style.opacity = '0';
    lightboxImg.src = fullSrc;
    lightboxImg.alt = img.alt;

    // Caption from the card
    const item = img.closest('.dam-display-item');
    const captionEl = item ? item.querySelector('.dam-display-caption') : null;
    if (captionEl && captionEl.textContent.trim()) {
      lightboxCaption.textContent = captionEl.textContent;
      lightboxCaption.style.display = 'block';
    } else {
      lightboxCaption.style.display = 'none';
    }

    lightboxImg.onload = () => {
      if (lightboxCaption.style.display !== 'none') {
        lightboxCaption.style.width = `${lightboxImg.offsetWidth}px`;
      }
      lightboxImg.style.opacity = '1';
      lightboxCaption.style.opacity = '1';
    };

    prevBtn.style.display = index > 0 ? 'flex' : 'none';
    nextBtn.style.display = index < images.length - 1 ? 'flex' : 'none';
    lightbox.classList.add('active');
  }

  function hide() {
    lightbox.classList.remove('active');
  }

  // Event listeners
  closeBtn.addEventListener('click', hide);
  prevBtn.addEventListener('click', () => { if (currentIndex > 0) show(currentIndex - 1); });
  nextBtn.addEventListener('click', () => { if (currentIndex < images.length - 1) show(currentIndex + 1); });

  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) hide();
  });

  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('active')) return;
    if (e.key === 'Escape') hide();
    else if (e.key === 'ArrowLeft' && currentIndex > 0) show(currentIndex - 1);
    else if (e.key === 'ArrowRight' && currentIndex < images.length - 1) show(currentIndex + 1);
  });

  return { show, hide };
}

/**
 * Render image gallery with lightbox.
 * @param {HTMLElement} block
 * @param {Array} data - Array of image metadata objects
 */
function renderImagesMode(block, data) {
  if (!Array.isArray(data) || data.length === 0) {
    renderEmpty(block, 'images');
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'dam-display-list dam-display-list-images';
  data.forEach((asset) => ul.append(createImageCard(asset)));
  block.replaceChildren(ul);

  // Wire up lightbox
  const imgs = block.querySelectorAll('.dam-display-image-wrapper img');
  const lb = createLightbox([...imgs]);

  imgs.forEach((img, index) => {
    img.style.cursor = 'pointer';

    // Fade-in on load
    img.style.opacity = '0';
    img.addEventListener('load', () => {
      img.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      img.style.opacity = '1';
    });

    img.addEventListener('click', (e) => {
      e.preventDefault();
      lb.show(index);
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Main decoration                                                    */
/* ------------------------------------------------------------------ */

/**
 * Main decoration function.
 * @param {HTMLElement} block
 */
export default async function decorate(block) {
  const params = getBlockParams(block);
  const { filepath } = params;
  const mode = (params.mode || 'pdf').toLowerCase();

  if (!filepath) {
    renderError(block, 'No filepath configured for DAM display.');
    return;
  }

  const servletUrl = getServletUrl(filepath);

  // Clear authored content and show loading state
  block.textContent = '';
  const loader = document.createElement('div');
  loader.className = 'dam-display-loading';
  loader.textContent = mode === 'images' ? 'Loading images…' : 'Loading PDFs…';
  block.append(loader);

  try {
    const response = await fetch(servletUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch assets (${response.status})`);
    }

    const data = await response.json();

    if (mode === 'images') {
      block.classList.add('mode-images');
      renderImagesMode(block, data);
    } else {
      block.classList.add('mode-pdf');
      renderPdfMode(block, data);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('DAM Display block error:', error);
    renderError(block, 'Unable to load assets. Please try again later.');
  }
}
