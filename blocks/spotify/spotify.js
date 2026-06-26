import observe from '../../scripts/utils/observer.js';

function decorate(el) {
  el.innerHTML = `<iframe src="${el.dataset.src}" class="spotify"
  frameborder="0" loading="lazy" allowtransparency="true"
  allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
  title="Spotify Embed"></iframe>`;
}

/**
 * Auto-blocked from Spotify links (see linkBlocks in scripts/scripts.js).
 * Turns e.g. https://open.spotify.com/episode/<id>?si=... into the embed
 * mini-player https://open.spotify.com/embed/episode/<id>.
 */
export default function init(a) {
  if (!a?.href?.includes('spotify.com')) return;

  let type;
  let id;
  try {
    // pathname is /<type>/<id>; query params (e.g. ?si=) are dropped.
    const { pathname } = new URL(a.href);
    [type, id] = pathname.split('/').filter(Boolean);
  } catch {
    return; // malformed URL — leave the original link in place
  }
  if (!type || !id) return;

  const div = document.createElement('div');
  div.className = 'spotify-embed';
  div.dataset.src = `https://open.spotify.com/embed/${type}/${id}`;
  a.parentElement.replaceChild(div, a);
  observe(div, decorate);
}
