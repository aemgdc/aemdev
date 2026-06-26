#!/usr/bin/env node

/**
 * Converts WordPress-extracted .plain.html articles from the old format
 * to the DA source format used by OpsInventor EDS.
 *
 * DA source format:
 *   <body><header></header><main><div>...section...</div></main><footer></footer></body>
 *
 * Blocks use nested divs with class, cell content wrapped in <p> tags.
 *
 * Usage:
 *   node tools/convert-to-new-blocks.mjs content/en/slug.plain.html
 *   node tools/convert-to-new-blocks.mjs --batch content/en/*.plain.html
 */

import fs from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

// --- Utility helpers ---

function parseDate(raw) {
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.trim();
  return d.toISOString().slice(0, 10);
}

function extractTextContent(el) {
  if (!el) return '';
  return el.textContent.trim();
}

function getImgSrc(el) {
  if (!el) return '';
  const img = el.querySelector('img');
  if (img) return img.getAttribute('src') || '';
  return el.textContent.trim();
}

// --- Metadata extraction ---

function extractMetadataFromTable(doc) {
  const meta = {};
  const tables = doc.querySelectorAll('table');
  for (const table of tables) {
    const header = table.querySelector('th');
    if (!header) continue;
    if (header.textContent.trim().toLowerCase() === 'metadata') {
      const rows = table.querySelectorAll('tr');
      for (let i = 1; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll('td');
        if (cells.length >= 2) {
          const key = extractTextContent(cells[0]).toLowerCase();
          if (key === 'image') {
            meta[key] = getImgSrc(cells[1]) || extractTextContent(cells[1]);
          } else {
            meta[key] = extractTextContent(cells[1]);
          }
        }
      }
      table.closest('div')?.remove();
      break;
    }
  }
  return meta;
}

function extractMetadataFromDivs(doc) {
  const meta = {};
  const metaDiv = doc.querySelector('.metadata');
  if (!metaDiv) return meta;
  const rows = metaDiv.querySelectorAll(':scope > div');
  for (const row of rows) {
    const cells = row.querySelectorAll(':scope > div');
    if (cells.length >= 2) {
      const key = extractTextContent(cells[0]).toLowerCase();
      if (key === 'image') {
        meta[key] = getImgSrc(cells[1]) || extractTextContent(cells[1]);
      } else {
        meta[key] = extractTextContent(cells[1]);
      }
    }
  }
  metaDiv.closest('div')?.remove();
  return meta;
}

// --- Comments stripping ---

function stripComments(doc) {
  const headings = doc.querySelectorAll('h2');
  for (const h of headings) {
    if (h.textContent.trim().toLowerCase() === 'comments') {
      const container = h.closest('div');
      if (container) {
        container.remove();
      }
    }
  }
}

// --- Body content extraction ---

function extractBodyContent(doc) {
  const topDivs = doc.querySelectorAll('body > div');
  const bodyParts = [];

  for (const div of topDivs) {
    if (div.querySelector('.blog-post-hero') || div.querySelector('table th')?.textContent?.trim() === 'Blog Post Hero') {
      continue;
    }
    if (div.querySelector('.metadata') || div.querySelector('table th')?.textContent?.trim() === 'Metadata') {
      continue;
    }
    if (!div.textContent.trim()) continue;

    // Remove any section-metadata tables (old format) or divs - we'll rebuild sections
    const smTables = div.querySelectorAll('table');
    for (const t of smTables) {
      const th = t.querySelector('th');
      if (th && th.textContent.trim().toLowerCase() === 'section metadata') {
        t.remove();
      }
    }
    const smDivs = div.querySelectorAll('.section-metadata');
    for (const sm of smDivs) { sm.remove(); }

    const html = div.innerHTML.trim();
    if (html) bodyParts.push(html);
  }

  return bodyParts.join('\n\n');
}

// --- Key points generation ---

function generateKeyPoints(bodyContent, tags, title) {
  const headingMatches = [...bodyContent.matchAll(/<h[23][^>]*>(.*?)<\/h[23]>/gi)];
  const points = headingMatches
    .map(m => m[1].replace(/<[^>]+>/g, '').trim())
    .filter(t => t.toLowerCase() !== 'comments' && t.toLowerCase() !== 'summary' && t.length > 0 && t.length < 60)
    .slice(0, 4);

  if (points.length >= 2) return points;

  if (tags) {
    const tagList = tags.split(',').map(t => t.trim()).filter(t => t.length > 2);
    if (tagList.length >= 2) return tagList.slice(0, 4);
  }

  return [title.split(/[–—:]/)[0].trim()];
}

// --- CTA question generation ---

function generateCtaQuestion(category, tags, title) {
  const lower = (category + ' ' + tags + ' ' + title).toLowerCase();
  if (lower.includes('aem') || lower.includes('adobe') || lower.includes('experience manager')) {
    return 'Got an AEM challenge that needs solving?';
  }
  if (lower.includes('cloud') || lower.includes('infrastructure') || lower.includes('devops')) {
    return 'Wrestling with infrastructure decisions?';
  }
  if (lower.includes('migration') || lower.includes('upgrade')) {
    return 'Facing a migration or upgrade decision?';
  }
  return 'Got a hard problem that needs a straight answer?';
}

function cleanCategory(cat) {
  const catMap = {
    'aem / cq': 'AEM',
    'technology': 'Technology',
    'aem / cq, technology': 'AEM',
    'photography': 'Photography',
    'automobiles': 'Automobiles',
    'mountain biking': 'Mountain Biking',
    'random nonsense': 'Random',
    'video games': 'Video Games',
    'life': 'Life',
  };
  const lower = cat.toLowerCase().trim();
  return catMap[lower] || cat.split(',')[0].trim();
}

// --- Generate DA source HTML ---

function generateDaSource(bodyContent, metadata) {
  const title = metadata.title || 'Untitled';
  const description = metadata.description || '';
  const image = metadata.image || '';
  const author = metadata.author || 'Tad Reeves';
  const date = parseDate(metadata.date);
  const category = metadata.category || metadata.categories || 'Field Notes';
  const tags = metadata.tags || '';
  const template = metadata.template || 'blog';

  const keyPoints = generateKeyPoints(bodyContent, tags, title);

  let sections = [];

  // Section 1: Blog Post Hero
  sections.push('<div><div class="blog-post-hero"><div><div></div></div></div></div>');

  // Section 2: Key Points + section-metadata
  const kpItems = keyPoints.map(kp => `<li>${kp}</li>`).join('');
  sections.push(
    `<div><p>// Key takeaways</p><ul>${kpItems}</ul>` +
    `<div class="section-metadata"><div><div><p>Style</p></div><div><p>key-points</p></div></div></div></div>`
  );

  // Section 3: Body content
  sections.push(`<div>${bodyContent}</div>`);

  // Section 4: Related reading
  sections.push(
    `<div><p>// Related reading</p><ul>` +
    `<li><p><em>Field Experiment · LLM</em></p><p><a href="/en/testing-geo-seo-with-adobe-llm-optimizer">Testing GEO/SEO with Adobe LLM Optimizer</a></p><p>Read the experiment →</p></li>` +
    `<li><p><em>Field Notes · DevOps</em></p><p><a href="/en/tailing-and-viewing-adobe-cloud-manager-build-logs">Tailing and viewing Adobe Cloud Manager build logs</a></p><p>Read the runbook →</p></li>` +
    `</ul><div class="section-metadata"><div><div><p>Style</p></div><div><p>related</p></div></div></div></div>`
  );

  // Section 5: CTA band (fragment reference)
  sections.push(
    `<div><p><a href="/en/fragments/cta-band">CTA Band</a></p></div>`
  );

  // Section 6: Metadata block
  let metaRows = '';
  metaRows += metaRow('title', title);
  metaRows += metaRow('description', description);
  if (image) metaRows += metaRow('image', image);
  metaRows += metaRow('template', template);
  metaRows += metaRow('author', author);
  metaRows += metaRow('date', date);
  metaRows += metaRow('category', cleanCategory(category));
  if (tags) metaRows += metaRow('tags', tags);

  sections.push(`<div><div class="metadata">${metaRows}</div></div>`);

  return `<body>\n  <header></header>\n  <main>${sections.join('')}</main>\n  <footer></footer>\n</body>`;
}

function metaRow(key, value) {
  return `<div><div><p>${escapeHtml(key)}</p></div><div><p>${escapeHtml(value)}</p></div></div>`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Process a single file ---

function processFile(inputPath) {
  const raw = fs.readFileSync(inputPath, 'utf-8');
  const dom = new JSDOM(raw);
  const doc = dom.window.document;

  // Extract metadata
  let metadata = extractMetadataFromTable(doc);
  if (!metadata.title) {
    metadata = { ...metadata, ...extractMetadataFromDivs(doc) };
  }

  // Strip comments
  stripComments(doc);

  // Get body content
  let bodyHtml = extractBodyContent(doc);

  // Clean up empty paragraphs
  bodyHtml = bodyHtml
    .replace(/<p>\s*\.?\s*<\/p>/g, '')
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return generateDaSource(bodyHtml, metadata);
}

// --- CLI ---

function slugFromFilename(filename) {
  return path.basename(filename, '.plain.html');
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node tools/convert-to-new-blocks.mjs <file.plain.html>');
    console.error('       node tools/convert-to-new-blocks.mjs --batch <files...>');
    process.exit(1);
  }

  const isBatch = args[0] === '--batch';
  const files = isBatch ? args.slice(1) : [args[0]];

  const results = [];

  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`File not found: ${file}`);
      continue;
    }

    try {
      const converted = processFile(file);
      const slug = slugFromFilename(file);
      const outputDir = path.join('en', slug);

      fs.mkdirSync(outputDir, { recursive: true });

      const outputPath = path.join(outputDir, 'index.plain.html');
      fs.writeFileSync(outputPath, converted, 'utf-8');

      console.log(`✓ ${slug}`);
      results.push({ slug, success: true });
    } catch (err) {
      console.error(`✗ ${file}: ${err.message}`);
      results.push({ slug: slugFromFilename(file), success: false, error: err.message });
    }
  }

  console.log(`\nDone: ${results.filter(r => r.success).length}/${results.length} converted`);
}

main();
