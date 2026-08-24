import { getConfig, getMetadata } from '../../scripts/ak.js';
import { loadLocalizedFragment } from '../fragment/fragment.js';

// Locale-independent — see the note on HEADER_PATH in blocks/header/header.js.
const FOOTER_PATH = '/fragments/nav/footer';

/**
 * loads and decorates the footer
 * @param {Element} el The footer element
 */
export default async function init(el) {
  const { locale } = getConfig();
  const footerMeta = getMetadata('footer');
  const path = footerMeta || FOOTER_PATH;
  try {
    const { fragment, localized } = await loadLocalizedFragment(path, locale);
    fragment.classList.add('footer-content');
    if (!localized) fragment.dataset.fallbackLocale = 'en';

    const sections = [...fragment.querySelectorAll('.section')];

    if (sections.length) {
      sections[0].classList.add('footer-brand');
      const last = sections[sections.length - 1];
      last.classList.add('footer-bottom');
      for (let i = 1; i < sections.length - 1; i += 1) {
        sections[i].classList.add('footer-col');
      }
    }

    el.append(fragment);
  } catch (e) {
    throw Error(e);
  }
}
