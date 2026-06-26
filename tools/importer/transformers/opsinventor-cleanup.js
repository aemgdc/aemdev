/* eslint-disable */
/* global WebImporter */

/**
 * Transformer for OpsInventor website cleanup
 * Purpose: Remove non-content elements (sidebar, footer, social, comments, nav, TOC)
 * Applies to: www.opsinventor.com (all templates)
 * Tested: /replacing-an-ssl-certificate-on-aem-6-5/
 * Generated: 2026-02-14
 *
 * SELECTORS EXTRACTED FROM:
 * - Captured DOM during migration workflow (cleaned.html)
 */

const TransformHook = {
  beforeTransform: 'beforeTransform',
  afterTransform: 'afterTransform',
};

export default function transform(hookName, element, payload) {
  if (hookName === TransformHook.beforeTransform) {
    // Remove site header and navigation (handled by EDS header fragment)
    // EXTRACTED: Found <div class="site-header container-fluid"> in captured DOM
    // EXTRACTED: Found <div class="main-menu"> with <nav id="site-navigation"> in captured DOM
    WebImporter.DOMUtils.remove(element, [
      '.site-header',
      '.main-menu',
      '.skip-link',
    ]);

    // Remove sidebar and all widget areas
    // EXTRACTED: Found <aside id="sidebar" class="col-md-4"> in captured DOM
    WebImporter.DOMUtils.remove(element, [
      'aside#sidebar',
      'aside',
      '.widget-area',
      '.widget',
      '.col-md-4',
    ]);

    // Remove site footer
    WebImporter.DOMUtils.remove(element, [
      'footer',
      '.site-footer',
      '.footer-widgets',
      '.footer-bottom',
    ]);

    // Remove Table of Contents widget
    // EXTRACTED: Found <div id="ez-toc-container" class="ez-toc-v2_0_66_1..."> in captured DOM
    WebImporter.DOMUtils.remove(element, [
      '#ez-toc-container',
    ]);

    // Remove EZ-TOC section markers from headings
    // EXTRACTED: Found <span class="ez-toc-section"> and <span class="ez-toc-section-end"> in captured DOM
    const tocMarkers = element.querySelectorAll('.ez-toc-section, .ez-toc-section-end');
    for (const marker of tocMarkers) {
      marker.remove();
    }

    // Remove social sharing widgets
    // EXTRACTED: Found <div class="sharedaddy sd-sharing-enabled"> in captured DOM
    // EXTRACTED: Found <div class="sharedaddy sd-block sd-like jetpack-likes-widget-wrapper..."> in captured DOM
    WebImporter.DOMUtils.remove(element, [
      '.sharedaddy',
      '.jetpack-likes-widget-wrapper',
    ]);

    // Remove related posts
    // EXTRACTED: Found <div id="jp-relatedposts" class="jp-relatedposts"> in captured DOM
    WebImporter.DOMUtils.remove(element, [
      '#jp-relatedposts',
    ]);

    // Remove comment reply form but preserve actual comments for parser
    // EXTRACTED: Found <div id="respond" class="comment-respond"> in captured DOM
    WebImporter.DOMUtils.remove(element, [
      '#respond',
      '.comment-respond',
    ]);

    // Remove comment meta count in post header
    // EXTRACTED: Found <span class="comments-meta"> in captured DOM
    WebImporter.DOMUtils.remove(element, [
      '.comments-meta',
    ]);
  }

  if (hookName === TransformHook.afterTransform) {
    // Remove entry footer, prev/next links, author bio
    // EXTRACTED: Found <div class="entry-footer"> in captured DOM
    // EXTRACTED: Found <div class="prev-next-links"> in captured DOM
    // EXTRACTED: Found <div class="postauthor-container"> in captured DOM
    // EXTRACTED: Found <div class="single-footer row"> in captured DOM
    WebImporter.DOMUtils.remove(element, [
      '.entry-footer',
      '.prev-next-links',
      '.postauthor-container',
      '.single-footer',
    ]);

    // Remove remaining unwanted elements
    WebImporter.DOMUtils.remove(element, [
      'iframe',
      'link',
      'noscript',
      'input',
      'form',
    ]);

    // Remove tracking pixels and junk paragraphs
    const allImgs = element.querySelectorAll('img');
    allImgs.forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (src.includes('pixel.wp.com') || src.includes('g.gif')) {
        const parent = img.closest('p') || img.closest('figure') || img;
        parent.remove();
      }
    });

    // Remove WordPress/Jetpack junk text and empty elements
    const allPs = element.querySelectorAll('p');
    allPs.forEach((p) => {
      const text = p.textContent.trim();
      if (text === 'Loading Comments...' || text === '%d' || text === 'Like Loading...' || text === '') {
        p.remove();
        return;
      }
      // Remove paragraphs that only contain hash anchors
      const anchors = p.querySelectorAll('a');
      if (anchors.length > 0 && !text) {
        p.remove();
      }
    });
  }
}
