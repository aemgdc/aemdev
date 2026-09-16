import observe from '../../scripts/utils/observer.js';
import isOwnLine from '../../scripts/utils/own-line.js';

function decorate(el) {
  el.innerHTML = `<iframe src="${el.dataset.src}" class="youtube"
  webkitallowfullscreen mozallowfullscreen allowfullscreen
  allow="encrypted-media; accelerometer; gyroscope; picture-in-picture"
  scrolling="no"
  title="Youtube Video">`;
}

function embedYoutube(a) {
  const div = document.createElement('div');
  div.className = 'video';
  const params = new URLSearchParams(a.search);
  const id = params.get('v') || a.pathname.split('/').pop();
  params.append('rel', '0');
  params.delete('v');
  div.dataset.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params.toString()}`;
  a.parentElement.replaceChild(div, a);
  observe(div, decorate);
}

/**
 * Auto-blocked from YouTube links (see linkBlocks in scripts/scripts.js).
 * Only embeds a link left alone on a line; anything inline — a chapter list whose
 * timestamps deep-link into the video, a video named mid-sentence — stays a link.
 * An author can opt a whole link out with the framework's `#_dnb` hash, which stops
 * ak.js auto-blocking it upstream, so this never sees it.
 * @param {HTMLAnchorElement} a the auto-blocked link
 */
export default function init(a) {
  if (isOwnLine(a)) {
    embedYoutube(a);
    return;
  }
  // Not embedded — shed the auto-block markers so no block styling leaks onto it.
  a.classList.remove('youtube', 'auto-block');
  if (!a.classList.length) a.removeAttribute('class');
  delete a.dataset.blockName;
}
