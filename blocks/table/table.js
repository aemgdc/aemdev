/*
 * Authored content reaches this block as div-per-row/div-per-cell (the standard EDS
 * block-table format), never a literal <table>. Measured against DA 2026-08-20: a
 * <table> nested inside `<div class="table">` does NOT survive — the pipeline reads
 * its first row as a BLOCK NAME, so `<div class="table"><table><tr><td>H1</td>…`
 * is delivered as `<div class="h1">` and the wrapper's own class is gone. The div-row
 * form is therefore the only authoring path, and without this the block found no
 * <table> to work on and every authored table rendered unstyled.
 */
function buildTableFromRows(el) {
  const rowDivs = [...el.children];
  if (!rowDivs.length || rowDivs[0].tagName !== 'DIV') return null;
  const table = document.createElement('table');
  rowDivs.forEach((rowDiv) => {
    const tr = document.createElement('tr');
    [...rowDiv.children].forEach((cellDiv) => {
      const td = document.createElement('td');
      td.innerHTML = cellDiv.innerHTML;
      tr.append(td);
    });
    rowDiv.remove();
    table.append(tr);
  });
  el.append(table);
  return table;
}

export default function init(el) {
  if (!el.querySelector('table')) buildTableFromRows(el);
  const tables = el.querySelectorAll('table');
  for (const table of tables) {
    let thead = table.querySelector('table > thead');
    const rows = [...table.querySelectorAll('tr')];

    if (!thead) {
      thead = document.createElement('thead');
      table.prepend(thead);

      const headingRow = rows.shift();
      if (headingRow) {
        thead.append(headingRow);
        const tds = headingRow.querySelectorAll(':scope > td');
        for (const td of tds) {
          const th = document.createElement('th');
          th.className = td.className;
          th.innerHTML = td.innerHTML;
          td.parentElement.replaceChild(th, td);
        }
      }
    }

    for (const row of rows) {
      row.classList.add('table-content-row');
    }
  }
}
