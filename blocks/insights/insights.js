/* Insights — dynamic article cards loaded from the query index.

   Variants (applied as block class via authoring, e.g. `Insights (images-large)`):
   - default / `text`        : 3-up text cards (tag, title, dek, CTA). No image.
   - `images-small`          : 3-up cards with image on top.
   - `images-large`          : 2-up cards with large image on top.

   Optional authored config rows (key | value):
   - limit    | 6                      (cards per page, default 9)
   - index    | /en/query-index.json   (query index path)
   - category | Meetup Recap, News     (only show articles in these categories)
   - tag      | EDS, GDC               (only show articles with any of these tags)

   `category` and `tag` accept a comma-separated list (matched case-insensitively;
   values within a key are OR'd). If both are given, an article must match both.

   Sort: by `date` descending.
*/

import { dateValue } from '../../scripts/utils/date.js';

const DEFAULT_INDEX = '/en/query-index.json';
const DEFAULT_PAGE_SIZE = 9;
const DA_HOST = 'https://content.da.live';

function cleanValue(s) {
  return (s || '').replace(/^["\s]+|["\s]+$/g, '');
}

// Normalize an article's `tags` field (array, JSON string, or comma list) to an array.
function articleTags(article) {
  const t = article.tags;
  if (Array.isArray(t)) return t.map(cleanValue).filter(Boolean);
  if (typeof t === 'string' && t.trim()) {
    const raw = t.trim();
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(cleanValue).filter(Boolean);
      } catch { /* fall through to manual parse */ }
      return raw.replace(/^\[|\]$/g, '').split(',').map(cleanValue).filter(Boolean);
    }
    return raw.split(',').map(cleanValue).filter(Boolean);
  }
  return [];
}

// Split a comma-separated authored value into a lowercased list for matching.
function splitList(val) {
  return val.split(',').map((s) => cleanValue(s).toLowerCase()).filter(Boolean);
}

function matchesFilters(article, { categories, tags }) {
  if (categories) {
    const cat = cleanValue(article.category).toLowerCase();
    if (!categories.includes(cat)) return false;
  }
  if (tags) {
    const articleTagsLc = articleTags(article).map((s) => s.toLowerCase());
    if (!tags.some((t) => articleTagsLc.includes(t))) return false;
  }
  return true;
}

function deriveTag(article) {
  if (article.category && article.category.trim()) return `// ${article.category.trim()}`;
  const [first] = articleTags(article);
  return first ? `// ${first}` : '// Field Notes';
}

function resolveImage(src) {
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src;
  // DA-hosted asset paths like /aemgdc/aemdev/en/... need the content.da.live host
  if (src.startsWith('/aemgdc/')) return `${DA_HOST}${src}`;
  return src;
}

function buildCard(article, withImage) {
  const card = document.createElement('a');
  card.className = 'insights-card';
  card.href = article.path;

  if (withImage) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'insights-card-image';
    const src = resolveImage(article.image);
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = article.title || '';
      img.loading = 'lazy';
      imgWrap.appendChild(img);
    } else {
      imgWrap.classList.add('insights-card-image-empty');
    }
    card.appendChild(imgWrap);
  }

  const body = document.createElement('div');
  body.className = 'insights-card-body';

  const tag = document.createElement('div');
  tag.className = 'insights-tag';
  tag.textContent = deriveTag(article);

  const title = document.createElement('h3');
  title.className = 'insights-title';
  title.textContent = article.title || article.path;

  const dek = document.createElement('p');
  dek.className = 'insights-dek';
  dek.textContent = article.description || '';

  const link = document.createElement('span');
  link.className = 'insights-link';
  link.textContent = 'Read more →';

  body.append(tag, title, dek, link);
  card.appendChild(body);
  return card;
}

function readConfig(block) {
  const config = { limit: DEFAULT_PAGE_SIZE, index: DEFAULT_INDEX };
  const rows = [...block.querySelectorAll(':scope > div')];
  rows.forEach((row) => {
    const cells = [...row.children];
    if (cells.length < 2) return;
    const key = (cells[0].textContent || '').trim().toLowerCase();
    const val = (cells[1].textContent || '').trim();
    if (!key || !val) return;
    if (key === 'limit' || key === 'count' || key === 'page-size') {
      const n = parseInt(val, 10);
      if (Number.isFinite(n) && n > 0) config.limit = n;
    } else if (key === 'index' || key === 'index-path') {
      if (val.startsWith('/')) config.index = val;
    } else if (key === 'category' || key === 'categories') {
      const list = splitList(val);
      if (list.length) config.categories = list;
    } else if (key === 'tag' || key === 'tags') {
      const list = splitList(val);
      if (list.length) config.tags = list;
    }
  });
  return config;
}

function resolveVariant(block) {
  if (block.classList.contains('images-large')) return 'images-large';
  if (block.classList.contains('images-small')) return 'images-small';
  return 'text';
}

export default async function decorate(block) {
  const config = readConfig(block);
  const { limit, index } = config;
  const variant = resolveVariant(block);
  const withImage = variant !== 'text';

  const section = block.closest('.section');
  if (section) section.classList.add('insights-section');

  block.innerHTML = '';
  block.classList.add(`insights-variant-${variant}`);

  const grid = document.createElement('div');
  grid.className = `insights-grid insights-grid-${variant}`;
  block.appendChild(grid);

  const moreWrap = document.createElement('div');
  moreWrap.className = 'insights-more-wrap';
  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = 'insights-more';
  moreBtn.textContent = 'More Articles →';
  moreWrap.appendChild(moreBtn);
  block.appendChild(moreWrap);

  let articles = [];
  let cursor = 0;

  function renderNext() {
    const slice = articles.slice(cursor, cursor + limit);
    slice.forEach((a) => grid.appendChild(buildCard(a, withImage)));
    cursor += slice.length;
    if (cursor >= articles.length) moreWrap.style.display = 'none';
  }

  try {
    const resp = await fetch(index);
    if (!resp.ok) throw new Error(`Failed to fetch ${index} (${resp.status})`);
    const json = await resp.json();
    articles = (json.data || [])
      .filter((a) => a.path
        && !a.path.endsWith('/index')
        && !a.redirectTarget
        && (!a.template || a.template === 'blog')
        && matchesFilters(a, config))
      .sort((a, b) => dateValue(b.date) - dateValue(a.date));
  } catch (e) {
    const err = document.createElement('p');
    err.className = 'insights-error';
    err.textContent = 'Unable to load articles.';
    block.insertBefore(err, moreWrap);
    moreWrap.style.display = 'none';
    return;
  }

  if (articles.length === 0) {
    moreWrap.style.display = 'none';
    return;
  }

  renderNext();
  moreBtn.addEventListener('click', renderNext);
}
