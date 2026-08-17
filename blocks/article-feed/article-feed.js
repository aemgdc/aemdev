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
 *   | index  | /en/query-index.json |
 *   | path   | /en/meetups/         |  (optional) only paths under these prefixes
 *   | status | recap                |  (optional) only these `status` values
 *   | limit  | 4 |
 *   | badge  | ... |
 *   | title  | ... |
 *   | cta    | ... |
 *
 * `path` and `status` accept comma-separated lists and are matched
 * case-insensitively; values within a key are OR'd, and the two keys are AND'd.
 * Without them the feed shows everything in the index, which for a site-wide
 * index means landing pages and the home page too.
 *
 * Sort is by `eventDate` where present, else `date`, descending — an event that
 * happened has a more meaningful recency than the day it was written up. Most
 * recaps carry only `date`, so this degrades to publication order.
 */

import { formatDate, dateValue } from '../../scripts/utils/date.js';

// Split an authored comma-separated cell into a lowercased list for matching.
function splitList(val) {
  return (val || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/*
 * Tags and categories are stored as canonical AEM ids (aemdev:category/meetup),
 * which must never reach a reader. Until the synced label map exists, derive a
 * readable label from the id's last segment.
 */
function labelFromTag(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return '';
  const afterSlash = String(raw).split('/').pop();
  const leaf = afterSlash.split(':').pop();
  return leaf
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Recency for an event: when it happened, else when it was written up.
function recencyOf(article) {
  return dateValue(article.eventDate || article.date);
}

function parseRows(block) {
  const config = {
    badge: '',
    title: '',
    cta: null,
    indexPath: '',
    paths: null,
    statuses: null,
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
      case 'path':
      case 'paths': config.paths = splitList(value); break;
      case 'status':
      case 'statuses': config.statuses = splitList(value); break;
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

async function loadArticles(indexPath, { paths, statuses } = {}) {
  const resp = await fetch(indexPath);
  if (!resp.ok) throw new Error(`Failed to fetch ${indexPath}`);
  const json = await resp.json();
  const articles = (json.data || [])
    .filter((a) => a.pagetype !== 'page' && !a.path.endsWith('/index'))
    .filter((a) => {
      if (!paths) return true;
      const path = (a.path || '').toLowerCase();
      // A prefix match on the folder, excluding the folder's own landing page.
      return paths.some((prefix) => path.startsWith(prefix) && path !== prefix.replace(/\/$/, ''));
    })
    .filter((a) => !statuses || statuses.includes((a.status || '').toLowerCase()));
  articles.sort((a, b) => recencyOf(b) - recencyOf(a));
  return articles;
}

function articleToCard(article) {
  const when = article.eventDate || article.date;
  return {
    category: labelFromTag(article.category || article.tags),
    title: article.title || '',
    dek: article.description || '',
    url: article.path || '#',
    date: when ? formatDate(when) : '',
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
      const articles = (await loadArticles(config.indexPath, config))
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
