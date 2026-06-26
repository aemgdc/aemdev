#!/usr/bin/env node
/**
 * Converts .plain.html (EDS delivery format) to DA authoring format.
 * Block divs become HTML tables. Sections become proper structure.
 *
 * Usage: node plain-to-da.js <input.plain.html> [output.html]
 */
const fs = require('fs');

const inputFile = process.argv[2];
const outputFile = process.argv[3];

if (!inputFile) {
  console.error('Usage: node plain-to-da.js <input.plain.html> [output.html]');
  process.exit(1);
}

let html = fs.readFileSync(inputFile, 'utf8');

/**
 * Find the matching closing </div> for a <div> tag that starts at `startIndex`.
 * Returns the index right after the closing </div>.
 */
function findMatchingCloseDiv(str, startIndex) {
  let depth = 0;
  let i = startIndex;
  while (i < str.length) {
    if (str.startsWith('<div', i)) {
      depth++;
      i = str.indexOf('>', i) + 1;
    } else if (str.startsWith('</div>', i)) {
      depth--;
      if (depth === 0) return i + 6; // past </div>
      i += 6;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Convert a block's inner HTML (key/value div rows) to an HTML table.
 */
function blockToTable(className, innerHtml) {
  const blockName = className
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const rowRegex = /<div><div>([\s\S]*?)<\/div><div>([\s\S]*?)<\/div><\/div>/g;
  const rows = [];
  let m;
  while ((m = rowRegex.exec(innerHtml)) !== null) {
    rows.push([m[1], m[2]]);
  }

  let table = `<table>\n  <tr><th colspan="2">${blockName}</th></tr>\n`;
  rows.forEach(([key, value]) => {
    table += `  <tr><td>${key}</td><td>${value}</td></tr>\n`;
  });
  table += '</table>';
  return table;
}

// Process blocks: find <div class="blockname"> and replace with table
const blockNames = ['metadata', 'section-metadata', 'blog-post-hero'];

blockNames.forEach((name) => {
  const searchStr = `<div class="${name}">`;
  let idx;
  while ((idx = html.indexOf(searchStr)) !== -1) {
    const endIdx = findMatchingCloseDiv(html, idx);
    if (endIdx === -1) break;

    const fullBlock = html.substring(idx, endIdx);
    const innerHtml = html.substring(idx + searchStr.length, endIdx - 6); // strip outer div tags

    const table = blockToTable(name, innerHtml);
    html = html.substring(0, idx) + table + html.substring(endIdx);
  }
});

// Wrap in DA document structure
const daHtml = `<body>
  <header></header>
  <main>${html}</main>
  <footer></footer>
</body>`;

if (outputFile) {
  fs.writeFileSync(outputFile, daHtml);
  console.log(`Converted: ${inputFile} -> ${outputFile}`);
} else {
  process.stdout.write(daHtml);
}
