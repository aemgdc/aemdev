/**
 * MTB card — cover-photo motif card. Image left, copy right (stacks on mobile).
 *
 *   | MTB Card |
 *   | -------- |
 *   | [image]                         |
 *   | // Eyebrow · Location           |
 *   | Heading text                    |
 *   | Body paragraph(s)               |
 */
export default function decorate(block) {
  const cells = [...block.querySelectorAll(':scope > div > div')];
  if (!cells.length) return;

  const imageCell = cells.find((c) => c.querySelector('picture, img'));
  const textCells = cells.filter((c) => c !== imageCell);
  const eyebrowText = textCells[0] ? textCells[0].textContent.trim() : '';
  const headingCell = textCells[1];
  const bodyCells = textCells.slice(2);

  block.innerHTML = '';

  if (imageCell) {
    const photo = document.createElement('div');
    photo.className = 'mtb-photo';
    const img = imageCell.querySelector('img');
    if (img) {
      photo.style.backgroundImage = `url("${img.src}")`;
      photo.setAttribute('role', 'img');
      if (img.alt) photo.setAttribute('aria-label', img.alt);
    }
    block.append(photo);
  }

  const copy = document.createElement('div');
  copy.className = 'mtb-copy';

  if (eyebrowText) {
    const eb = document.createElement('div');
    eb.className = 'eyebrow mtb-eyebrow';
    eb.textContent = eyebrowText.startsWith('//') ? eyebrowText : `// ${eyebrowText}`;
    copy.append(eb);
  }

  if (headingCell && headingCell.textContent.trim()) {
    const h = document.createElement('h4');
    while (headingCell.firstChild) h.append(headingCell.firstChild);
    copy.append(h);
  }

  bodyCells.forEach((c) => {
    while (c.firstChild) copy.append(c.firstChild);
  });

  block.append(copy);
}
