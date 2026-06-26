/**
 * Pullquote block — heavy display quote with citation.
 *
 *   | Pullquote |
 *   | --------- |
 *   | The quote text.            |
 *   | — Citation / Attribution   |
 */
export default function decorate(block) {
  const rows = [...block.children];
  const cells = rows.flatMap((r) => [...r.children]);
  const quote = cells[0];
  const cite = cells[1];

  block.innerHTML = '';
  const p = document.createElement('p');
  while (quote.firstChild) p.append(quote.firstChild);
  block.append(p);

  if (cite && cite.textContent.trim()) {
    const c = document.createElement('cite');
    c.textContent = cite.textContent.trim().replace(/^[—-]\s*/, '');
    block.append(c);
  }
}
