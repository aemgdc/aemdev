import observe from '../../scripts/utils/observer.js';
import isOwnLine from '../../scripts/utils/own-line.js';

/* Strava serves its embeds as an iframe at
     https://strava-embeds.com/<type>/<id>?style=standard&token=<token>
   Authors rarely see that URL: they paste Strava's embed code, and
   scripts/utils/embed-code.js turns it into a link to it before this block runs.
   The token is required — without it the frame is Strava's 403 page — and it can't
   be derived from the activity, which is why a plain activity link can't embed. */
const ORIGIN = 'https://strava-embeds.com';
const EMBED_PATH = /^\/([a-z]+)\/\d+\/?$/;

// The frame posts its content height to the parent as [ns, HEIGHT_MESSAGE, px], where
// ns is the namespace it was handed in its URL hash.
const HEIGHT_MESSAGE = 'BROADCAST_IFRAME_HEIGHT';

/**
 * Validate a strava-embeds.com iframe URL.
 * @param {string} href a link's href
 * @returns {string|null} the embed src, or null if this isn't an embeddable frame URL
 */
export function embedSrc(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null; // malformed URL
  }
  if (url.origin !== ORIGIN || !EMBED_PATH.test(url.pathname)) return null; // e.g. /embed.js
  if (!url.searchParams.get('token')) return null;
  return url.href;
}

function decorate(el) {
  const url = new URL(el.dataset.src);
  const [, type] = url.pathname.match(EMBED_PATH);

  // embed.js also hands the frame hostOrigin, hostPath and hostTitle, which Strava only
  // reports back to its own analytics, so they're left off. The namespace is all the
  // height handshake needs; any mapHash the snippet carried rides along after it.
  const ns = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const carried = new URLSearchParams(url.hash.slice(1));
  url.hash = new URLSearchParams([['ns', ns], ...carried]).toString();

  const iframe = document.createElement('iframe');
  iframe.src = url.href;
  iframe.title = `Embedded Strava ${type}`;
  iframe.allowFullscreen = true;

  // Strava sizes the frame to its content (photos, map, description all vary), so the
  // CSS default only holds the space until the first report arrives.
  window.addEventListener('message', ({ source, origin, data }) => {
    if (source !== iframe.contentWindow || origin !== ORIGIN) return;
    if (!Array.isArray(data) || data[0] !== ns || data[1] !== HEIGHT_MESSAGE) return;
    const height = Math.ceil(Number(data[2]));
    if (height > 0) el.style.setProperty('--strava-embed-height', `${height}px`);
  });

  el.replaceChildren(iframe);
}

/**
 * Swap a strava-embeds.com link for the embedded activity or route. The iframe itself
 * is deferred until the placeholder scrolls into view.
 * @param {HTMLAnchorElement} a the link
 * @returns {boolean} whether the link was embedded
 */
export function embedStrava(a) {
  const src = embedSrc(a.href);
  if (!src) return false;

  const div = document.createElement('div');
  div.className = 'strava-embed';
  div.dataset.src = src;
  a.parentElement.replaceChild(div, a);
  observe(div, decorate);
  return true;
}

/**
 * Auto-blocked from strava-embeds.com links (see linkBlocks in scripts/scripts.js).
 * Only embeds a link left alone on a line; anything inline stays a link. An author
 * can opt a whole link out with the framework's `#_dnb` hash, which stops ak.js
 * auto-blocking it upstream, so this never sees it.
 * @param {HTMLAnchorElement} a the auto-blocked link
 */
export default function init(a) {
  if (isOwnLine(a) && embedStrava(a)) return;
  // Not embedded — shed the auto-block markers so no block styling leaks onto it.
  a.classList.remove('strava', 'auto-block');
  if (!a.classList.length) a.removeAttribute('class');
  delete a.dataset.blockName;
}
