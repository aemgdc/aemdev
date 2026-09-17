import observe from '../../scripts/utils/observer.js';
import isOwnLine from '../../scripts/utils/own-line.js';

function decorate(el) {
  el.innerHTML = `<iframe src="${el.dataset.src}" class="spotify"
  frameborder="0" loading="lazy" allowtransparency="true"
  allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
  title="Spotify Embed"></iframe>`;
}

/**
 * Turns e.g. https://open.spotify.com/episode/<id>?si=... into the embed
 * mini-player https://open.spotify.com/embed/episode/<id>.
 * @param {HTMLAnchorElement} a the link to replace
 * @returns {boolean} true when the link became an embed
 */
function embedSpotify(a) {
  if (!a?.href?.includes('spotify.com')) return false;

  let type;
  let id;
  try {
    // pathname is /<type>/<id>; query params (e.g. ?si=) are dropped.
    const { pathname } = new URL(a.href);
    [type, id] = pathname.split('/').filter(Boolean);
  } catch {
    return false; // malformed URL — leave the original link in place
  }
  if (!type || !id) return false;

  const div = document.createElement('div');
  div.className = 'spotify-embed';
  div.dataset.src = `https://open.spotify.com/embed/${type}/${id}`;
  a.parentElement.replaceChild(div, a);
  observe(div, decorate);
  return true;
}

/**
 * Auto-blocked from Spotify links (see linkBlocks in scripts/scripts.js).
 * Only embeds a link left alone on a line; a track or episode mentioned inline
 * stays a link. An author can opt a whole link out with the framework's `#_dnb`
 * hash, which stops ak.js auto-blocking it upstream, so this never sees it.
 * @param {HTMLAnchorElement} a the auto-blocked link
 */
export default function init(a) {
  if (isOwnLine(a) && embedSpotify(a)) return;
  // Not embedded — shed the auto-block markers so no block styling leaks onto it.
  a.classList.remove('spotify', 'auto-block');
  if (!a.classList.length) a.removeAttribute('class');
  delete a.dataset.blockName;
}
