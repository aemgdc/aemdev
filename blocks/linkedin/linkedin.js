import observe from '../../scripts/utils/observer.js';

/* LinkedIn's guest embed endpoint renders a post from its URN:
     https://www.linkedin.com/embed/feed/update/urn:li:ugcPost:<id>
   Permalinks carry that URN in one of two shapes. Feed links spell it out —
     /feed/update/urn:li:activity:7498946243193257984/
   — while share links bury it in the last slug segment, after the post's words:
     /posts/dianne-eveler_adobe-eds-ugcPost-7498946243193257984-NbEe/          */
const URN_TYPES = { ugcpost: 'ugcPost', activity: 'activity', share: 'share' };
const LITERAL_URN = /urn:li:(ugcPost|activity|share):(\d+)/i;
const SLUG_URN = /-(ugcPost|activity|share)-(\d+)/gi;

/**
 * Build the guest embed URL for a LinkedIn post permalink.
 * @param {string} href a LinkedIn post URL
 * @returns {string|null} the embed src, or null if this isn't an embeddable post
 */
export function embedSrc(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null; // malformed URL
  }
  if (!url.hostname.endsWith('linkedin.com')) return null;

  // Feed permalinks percent-encode the URN's colons, so decode before matching.
  const path = decodeURIComponent(url.pathname);

  let type;
  let id;
  const literal = path.match(LITERAL_URN);
  if (literal) {
    [, type, id] = literal;
  } else {
    // Take the LAST match: a post's own words can contain "-share-", but only
    // the real URN is followed by a numeric id.
    const slug = [...path.matchAll(SLUG_URN)].at(-1);
    if (!slug) return null; // a profile, company or article link — not a post
    [, type, id] = slug;
  }

  const urn = URN_TYPES[type.toLowerCase()];
  if (!urn) return null;
  return `https://www.linkedin.com/embed/feed/update/urn:li:${urn}:${id}`;
}

function decorate(el) {
  // scrolling is left to "auto" on purpose: posts run to any length, so whatever
  // height the frame ends up with, the rest of the post stays reachable.
  el.innerHTML = `<iframe src="${el.dataset.src}"
  frameborder="0" loading="lazy" allowfullscreen
  allow="encrypted-media; fullscreen; picture-in-picture"
  title="Embedded LinkedIn post"></iframe>`;
}

/* A LinkedIn post can be two lines or twenty, and a cross-origin iframe can't
   report the height it wants — so the frame's height is authored, in the same
   `#_` hash language as link targets (see scripts/utils/link-target.js):

     https://www.linkedin.com/posts/...-ugcPost-7498946243193257984-NbEe/#_height=1450

   The hash is consumed here so it never survives as a fragment id. Without one,
   the CSS default applies and long posts scroll inside the frame. */
const HEIGHT_HASH = /#_height=(\d{2,4})(?![\w-])/;

function takeHeightHash(a) {
  const match = a.getAttribute('href').match(HEIGHT_HASH);
  if (!match) return null;
  a.setAttribute('href', a.getAttribute('href').replace(match[0], ''));
  return match[1];
}

/**
 * Swap an anchor for the embedded post. The iframe itself is deferred until the
 * placeholder scrolls into view; the placeholder reserves its height up front so
 * the swap costs no layout shift.
 * @param {HTMLAnchorElement} a the LinkedIn link
 * @returns {boolean} whether the link was embedded
 */
export function embedLinkedIn(a) {
  const src = embedSrc(a.href);
  if (!src) return false;

  const div = document.createElement('div');
  div.className = 'linkedin-embed';
  div.dataset.src = src;
  const height = takeHeightHash(a);
  if (height) div.style.setProperty('--linkedin-embed-height', `${height}px`);
  a.parentElement.replaceChild(div, a);
  observe(div, decorate);
  return true;
}

/* A link is "on its own line" when nothing else shares its paragraph or list
   item, so inline mentions of a post stay links. Compare text rather than child
   count: a formatting wrapper (a bolded link, say) adds an element but no text
   of its own, and shouldn't stop the line counting as the link's alone. */
function isOwnLine(a) {
  const line = a.closest('p, li');
  return !!line && line.textContent.trim() === a.textContent.trim();
}

/**
 * Auto-blocked from LinkedIn post links (see linkBlocks in scripts/scripts.js).
 * Only embeds a link left alone on a line; anything inline stays a link. An author
 * can opt a whole link out with the framework's `#_dnb` hash, which stops ak.js
 * auto-blocking it upstream, so this never sees it.
 * @param {HTMLAnchorElement} a the auto-blocked link
 */
export default function init(a) {
  if (isOwnLine(a) && embedLinkedIn(a)) return;
  // Not embedded — shed the auto-block markers so no block styling leaks onto it.
  a.classList.remove('linkedin', 'auto-block');
  if (!a.classList.length) a.removeAttribute('class');
  delete a.dataset.blockName;
}
