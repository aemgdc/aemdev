/**
 * Update block — dated update note (teal accent by default).
 * Variant via class: `update success` swaps to green.
 *
 *   | Update | success (optional)  |
 *   | ------ |
 *   | // 21 Nov 2025 · Update      |
 *   | Heading text                 |
 *   | Body paragraph(s)            |
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
    tag.className = 'update-tag';
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
