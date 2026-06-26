/**
 * Code block — terminal-style code with a labelled bar.
 *
 *   | Code | bash · install (label) | shell (kind) |
 *   | ---- |
 *   | ```...code...``` (DA renders as <pre>) |
 *
 * The block is authored with a <pre> child (preserve whitespace). The first
 * non-pre cell becomes the label; an optional second non-pre cell becomes
 * the "kind" badge (teal). If no <pre> is found, the entire block textContent
 * is wrapped in one.
 */
export default function decorate(block) {
  let pre = block.querySelector('pre');
  const cells = [...block.querySelectorAll(':scope > div > div')];

  // Label cell = first non-empty cell that doesn't contain a <pre>
  const labelCells = cells.filter((c) => !c.querySelector('pre'));
  const labelText = labelCells[0] ? labelCells[0].textContent.trim() : '';
  const kindText = labelCells[1] ? labelCells[1].textContent.trim() : '';

  // If no <pre> in DOM, treat the last cell's textContent as the code body
  if (!pre) {
    const codeCell = cells.find((c) => /\n/.test(c.textContent) || c.children.length === 0);
    pre = document.createElement('pre');
    pre.textContent = (codeCell || cells[cells.length - 1] || block).textContent;
  }

  block.innerHTML = '';

  if (labelText || kindText) {
    const bar = document.createElement('div');
    bar.className = 'code-bar';
    if (labelText) {
      const left = document.createElement('span');
      left.innerHTML = labelText.replace(/^([^\s·]+)/, '<strong>$1</strong>');
      bar.append(left);
    }
    if (kindText) {
      const kind = document.createElement('span');
      kind.className = 'code-kind';
      kind.textContent = kindText;
      bar.append(kind);
    }
    block.append(bar);
  }

  block.append(pre);

  // Add a "single line" modifier when content is short
  const lineCount = (pre.textContent.match(/\n/g) || []).length;
  if (lineCount <= 1) block.classList.add('code-single');
}
