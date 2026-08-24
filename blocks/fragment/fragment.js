import { loadArea } from '../../scripts/ak.js';

function replaceDotMedia(path, doc) {
  const resetAttributeBase = (tag, attr) => {
    doc.querySelectorAll(`${tag}[${attr}^="./media_"]`).forEach((el) => {
      el[attr] = new URL(el.getAttribute(attr), new URL(path, window.location)).href;
    });
  };
  resetAttributeBase('img', 'src');
  resetAttributeBase('source', 'srcset');
}

/**
 * Inject a fragment into the dom to for calculating styles
 * @param {HTMLElement} fragment the fragment
 */
function applyPageStyles(fragment) {
  const container = document.createElement('div');
  container.classList.add('hidden-container');
  container.style = 'display: none';
  document.body.append(container);
  container.append(fragment);
  return container;
}

/**
 * Loads a fragment.
 * @param {string} path The path to the fragment
 * @returns {HTMLElement} The root element of the fragment
 */
export async function loadFragment(path) {
  const resp = await fetch(`${path}`);
  if (!resp.ok) throw Error(`Couldn't fetch ${path}`);

  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const sections = doc.body.querySelectorAll('main > div');
  const fragment = document.createElement('div');
  fragment.classList.add('fragment-content');
  fragment.append(...sections);

  replaceDotMedia(path, doc);

  const container = applyPageStyles(fragment);

  await loadArea({ area: fragment });

  fragment.remove();
  container.remove();

  return fragment;
}

/**
 * Loads a fragment for the current locale, falling back to the source locale.
 *
 * Site chrome is rolled out per locale, and a locale is only ever PARTLY translated —
 * translation lands one batch at a time, and a new locale starts completely empty. So
 * `/de/fragments/nav/header` not existing yet is the NORMAL state for most of a
 * rollout, not an error.
 *
 * Without this fallback the header and footer blocks throw on that 404 and the page
 * renders with no navigation at all. That failure is also badly misleading to debug:
 * the symptom is missing chrome on every page in a locale, and the cause is one
 * unwritten document.
 *
 * Returns `{ fragment, localized }`. `localized` is false when the caller got English —
 * the translation tracker's layout tier uses it to avoid reporting "the chrome is in
 * English" as a translation defect on a page where English chrome is the intended
 * state.
 *
 * @param {string} path locale-independent fragment path, e.g. `/fragments/nav/header`
 * @param {{prefix: string}} locale the locale from `getConfig()`
 * @param {string} sourcePrefix the prefix to fall back to
 */
export async function loadLocalizedFragment(path, locale, sourcePrefix = '/en') {
  const prefix = locale?.prefix ?? '';
  try {
    return { fragment: await loadFragment(`${prefix}${path}`), localized: true };
  } catch (e) {
    // Only the source locale is worth a second attempt; anything else would ask twice
    // for the same URL and turn one 404 into two.
    if (prefix === sourcePrefix) throw e;
    return { fragment: await loadFragment(`${sourcePrefix}${path}`), localized: false };
  }
}

/**
 *
 * @param {Element}} a the fragment link
 * @returns the element that can be replaced
 */
function getReplaceEl(a) {
  let current = a;
  const ancestor = a.closest('.section');

  // Walk up the DOM from child to ancestor
  // Break when there is more than one child
  while (current && current !== ancestor) {
    const childCount = current.parentElement.children.length;
    if (childCount <= 1) {
      current = current.parentElement;
    } else {
      break;
    }
  }

  return current;
}

function getRequestPath(a) {
  const { hostname, pathname } = a;
  const href = a.getAttribute('href');
  // If its already relative, return the pathname
  if (href.startsWith('/')) return pathname;
  // If the hostname matches, return the pathname
  if (hostname === window.location.hostname) return pathname;
  // If the aem project matches, make it relative (useful across delivery tiers)
  const isAem = ['.da.', '.aem.', 'local'].some((host) => hostname.includes(host));
  if (isAem) {
    // If org and site matches, return the pathname
    const [aemOrg, aemSite] = hostname.split('.')[0].split('--').reverse();
    const [winOrg, winSite] = window.location.hostname.split('.')[0].split('--').reverse();
    if ((aemOrg === winOrg) && (aemSite === winSite)) return pathname;
  }
  // Give up and return the full href
  return a.href;
}

export default async function init(a) {
  const path = getRequestPath(a);

  const fragment = await loadFragment(path);
  if (fragment) {
    const elToReplace = getReplaceEl(a);
    const sections = fragment.querySelectorAll(':scope > .section');
    const children = sections.length === 1
      ? fragment.querySelectorAll(':scope > *')
      : [fragment];
    for (const [idx, child] of children.entries()) {
      // If relative, create a unique ID to help fragments be identified after
      // being inserted into the page
      if (path.startsWith('/')) child.id = btoa(encodeURIComponent(`${path}/${idx + 1}`));
      elToReplace.insertAdjacentElement('afterend', child);
    }
    elToReplace.remove();
  }
}
