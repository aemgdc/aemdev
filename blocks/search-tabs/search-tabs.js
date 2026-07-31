import decorateSearchTabs from '../../scripts/search/eds/search-tabs.js';
import { searchRenderers, observeFacets } from '../results-panel/results-panel.js';
import { loadFragment } from '../fragment/fragment.js';

/* URL param the library persists the active tab under. Duplicated rather than
   imported: it only ships from a hash-named chunk, and those names change on
   every re-copy of the bundle (see scripts/search/README.md). */
const ACTIVE_TAB_PARAM = 'stx-tab';

/* Prefix marking an authored line as search hints rather than answer copy, e.g.
   an `h3` reading "Fuzzy Terms: Frank". Matched case-insensitively. */
const SEARCH_TERMS_PREFIX = 'fuzzy terms:';

/**
 * Slides one shared indicator under the active tab.
 *
 * The library gives every button its own state but no shared indicator, so the
 * bar lives on the button row as a pseudo-element and is driven from here via
 * two custom properties.
 *
 * Position is read off `aria-selected`, which the library sets on every
 * activation path - pointer, keyboard, and the `stx-tab` URL param - so one
 * MutationObserver covers all of them without patching the bundle.
 *
 * @param {Element} block The decorated search-tabs block
 */
function slideTabIndicator(block) {
  const list = block.querySelector('.stx-tabs__buttons');
  if (!list) return;

  const position = () => {
    const active = list.querySelector('[aria-selected="true"]');
    if (!active) return;
    // offsetLeft is measured against the row, which the CSS positions.
    list.style.setProperty('--stx-indicator-x', `${active.offsetLeft}px`);
    list.style.setProperty('--stx-indicator-w', `${active.offsetWidth}px`);
  };

  position();

  // Transitions are held back for one frame so the bar appears under the first
  // tab instead of sliding in from the left edge on load.
  requestAnimationFrame(() => list.classList.add('tabs-indicator-ready'));

  const selection = new MutationObserver(position);
  selection.observe(list, {
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-selected'],
  });

  // Label widths move when the row is resized or a webfont swaps in.
  const resize = new ResizeObserver(position);
  resize.observe(list);
  if (document.fonts) document.fonts.ready.then(position);
}

/**
 * Reads the block's key/value rows.
 *
 * Must run before `decorateSearchTabs`, which consumes the rows and then clears
 * the block. Deliberately a local copy of the library's `getEDSConfig` for the
 * same reason `ACTIVE_TAB_PARAM` is duplicated above.
 *
 * @param {Element} block The search-tabs block, still holding its authored rows
 * @returns {Object} Authored keys mapped to their values
 */
function readRows(block) {
  const rows = {};
  block.querySelectorAll(':scope > div').forEach((row) => {
    const [keyEl, valueEl] = row.querySelectorAll(':scope > div');
    const key = keyEl?.textContent?.trim();
    const value = valueEl?.textContent?.trim();
    if (key && value) rows[key] = value;
  });
  return rows;
}

/**
 * Groups an `h2`-led run of authored content into native disclosure widgets.
 *
 * The FAQ is authored flat - a heading, then its answer, then the next heading -
 * so an entry is everything from one `h2` up to the following one.
 *
 * `<details>`/`<summary>` rather than a scripted toggle: it brings its own
 * keyboard handling and open/closed semantics for assistive tech, and browsers
 * open a collapsed entry when in-page find matches inside it. The `h2` moves
 * into the `summary` instead of being replaced by it, so the page keeps its
 * heading outline - a bare `summary` carries none.
 *
 * Nodes are moved, never re-serialised, so authored links survive intact.
 *
 * @param {Element} root Container holding the loaded fragment
 */
function buildAccordion(root) {
  root.querySelectorAll('h2').forEach((heading) => {
    // Collected before anything moves, while the run is still siblings.
    const answer = [];
    let sibling = heading.nextElementSibling;
    while (sibling && sibling.tagName !== 'H2') {
      const next = sibling.nextElementSibling;
      answer.push(sibling);
      sibling = next;
    }

    // A heading with nothing under it would become a toggle that opens onto
    // nothing, so it is left as a plain heading.
    if (answer.length === 0) return;

    const details = document.createElement('details');
    details.className = 'search-tabs-entry';

    const summary = document.createElement('summary');
    summary.className = 'search-tabs-entry-question';

    const body = document.createElement('div');
    body.className = 'search-tabs-entry-answer';

    heading.replaceWith(details);
    summary.append(heading);
    body.append(...answer);
    details.append(summary, body);
  });
}

/**
 * Takes authored search-hint lines out of the rendered content.
 *
 * A line like "Fuzzy Terms: Frank" is metadata for matching, not something a
 * reader should see. It moves onto the entry as `data-search-terms` rather than
 * being thrown away, so the authored value is still in the DOM for whatever
 * eventually matches against it.
 *
 * Nothing does today: this tab holds a fragment, not indexed documents, so the
 * terms have no effect on search until the FAQ is actually indexed.
 *
 * @param {Element} root Container holding the loaded fragment
 */
function liftSearchTerms(root) {
  root.querySelectorAll('h3, h4, h5, h6, p').forEach((el) => {
    const text = el.textContent.trim();
    if (!text.toLowerCase().startsWith(SEARCH_TERMS_PREFIX)) return;
    const terms = text.slice(SEARCH_TERMS_PREFIX.length).trim();
    // Falls back to the panel when the entries were not collapsed.
    if (terms) (el.closest('details') || root).dataset.searchTerms = terms;
    el.remove();
  });
}

/**
 * Appends a tab whose panel holds authored content instead of search results.
 *
 * The library builds its tabs from a closed-over `buttonList` and offers no way
 * to register another, so the button and panel are built to match its markup
 * and appended afterwards. Nothing in the bundle is patched - it stays a
 * copy-in-only distribution.
 *
 * Being outside that closure has two consequences, both handled here:
 * - the library's `activateTab` hides only its own panels, so this one stands
 *   itself down when one of theirs is activated;
 * - its arrow-key cycle is built from `buttonList`, so it would skip this tab
 *   entirely - the keydown handler below replaces that cycle with one over
 *   every tab actually in the row.
 *
 * @param {Element} block The decorated search-tabs block
 * @param {Object} tab The authored content tab
 * @param {string} tab.id Tab id, used in the `stx-tab` URL param
 * @param {string} tab.label Visible button text
 * @param {string} tab.path Path of the page to load into the panel
 * @param {boolean} tab.accordion Collapse each `h2`-led entry into a disclosure
 */
function injectContentTab(block, {
  id, label, path, accordion,
}) {
  const tabs = block.querySelector('.stx-tabs');
  const tablist = tabs?.querySelector('[role="tablist"]');
  // Absent when the library replaced the block with its own config error.
  if (!tablist) return;

  const buttonId = `stx-tab-${id}`;
  const panelId = `stx-tab-content-${id}`;

  const button = document.createElement('button');
  button.id = buttonId;
  button.className = 'stx-tabs__button';
  button.type = 'button';
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-controls', panelId);
  button.setAttribute('aria-selected', 'false');
  button.tabIndex = -1;
  button.textContent = label;

  const panel = document.createElement('div');
  panel.id = panelId;
  panel.className = 'stx-tabs__content search-tabs-content-tab';
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', buttonId);
  panel.hidden = true;

  // The library wraps every panel's content in a plain div; matching that keeps
  // the shared .stx-tabs__content rules applying identically to this one.
  const content = document.createElement('div');
  panel.append(content);

  tablist.append(button);
  tabs.append(panel);

  // Deferred to first activation, mirroring the lazy mount the library gives
  // its own panels - an unopened tab costs no fetch.
  let loaded = false;
  const loadContent = async () => {
    if (loaded) return;
    loaded = true;
    const fragment = await loadFragment(path);
    if (!fragment) {
      // eslint-disable-next-line no-console
      console.error(`The "${label}" search tab could not load its content from "${path}".`);
      return;
    }
    content.append(...fragment.childNodes);
    if (accordion) buildAccordion(content);
    // After the entries exist, so the terms can attach to the one they belong to.
    liftSearchTerms(content);
  };

  const allTabs = () => [...tablist.querySelectorAll('[role="tab"]')];

  const activate = () => {
    tabs.querySelectorAll(':scope > .stx-tabs__content').forEach((el) => {
      el.hidden = el !== panel;
    });
    allTabs().forEach((el) => {
      const isSelf = el === button;
      el.setAttribute('aria-selected', String(isSelf));
      el.tabIndex = isSelf ? 0 : -1;
    });
    const url = new URL(window.location.href);
    url.searchParams.set(ACTIVE_TAB_PARAM, id);
    window.history.replaceState({}, '', url);
    loadContent();
  };

  button.addEventListener('click', activate);

  // Covers keyboard activation as well: the library's arrow keys dispatch a
  // real click on the tab they move to.
  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab || tab === button) return;
    panel.hidden = true;
    button.setAttribute('aria-selected', 'false');
    button.tabIndex = -1;
  });

  // Capture phase, so this runs before the per-button listeners the library
  // attached; stopping propagation there suppresses its partial cycle.
  tablist.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step === undefined && event.key !== 'Home' && event.key !== 'End') return;
    const list = allTabs();
    const current = list.indexOf(event.target.closest('[role="tab"]'));
    if (current === -1) return;
    event.preventDefault();
    event.stopPropagation();
    let next = (current + step + list.length) % list.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = list.length - 1;
    list[next].focus();
    list[next].click();
  }, true);

  // Deep link to this tab. An `stx-tab` value the library does not recognise
  // resolves to its own first tab (`Math.max(0, -1)`), so by now that one is
  // selected and mounted; this corrects it synchronously, at the cost of one
  // wasted search request.
  if (new URLSearchParams(window.location.search).get(ACTIVE_TAB_PARAM) === id) activate();
}

export default function decorate(block) {
  const rows = readRows(block);
  decorateSearchTabs(block, '.search-tab', searchRenderers);
  if (rows.contentTabId && rows.contentTabLabel && rows.contentTabPath) {
    injectContentTab(block, {
      id: rows.contentTabId,
      label: rows.contentTabLabel,
      path: rows.contentTabPath,
      accordion: rows.contentTabAccordion?.toLowerCase() === 'true',
    });
  }
  slideTabIndicator(block);
  // Each tab builds its own results panel on activation, so this watches the
  // whole block rather than any one panel.
  observeFacets(block);
}
