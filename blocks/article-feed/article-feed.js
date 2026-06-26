/**
 * Article Feed block — fetches posts from the query index and renders cards.
 *
 * Configuration via block content:
 * - Row 1: query index path (e.g. /opsinventor-en.json)
 * - Row 2 (optional): limit (default 10)
 *
 * The locale-specific index path makes this block reusable across locales:
 *   /opsinventor-en.json, /opsinventor-de.json, etc.
 *
 * Index `date` fields are ISO `yyyy-mm-dd`; see scripts/utils/date.js.
 */

import { formatDate, dateValue } from '../../scripts/utils/date.js';

function createCard(article, featured = false) {
  const card = document.createElement('article');
  card.className = featured ? 'feed-card feed-card-featured' : 'feed-card';

  const link = document.createElement('a');
  link.href = article.path;
  link.className = 'feed-card-link';

  if (article.image) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'feed-card-image';
    const img = document.createElement('img');
    img.src = article.image;
    img.alt = article.title || '';
    img.loading = 'lazy';
    imgWrap.append(img);
    link.append(imgWrap);
  }

  const content = document.createElement('div');
  content.className = 'feed-card-content';

  if (article.tags) {
    const tags = document.createElement('div');
    tags.className = 'feed-card-tags';
    tags.textContent = article.tags;
    content.append(tags);
  }

  const title = document.createElement('h3');
  title.textContent = article.title || '';
  content.append(title);

  const meta = document.createElement('div');
  meta.className = 'feed-card-meta';
  const parts = [];
  if (article.date) parts.push(formatDate(article.date));
  if (article.author) parts.push(article.author);
  meta.textContent = parts.join(' · ');
  content.append(meta);

  if (article.description) {
    const desc = document.createElement('p');
    desc.className = 'feed-card-description';
    desc.textContent = article.description;
    content.append(desc);
  }

  link.append(content);
  card.append(link);
  return card;
}

/**
 * Fetch, filter (blog posts only) and date-sort the article index.
 * @returns {Promise<Array>} newest-first list of articles
 */
async function loadArticles(indexPath) {
  const resp = await fetch(indexPath);
  if (!resp.ok) throw new Error(`Failed to fetch ${indexPath}`);
  const json = await resp.json();

  const articles = (json.data || [])
    .filter((a) => a.pagetype !== 'page' && !a.path.endsWith('/index'));

  articles.sort((a, b) => dateValue(b.date) - dateValue(a.date));

  return articles;
}

/**
 * Read key/value config rows for the rapid-drop variant.
 * Falls back to positional rows (index, limit) for back-compat.
 */
function parseRapidConfig(rows) {
  const config = {
    indexPath: '/opsinventor-en.json',
    limit: 4,
    badge: '// Featured Reads',
    title: 'Latest drops.',
    cta: null,
  };

  rows.forEach((row, idx) => {
    const cells = [...row.children];
    const keyCell = cells[0];
    const valueCell = cells[1] || cells[0];
    const key = keyCell?.textContent?.trim().toLowerCase();
    const value = valueCell?.textContent?.trim() || '';

    switch (key) {
      case 'index':
      case 'index path':
        config.indexPath = value || config.indexPath;
        break;
      case 'limit':
        config.limit = parseInt(value, 10) || config.limit;
        break;
      case 'badge':
        config.badge = value;
        break;
      case 'title':
        config.title = value;
        break;
      case 'cta':
      case 'link': {
        const link = valueCell?.querySelector('a[href]');
        if (link) config.cta = { label: link.textContent.trim(), href: link.getAttribute('href') };
        break;
      }
      default:
        // Positional fallback: single-cell rows (no key/value pair).
        if (cells.length === 1) {
          if (idx === 0 && value) config.indexPath = value;
          if (idx === 1 && parseInt(value, 10)) config.limit = parseInt(value, 10);
        }
        break;
    }
  });

  // Hard cap: never more than 4 featured articles.
  config.limit = Math.min(Math.max(config.limit, 1), 4);
  return config;
}

/**
 * Rapid Drop variant: compact, orange-panel feed of up to 4 featured articles.
 * Designed to drop into the home-hero right column (keeps the .rapid-drop hook).
 */
async function renderRapidDrop(el) {
  const rows = [...el.querySelectorAll(':scope > div')];
  const config = parseRapidConfig(rows);

  el.innerHTML = '';

  if (config.badge) {
    const badge = document.createElement('div');
    badge.className = 'feed-drop-badge';
    badge.textContent = config.badge;
    el.append(badge);
  }

  if (config.title) {
    const title = document.createElement('h2');
    title.className = 'feed-drop-title';
    title.textContent = config.title;
    el.append(title);
  }

  const list = document.createElement('ul');
  list.className = 'feed-drop-list';
  el.append(list);

  try {
    const articles = (await loadArticles(config.indexPath))
      .filter((a) => !a.path.includes('/drafts/'))
      .slice(0, config.limit);
    if (articles.length === 0) {
      list.remove();
      const empty = document.createElement('p');
      empty.className = 'feed-drop-empty';
      empty.textContent = 'No articles yet.';
      el.append(empty);
    } else {
      articles.forEach((article) => {
        const item = document.createElement('li');
        item.className = 'feed-drop-item';

        const link = document.createElement('a');
        link.className = 'feed-drop-link';
        link.href = article.path;

        const itemTitle = document.createElement('span');
        itemTitle.className = 'feed-drop-item-title';
        itemTitle.textContent = article.title || '';
        link.append(itemTitle);

        const meta = document.createElement('span');
        meta.className = 'feed-drop-item-meta';
        const parts = [];
        if (article.date) parts.push(formatDate(article.date));
        if (article.categories) parts.push(article.categories);
        else if (article.author) parts.push(article.author);
        meta.textContent = parts.join(' · ');
        link.append(meta);

        item.append(link);
        list.append(item);
      });
    }
  } catch (e) {
    list.remove();
    const err = document.createElement('p');
    err.className = 'feed-drop-empty';
    err.textContent = 'Unable to load articles.';
    el.append(err);
  }

  if (config.cta) {
    const cta = document.createElement('a');
    cta.className = 'feed-drop-cta';
    cta.href = config.cta.href;
    cta.textContent = config.cta.label;
    el.append(cta);
  }
}

export default async function init(el) {
  if (el.classList.contains('rapid-drop')) {
    await renderRapidDrop(el);
    return;
  }

  const rows = el.querySelectorAll(':scope > div');
  const indexPath = rows[0]?.textContent?.trim() || '/opsinventor-en.json';
  const limit = parseInt(rows[1]?.textContent?.trim(), 10) || 0;

  el.innerHTML = '';

  try {
    let articles = await loadArticles(indexPath);

    if (limit > 0) articles = articles.slice(0, limit);

    if (articles.length === 0) {
      el.textContent = 'No articles found.';
      return;
    }

    // Featured section: top 5
    const featured = articles.slice(0, 5);
    const rest = articles.slice(5);

    const featuredSection = document.createElement('div');
    featuredSection.className = 'feed-featured';
    featured.forEach((a) => featuredSection.append(createCard(a, true)));
    el.append(featuredSection);

    // Remaining articles
    if (rest.length > 0) {
      const listSection = document.createElement('div');
      listSection.className = 'feed-list';
      rest.forEach((a) => listSection.append(createCard(a)));
      el.append(listSection);
    }
  } catch (e) {
    el.textContent = 'Unable to load articles.';
  }
}
