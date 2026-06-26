/**
 * Article Feed block — card grid with section header.
 *
 * Two rendering modes (auto-detected from content model):
 *
 * Static mode (when block has card-N-* rows):
 *   | badge           | // Technical Writing |
 *   | title           | Latest from the community. |
 *   | cta             | <a href="/en/articles/">All articles</a> |
 *   | card-1-category | AEM EDS |
 *   | card-1-title    | AEM EDS Content Modeling: A Deep Dive |
 *   | card-1-dek      | A field guide... |
 *   | card-1-url      | /en/articles/aem-eds-content-modeling-deep-dive/ |
 *   | card-1-date     | Jun 25, 2026 |
 *   | card-1-author   | Tad Reeves |
 *
 * Dynamic mode (falls back to index fetch when no card rows present):
 *   | index | /en/articles/query-index.json |
 *   | limit | 4 |
 *   | badge | ... |
 *   | title | ... |
 *   | cta   | ... |
 */

import { formatDate, dateValue } from '../../scripts/utils/date.js';

function parseRows(block) {
  const config = {
    badge: '',
    title: '',
    cta: null,
    indexPath: '',
    limit: 4,
    cards: [],
  };

  const cardMap = {};

  const rows = [...block.querySelectorAll(':scope > div')];
  rows.forEach((row) => {
    const cells = [...row.children];
    if (cells.length < 2) return;
    const key = (cells[0].textContent || '').trim().toLowerCase();
    const valueCell = cells[1];
    const value = (valueCell.textContent || '').trim();

    const cardMatch = key.match(/^card-(\d+)-(.+)$/);
    if (cardMatch) {
      const num = cardMatch[1];
      const field = cardMatch[2];
      if (!cardMap[num]) cardMap[num] = {};
      if (field === 'url') {
        const link = valueCell.querySelector('a[href]');
        cardMap[num].url = link ? link.getAttribute('href') : value;
      } else {
        cardMap[num][field] = value;
      }
      return;
    }

    switch (key) {
      case 'badge': config.badge = value; break;
      case 'title': config.title = value; break;
      case 'index':
      case 'index path': config.indexPath = value; break;
      case 'limit': config.limit = parseInt(value, 10) || 4; break;
      case 'cta':
      case 'link': {
        const link = valueCell.querySelector('a[href]');
        if (link) config.cta = { label: link.textContent.trim(), href: link.getAttribute('href') };
        break;
      }
      default: break;
    }
  });

  if (Object.keys(cardMap).length) {
    config.cards = Object.keys(cardMap)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
      .map((num) => cardMap[num]);
  }

  return config;
}

function buildSectionHeader(config) {
  const header = document.createElement('div');
  header.className = 'feed-section-header';

  const left = document.createElement('div');
  if (config.badge) {
    const badge = document.createElement('p');
    badge.className = 'feed-section-badge';
    badge.textContent = config.badge;
    left.append(badge);
  }
  if (config.title) {
    const title = document.createElement('h2');
    title.className = 'feed-section-title';
    title.textContent = config.title;
    left.append(title);
  }
  header.append(left);

  if (config.cta) {
    const cta = document.createElement('a');
    cta.className = 'feed-section-cta';
    cta.href = config.cta.href;
    cta.textContent = config.cta.label;
    header.append(cta);
  }

  return header;
}

function buildCard(card) {
  const a = document.createElement('a');
  a.className = 'feed-card-item';
  a.href = card.url || '#';

  if (card.category) {
    const cat = document.createElement('p');
    cat.className = 'feed-card-category';
    cat.textContent = card.category;
    a.append(cat);
  }

  const title = document.createElement('h3');
  title.className = 'feed-card-title';
  title.textContent = card.title || '';
  a.append(title);

  if (card.dek) {
    const dek = document.createElement('p');
    dek.className = 'feed-card-dek';
    dek.textContent = card.dek;
    a.append(dek);
  }

  const meta = document.createElement('div');
  meta.className = 'feed-card-meta';
  const parts = [];
  if (card.date) parts.push(card.date);
  if (card.author) parts.push(card.author);
  if (parts.length) meta.textContent = parts.join(' · ');
  a.append(meta);

  return a;
}

function buildGrid(cards) {
  const grid = document.createElement('div');
  grid.className = 'feed-card-grid';
  cards.forEach((card) => grid.append(buildCard(card)));
  return grid;
}

async function loadArticles(indexPath) {
  const resp = await fetch(indexPath);
  if (!resp.ok) throw new Error(`Failed to fetch ${indexPath}`);
  const json = await resp.json();
  const articles = (json.data || [])
    .filter((a) => a.pagetype !== 'page' && !a.path.endsWith('/index'));
  articles.sort((a, b) => dateValue(b.date) - dateValue(a.date));
  return articles;
}

function articleToCard(article) {
  return {
    category: article.tags || article.category || '',
    title: article.title || '',
    dek: article.description || '',
    url: article.path || '#',
    date: article.date ? formatDate(article.date) : '',
    author: article.author || '',
  };
}

export default async function init(el) {
  const config = parseRows(el);
  el.innerHTML = '';

  const inner = document.createElement('div');
  inner.className = 'article-feed-inner';

  if (config.badge || config.title || config.cta) {
    inner.append(buildSectionHeader(config));
  }

  if (config.cards.length > 0) {
    inner.append(buildGrid(config.cards));
  } else if (config.indexPath) {
    try {
      const articles = (await loadArticles(config.indexPath))
        .slice(0, config.limit)
        .map(articleToCard);
      if (articles.length) {
        inner.append(buildGrid(articles));
      } else {
        const empty = document.createElement('p');
        empty.className = 'feed-empty';
        empty.textContent = 'No articles yet.';
        inner.append(empty);
      }
    } catch {
      const err = document.createElement('p');
      err.className = 'feed-empty';
      err.textContent = 'Unable to load articles.';
      inner.append(err);
    }
  }

  el.append(inner);
}
