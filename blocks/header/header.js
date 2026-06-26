import { getConfig, getMetadata } from '../../scripts/ak.js';
import { loadFragment } from '../fragment/fragment.js';
import { setColorScheme } from '../section-metadata/section-metadata.js';

const { locale } = getConfig();

const HEADER_PATH = '/fragments/nav/header';
const HEADER_ACTIONS = [
  '/tools/widgets/scheme',
  '/tools/widgets/language',
  '/tools/widgets/toggle',
];

function closeAllMenus() {
  const openMenus = document.body.querySelectorAll('header .is-open');
  for (const openMenu of openMenus) {
    openMenu.classList.remove('is-open');
  }
}

function docClose(e) {
  if (e.target.closest('header')) return;
  closeAllMenus();
}

function toggleMenu(menu) {
  const isOpen = menu.classList.contains('is-open');
  closeAllMenus();
  if (isOpen) {
    document.removeEventListener('click', docClose);
    return;
  }

  // Setup the global close event
  document.addEventListener('click', docClose);
  menu.classList.add('is-open');
}

function decorateLanguage(btn) {
  const section = btn.closest('.section');
  btn.addEventListener('click', async () => {
    let menu = section.querySelector('.language.menu');
    if (!menu) {
      const content = document.createElement('div');
      content.classList.add('block-content');
      const fragment = await loadFragment(`${locale.prefix}${HEADER_PATH}/languages`);
      menu = document.createElement('div');
      menu.className = 'language menu';
      menu.append(fragment);
      content.append(menu);
      section.append(content);
    }
    toggleMenu(section);
  });
}

function decorateScheme(btn) {
  btn.addEventListener('click', async () => {
    const { body } = document;

    let currPref = localStorage.getItem('color-scheme');
    if (!currPref) {
      currPref = matchMedia('(prefers-color-scheme: dark)')
        .matches ? 'dark-scheme' : 'light-scheme';
    }

    const theme = currPref === 'dark-scheme'
      ? { add: 'light-scheme', remove: 'dark-scheme' }
      : { add: 'dark-scheme', remove: 'light-scheme' };

    body.classList.remove(theme.remove);
    body.classList.add(theme.add);
    localStorage.setItem('color-scheme', theme.add);
    // Re-calculatie section schemes
    const sections = document.querySelectorAll('.section');
    for (const section of sections) {
      setColorScheme(section);
    }
  });
}

function decorateNavToggle(btn) {
  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const header = document.body.querySelector('header');
    if (!header) return;
    const isOpen = header.classList.toggle('is-mobile-open');
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  };
  btn.addEventListener('click', handler);
}

async function decorateAction(header, pattern) {
  const link = header.querySelector(`[href*="${pattern}"]`);
  if (!link) return;

  let icon = link.querySelector('.icon');
  const text = link.textContent.trim();
  const btn = document.createElement('button');
  btn.type = 'button';

  // The toggle widget comes from DA without an icon span — inject a hamburger SVG.
  if (pattern === '/tools/widgets/toggle' && !icon) {
    icon = document.createElement('span');
    icon.className = 'icon icon-burger';
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
  }

  if (icon) btn.append(icon);
  if (text) {
    const textSpan = document.createElement('span');
    textSpan.className = 'text';
    textSpan.textContent = text;
    btn.append(textSpan);
    btn.setAttribute('aria-label', text);
  }

  const variant = icon ? (icon.classList[1] || '').replace('icon-', '') : pattern.split('/').pop();
  const wrapper = document.createElement('div');
  wrapper.className = `action-wrapper ${variant}`.trim();
  wrapper.append(btn);

  if (pattern === '/tools/widgets/toggle') {
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'main-nav');
    // Lift the toggle out of the brand section so it can be its own grid cell.
    const headerContent = header.classList.contains('header-content')
      ? header
      : header.querySelector('.header-content') || link.closest('.header-content');
    link.parentElement.remove();
    (headerContent || link.closest('header') || link.parentElement.parentElement).append(wrapper);
    wrapper.classList.add('mobile-toggle');
  } else {
    link.parentElement.parentElement.replaceChild(wrapper, link.parentElement);
  }

  if (pattern === '/tools/widgets/language') decorateLanguage(btn);
  if (pattern === '/tools/widgets/scheme') decorateScheme(btn);
  if (pattern === '/tools/widgets/toggle') decorateNavToggle(btn);
}

function decorateMenu() {
  // TODO: finish single menu support
  return null;
}

function decorateMegaMenu(li) {
  const menu = li.querySelector('.fragment-content');
  if (!menu) return null;
  const wrapper = document.createElement('div');
  wrapper.className = 'mega-menu';
  wrapper.append(menu);
  li.append(wrapper);
  return wrapper;
}

function decorateNavItem(li) {
  li.classList.add('main-nav-item');
  const link = li.querySelector(':scope > p > a, :scope > a');
  if (link) link.classList.add('main-nav-link');
  const menu = decorateMegaMenu(li) || decorateMenu(li);
  if (!(menu || link)) return;
  // Only intercept top-level link clicks when the item controls a menu.
  // Plain links should keep native navigation behavior.
  if (!menu || !link) return;
  link.addEventListener('click', (e) => {
    e.preventDefault();
    toggleMenu(li);
  });
}

function decorateBrandSection(section) {
  section.classList.add('brand-section');
  const brandLink = section.querySelector('a');

  // Replace <use>-based SVG icon with inline SVG for cross-origin compatibility
  const icon = brandLink.querySelector('svg.icon');
  if (icon) {
    const use = icon.querySelector('use');
    if (use) {
      const href = use.getAttribute('href');
      const svgUrl = href.split('#')[0];
      fetch(svgUrl).then((resp) => resp.text()).then((svgText) => {
        const tmp = document.createElement('div');
        tmp.innerHTML = svgText;
        const inlineSvg = tmp.querySelector('svg');
        if (inlineSvg) {
          inlineSvg.setAttribute('class', icon.getAttribute('class'));
          icon.replaceWith(inlineSvg);
        }
      });
    }
  }

  const [, text] = brandLink.childNodes;
  const span = document.createElement('span');
  span.className = 'brand-text';
  if (text) {
    span.append(text);
  } else {
    span.textContent = brandLink.textContent.trim();
    brandLink.textContent = '';
  }
  brandLink.append(span);

  // "TAD REEVES" links to the about page; the "// OPSINVENTOR" imprint links home.
  // The imprint was a CSS ::after pseudo on .brand-text; make it a real anchor so
  // it can carry its own href, then wrap both in a lockup to preserve the layout.
  brandLink.setAttribute('href', '/en/about-me');
  const imprint = document.createElement('a');
  imprint.className = 'brand-imprint';
  imprint.href = '/';
  imprint.textContent = '// OPSINVENTOR';
  const lockup = document.createElement('span');
  lockup.className = 'brand-lockup';
  brandLink.replaceWith(lockup);
  lockup.append(brandLink, imprint);
}

function decorateNavSection(section) {
  section.classList.add('main-nav-section');
  const navContent = section.querySelector('.default-content');
  const navList = section.querySelector('ul');
  if (!navList) return;
  navList.classList.add('main-nav-list');

  const nav = document.createElement('nav');
  nav.id = 'main-nav';
  nav.append(navList);
  navContent.append(nav);

  const mainNavItems = section.querySelectorAll('nav > ul > li');
  for (const navItem of mainNavItems) {
    decorateNavItem(navItem);
  }
}

async function decorateActionSection(section) {
  section.classList.add('actions-section');
  const cta = section.querySelector('a:not([href*="/tools/widgets/"])');
  if (cta) cta.classList.add('btn-accent');
}

async function decorateHeader(fragment) {
  const sections = fragment.querySelectorAll(':scope > .section');
  if (sections[0]) decorateBrandSection(sections[0]);
  if (sections[1]) decorateNavSection(sections[1]);
  if (sections[2]) decorateActionSection(sections[2]);

  for (const pattern of HEADER_ACTIONS) {
    decorateAction(fragment, pattern);
  }
}

/**
 * loads and decorates the header
 * @param {Element} el The header element
 */
export default async function init(el) {
  const headerMeta = getMetadata('header');
  const path = headerMeta || HEADER_PATH;
  try {
    const fragment = await loadFragment(`${locale.prefix}${path}`);
    fragment.classList.add('header-content');
    await decorateHeader(fragment);
    el.append(fragment);
  } catch (e) {
    throw Error(e);
  }
}
