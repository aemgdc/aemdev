/**
 * Callout block — ink-bg attention box with orange "!" pill.
 *
 *   | Callout | (optional variant class) |
 *   | ------- |
 *   | // Important · Tag-line label    |
 *   | Heading text                     |
 *   | Body paragraph(s) and/or list    |
 *
 * The first row becomes the tag (starts with // or just label text),
 * the second the heading, the rest the body content.
 */
export default function decorate(block) {
  const cells = [...block.querySelectorAll(':scope > div > div')];
  if (!cells.length) return;

  const tagText = cells[0] ? cells[0].textContent.trim() : '';
  const headingCell = cells[1];
  const bodyCells = cells.slice(2);

  block.innerHTML = '';

  if (tagText) {
    const tag = document.createElement('div');
    tag.className = 'callout-tag';
    tag.textContent = tagText.startsWith('//') ? tagText : `// ${tagText}`;
    block.append(tag);
  }

  if (headingCell && headingCell.textContent.trim()) {
    const h = document.createElement('h3');
    while (headingCell.firstChild) h.append(headingCell.firstChild);
    block.append(h);
  }

  bodyCells.forEach((c) => {
    while (c.firstChild) block.append(c.firstChild);
  });
}
