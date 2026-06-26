import { getConfig, loadStyle } from '../ak.js';

let dialog = null;
let imageFrame = null;
let stylesInjected = false;

function injectStyles(codeBase) {
  if (stylesInjected) return;
  stylesInjected = true;

  loadStyle(`${codeBase}/blocks/carousel/carousel.css`);

  const style = document.createElement('style');
  style.textContent = `
    .image-lightbox-p { line-height: 0; }

    .image-lightbox-trigger {
      display: block;
      width: 100%;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      cursor: zoom-in;
      line-height: 0;
    }

    .image-lightbox-trigger picture,
    .image-lightbox-trigger img {
      display: block;
      width: 100%;
      height: auto;
    }

    .image-lightbox-body {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 16px;
      padding: 16px 24px 24px;
      height: 100dvh;
      max-height: 100dvh;
      box-sizing: border-box;
    }

    .image-lightbox-body .carousel-lightbox-image {
      flex: 1;
      align-self: stretch;
      min-height: 0;
    }
  `;
  document.head.append(style);
}

function ensureDialog() {
  if (dialog) return;

  dialog = document.createElement('dialog');
  dialog.className = 'carousel-lightbox';

  const body = document.createElement('div');
  body.className = 'image-lightbox-body';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'carousel-lightbox-close';
  closeBtn.setAttribute('aria-label', 'Close image');
  closeBtn.textContent = 'Close';

  imageFrame = document.createElement('div');
  imageFrame.className = 'carousel-lightbox-image';

  body.append(closeBtn, imageFrame);
  dialog.append(body);

  closeBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dialog.close();
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('carousel-lightbox-open');
  });

  document.body.append(dialog);
}

function openLightbox(picture) {
  ensureDialog();

  const clone = picture.cloneNode(true);
  const img = clone.querySelector('img');
  if (img) {
    img.loading = 'eager';
    img.decoding = 'async';
  }

  imageFrame.replaceChildren(clone);
  document.body.classList.add('carousel-lightbox-open');
  dialog.showModal();
}

function isStandaloneImage(p) {
  const nodes = [...p.childNodes].filter(
    (n) => n.nodeType !== Node.TEXT_NODE || n.textContent.trim(),
  );
  return nodes.length === 1 && nodes[0].nodeName === 'PICTURE';
}

(function init() {
  const { codeBase } = getConfig();
  const paragraphs = document.querySelectorAll('main .default-content p');
  let found = false;

  for (const p of paragraphs) {
    if (!isStandaloneImage(p)) continue;
    const picture = p.querySelector('picture');
    if (picture.closest('a')) continue;

    if (!found) {
      injectStyles(codeBase);
      found = true;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'image-lightbox-trigger';
    btn.setAttribute('aria-label', 'View full image');
    btn.setAttribute('aria-haspopup', 'dialog');

    picture.replaceWith(btn);
    btn.append(picture);
    p.classList.add('image-lightbox-p');

    btn.addEventListener('click', () => openLightbox(picture));
  }
}());
