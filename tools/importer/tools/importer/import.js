/* eslint-disable no-console */
import { createRequire } from 'module';
import { promises as fs } from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const cheerio = require('cheerio');
const fetch = require('node-fetch');

const BASE_URL = 'https://www.opsinventor.com';
const OUTPUT_DIR = './output';

async function fetchPage(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.text();
  } catch (error) {
    console.error(`Error fetching ${url}:`, error);
    return null;
  }
}

function extractMetadata($, doc) {
  const metadata = {};

  // Extract title
  metadata.title = $('h1').first().text().trim() || $('title').text().trim();

  // Extract publish date
  const dateEl = $('time').first();
  if (dateEl.length) {
    metadata.date = dateEl.attr('datetime') || dateEl.text();
  }

  // Extract description/excerpt
  metadata.description = $('meta[name="description"]').attr('content') || '';

  // Extract og:image
  metadata.image = $('meta[property="og:image"]').attr('content') || '';

  // Extract categories
  const categories = [];
  $('a[rel="category"]').each((_, el) => {
    categories.push($(el).text().trim());
  });
  metadata.categories = categories;

  // Extract tags
  const tags = [];
  $('.tags-links a').each((_, el) => {
    tags.push($(el).text().trim());
  });
  metadata.tags = tags.join(', ');
}

function processImages($, docPath) {
  $('img').each((_, img) => {
    const $img = $(img);
    const src = $img.attr('src');
    if (!src) return;

    // Convert relative URLs to absolute
    if (src.startsWith('/')) {
      $img.attr('src', `${BASE_URL}${src}`);
    } else if (!src.startsWith('http')) {
      $img.attr('src', `${BASE_URL}/${src}`);
    }

    // Add required attributes for AEM
    if (!$img.attr('alt')) {
      $img.attr('alt', ''); // AEM requires alt attributes
    }
  });
}

function cleanupContent($) {
  // Remove unwanted elements
  $('script, style, iframe, .wp-block-embed, .sharedaddy, .jp-relatedposts').remove();

  // Remove screen reader text
  $('a:contains("Skip to the content")').remove();
  $('[class*="screen-reader"]').remove();  // Also remove any elements with screen-reader in their class

  // Convert WordPress blocks to simple HTML
  $('.wp-block-quote').each((_, quote) => {
    $(quote).replaceWith(`<blockquote>${$(quote).html()}</blockquote>`);
  });

  // Clean up formatting
  $('br + br').remove(); // Remove double line breaks
  $('p:empty').remove(); // Remove empty paragraphs
}

function createDocumentStructure(metadata, content) {
  return {
    $schema: 'https://aem.live/content/v1',
    title: metadata.title,
    datePublished: metadata.date,
    description: metadata.description,
    image: metadata.image,
    topics: metadata.categories,
    tags: metadata.tags,
    content: {
      document: {
        type: 'doc',
        content: [{
          type: 'section',
          content: content
        }]
      }
    }
  };
}

async function saveDocument(doc, outputPath) {
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(doc, null, 2));
    console.log(`Saved document to ${outputPath}`);
  } catch (error) {
    console.error(`Error saving document to ${outputPath}:`, error);
  }
}

async function importPage(url) {
  console.log(`Importing ${url}...`);
  
  const html = await fetchPage(url);
  if (!html) return;

  const $ = cheerio.load(html);
  const metadata = extractMetadata($, html);

  // Process main content area
  const $content = $('.content, article').first();
  
  processImages($, url);
  cleanupContent($);

  const mainContent = $content.html() || $('body').html();
  
  // Create the document structure
  const doc = createDocumentStructure(metadata, mainContent);

  // Generate safe filename from title
  const filename = metadata.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);

  const outputPath = path.join(OUTPUT_DIR, `${filename}.json`);
  await saveDocument(doc, outputPath);
}

async function main() {
  try {
    // Create output directory if it doesn't exist
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Start with the main URL
    await importPage(BASE_URL);

    console.log('Import completed successfully!');
  } catch (error) {
    console.error('Import failed:', error);
    process.exit(1);
  }
}

main();