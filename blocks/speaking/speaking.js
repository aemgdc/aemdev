/* Speaking — YouTube card grid. Each authored row is one card:
   | event label | title | youtube url |

   The site has a `youtube` auto-linkBlock that swaps youtube anchors for
   `<div class="video">` BEFORE this decorator runs, so we resolve the URL
   from either the original anchor (when present) or the auto-block's data-src. */

function videoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    if (u.pathname.includes('/embed/')) {
      return decodeURIComponent(u.pathname.split('/embed/').pop());
    }
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || '';
  } catch (e) {
    return '';
  }
}

function resolveUrl(cell) {
  if (!cell) return '';
  const a = cell.querySelector('a[href]');
  if (a) return a.getAttribute('href');
  const video = cell.querySelector('.video');
  if (video?.dataset?.src) return video.dataset.src;
  return cell.textContent.trim();
}

async function fetchOgImage(url) {
  const oembed = [
    `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
    `https://noembed.com/embed?url=${encodeURIComponent(url)}`,
  ];

  for (const endpoint of oembed) {
    try {
      const resp = await fetch(endpoint);
      if (resp.ok) {
        const data = await resp.json();
        if (data?.thumbnail_url) return data.thumbnail_url;
      }
    } catch (e) {
      // Ignore provider failures and continue through fallbacks.
    }
  }

  const id = videoId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
}

function readFeedConfig(rows) {
  const config = { source: '', category: '' };

  rows.forEach((row) => {
    const cells = [...row.querySelectorAll(':scope > div')];
    if (cells.length < 2) return;
    const key = (cells[0]?.textContent || '').trim().toLowerCase();
    const value = (cells[1]?.textContent || '').trim();
    if (!key || !value) return;
    if (key === 'source' || key === 'feed' || key === 'index') config.source = value;
    if (key === 'category') config.category = value;
  });

  return config;
}

function resolveFeedCandidates(source) {
  const candidates = [];
  const push = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  if (source) {
    push(source);
    try {
      const url = new URL(source, window.location.origin);
      const isAemHost = /\.aem\.(live|page)$/i.test(url.hostname);
      if (isAemHost && url.pathname.endsWith('.json')) {
        push(url.pathname);
      }
    } catch (e) {
      // If source isn't a valid URL, keep using it as-is.
    }
  }

  push('/speaking.json');
  return candidates;
}

async function fetchFeedData(source) {
  const candidates = resolveFeedCandidates(source);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const resp = await fetch(candidate);
      if (!resp.ok) {
        lastError = new Error(`Failed to fetch ${candidate} (${resp.status})`);
      } else {
        return await resp.json();
      }
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError || new Error('Unable to fetch speaking feed');
}

function buildCard(event, title, url, thumb) {
  const card = document.createElement('a');
  card.className = 'speaking-card';
  card.href = url;
  card.target = '_blank';
  card.rel = 'noopener';
  card.innerHTML = `
    <div class="speaking-thumb">
      ${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : ''}
    </div>
    <div class="speaking-body">
      <div class="speaking-event">${event}</div>
      <div class="speaking-title">${title}</div>
      <span class="speaking-link">Watch on YouTube →</span>
    </div>
  `;
  return card;
}

export default async function decorate(block) {
  const rows = [...block.querySelectorAll(':scope > div')];
  const { source, category } = readFeedConfig(rows);

  const grid = document.createElement('div');
  grid.className = 'speaking-grid';

  if (source) {
    try {
      const json = await fetchFeedData(source);
      const data = (json.data || []).filter((item) => {
        if (!category) return true;
        return (item.category || '').trim().toLowerCase() === category.trim().toLowerCase();
      });

      const cards = await Promise.all(data.map(async (item) => {
        const url = (item.url || '').trim();
        if (!url) return null;
        const thumb = await fetchOgImage(url);
        const event = (item.tag || item.category || 'Speaking').replace(/-/g, ' ');
        const title = (item.title || item.description || '').trim();
        const description = (item.description || '').trim();
        const cardTitle = description ? `${title} - ${description}` : title;
        return buildCard(event, cardTitle, url, thumb);
      }));

      cards.filter(Boolean).forEach((card) => grid.append(card));
    } catch (e) {
      const error = document.createElement('p');
      error.className = 'speaking-error';
      error.textContent = 'Unable to load speaking entries.';
      block.innerHTML = '';
      block.append(error);
      const section = block.closest('.section');
      if (section) section.classList.add('speaking-section');
      return;
    }
  } else {
    rows.forEach((row) => {
      const cells = [...row.querySelectorAll(':scope > div')];
      const event = (cells[0]?.textContent || '').trim();
      const title = (cells[1]?.textContent || '').trim();
      const url = resolveUrl(cells[2]);
      if (!url) return;

      const id = videoId(url);
      const watchUrl = id ? `https://www.youtube.com/watch?v=${id}` : url;
      const thumb = id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
      grid.append(buildCard(event, title, watchUrl, thumb));
    });
  }

  block.innerHTML = '';
  block.appendChild(grid);

  const section = block.closest('.section');
  if (section) section.classList.add('speaking-section');
}
