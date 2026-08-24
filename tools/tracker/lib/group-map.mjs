/**
 * group-map.mjs — which tracked group does a page path belong to?
 *
 * Node-side only (it is `.mjs`, so it must never appear in a browser import graph —
 * see tools/tracker/check-browser-modules.mjs). It has no Node APIs of its own; the
 * restriction is about the extension, not the dependencies.
 *
 * ─── Resolution is BY PATH PREFIX, never by `template` ───────────────────────
 *
 * `scripts/scripts.js` builds `templatedSections` from `['articles',
 * 'meetup-recaps', 'meeting-recaps']` — `'meetups'` is absent. Since the content
 * moved to `/en/meetups/`, the path-based `template=` auto-injection no longer fires
 * there, so those pages carry NO template metadata at all: verified against the live
 * index, every `/en/meetups/*` row does have `template: 'meetup'` from its own
 * authored metadata, but the three landing pages and `/en/contact` have
 * `template: ''`. A template-keyed grouper therefore classifies the landing pages as
 * ungrouped and would classify the meetup pages as ungrouped the day anyone drops the
 * per-page metadata row. Path prefix is the fact that cannot go missing.
 *
 * ─── The two orderings that matter ──────────────────────────────────────────
 *
 * 1. LANDING PAGES ARE LISTED EXPLICITLY, AND MATCHED FIRST. `/en/meetups` (the
 *    section landing page) belongs to `indexes`; `/en/meetups/berlin` belongs to
 *    `meetups`. They differ by one path segment, so an unordered prefix map puts the
 *    landing page in the wrong group — and the landing page is the one with its own
 *    judge brief and its own visual baseline, because a section index is a different
 *    BUILD from the pages beneath it.
 *
 * 2. LONGEST PREFIX WINS among the prefix groups, so a future `/en/articles/series/**`
 *    group cannot be shadowed by `/en/articles/**`.
 *
 * ─── Why `meetups` accepts two prefixes ─────────────────────────────────────
 *
 * The `/en/meetup-recaps/` → `/en/meetups/` rename has already happened on the live
 * site, but the git tree, `helix-query.yaml` and `scripts/scripts.js` all still carry
 * the old spelling. Accepting BOTH prefixes means the tracker survives the rename in
 * either direction: a page that reappears at the old path is still tracked in the
 * group that owns it, and a partial revert does not silently drop 14 pages out of
 * every count. Neither prefix is deprecated here — remove one only when nothing on
 * the live host answers it.
 */
import { normalizePath, basePath } from '../../../scripts/tracker/locales.js';

/**
 * The landing pages, group by group, spelled out.
 *
 * `/` is the root home page. It sits OUTSIDE every index's `include: /en/**` (see
 * config/sites/aemdev/query.yaml), so no query index will ever list it and
 * `sync-groups-from-index` has to add it as a deliberate manual row. It is a tracked
 * page all the same — it is the first thing a visitor sees.
 *
 * `/en` is the locale home page. The live index lists it as `/en/`, with the trailing
 * slash; every path here and every path compared against it goes through
 * `normalizePath` first, because the slashed form 404s on this site and the two
 * spellings must not become two rows for one page.
 */
export const LANDING_PAGES = {
  indexes: ['/', '/en', '/en/articles', '/en/meetups', '/en/contact'],
};

/**
 * Prefix-matched groups, most specific first.
 *
 * A prefix matches the bare prefix path as well as its children, so a hypothetical
 * bare `/en/meetup-recaps` landing page resolves to `meetups` rather than to nothing.
 * That cannot steal `/en/meetups` from `indexes`, because the landing list above is
 * consulted first.
 */
export const GROUP_PREFIXES = [
  { group: 'bios', prefixes: ['/en/fragments/bios'] },
  { group: 'meetups', prefixes: ['/en/meetups', '/en/meetup-recaps'] },
  { group: 'technical-articles', prefixes: ['/en/articles'] },
];

/**
 * Every group name this map can produce, in orchestrator.json registry order.
 *
 * Registry order, not alphabetical: the four group sheets are created, synced and
 * reported in this order everywhere, and a tool that lists them differently reads as
 * a different set of groups.
 */
export const GROUP_NAMES = ['indexes', 'meetups', 'technical-articles', 'bios'];

/** Is this path one of the explicitly listed landing pages? */
function landingGroup(path) {
  for (const [group, pages] of Object.entries(LANDING_PAGES)) {
    if (pages.includes(path)) return group;
  }
  return null;
}

const prefixMatches = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Which group owns this page path?
 *
 * @param {string} path any page path; normalized here, so a caller may pass the raw
 *   `path` value out of a query index row (`/en/` and `/en` both resolve).
 * @returns {string|null} the group name, or `null` for a path in no tracked group.
 *
 * `null`, never a default bucket. The tracker this is ported from routed everything
 * it could not classify into a `snowflakes` catch-all, and the cost was that a
 * misspelled path or a new section silently became a tracked page in a group whose
 * judge brief and visual baseline did not describe it. Here an unresolved path is
 * REPORTED by the sync and left out of every sheet, which is the only answer that
 * makes "19 pages in, 19 pages tracked" a claim worth checking.
 *
 * Deliberately STRICT about the source tree: only `/` and paths under `/en` resolve.
 * A locale path (`/de/meetups/x`) resolves to `null` even though it is obviously a
 * meetup, because the `data` tab of a group sheet is keyed on EN paths — accepting a
 * locale path here would let a locale row be reconciled into the master tab as if it
 * were a page of its own, doubling the denominator. `pagetypeOf` below is the
 * locale-tolerant one, because a locale ROW legitimately wants the coarse kind.
 */
export function groupForPath(path) {
  const p = normalizePath(path);
  if (!p) return null;

  const landing = landingGroup(p);
  if (landing) return landing;

  // Longest prefix wins, so adding a narrower group later cannot be shadowed by a
  // broader one that happens to be listed first.
  let best = null;
  let bestLength = 0;
  for (const { group, prefixes } of GROUP_PREFIXES) {
    for (const prefix of prefixes) {
      if (prefixMatches(p, prefix) && prefix.length > bestLength) {
        best = group;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * The coarse kind of a page, for the band-1 `pagetype` column.
 *
 * Derived from the path, NOT from `template`, for the reason in the header — and it
 * is a separate axis from the group on purpose: `indexes` holds three different kinds
 * of page (the two homes, two section indexes and one standalone page), and a judge
 * brief that cannot tell them apart is a brief that has to hedge.
 *
 * Locale-tolerant: the locale prefix is stripped through `basePath`, so a locale row
 * and its English source always agree about the kind. `/de/articles/x` and
 * `/en/articles/x` are both `article`.
 */
export const PAGETYPES = ['home', 'index', 'page', 'meetup', 'article', 'bio'];

export function pagetypeOf(path) {
  const base = basePath(normalizePath(path));
  if (!base || base === '/') return 'home';
  if (prefixMatches(base, '/fragments/bios')) return 'bio';
  if (base === '/articles' || base === '/meetups' || base === '/meetup-recaps') return 'index';
  if (prefixMatches(base, '/articles')) return 'article';
  if (prefixMatches(base, '/meetups') || prefixMatches(base, '/meetup-recaps')) return 'meetup';
  if (base === '/contact') return 'page';
  return '';
}

/**
 * Pages no query index can supply, and which group carries them anyway.
 *
 * Exactly one today. `/` is outside `include: /en/**` for every index in
 * config/sites/aemdev/query.yaml, so a sync driven by `/en/query-index.json` will
 * never see it. Listing it here rather than hardcoding it inside the sync means the
 * next such page (a `/robots`-adjacent landing page, a campaign root) is one line
 * rather than a second special case.
 *
 * `title` is a seed only. It is a band-1 column, so the sync overwrites it the moment
 * a real observation is available — the status API reports the live path, not its
 * title, so today the seed is what stays.
 */
export const MANUAL_PAGES = [
  {
    path: '/',
    group: 'indexes',
    title: 'aemdev.org (root home)',
    why: 'outside every query index include: /en/** — see config/sites/aemdev/query.yaml',
  },
];

/** The manual pages belonging to one group. */
export const manualPagesFor = (group) => MANUAL_PAGES.filter((m) => m.group === group);
