/* eslint-disable */
/* global WebImporter */

/**
 * Parser for blog-post-hero block
 *
 * Handles three concerns:
 * 1. Creates the blog-post-hero block (metadata-driven, reads from page meta tags)
 * 2. Extracts and formats comments as a styled section (if any exist)
 * 3. Creates a comprehensive Metadata block with title, description, author,
 *    date, image, tags, categories, and template
 *
 * Source HTML Pattern:
 * <div class="post-XXXX post type-post...">
 *   <div class="news-thumb"><img src="..."></div>
 *   <h1 class="single-title">Title</h1>
 *   <span class="posted-date">April 12, 2023</span>
 *   <span class="author-meta"><a>Author</a></span>
 *   <div class="single-content"><div class="single-entry-summary">...</div></div>
 *   <div class="entry-footer"><div class="cat-links"><a>Category</a></div></div>
 * </div>
 */
export default function parse(element, { document }) {
  // --- Extract hero metadata ---
  const featuredImg = element.querySelector('.news-thumb img');
  const imageUrl = featuredImg ? (featuredImg.getAttribute('src') || '') : '';

  const titleEl = element.querySelector('h1.single-title') || element.querySelector('h1');
  const title = titleEl ? titleEl.textContent.trim() : '';

  const dateEl = element.querySelector('.posted-date');
  const dateText = dateEl ? dateEl.textContent.trim() : '';

  const authorEl = element.querySelector('.author-meta a');
  const author = authorEl ? authorEl.textContent.trim() : '';

  // --- Extract ALL categories and tags ---
  const catLinks = element.querySelectorAll('.cat-links a');
  const categories = [...catLinks].map((a) => a.textContent.trim()).filter(Boolean);

  const tagLinks = element.querySelectorAll('.tag-links a, .tags-links a, a[rel="tag"]');
  const tags = [...tagLinks].map((a) => a.textContent.trim()).filter(Boolean);

  // Combine categories + tags for the tags metadata field
  const allTaxonomy = [...new Set([...categories, ...tags])];

  // --- Extract description from first paragraph ---
  const bodyContainer = element.querySelector('.single-entry-summary')
    || element.querySelector('.single-content')
    || element.querySelector('.entry-content');
  const firstP = bodyContainer ? bodyContainer.querySelector('p') : null;
  let description = '';
  if (firstP) {
    description = firstP.textContent.trim().substring(0, 200);
    if (firstP.textContent.trim().length > 200) description += '...';
  }

  // --- Fix 3: Create the blog-post-hero block (empty, metadata-driven) ---
  const heroBlock = WebImporter.Blocks.createBlock(document, {
    name: 'Blog Post Hero',
    cells: [],
  });

  // --- Clean body content ---
  if (bodyContainer) {
    const junk = bodyContainer.querySelectorAll(
      '.sharedaddy, .jetpack-likes-widget-wrapper, #jp-relatedposts, .sd-sharing-enabled, .sd-block'
    );
    junk.forEach((el) => el.remove());
  }

  // --- Build page structure: hero block → section break → body content ---
  const container = document.createElement('div');
  container.append(heroBlock);

  // Section break so hero and body are separate EDS sections
  const heroBreak = document.createElement('hr');
  container.append(heroBreak);

  if (bodyContainer) {
    while (bodyContainer.firstChild) {
      container.append(bodyContainer.firstChild);
    }
  }

  // --- Fix 1: Extract and format comments section ---
  const article = element.closest('article') || element.parentElement;
  const commentsList = article ? article.querySelector('.commentlist, .comment-list') : null;
  const commentItems = commentsList ? commentsList.querySelectorAll(':scope > li.comment, :scope > li.trackback, :scope > li.pingback') : [];

  if (commentItems.length > 0) {
    // Section break before comments
    const sectionBreak = document.createElement('hr');
    container.append(sectionBreak);

    // Comments heading
    const commentsHeading = document.createElement('h2');
    commentsHeading.textContent = 'Comments';
    container.append(commentsHeading);

    // Format each comment
    commentItems.forEach((li) => {
      const commentBody = li.querySelector('.comment-body');
      if (!commentBody) return;

      const commentAuthorEl = commentBody.querySelector('.comment-author .fn a, .comment-author .fn, cite.fn a, cite.fn');
      const commentAuthor = commentAuthorEl ? commentAuthorEl.textContent.trim() : 'Anonymous';

      const commentDateEl = commentBody.querySelector('.comment-meta a, .comment-metadata a, .commentmetadata a');
      const commentDate = commentDateEl ? commentDateEl.textContent.trim() : '';

      const commentTextEls = commentBody.querySelectorAll('p');
      // Filter out paragraphs that are just inside nested elements
      const commentTexts = [...commentTextEls]
        .filter((p) => !p.closest('.comment-author') && !p.closest('.comment-meta') && !p.closest('.commentmetadata') && !p.closest('.reply'))
        .map((p) => p.textContent.trim())
        .filter(Boolean);

      if (commentTexts.length > 0) {
        const commentBlock = document.createElement('div');

        const authorLine = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = commentAuthor;
        authorLine.append(strong);
        if (commentDate) {
          const dateSpan = document.createElement('em');
          dateSpan.textContent = ` — ${commentDate}`;
          authorLine.append(dateSpan);
        }
        commentBlock.append(authorLine);

        commentTexts.forEach((text) => {
          const p = document.createElement('p');
          p.textContent = text;
          commentBlock.append(p);
        });

        container.append(commentBlock);
      }
    });

    // Section-metadata for comments styling
    const sectionMeta = WebImporter.Blocks.createBlock(document, {
      name: 'Section Metadata',
      cells: [
        ['style', 'light'],
      ],
    });
    container.append(sectionMeta);
  }

  // --- Section break before metadata ---
  const metaHr = document.createElement('hr');
  container.append(metaHr);

  // --- Fix 2: Comprehensive Metadata block ---
  const metaCells = [];
  if (title) metaCells.push(['title', title]);
  if (description) metaCells.push(['description', description]);
  if (author) metaCells.push(['author', author]);
  if (dateText) metaCells.push(['date', dateText]);
  if (imageUrl) metaCells.push(['image', imageUrl]);
  if (allTaxonomy.length > 0) metaCells.push(['tags', allTaxonomy.join(', ')]);
  if (categories.length > 0) metaCells.push(['categories', categories.join(', ')]);
  metaCells.push(['template', 'blog']);

  const metaBlock = WebImporter.Blocks.createBlock(document, {
    name: 'Metadata',
    cells: metaCells,
  });
  container.append(metaBlock);

  // Replace the entire post element with the clean structure
  element.replaceWith(container);
}
