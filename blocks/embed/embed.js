import observe from '../../scripts/utils/observer.js';
import { getConfig, loadStyle } from '../../scripts/ak.js';
import { embedSrc as linkedinSrc, embedLinkedIn } from '../linkedin/linkedin.js';

function youtubeSrc(url) {
  const params = new URLSearchParams(url.search);
  const id = params.get('v') || url.pathname.split('/').pop();
  params.append('rel', '0');
  params.delete('v');
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params.toString()}`;
}

function spotifySrc(url) {
  const [type, id] = url.pathname.split('/').filter(Boolean);
  if (!type || !id) return null;
  return `https://open.spotify.com/embed/${type}/${id}`;
}

function decorate(el) {
  const { src, kind } = el.dataset;
  if (kind === 'spotify') {
    el.innerHTML = `<iframe src="${src}" class="spotify"
  frameborder="0" loading="lazy" allowtransparency="true"
  allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
  title="Spotify Embed"></iframe>`;
    return;
  }
  el.innerHTML = `<iframe src="${src}" class="youtube"
  webkitallowfullscreen mozallowfullscreen allowfullscreen
  allow="encrypted-media; accelerometer; gyroscope; picture-in-picture"
  scrolling="no"
  title="Embedded Video">`;
}

/**
 * Manually-authored "embed" block. Wraps a single link and turns it into an
 * inline iframe. Recognizes YouTube, Spotify and LinkedIn posts; other links
 * are left as-is.
 */
export default function init(block) {
  const a = block.querySelector('a[href]');
  if (!a) return;

  let url;
  try {
    url = new URL(a.href);
  } catch {
    return; // malformed URL — leave the original link in place
  }

  // LinkedIn posts render as their own card rather than a 16:9 frame, so hand
  // the link to that block — and to its stylesheet, which this block never loads.
  if (url.hostname.endsWith('linkedin.com') && linkedinSrc(a.href)) {
    loadStyle(`${getConfig().codeBase}/blocks/linkedin/linkedin.css`);
    block.replaceChildren(a); // drop the authoring table's wrapper cells
    if (embedLinkedIn(a)) return;
  }

  let src;
  let kind = 'video';
  if (url.hostname.includes('youtube') || url.hostname.includes('youtu.be')) {
    src = youtubeSrc(url);
  } else if (url.hostname.includes('spotify.com')) {
    src = spotifySrc(url);
    kind = 'spotify';
  }
  if (!src) return; // unsupported provider — keep the link as a fallback

  block.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'video';
  div.dataset.src = src;
  div.dataset.kind = kind;
  block.append(div);
  observe(div, decorate);
}
