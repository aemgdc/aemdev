/**
 * Figure block — image with mono caption + FIG number.
 *
 *   | Figure | 03 (optional figure number) |
 *   | ------ |
 *   | [image]               |
 *   | Caption text.         |
 *
 * Variant: add "wide" as a class via second column on first row, or via
 * section-metadata.
 */
export default function decorate(block) {
  // Optional figure number from a class added by DA (e.g. .figure-03)
  let num = '';
  const numClass = [...block.classList].find((c) => /^\d+$/.test(c));
  if (numClass) num = numClass;

  const pic = block.querySelector('picture, img');
  const cells = [...block.querySelectorAll(':scope > div > div')];
  // Last cell that is NOT the image cell is the caption
  const captionCell = cells.reverse().find((c) => !c.querySelector('picture, img'));
  const captionText = captionCell ? captionCell.textContent.trim() : '';

  block.innerHTML = '';

  if (pic) {
    const wrap = document.createElement('div');
    wrap.append(pic.closest('picture') || pic);
    block.append(wrap);
  }

  if (captionText) {
    const cap = document.createElement('figcaption');
    if (num) {
      const n = document.createElement('span');
      n.className = 'num';
      n.textContent = num;
      cap.append(n, ' ', document.createTextNode(captionText));
    } else {
      cap.textContent = captionText;
    }
    block.append(cap);
  }
}
