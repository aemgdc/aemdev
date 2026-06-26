import { getMetadata } from '../../scripts/ak.js';
import { formatDate as fmtDate } from '../../scripts/utils/date.js';

function avatarFor(name) {
  if (!name) return 'TR';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function readTime(words) {
  const m = Math.max(1, Math.round(words / 220));
  return `${m} min read`;
}

function normalizeHeroImage(raw) {
  if (!raw) return '';
  try {
    const url = new URL(raw, window.location.origin);
    const width = parseInt(url.searchParams.get('width') || '', 10);
    if (Number.isFinite(width) && width < 2200) {
      url.searchParams.set('width', '2400');
    }
    if (url.origin === window.location.origin) {
      return `${url.pathname}${url.search}`;
    }
    return url.toString();
  } catch (e) {
    return raw;
  }
}

export default function decorate(block) {
  const section = block.closest('.section');
  const title = getMetadata('og:title') || document.querySelector('h1')?.textContent || '';
  const dek = block.textContent.trim() || getMetadata('description') || '';
  const tagsRaw = getMetadata('article:tag') || getMetadata('tags') || '';
  const author = getMetadata('author') || 'Tad Reeves';
  const date = getMetadata('date') || getMetadata('article:date') || '';
  const category = getMetadata('category') || 'Insights';
  const heroImg = normalizeHeroImage(
    getMetadata('hero-image')
      || getMetadata('heroimage')
      || getMetadata('image')
      || getMetadata('og:image')
      || '',
  );

  // word count for read-time estimate
  const wordCount = document.body.textContent.split(/\s+/).filter(Boolean).length;

  // Build the layered hero
  const bg = document.createElement('div');
  bg.className = 'bph-bg';
  if (heroImg) bg.style.backgroundImage = `url("${heroImg}")`;
  section.prepend(bg);
  const overlay = document.createElement('div');
  overlay.className = 'bph-overlay';
  section.prepend(overlay);
  section.classList.add('has-bph-bg');
  if (heroImg) section.classList.add('has-bph-image');

  const tags = tagsRaw.split(',').map((t) => t.trim()).filter(Boolean);

  block.innerHTML = '';
  const inner = document.createElement('div');
  inner.className = 'bph-inner';

  if (category) {
    const cat = document.createElement('p');
    cat.className = 'bph-category';
    cat.textContent = category;
    inner.append(cat);
  }

  const h1 = document.createElement('h1');
  h1.className = 'bph-title';
  h1.textContent = title;
  inner.append(h1);

  if (dek) {
    const p = document.createElement('p');
    p.className = 'bph-dek';
    p.textContent = dek;
    inner.append(p);
  }

  const byline = document.createElement('div');
  byline.className = 'bph-byline';
  const metaParts = [];
  if (author) metaParts.push(author);
  if (date) metaParts.push(fmtDate(date));
  metaParts.push(readTime(wordCount));
  const metaEl = document.createElement('div');
  metaEl.className = 'bph-byline-meta';
  metaEl.textContent = metaParts.join(' · ');
  byline.append(metaEl);
  inner.append(byline);

  block.append(inner);

  // Hide the page H1 elsewhere (the hero owns it now)
  const pageH1 = document.querySelector('main > .section:not(:first-child) h1');
  if (pageH1) pageH1.style.display = 'none';
}
