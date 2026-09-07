import { getConfig, getMetadata } from '../../scripts/ak.js';
import { loadLocalizedFragment } from '../fragment/fragment.js';
import { setColorScheme } from '../section-metadata/section-metadata.js';
import {
  ALL_LOCALES,
  SOURCE_LOCALE,
  locale as localeByCode,
  localeForPath,
  pathForLocale,
} from '../../scripts/tracker/locales.js';

const { locale } = getConfig();

// Locale-independent. `loadLocalizedFragment` prepends the active locale and falls
// back to English, so an untranslated locale still gets a nav.
const HEADER_PATH = '/fragments/nav/header';
const HEADER_ACTIONS = [
  '/tools/widgets/scheme',
  '/tools/widgets/language',
  '/tools/widgets/toggle',
];

/*
 * Widgets whose icon is drawn here rather than authored.
 *
 * These links come from DA as plain text — an author writes `/tools/widgets/language`,
 * not an icon — so the glyph has to come from code. It is written inline rather than
 * referenced out of `img/icons/` because the site's icon loader emits `<use href=...>`
 * against `codeBase`, and `decorateBrandSection` below already documents that failing
 * cross-origin. Both are single-stroke line art on purpose: one visual family with the
 * header's mono type, and `currentColor` keeps them black and white with the button.
 */
const ACTION_ICONS = {
  '/tools/widgets/toggle': {
    name: 'burger',
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
  },
  '/tools/widgets/language': {
    name: 'globe',
    svg: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="3.7" ry="9"/><line x1="3" y1="12" x2="21" y2="12"/></svg>',
  },
};

function closeAllMenus() {
  const openMenus = document.body.querySelectorAll('header .is-open');
  for (const openMenu of openMenus) {
    openMenu.classList.remove('is-open');
    // A click anywhere outside the header closes menus through here, not through the
    // button's own handler, so `aria-expanded` has to be reset here too — otherwise a
    // click-away leaves the button claiming an open menu that is shut.
    for (const btn of openMenu.querySelectorAll('button[aria-haspopup]')) {
      btn.setAttribute('aria-expanded', 'false');
    }
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

/**
 * The locale to SHOW as current.
 *
 * Off the locale tree — the site root and every `/tracker/**` page — there is no
 * locale in the path, and `scripts/tracker/locales.js` deliberately declines to
 * assert one there. The chrome a reader is looking at on those pages is nonetheless
 * the English fallback `loadLocalizedFragment` served them, so English is the honest
 * label. This is display only: nothing here touches `documentElement.lang`.
 */
function currentLocale(pathname) {
  return localeByCode(localeForPath(pathname)) || localeByCode(SOURCE_LOCALE);
}

/**
 * Where the picker sends a reader for `code`.
 *
 * The same page in the other locale, so switching language does not also throw away
 * the page you were on. Off the locale tree there IS no equivalent page — `/tracker/x`
 * has no German twin — so those pages offer the locale home instead of linking to a
 * path that cannot exist.
 */
function localeHref(pathname, code) {
  return localeForPath(pathname) ? pathForLocale(pathname, code) : localeByCode(code).location;
}

/**
 * Builds the picker's menu from the locale registry.
 *
 * The list is NOT authored. `scripts/tracker/locales.js` is already the one place that
 * says which locales this site serves — `scripts.js` hands the same registry to
 * `setConfig` — so building from it means the picker cannot offer a locale the site
 * does not have, and adding one is a row in that table rather than an authored menu
 * per locale. It also removes a failure mode the authored version had: the menu is the
 * one piece of chrome a reader in an untranslated locale must be able to reach, and it
 * no longer depends on a document existing to do it.
 */
function buildLocaleMenu(pathname, currentCode) {
  const list = document.createElement('ul');

  for (const code of ALL_LOCALES) {
    const { native, name } = localeByCode(code);

    const codeEl = document.createElement('span');
    codeEl.className = 'lang-code';
    codeEl.textContent = code;
    // The code repeats what `hreflang` already says and is a URL prefix, not a word.
    // Hiding it keeps the link's accessible name "Deutsch", not "de Deutsch".
    codeEl.setAttribute('aria-hidden', 'true');

    const nativeEl = document.createElement('span');
    nativeEl.className = 'lang-native';
    nativeEl.textContent = native;

    const a = document.createElement('a');
    a.href = localeHref(pathname, code);
    // `lang` describes the link's own text, which is that language's name for itself;
    // `hreflang` describes what is on the other end.
    a.lang = code;
    a.hreflang = code;
    a.title = name;
    if (code === currentCode) a.setAttribute('aria-current', 'true');
    a.append(codeEl, nativeEl);

    const li = document.createElement('li');
    li.append(a);
    list.append(li);
  }

  const menu = document.createElement('div');
  menu.className = 'language-menu';
  menu.append(list);
  return menu;
}

function decorateLanguage(btn) {
  const wrapper = btn.closest('.action-wrapper');
  const { pathname } = window.location;
  const current = currentLocale(pathname);

  const codeEl = document.createElement('span');
  codeEl.className = 'lang-code';
  codeEl.textContent = current.code;
  btn.append(codeEl);

  // The visible code is an abbreviation; the accessible name says which language that
  // is. `aria-label` overrides the button's text, so the code and the author's label
  // both have to be folded into it.
  btn.setAttribute('aria-label', `${btn.getAttribute('aria-label') || 'Language'}: ${current.name}`);
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');

  wrapper.append(buildLocaleMenu(pathname, current.code));

  btn.addEventListener('click', () => {
    toggleMenu(wrapper);
    btn.setAttribute('aria-expanded', wrapper.classList.contains('is-open') ? 'true' : 'false');
  });

  wrapper.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !wrapper.classList.contains('is-open')) return;
    closeAllMenus();
    btn.focus();
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

  // Widget links come from DA as bare text, with no icon span to decorate. Drawing the
  // glyph here also fixes the wrapper's variant class, which is read off the icon.
  if (!icon && ACTION_ICONS[pattern]) {
    const { name, svg } = ACTION_ICONS[pattern];
    icon = document.createElement('span');
    icon.className = `icon icon-${name}`;
    icon.innerHTML = svg;
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

  const span = document.createElement('span');
  span.className = 'brand-text';
  span.textContent = brandLink.textContent.trim();
  brandLink.textContent = '';
  brandLink.append(span);

  const lockup = document.createElement('span');
  lockup.className = 'brand-lockup';
  brandLink.replaceWith(lockup);
  lockup.append(brandLink);
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
    const { fragment, localized } = await loadLocalizedFragment(path, locale);
    fragment.classList.add('header-content');
    // Marks chrome that fell back to English, so it is visible in the DOM rather than
    // only in a network log — and so the translation QA can tell "not translated yet"
    // apart from "translated wrongly".
    if (!localized) fragment.dataset.fallbackLocale = 'en';
    await decorateHeader(fragment);
    el.append(fragment);
  } catch (e) {
    throw Error(e);
  }
}
