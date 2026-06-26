var CustomImportScript = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // tools/importer/import-blog-post.js
  var import_blog_post_exports = {};
  __export(import_blog_post_exports, {
    default: () => import_blog_post_default
  });

  // tools/importer/parsers/blog-post-hero.js
  function parse(element, { document }) {
    const featuredImg = element.querySelector(".news-thumb img");
    const imageUrl = featuredImg ? featuredImg.getAttribute("src") || "" : "";
    const titleEl = element.querySelector("h1.single-title") || element.querySelector("h1");
    const title = titleEl ? titleEl.textContent.trim() : "";
    const dateEl = element.querySelector(".posted-date");
    const dateText = dateEl ? dateEl.textContent.trim() : "";
    const authorEl = element.querySelector(".author-meta a");
    const author = authorEl ? authorEl.textContent.trim() : "";
    const catLinks = element.querySelectorAll(".cat-links a");
    const categories = [...catLinks].map((a) => a.textContent.trim()).filter(Boolean);
    const tagLinks = element.querySelectorAll('.tag-links a, .tags-links a, a[rel="tag"]');
    const tags = [...tagLinks].map((a) => a.textContent.trim()).filter(Boolean);
    const allTaxonomy = [.../* @__PURE__ */ new Set([...categories, ...tags])];
    const bodyContainer = element.querySelector(".single-entry-summary") || element.querySelector(".single-content") || element.querySelector(".entry-content");
    const firstP = bodyContainer ? bodyContainer.querySelector("p") : null;
    let description = "";
    if (firstP) {
      description = firstP.textContent.trim().substring(0, 200);
      if (firstP.textContent.trim().length > 200) description += "...";
    }
    const heroBlock = WebImporter.Blocks.createBlock(document, {
      name: "Blog Post Hero",
      cells: []
    });
    if (bodyContainer) {
      const junk = bodyContainer.querySelectorAll(
        ".sharedaddy, .jetpack-likes-widget-wrapper, #jp-relatedposts, .sd-sharing-enabled, .sd-block"
      );
      junk.forEach((el) => el.remove());
    }
    const container = document.createElement("div");
    container.append(heroBlock);
    const heroBreak = document.createElement("hr");
    container.append(heroBreak);
    if (bodyContainer) {
      while (bodyContainer.firstChild) {
        container.append(bodyContainer.firstChild);
      }
    }
    const article = element.closest("article") || element.parentElement;
    const commentsList = article ? article.querySelector(".commentlist, .comment-list") : null;
    const commentItems = commentsList ? commentsList.querySelectorAll(":scope > li.comment, :scope > li.trackback, :scope > li.pingback") : [];
    if (commentItems.length > 0) {
      const sectionBreak = document.createElement("hr");
      container.append(sectionBreak);
      const commentsHeading = document.createElement("h2");
      commentsHeading.textContent = "Comments";
      container.append(commentsHeading);
      commentItems.forEach((li) => {
        const commentBody = li.querySelector(".comment-body");
        if (!commentBody) return;
        const commentAuthorEl = commentBody.querySelector(".comment-author .fn a, .comment-author .fn, cite.fn a, cite.fn");
        const commentAuthor = commentAuthorEl ? commentAuthorEl.textContent.trim() : "Anonymous";
        const commentDateEl = commentBody.querySelector(".comment-meta a, .comment-metadata a, .commentmetadata a");
        const commentDate = commentDateEl ? commentDateEl.textContent.trim() : "";
        const commentTextEls = commentBody.querySelectorAll("p");
        const commentTexts = [...commentTextEls].filter((p) => !p.closest(".comment-author") && !p.closest(".comment-meta") && !p.closest(".commentmetadata") && !p.closest(".reply")).map((p) => p.textContent.trim()).filter(Boolean);
        if (commentTexts.length > 0) {
          const commentBlock = document.createElement("div");
          const authorLine = document.createElement("p");
          const strong = document.createElement("strong");
          strong.textContent = commentAuthor;
          authorLine.append(strong);
          if (commentDate) {
            const dateSpan = document.createElement("em");
            dateSpan.textContent = ` \u2014 ${commentDate}`;
            authorLine.append(dateSpan);
          }
          commentBlock.append(authorLine);
          commentTexts.forEach((text) => {
            const p = document.createElement("p");
            p.textContent = text;
            commentBlock.append(p);
          });
          container.append(commentBlock);
        }
      });
      const sectionMeta = WebImporter.Blocks.createBlock(document, {
        name: "Section Metadata",
        cells: [
          ["style", "light"]
        ]
      });
      container.append(sectionMeta);
    }
    const metaHr = document.createElement("hr");
    container.append(metaHr);
    const metaCells = [];
    if (title) metaCells.push(["title", title]);
    if (description) metaCells.push(["description", description]);
    if (author) metaCells.push(["author", author]);
    if (dateText) metaCells.push(["date", dateText]);
    if (imageUrl) metaCells.push(["image", imageUrl]);
    if (allTaxonomy.length > 0) metaCells.push(["tags", allTaxonomy.join(", ")]);
    if (categories.length > 0) metaCells.push(["categories", categories.join(", ")]);
    metaCells.push(["template", "blog"]);
    const metaBlock = WebImporter.Blocks.createBlock(document, {
      name: "Metadata",
      cells: metaCells
    });
    container.append(metaBlock);
    element.replaceWith(container);
  }

  // tools/importer/transformers/opsinventor-cleanup.js
  var TransformHook = {
    beforeTransform: "beforeTransform",
    afterTransform: "afterTransform"
  };
  function transform(hookName, element, payload) {
    if (hookName === TransformHook.beforeTransform) {
      WebImporter.DOMUtils.remove(element, [
        ".site-header",
        ".main-menu",
        ".skip-link"
      ]);
      WebImporter.DOMUtils.remove(element, [
        "aside#sidebar",
        "aside",
        ".widget-area",
        ".widget",
        ".col-md-4"
      ]);
      WebImporter.DOMUtils.remove(element, [
        "footer",
        ".site-footer",
        ".footer-widgets",
        ".footer-bottom"
      ]);
      WebImporter.DOMUtils.remove(element, [
        "#ez-toc-container"
      ]);
      const tocMarkers = element.querySelectorAll(".ez-toc-section, .ez-toc-section-end");
      for (const marker of tocMarkers) {
        marker.remove();
      }
      WebImporter.DOMUtils.remove(element, [
        ".sharedaddy",
        ".jetpack-likes-widget-wrapper"
      ]);
      WebImporter.DOMUtils.remove(element, [
        "#jp-relatedposts"
      ]);
      WebImporter.DOMUtils.remove(element, [
        "#respond",
        ".comment-respond"
      ]);
      WebImporter.DOMUtils.remove(element, [
        ".comments-meta"
      ]);
    }
    if (hookName === TransformHook.afterTransform) {
      WebImporter.DOMUtils.remove(element, [
        ".entry-footer",
        ".prev-next-links",
        ".postauthor-container",
        ".single-footer"
      ]);
      WebImporter.DOMUtils.remove(element, [
        "iframe",
        "link",
        "noscript",
        "input",
        "form"
      ]);
      const allImgs = element.querySelectorAll("img");
      allImgs.forEach((img) => {
        const src = img.getAttribute("src") || "";
        if (src.includes("pixel.wp.com") || src.includes("g.gif")) {
          const parent = img.closest("p") || img.closest("figure") || img;
          parent.remove();
        }
      });
      const allPs = element.querySelectorAll("p");
      allPs.forEach((p) => {
        const text = p.textContent.trim();
        if (text === "Loading Comments..." || text === "%d" || text === "Like Loading..." || text === "") {
          p.remove();
          return;
        }
        const anchors = p.querySelectorAll("a");
        if (anchors.length > 0 && !text) {
          p.remove();
        }
      });
    }
  }

  // tools/importer/import-blog-post.js
  var parsers = {
    "blog-post-hero": parse
  };
  var transformers = [
    transform
  ];
  var PAGE_TEMPLATE = {
    name: "blog-post",
    description: "WordPress blog post template from OpsInventor. Features a hero area with featured image, title, date, and author, followed by article body content with headings, paragraphs, code blocks, ordered lists, and images.",
    blocks: [
      {
        name: "blog-post-hero",
        instances: ['article.col-md-8 > div[class*="post-"]']
      }
    ]
  };
  function executeTransformers(hookName, element, payload) {
    transformers.forEach((transformerFn) => {
      try {
        transformerFn.call(null, hookName, element, payload);
      } catch (e) {
        console.error(`Transformer failed at ${hookName}:`, e);
      }
    });
  }
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
            element
          });
        });
      });
    });
    console.log(`Found ${pageBlocks.length} block instances on page`);
    return pageBlocks;
  }
  var import_blog_post_default = {
    transform: (payload) => {
      const { document, url, html, params } = payload;
      const main = document.body;
      executeTransformers("beforeTransform", main, payload);
      const pageBlocks = findBlocksOnPage(document, PAGE_TEMPLATE);
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
      executeTransformers("afterTransform", main, payload);
      WebImporter.rules.transformBackgroundImages(main, document);
      WebImporter.rules.adjustImageUrls(main, url, params.originalURL);
      const metadataBlocks = document.querySelectorAll(".metadata");
      metadataBlocks.forEach((metaBlock) => {
        let sibling = metaBlock.nextSibling;
        while (sibling) {
          const next = sibling.nextSibling;
          sibling.remove();
          sibling = next;
        }
      });
      document.querySelectorAll("p").forEach((p) => {
        const text = p.textContent.trim();
        if (text === "Loading Comments..." || text === "%d" || text === "Like Loading..." || text === "") {
          p.remove();
        }
      });
      document.querySelectorAll("p").forEach((p) => {
        if (!p.textContent.trim()) {
          const anchors = p.querySelectorAll("a");
          if (anchors.length > 0) p.remove();
        }
      });
      document.querySelectorAll("img").forEach((img) => {
        const src = img.getAttribute("src") || "";
        if (src.includes("pixel.wp.com") || src.includes("g.gif")) {
          (img.closest("p") || img).remove();
        }
      });
      const originalPath = new URL(params.originalURL).pathname.replace(/\/$/, "").replace(/\.html$/, "");
      const slug = originalPath.split("/").filter(Boolean).pop();
      const path = `/en/${WebImporter.FileUtils.sanitizePath(slug)}`;
      return [{
        element: main,
        path,
        report: {
          title: document.title,
          template: PAGE_TEMPLATE.name,
          blocks: pageBlocks.map((b) => b.name)
        }
      }];
    }
  };
  return __toCommonJS(import_blog_post_exports);
})();
