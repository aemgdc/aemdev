/* eslint-disable */
/* global WebImporter */

// PARSER IMPORTS
import blogPostHeroParser from './parsers/blog-post-hero.js';

// TRANSFORMER IMPORTS
import opsinventorCleanupTransformer from './transformers/opsinventor-cleanup.js';

// PARSER REGISTRY
const parsers = {
  'blog-post-hero': blogPostHeroParser,
};

// TRANSFORMER REGISTRY
const transformers = [
  opsinventorCleanupTransformer,
];

// PAGE TEMPLATE CONFIGURATION
const PAGE_TEMPLATE = {
  name: 'blog-post',
  description: 'WordPress blog post template from OpsInventor. Features a hero area with featured image, title, date, and author, followed by article body content with headings, paragraphs, code blocks, ordered lists, and images.',
  blocks: [
    {
      name: 'blog-post-hero',
      instances: ['article.col-md-8 > div[class*="post-"]'],
    },
  ],
};

/**
 * Execute all page transformers for a specific hook
 */
function executeTransformers(hookName, element, payload) {
  transformers.forEach((transformerFn) => {
    try {
      transformerFn.call(null, hookName, element, payload);
    } catch (e) {
      console.error(`Transformer failed at ${hookName}:`, e);
    }
  });
}

/**
 * Find all blocks on the page based on embedded template configuration
 */
function findBlocksOnPage(document, template) {
  const pageBlocks = [];

  template.blocks.forEach((blockDef) => {
    blockDef.instances.forEach((selector) => {
      const elements = document.querySelectorAll(selector);
      if (elements.length === 0) {
        console.warn(`Block "${blockDef.name}" selector not found: ${selector}`);
      }
      elements.forEach((element) => {
        pageBlocks.push({
          name: blockDef.name,
          selector,
          element,
        });
      });
    });
  });

  console.log(`Found ${pageBlocks.length} block instances on page`);
  return pageBlocks;
}

// EXPORT DEFAULT CONFIGURATION
export default {
  transform: (payload) => {
    const { document, url, html, params } = payload;

    const main = document.body;

    // 1. Execute beforeTransform transformers (strip sidebar, footer, social, nav, etc.)
    executeTransformers('beforeTransform', main, payload);

    // 2. Find blocks on page using embedded template
    const pageBlocks = findBlocksOnPage(document, PAGE_TEMPLATE);

    // 3. Parse each block using registered parsers
    pageBlocks.forEach((block) => {
      const parser = parsers[block.name];
      if (parser) {
        try {
          parser(block.element, { document, url, params });
        } catch (e) {
          console.error(`Failed to parse ${block.name} (${block.selector}):`, e);
        }
      } else {
        console.warn(`No parser found for block: ${block.name}`);
      }
    });

    // 4. Execute afterTransform transformers (final cleanup)
    executeTransformers('afterTransform', main, payload);

    // 5. Apply WebImporter built-in rules (skip createMetadata — parser handles it)
    WebImporter.rules.transformBackgroundImages(main, document);
    WebImporter.rules.adjustImageUrls(main, url, params.originalURL);

    // 6. Final cleanup — remove all content after the metadata block
    // The metadata block is the last meaningful element; anything after it is junk
    const metadataBlocks = document.querySelectorAll('.metadata');
    metadataBlocks.forEach((metaBlock) => {
      let sibling = metaBlock.nextSibling;
      while (sibling) {
        const next = sibling.nextSibling;
        sibling.remove();
        sibling = next;
      }
    });

    // Also clean junk paragraphs anywhere in the document
    document.querySelectorAll('p').forEach((p) => {
      const text = p.textContent.trim();
      if (text === 'Loading Comments...' || text === '%d' || text === 'Like Loading...' || text === '') {
        p.remove();
      }
    });
    // Remove paragraphs with only hash anchors
    document.querySelectorAll('p').forEach((p) => {
      if (!p.textContent.trim()) {
        const anchors = p.querySelectorAll('a');
        if (anchors.length > 0) p.remove();
      }
    });
    // Remove tracking pixels
    document.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (src.includes('pixel.wp.com') || src.includes('g.gif')) {
        (img.closest('p') || img).remove();
      }
    });

    // 6. Generate path under /en/ subtree
    const originalPath = new URL(params.originalURL).pathname
      .replace(/\/$/, '')
      .replace(/\.html$/, '');
    const slug = originalPath.split('/').filter(Boolean).pop();
    const path = `/en/${WebImporter.FileUtils.sanitizePath(slug)}`;

    return [{
      element: main,
      path,
      report: {
        title: document.title,
        template: PAGE_TEMPLATE.name,
        blocks: pageBlocks.map((b) => b.name),
      },
    }];
  },
};
