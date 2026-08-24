/**
 * Speakers — the bio roster for a page.
 *
 * Authoring, in precedence order:
 *
 *   1. Slugs in the block. Either shape works:
 *
 *        | Speakers |                            |
 *        | -------- | -------------------------- |
 *        | bios     | tad-reeves, laurel-timko   |
 *
 *        | Speakers                 |
 *        | ------------------------ |
 *        | tad-reeves               |
 *        | laurel-timko             |
 *
 *   2. Nothing in the block — it reads `<meta name="speakers">` from the page,
 *      which is the contract every `/en/meetups/*` page already follows
 *      (docs/adaptto-2026/content-model.md). So an empty block on a meetup
 *      page needs no authoring at all.
 *
 * A bare slug resolves to `/en/fragments/bios/<slug>`; a token starting with
 * `/` is used verbatim, which is how another locale's bios get referenced.
 *
 * A slug with no document renders a visible "no bio yet" row rather than
 * vanishing — the orphan rule from content-model.md. That is deliberate: a
 * silently missing speaker is the failure nobody notices before publish.
 */

import { getConfig, getMetadata, loadStyle } from '../../scripts/ak.js';
import { buildBio, parseBio } from '../bio/bio.js';

const BIOS_PATH = '/en/fragments/bios';
const LABEL_CELLS = ['speakers', 'speaker', 'presenters', 'presenter', 'bios', 'bio', 'slugs'];
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function splitTokens(text) {
  return String(text || '')
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Read slugs out of the authored block: value cell when there is one, else the row. */
function slugsFromBlock(block) {
  return [...block.children].flatMap((row) => {
    const cells = [...row.children];
    if (!cells.length) return [];
    const source = cells.length > 1 ? cells[cells.length - 1] : cells[0];
    const label = cells[0].textContent.trim().toLowerCase();
    if (cells.length === 1 && LABEL_CELLS.includes(label)) return [];
    return splitTokens(source.textContent);
  });
}

function toPath(token) {
  if (token.startsWith('/')) return token.replace(/\.plain\.html$/, '').replace(/\/$/, '');
  return `${BIOS_PATH}/${token}`;
}

/**
 * The pipeline rewrites a document's images to `./media_<hash>.jpg`, relative to
 * that document. Moving the markup onto a host page changes what "." means, so
 * every such URL has to be resolved against the bio's own path first — the same
 * job blocks/fragment does in `replaceDotMedia`. Without this every headshot
 * 404s against the host page's folder.
 */
function resolveMediaUrls(root, docPath) {
  const base = new URL(`${docPath}.plain.html`, window.location.href);
  const resolve = (value) => value
    .split(',')
    .map((candidate) => {
      const [url, ...descriptors] = candidate.trim().split(/\s+/);
      if (!url.startsWith('./')) return candidate.trim();
      const abs = new URL(url, base);
      return [`${abs.pathname}${abs.search}`, ...descriptors].join(' ');
    })
    .join(', ');

  root.querySelectorAll('[src], [srcset]').forEach((el) => {
    ['src', 'srcset'].forEach((attr) => {
      const value = el.getAttribute(attr);
      if (value?.includes('./')) el.setAttribute(attr, resolve(value));
    });
  });
}

/** Fetch one bio document and hand back its `.bio` block, or null if absent. */
async function fetchBioBlock(path) {
  try {
    const resp = await fetch(`${path}.plain.html`);
    if (!resp.ok) return null;
    const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
    const block = doc.querySelector('.bio');
    if (block) resolveMediaUrls(block, path);
    return block;
  } catch (e) {
    return null;
  }
}

function missingRow(token) {
  const row = document.createElement('div');
  row.className = 'bio speakers-missing';
  row.innerHTML = `
    <div class="bio-photo bio-photo-initials" aria-hidden="true">?</div>
    <div class="bio-copy">
      <p class="bio-name"></p>
      <p class="bio-role">No bio yet</p>
      <div class="bio-body"><p>Add this bio in the Bio Manager and it appears here.</p></div>
    </div>
  `;
  row.querySelector('.bio-name').textContent = token;
  return row;
}

export default async function decorate(block) {
  const authored = slugsFromBlock(block);
  const tokens = authored.length ? authored : splitTokens(getMetadata('speakers'));
  const slugs = tokens.filter((t) => t.startsWith('/') || SLUG_RE.test(t));

  if (!slugs.length) {
    block.remove();
    return;
  }

  const { codeBase } = getConfig();
  const styles = loadStyle(`${codeBase}/blocks/bio/bio.css`);
  const blocks = await Promise.all(slugs.map((slug) => fetchBioBlock(toPath(slug))));

  const list = document.createElement('div');
  list.className = 'speakers-list';

  slugs.forEach((slug, i) => {
    const source = blocks[i];
    if (!source) {
      list.append(missingRow(slug));
      return;
    }
    const bio = parseBio(source);
    if (!bio.name) {
      list.append(missingRow(slug));
      return;
    }
    const row = document.createElement('div');
    row.className = 'bio';
    row.append(buildBio(bio));
    list.append(row);
  });

  await styles;
  block.replaceChildren(list);
  block.classList.add('speakers-decorated');
}
