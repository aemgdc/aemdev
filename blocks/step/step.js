/**
 * Step block — numbered step header inline with an H2.
 *
 *   | Step | 01            |
 *   | ---- | ------------- |
 *   | Install aio-cli     |
 *
 * The number appears huge in orange to the left of the heading.
 */
export default function decorate(block) {
  // Number lives in a class set by DA (e.g. step-01 -> "01") or in first cell
  const cells = [...block.querySelectorAll(':scope > div > div')];

  let num = '';
  // class-based number: any class that's just digits
  const numClass = [...block.classList].find((c) => /^\d{1,3}$/.test(c));
  if (numClass) num = numClass;

  let headingText;
  if (cells.length >= 2 && /^\d{1,3}$/.test(cells[0].textContent.trim())) {
    num = num || cells[0].textContent.trim();
    headingText = cells[1].textContent.trim();
  } else if (cells.length) {
    headingText = cells[cells.length - 1].textContent.trim();
  }

  block.innerHTML = '';

  if (num) {
    const n = document.createElement('div');
    n.className = 'step-num';
    n.textContent = num.padStart(2, '0');
    block.append(n);
  }

  if (headingText) {
    const h = document.createElement('h2');
    h.textContent = headingText;
    block.append(h);
  }
}
