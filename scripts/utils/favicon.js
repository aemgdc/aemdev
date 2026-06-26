import { getConfig, getMetadata } from '../ak.js';

(async function loadFavicon() {
  const { codeBase } = getConfig();
  const name = getMetadata('favicon') || 'favicon';
  const favBase = `${codeBase}/img/favicons/${name}`;

  const tags = `<link rel="apple-touch-icon" href="${favBase}-180.png">
                <link rel="manifest" href="${favBase}.webmanifest">`;

  document.head.insertAdjacentHTML('beforeend', tags);
  const favicon = document.head.querySelector('link[rel="icon"]') || document.createElement('link');
  favicon.rel = 'icon';
  favicon.type = 'image/svg+xml';
  favicon.href = `${favBase}.svg`;
  if (!favicon.parentElement) document.head.append(favicon);
}());
