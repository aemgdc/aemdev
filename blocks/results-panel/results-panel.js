/* eslint-disable no-underscore-dangle */
import decorateResultsPanel from '../../scripts/search/eds/search-results-panel.js';
import { getHitUrl } from '../../scripts/search/streamx-search-results-panel.js';

/**
 * Renders one search result as a link to the page it represents.
 *
 * `getHitUrl` turns the hit's `_id` ("en:/en/blog/post") into its URL, stripping
 * the namespace prefix when the hit carries one. Index values are applied with
 * textContent/href rather than innerHTML, so they are never parsed as markup.
 * @param {Object} item Search hit
 * @returns {HTMLElement} The rendered result
 */
export function renderItem(item) {
  const url = getHitUrl(item);

  const link = document.createElement('a');
  link.className = 'results-panel-item';
  link.href = url;

  // A hit whose payload never got enriched has no title. Falling back to the
  // URL keeps the row clickable - throwing here would make the library drop it
  // from the list while it still counted toward the reported total.
  const title = document.createElement('span');
  title.className = 'results-panel-item__title';
  title.textContent = item._source.payload?.title || url;

  link.append(title);

  /*
   * The authored Category, from `payload.facets.categories_level0` - plural, and
   * unrelated to the `facetFieldPrefix` the panel requests aggregations under.
   *
   * `_source.type` used to sit here, which meant every row was labelled
   * "page/eds": that field selects the renderer, it is not a label. Rows with no
   * category get no pill rather than a fallback, since anything shown there
   * instead would be the same kind of noise.
   */
  const categories = item._source.payload?.facets?.categories_level0;
  if (categories?.length) {
    const category = document.createElement('span');
    category.className = 'results-panel-item__category';
    category.textContent = categories.join(', ');
    link.append(category);
  }

  return link;
}

/*
 * Inline SVG icons replacing the library's default "🔍" and "✕" glyphs.
 *
 * These return strings rather than elements on purpose. The library's `html`
 * tag only turns HTMLElement/Array/NodeList values into real nodes and
 * concatenates everything else straight into innerHTML - and an SVG built with
 * createElementNS is an SVGElement, not an HTMLElement, so it would render as
 * the literal text "[object SVGSVGElement]".
 *
 * Both buttons already carry an aria-label, so the glyphs stay hidden.
 */
const icon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

export const searchIcon = () => icon('<circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" />');

export const clearIcon = () => icon('<path d="M18 6 6 18M6 6l12 12" />');

/*
 * Renderers shared by the standalone panel and the tabbed search.
 *
 * The library looks up `item-${_source.type}` per hit and, with no match, drops
 * the row (or shows a "Missing renderer" diagnostic when debugMode is on). The
 * index currently holds two page types, so both are mapped to the same renderer:
 *
 *   page/eds       - what .github/workflows/streamx-publish.yaml ingests today,
 *                    so every newly published page arrives under this type.
 *   page/eds-page  - legacy hits from an earlier ingestion path. No workflow in
 *                    this repo emits it, but they are still in the index, so the
 *                    mapping stays until they are reingested or purged.
 */
export const searchRenderers = {
  'item-page/eds': renderItem,
  'item-page/eds-page': renderItem,
  searchIcon,
  clearIcon,
};

/** Top-level values a facet shows before "show more" takes over. */
const FACET_VISIBLE_LIMIT = 5;

const NODE_SELECTOR = ':scope > .stx-results-panel__facet-node';
const CHILD_NODE_SELECTOR = ':scope > .stx-results-panel__facet-children > .stx-results-panel__facet-node';
const ROW_LABEL_SELECTOR = ':scope > .stx-results-panel__facet-row .stx-results-panel__facet-label';
const FACETS_CONTAINER_CLASS = 'stx-results-panel__facets-container';
const RESULTS_META_CLASS = 'stx-results-panel__results-number';

/** A facet node's own bucket label, ignoring any nested below it. */
const facetLabelOf = (node) => node.querySelector(ROW_LABEL_SELECTOR)?.textContent?.trim() || '';

/**
 * Labels from the root of a facet tree down to the given node.
 *
 * Read from the DOM rather than by splitting the checkbox value, which is a
 * separator-joined path whose separator is authored (`facetPathSeparator`) and
 * so is not knowable from here.
 *
 * @param {Element} input A facet checkbox
 * @returns {string[]} Ancestor labels, outermost first
 */
function facetAncestry(input) {
  const labels = [];
  let node = input.closest('.stx-results-panel__facet-node');
  while (node) {
    const label = facetLabelOf(node);
    if (label) labels.unshift(label);
    node = node.parentElement?.closest('.stx-results-panel__facet-node') || null;
  }
  return labels;
}

/**
 * Adds a filter field and a truncated value list to one facet group.
 *
 * The library renders every bucket the response carried, uncapped and
 * unfiltered, so a facet at `facetFieldSize: 20` fills the whole column. Both
 * controls are added from here because the bundle is copy-in-only.
 *
 * Skipped entirely for groups at or under the limit - a filter field above four
 * checkboxes is clutter, not help.
 *
 * @param {Element} group One `.stx-results-panel__facet`
 */
function enhanceFacetGroup(group) {
  const values = group.querySelector('.stx-results-panel__facet-values');
  const nodes = values ? [...values.querySelectorAll(NODE_SELECTOR)] : [];
  if (nodes.length <= FACET_VISIBLE_LIMIT) return;

  const groupName = group.querySelector('.stx-results-panel__facet-name')?.textContent?.trim();

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'results-panel-facet-search';
  search.placeholder = 'Filter';
  search.setAttribute('aria-label', groupName ? `Filter ${groupName}` : 'Filter values');

  // A button rather than an anchor: it acts on this page and goes nowhere, so a
  // link would be the wrong affordance and the wrong keyboard contract.
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'results-panel-facet-more';

  let expanded = false;

  const labelOf = (node) => facetLabelOf(node).toLowerCase();

  /*
   * Matches a subtree and reports whether anything in it hit, so a parent can
   * stay visible for the sake of a matching descendant.
   *
   * `inherited` carries a matched ancestor downwards: once a parent matches, its
   * whole subtree stays browsable rather than being filtered out from under it.
   */
  const filterNode = (node, query, inherited) => {
    const self = !query || labelOf(node).includes(query);
    const children = [...node.querySelectorAll(CHILD_NODE_SELECTOR)];
    const childMatch = children
      .map((child) => filterNode(child, query, inherited || self))
      .some(Boolean);

    node.hidden = !(self || childMatch || inherited);

    // A hit two levels down is worthless while its parent is still collapsed.
    if (query && childMatch) {
      const panel = node.querySelector(':scope > .stx-results-panel__facet-children');
      const toggle = node.querySelector(':scope > .stx-results-panel__facet-row .stx-results-panel__facet-subtoggle');
      if (panel) panel.hidden = false;
      if (toggle) toggle.setAttribute('aria-expanded', 'true');
    }

    return self || childMatch;
  };

  const apply = () => {
    const query = search.value.trim().toLowerCase();
    nodes.forEach((node) => filterNode(node, query, false));

    // The cap applies to whatever survived the filter, so searching inside a
    // long facet does not immediately bury its own matches.
    const matching = nodes.filter((node) => !node.hidden);
    if (!expanded) matching.slice(FACET_VISIBLE_LIMIT).forEach((node) => { node.hidden = true; });

    // Clamped, not just tested: styles.css puts `display: inline-block` on every
    // button, so a stylesheet that has not undone it for [hidden] would leave a
    // "Show -3 more" on screen instead of hiding the control.
    const over = Math.max(0, matching.length - FACET_VISIBLE_LIMIT);
    more.hidden = over === 0;
    more.textContent = expanded ? 'Show less' : `Show ${over} more`;
    more.setAttribute('aria-expanded', String(expanded));
  };

  // Re-collapsing on every keystroke keeps "show more" meaning the same thing
  // for each new query.
  search.addEventListener('input', () => {
    expanded = false;
    apply();
  });

  more.addEventListener('click', () => {
    expanded = !expanded;
    apply();
  });

  values.prepend(search);
  values.append(more);
  apply();
}

/**
 * Mirrors the current facet selection into removable badges beside the count.
 *
 * The selection is read off the checkboxes rather than tracked here: the library
 * keeps it in a private `panelState`, but `refreshFacetStates` writes it back to
 * every input, so `:checked` is that state. It also rolls a fully selected
 * branch up to its parent, which the badges inherit for free - one "Tablets"
 * chip rather than every model under it.
 *
 * Removal replays a real click, so the library's own change handler clears the
 * selection, rewrites the URL and re-runs the search exactly as the checkbox
 * would have.
 *
 * @param {Element} panel One `.stx-results-panel`
 */
function renderSelectedBadges(panel) {
  const meta = panel?.querySelector(`.${RESULTS_META_CLASS}`);
  if (!meta) return;

  let list = meta.querySelector('.results-panel-selected');
  if (!list) {
    list = document.createElement('div');
    list.className = 'results-panel-selected';
    meta.append(list);
  }

  const facets = panel.querySelector(`.${FACETS_CONTAINER_CLASS}`);
  const selected = facets
    ? [...facets.querySelectorAll('.stx-results-panel__facet-option input:checked')]
    : [];

  list.replaceChildren();
  list.hidden = selected.length === 0;

  selected.forEach((input) => {
    const path = facetAncestry(input);
    const leaf = path[path.length - 1] || input.value;

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'results-panel-selected-badge';
    badge.setAttribute('aria-label', `Remove filter ${path.join(' › ') || leaf}`);
    // Only the ancestry a nested value carries; a top-level one adds nothing.
    if (path.length > 1) badge.title = path.join(' › ');

    const text = document.createElement('span');
    text.textContent = leaf;

    // Decorative: the button's aria-label already says what activating it does.
    const remove = document.createElement('span');
    remove.className = 'results-panel-selected-badge__remove';
    remove.setAttribute('aria-hidden', 'true');
    remove.textContent = '×';

    badge.append(text, remove);
    badge.addEventListener('click', () => input.click());
    list.append(badge);
  });
}

/**
 * Keeps the facet controls and the selection badges attached across re-renders.
 *
 * `updateFacets` replaces the entire facets container on every response, so a
 * one-shot pass would be thrown away by the next query, filter or page change.
 * The results header is the opposite - `updateResultsMeta` rewrites its text in
 * place - so the badge list is built once there and refilled.
 *
 * Only *added* nodes are inspected, and neither the controls nor the badges are
 * one of the two watched classes, so nothing inserted here retriggers this.
 *
 * @param {Element} root Element containing one or more results panels
 */
export function observeFacets(root) {
  const enhance = (container) => {
    if (!container.dataset.facetsEnhanced) {
      container.dataset.facetsEnhanced = 'true';
      container.querySelectorAll('.stx-results-panel__facet').forEach(enhanceFacetGroup);
    }
    renderSelectedBadges(container.closest('.stx-results-panel'));
  };

  const collect = (node, className) => {
    if (!(node instanceof HTMLElement)) return [];
    return node.classList.contains(className) ? [node] : [...node.querySelectorAll(`.${className}`)];
  };

  const handleAdded = (node) => {
    collect(node, FACETS_CONTAINER_CLASS).forEach(enhance);
    // The header can arrive after the facets on first render, so a selection
    // restored from the URL still gets its badges.
    collect(node, RESULTS_META_CLASS)
      .forEach((meta) => renderSelectedBadges(meta.closest('.stx-results-panel')));
  };

  root.querySelectorAll(`.${FACETS_CONTAINER_CLASS}`).forEach(enhance);

  const observer = new MutationObserver((records) => {
    records.forEach((record) => record.addedNodes.forEach(handleAdded));
  });
  observer.observe(root, { childList: true, subtree: true });

  // Delegated, so the badges update on the click rather than waiting for the
  // response that replaces the facets. The library's own listener sits on the
  // input and has already run by the time this fires.
  root.addEventListener('change', (event) => {
    if (!event.target.closest?.('.stx-results-panel__facet-option')) return;
    renderSelectedBadges(event.target.closest('.stx-results-panel'));
  });
}

export default function decorate(block) {
  decorateResultsPanel(block, searchRenderers);
  observeFacets(block);
}
