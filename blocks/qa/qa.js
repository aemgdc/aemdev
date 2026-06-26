/**
 * QA block — interview question/answer pairs.
 *
 * Author pattern (DA): one row per Q or A; the first column carries the
 * speaker label ending in a colon, the second the prose.
 *
 *   | Q: AC | What's the biggest infra failure mode you see? |
 *   | A: TJ | Teams treating publishers as cattle when they're pets. |
 */
export default function decorate(block) {
  const rows = [...block.children];
  block.innerHTML = '';
  rows.forEach((row) => {
    const cells = [...row.children];
    if (cells.length < 2) return;
    const labelText = cells[0].textContent.trim().replace(/:$/, '');
    const isQ = /^q\b/i.test(labelText);
    const pair = document.createElement('div');
    pair.className = `qa-block ${isQ ? 'qa-q' : 'qa-a'}`;

    const speaker = document.createElement('div');
    speaker.className = 'qa-speaker';
    speaker.textContent = labelText;

    const text = document.createElement('div');
    text.className = 'qa-text';
    while (cells[1].firstChild) text.append(cells[1].firstChild);

    pair.append(speaker, text);
    block.append(pair);
  });
}
