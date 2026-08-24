/*
 * table.js — the page list. One row per page in English mode, one row per
 * (page, locale) pair in a locale mode.
 *
 * Every column is either derived from the model or a raw stored cell, and the header
 * says which: a reader has to be able to tell what the pipeline recorded from what the
 * model concluded, because those are the two things that disagree when something is
 * wrong.
 *
 * The DOM helpers come from `scripts/tracker/block-utils.js` — the same `el` and
 * `statusChip` the boards use, so a status added to `stages.js` arrives here already
 * named and already styled. `el` sets TEXT, never HTML: every string on this table
 * comes from a sheet a human types into.
 */

import { dom } from '../../scripts/tracker/block-utils.js';
import { statusClass } from '../../scripts/tracker/stages.js';

/**
 * The two CRAWL columns, rendered as a pair.
 *
 * Shown as an explicit three-state chip rather than a tick or a blank, because a blank
 * cell reads as "no" and the honest answer at zero is "the crawl has not looked". They
 * are also the only two columns on this table nothing in this app can write — see the
 * allow-list in da-source.js — so they carry that in their tooltip rather than looking
 * inertly clickable.
 */
function crawlCell(el, page) {
  const td = el('td', 'pt-col-crawl');
  const pair = [
    ['PREV', page.previewed, 'the preview host'],
    ['LIVE', page.online, 'the live host'],
  ];
  for (const [name, on, where] of pair) {
    const chip = el('span', `pt-crawl pt-crawl-${on ? 'yes' : 'no'}`, name);
    chip.title = `${on ? 'Answers' : 'Does not answer'} on ${where}. Crawl output — `
      + 're-observed by every `tx:scan`, so nothing here can set it by hand.';
    td.append(chip);
  }
  return td;
}

function miniLink(el, href, label, hint) {
  if (!href) {
    const dead = el('span', 'pt-mini pt-mini-dead', label);
    dead.title = hint;
    return dead;
  }
  const a = el('a', 'pt-mini', label);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = hint;
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
}

function nameCell(el, page) {
  const td = el('td', 'pt-col-name');
  td.append(el('span', 'pt-title', page.title));
  if (page.contentEscalation) {
    const flag = el('span', 'pt-chip pt-chip-flag', '⚑ content');
    flag.title = 'A problem in the ENGLISH source, flagged during QA. It coexists with '
      + 'whatever stage this page is at, in every locale.';
    td.append(flag);
  }
  if (page.missingLocaleRow && page.locale) {
    const chip = el('span', 'pt-chip pt-chip-quiet', 'no locale row');
    chip.title = `This page has no row on the ${page.locale} tab at all, so it has never `
      + 'been sent to that locale. Not an error — it is the normal state before `tx:send`.';
    td.append(chip);
  }
  if (page.warnings.length) {
    const chip = el('span', 'pt-chip pt-chip-warn', `! ${page.warnings.length}`);
    chip.title = page.warnings.join('\n');
    td.append(chip);
  }
  td.append(el('div', 'pt-path', page.path));
  return td;
}

function stageCell(el, page) {
  const td = el('td', 'pt-col-stage');
  const chip = el('span', 'pt-stage', page.stageShort);
  chip.dataset.stage = page.blocked ? 'blocked' : statusClass(page.stage);
  chip.title = `${page.stageLabel} — ${page.stageHint}`;
  td.append(chip);
  td.append(el('span', 'pt-stage-label', page.stageLabel));
  for (const q of page.queues) {
    const qc = el('span', 'pt-chip pt-chip-queue', q);
    qc.title = `In the "${q}" work queue.`;
    td.append(qc);
  }
  return td;
}

function buildRow(page, handlers) {
  const { el, statusChip } = dom(handlers.mount);
  const tr = el('tr', 'pt-row');
  tr.dataset.path = page.path;
  tr.tabIndex = 0;
  if (page.blocked) tr.classList.add('pt-row-blocked');

  tr.append(nameCell(el, page));

  const sub = el('td', 'pt-col-sub');
  sub.append(el('span', 'pt-subgroup-name', page.subgroup));
  tr.append(sub);

  tr.append(stageCell(el, page));

  const en = el('td', 'pt-col-status');
  en.append(statusChip(page.enStatus, page.enStatusLabel));
  tr.append(en);

  const tx = el('td', 'pt-col-status');
  if (page.locale) tx.append(statusChip(page.translationStatus, page.translationLabel));
  else tx.append(el('span', 'pt-na', '—'));
  tr.append(tx);

  const rev = el('td', 'pt-col-status');
  if (page.locale) rev.append(statusChip(page.reviewStatus, page.reviewLabel));
  else rev.append(el('span', 'pt-na', '—'));
  tr.append(rev);

  tr.append(crawlCell(el, page));

  const open = el('td', 'pt-col-links');
  open.append(
    miniLink(el, page.links.enPreview, 'EN', 'The English page on the preview host'),
    miniLink(el, page.links.enEdit, 'DA', 'Edit the English document in Document Authoring'),
  );
  if (page.locale) {
    open.append(miniLink(
      el,
      page.previewed ? page.links.localePreview : null,
      page.locale.toUpperCase(),
      page.previewed
        ? 'The translated page on the preview host'
        : 'Nothing answers on the preview host for this locale yet',
    ));
  }
  tr.append(open);

  const actions = el('td', 'pt-col-actions');
  const detail = el('button', 'pt-btn pt-btn-quiet', 'Detail');
  detail.type = 'button';
  detail.title = 'Every locale for this page, the tier verdicts, and the write actions';
  detail.addEventListener('click', (e) => {
    e.stopPropagation();
    handlers.onOpen(page);
  });
  actions.append(detail);
  tr.append(actions);

  tr.addEventListener('click', () => handlers.onOpen(page));
  tr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handlers.onOpen(page);
    }
  });
  return tr;
}

const HEADERS = [
  ['Page', 'The English page. The path is the join key across every tab.'],
  ['Subgroup', 'Authored on the data tab. Blank rolls up as (unassigned).'],
  ['Stage', 'DERIVED on every render from the stored columns plus the two crawl '
    + 'observations. Nothing stores a stage.'],
  ['EN status', 'Stored: en-status on the data tab. Writable here.'],
  ['Translation', 'Stored: translation-status on the locale tab. The pipeline owns it — '
    + 'read-only here.'],
  ['Review', 'Stored: review-status on the locale tab. Writable here.'],
  ['Crawl', 'Observed by tx:scan on both hosts. Read-only here — the next scan would '
    + 'revert any hand edit.'],
  ['Open in', null],
  ['', null],
];

/**
 * The empty state, which must never be a blank area.
 *
 * It names the constraint that emptied the table and offers to clear THAT one, because
 * a reader looking at nothing cannot tell a filter matching zero rows from a sheet with
 * no pages in it, and those need opposite next actions. With no filter active at all it
 * says so instead of inventing a filter to blame.
 */
function emptyState(el, handlers) {
  const box = el('div', 'pt-empty');
  const active = handlers.active || [];
  if (!active.length) {
    box.append(el('p', 'pt-empty-head', 'No pages on this tab.'));
    box.append(el('p', 'pt-hint', 'The group sheet has no page rows yet. Populate it with '
      + '`npm run group:sync -- --group=<group> --apply`, which reconciles '
      + '/en/query-index.json into the sheet.'));
    return box;
  }
  const named = active.map((a) => `${a.label} “${a.value}”`).join(' and ');
  box.append(el('p', 'pt-empty-head', `No pages match ${named}.`));
  const row = el('p', 'pt-empty-actions');
  for (const a of active) {
    const b = el('button', 'pt-btn pt-btn-quiet', `Clear ${a.label.toLowerCase()}`);
    b.type = 'button';
    b.addEventListener('click', () => handlers.onClear(a.key));
    row.append(b);
  }
  if (active.length > 1) {
    const all = el('button', 'pt-btn', 'Clear all filters');
    all.type = 'button';
    all.addEventListener('click', () => handlers.onClear(null));
    row.append(all);
  }
  box.append(row);
  return box;
}

/**
 * Render the table into `mount`.
 *
 * @param {Element} mount
 * @param {object[]} pages view rows from `buildRows`
 * @param {object} handlers `{ onOpen, onClear, active, readonly }`
 * @returns {{ updateRow: Function, setSelected: Function }}
 */
export function renderTable(mount, pages, handlers) {
  const { el } = dom(mount);
  const opts = { ...handlers, mount };
  mount.textContent = '';

  if (!pages.length) {
    mount.append(emptyState(el, opts));
    return { updateRow: () => {}, setSelected: () => {} };
  }

  const table = el('table', 'pt-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const [label, hint] of HEADERS) {
    const th = el('th', null, label);
    th.scope = 'col';
    if (hint) th.title = hint;
    hr.append(th);
  }
  thead.append(hr);
  table.append(thead);

  const tbody = el('tbody');
  const byPath = new Map();
  for (const page of pages) {
    const tr = buildRow(page, opts);
    byPath.set(page.path, tr);
    tbody.append(tr);
  }
  table.append(tbody);
  mount.append(table);

  return {
    /** Repaint one row in place — a write landed, so the derived stage may have moved. */
    updateRow(page) {
      const existing = byPath.get(page.path);
      if (!existing) return;
      const fresh = buildRow(page, opts);
      if (existing.classList.contains('pt-row-selected')) fresh.classList.add('pt-row-selected');
      existing.replaceWith(fresh);
      byPath.set(page.path, fresh);
    },
    setSelected(path) {
      for (const [p, tr] of byPath) tr.classList.toggle('pt-row-selected', p === path);
    },
  };
}
