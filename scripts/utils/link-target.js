/*
 * Link targets — the default policy, and the authoring language that overrides it.
 *
 * DEFAULT: a link opens in the SAME window, whether it points inside the site or off
 * it. The one exception is a PDF, which opens in a new window. Nothing has to be
 * authored for that — a plain link gets the right behaviour on its own.
 *
 * OVERRIDE: append a target hash to the href and it becomes the anchor's `target`:
 *
 *   /en/meetups#_blank    /en/meetups#_self    /en/meetups#_parent    /en/meetups#_top
 *
 * The hash is *consumed* — stripped off the href before the browser ever sees it as
 * a fragment id — so it can sit alongside a real one in either order:
 * `/en/meetups#agenda#_blank` and `/en/meetups#_blank#agenda` both land on `agenda`
 * in a new window. Named-iframe targets are deliberately not supported; the four
 * reserved keywords are the whole vocabulary.
 *
 * ak.js's own `decorateHash` also understands `#_blank`, but this pass runs first
 * (`decorateArea` in scripts.js, ahead of `decorateSections`) and has already eaten
 * the hash by the time it looks — so ak.js stays pristine for Author Kit syncs and
 * the four keywords are handled in one place instead of one-and-a-half.
 */

// The negative lookahead keeps `#_topic` / `#_blank-2` from reading as targets: the
// keyword has to end the hash segment, not merely start it.
const TARGET_HASH = /#(_blank|_self|_parent|_top)(?![\w-])/;

/**
 * Pull a target hash off a link's href, if it has one.
 * @param {HTMLAnchorElement} a the link
 * @returns {string} the target keyword, or '' if the href carried none
 */
function takeTargetHash(a) {
  const href = a.getAttribute('href');
  const match = href.match(TARGET_HASH);
  if (!match) return '';
  // `#_blank` on its own leaves nothing behind — keep it a same-page link, not an
  // empty href (which resolves to the current URL *including* its query string).
  a.setAttribute('href', href.replace(match[0], '') || '#');
  return match[1];
}

/**
 * Does this link point at a PDF? Read the resolved PATHNAME, so a query string
 * (`/x/report.pdf?utm_source=news`) and an absolute URL both answer correctly.
 * @param {HTMLAnchorElement} a the link
 * @returns {boolean} true for a .pdf
 */
function isPdf(a) {
  try {
    const { pathname } = new URL(a.getAttribute('href'), window.location.href);
    return pathname.toLowerCase().endsWith('.pdf');
  } catch (e) {
    return false;
  }
}

/**
 * Apply the default target policy — and any authored override — to every link in an area.
 * Runs on the document and, via `loadArea`, on every fragment (header, footer, nav,
 * schedules), so authored chrome behaves the same as authored body copy.
 * @param {Element|Document} area the area to decorate
 */
export default function decorateLinkTargets(area) {
  for (const a of area.querySelectorAll('a[href]')) {
    // Consume the hash whatever we decide, so it never survives as a fragment id.
    const authored = takeTargetHash(a);
    // Precedence: the authored hash, then a target a block or the source markup
    // already set, then the PDF default. Everything else keeps the same window.
    const target = authored || a.getAttribute('target') || (isPdf(a) ? '_blank' : '');
    if (target) {
      a.target = target;
      if (target === '_blank' && !a.getAttribute('rel')) a.rel = 'noopener';
    }
  }
}
