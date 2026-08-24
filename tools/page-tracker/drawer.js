/*
 * drawer.js — one page, ten languages, and the only three write actions this app has.
 *
 * ─── Why the drawer is per PAGE and the table is per pair ───────────────────
 *
 * The table answers "where is this locale?" and every board answers the same question.
 * Nothing answers "where is this PAGE?", because that means holding ten rows from ten
 * tabs side by side, and assembling it from boards takes ten loads and cannot be seen
 * at once. "German is signed off, Japanese never arrived, the other eight were never
 * sent" is one glance here and a research project anywhere else — and it is the shape
 * of almost every real question about a rollout.
 *
 * Everything the pipeline already found is shown ABOVE the write controls, for one
 * reason: a reviewer who re-finds a known defect has spent their time discovering
 * nothing.
 */

import { dom, fmtInt } from '../../scripts/tracker/block-utils.js';
import { EN_STATUSES, REVIEW_STATUSES, statusClass } from '../../scripts/tracker/stages.js';
import { locale as localeFor } from '../../scripts/tracker/locales.js';
import { tierStates } from './rows.js';

/* ------------------------------------------------------------------ the gate */

/**
 * ONE busy gate across ALL write controls, not one per control.
 *
 * Every write here is a read-modify-write of the WHOLE group sheet: read the doc, set
 * one cell, POST the doc back. Two of those racing on one sheet is not a slow write,
 * it is a LOST ROW — the second read happens before the first write lands, so the
 * second POST carries the pre-first-write copy of every other row, and it reports
 * success. The ETag precondition catches the interleaving it can see, but the honest
 * fix is not to issue the second write at all.
 *
 * So the registry is per DRAWER, not per button: raising the escalation flag disables
 * the en-status select and all ten review selects too, until it lands.
 */
function gate() {
  const controls = new Set();
  let busy = false;
  return {
    register(node) {
      controls.add(node);
      return node;
    },
    /** Disable every registered control. Used for readonly as well as for in-flight. */
    freeze(reason) {
      for (const c of controls) {
        c.disabled = true;
        if (reason) c.title = reason;
      }
    },
    thaw() {
      for (const c of controls) c.disabled = false;
    },
    async run(fn) {
      if (busy) return { ok: false, reason: 'another write is still running' };
      busy = true;
      this.freeze('a write is in flight');
      try {
        return await fn();
      } finally {
        busy = false;
        this.thaw();
      }
    },
  };
}

/* ------------------------------------------------------------------ rendering */

function section(el, title, hint) {
  const box = el('section', 'pt-section');
  box.append(el('h3', null, title));
  if (hint) box.append(el('p', 'pt-hint', hint));
  return box;
}

/** One link, or a dead-looking span when there is nothing to point at. */
function mini(el, label, href, hint) {
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
  return a;
}

function linkRow(el, entries) {
  const wrap = el('p', 'pt-links');
  for (const [label, href, hint] of entries) wrap.append(mini(el, label, href, hint));
  return wrap;
}

/**
 * The always-three tier chips.
 *
 * `not-run` is rendered as its own visibly distinct state and labelled in words in the
 * chip itself, not only in a tooltip. `null` and `pass` looking the same is the exact
 * failure this guards: three grey chips that a reader skims as "all clear" when in
 * fact nothing has run. Today nothing HAS run for any page, so this is the state the
 * app is in, not a corner of it.
 */
function tierRow(el, report) {
  const wrap = el('div', 'pt-tiers');
  for (const tier of tierStates(report)) {
    const chip = el('span', 'pt-tier');
    chip.dataset.state = tier.state;
    chip.title = tier.title;
    chip.append(el('span', 'pt-tier-name', tier.short));
    chip.append(el('span', 'pt-tier-verdict', tier.state === 'not-run' ? 'did not run' : tier.verdict));
    wrap.append(chip);
  }
  return wrap;
}

function reportSection(el, page, report) {
  const box = section(
    el,
    `Auto QA — ${page.localeName}`,
    'What the three tiers found, from the published per-page report. Structural, '
      + 'fidelity and layout are independent answers with different owners, so all '
      + 'three are always shown.',
  );
  box.append(tierRow(el, report?.report));

  if (!report?.exists) {
    box.append(el('p', 'pt-note', report?.where
      ? `No published report at ${report.where}.`
      : 'No published report for this page and locale.'));
    box.append(el('p', 'pt-hint', 'That is "nobody has looked", not "it passed". Run '
      + `\`npm run tx:batch -- --group=<group> --locale=${page.locale || '<code>'}\` to run the `
      + 'tiers, then `npm run tx:publish -- --apply` to publish the report this panel reads.'));
    return box;
  }

  const row = report.report || {};
  const meta = el('p', 'pt-note');
  meta.append(el('span', null, `Verdict ${row.verdict || '—'}`));
  if (row.confidence !== '' && row.confidence != null) {
    meta.append(el('span', null, ` · judge confidence ${Number(row.confidence).toFixed(2)}`));
  }
  meta.append(el('span', null, ` · ${fmtInt(row['finding-count'])} finding(s)`));
  if (row.generated) meta.append(el('span', null, ` · generated ${row.generated}`));
  if (row.branch) meta.append(el('span', null, ` · ref ${row.branch}`));
  box.append(meta);

  if (report.findings.length) {
    const ul = el('ul', 'pt-findings');
    for (const f of report.findings) {
      const li = el('li');
      li.append(el('span', 'pt-finding-tier', f.tier || '?'));
      if (f.severity) li.append(el('span', 'pt-finding-sev', f.severity));
      li.append(el('span', 'pt-finding-detail', f.detail || f.kind || f.check || ''));
      if (f.width) li.append(el('span', 'pt-finding-width', `@${f.width}px`));
      ul.append(li);
    }
    box.append(ul);
  }
  return box;
}

/**
 * One locale's review verdict, as a select that writes.
 *
 * A select rather than a row of buttons: there are six values and they are not a
 * ladder — `needs-terminology-fix` and `needs-layout-fix` route to different people —
 * so six buttons per row times ten rows is sixty controls that all look equally likely.
 *
 * The value written is checked against `REVIEW_STATUSES` again in da-source.js. Two
 * checks on purpose: this one keeps a wrong value off the screen, that one keeps it out
 * of the sheet, and only the second one is a guarantee.
 */
function reviewCell(el, statusChip, state, opts, g) {
  const td = el('td', 'pt-col-review');
  if (state.missingLocaleRow) {
    const none = el('span', 'pt-na', '—');
    none.title = `No row on the ${state.locale} tab, so there is nothing to write a verdict `
      + 'on. `tx:send` creates the row.';
    td.append(none);
    return td;
  }

  const select = g.register(el('select', 'pt-select pt-write'));
  for (const s of REVIEW_STATUSES) {
    const opt = el('option', null, s.label);
    opt.value = s.value;
    if (s.value.toLowerCase() === state.reviewStatus.toLowerCase()) opt.selected = true;
    select.append(opt);
  }
  const status = el('span', 'pt-write-status');
  /*
   * The option that was selected when the panel was built, NOT the raw cell.
   *
   * A refused write has to put the control back to what the SHEET says, and the raw
   * cell may be a hand-typed spelling (`Translation Ok`) that matches no option value —
   * assigning it would silently reset the select to its first option, leaving the screen
   * showing a verdict nobody recorded. The option matched case-insensitively above is
   * the one thing guaranteed to exist.
   */
  const asBuilt = select.value;
  select.addEventListener('change', async () => {
    const { value } = select;
    status.textContent = '…';
    const result = await g.run(() => opts.onReviewStatus(state.locale, value));
    status.textContent = result.ok ? '✓' : '✕';
    status.title = result.ok
      ? `Saved${result.previewed === false ? ` (preview: ${result.previewError})` : ''}`
      : result.reason;
    if (!result.ok) select.value = asBuilt;
  });
  td.append(select);
  td.append(status);
  if (state.reviewUpdated) {
    td.append(el('span', 'pt-when', state.reviewUpdated.slice(0, 10)));
  }
  return td;
}

/**
 * The ten-locale matrix, with the per-locale review verdict inline.
 *
 * All ten rows always, including the ones with no locale row at all — their absence IS
 * the rollout status. A row with no locale row reads "Not sent", which is
 * `TRANSLATION_STATUSES[0].label` and not a phrase invented here.
 */
function localeSection(el, statusChip, page, opts, g) {
  const box = section(
    el,
    'Every locale for this page',
    'One page, ten languages. The stage in each row is derived from that locale\'s '
      + 'stored columns and the two crawl observations — nothing here is a stored stage.',
  );

  const table = el('table', 'pt-locale-table');
  const thead = el('thead');
  const head = el('tr');
  for (const h of ['Locale', 'Stage', 'Translation', 'Crawl', 'Review verdict', 'Open']) {
    const th = el('th', null, h);
    th.scope = 'col';
    head.append(th);
  }
  thead.append(head);
  table.append(thead);
  const tbody = el('tbody');

  for (const state of opts.locales) {
    const tr = el('tr', 'pt-locale-row');
    if (state.locale === page.locale) tr.classList.add('pt-locale-row-focus');

    const name = el('td', 'pt-locale-name');
    name.append(el('span', 'pt-locale-native', localeFor(state.locale)?.native || state.locale));
    name.append(el('span', 'pt-locale-code', state.locale));
    tr.append(name);

    const stage = el('td');
    const chip = el('span', 'pt-stage', state.stageShort);
    chip.dataset.stage = state.blocked ? 'blocked' : statusClass(state.stage);
    chip.title = `${state.stageLabel} — ${state.stageHint}`;
    stage.append(chip);
    for (const q of state.queues) stage.append(el('span', 'pt-chip pt-chip-queue', q));
    tr.append(stage);

    const tx = el('td');
    tx.append(statusChip(state.translationStatus, state.translationLabel));
    tr.append(tx);

    const crawl = el('td', 'pt-col-crawl');
    for (const [label, on] of [['PREV', state.previewed], ['LIVE', state.online]]) {
      crawl.append(el('span', `pt-crawl pt-crawl-${on ? 'yes' : 'no'}`, label));
    }
    tr.append(crawl);

    tr.append(reviewCell(el, statusChip, state, opts, g));

    const open = el('td', 'pt-col-links');
    const preview = state.previewed ? state.links.localePreview : null;
    const edit = state.missingLocaleRow ? null : state.links.localeEdit;
    open.append(mini(el, 'view', preview, 'The translated page on the preview host'));
    open.append(mini(el, 'edit', edit, 'Edit the translated document in DA'));
    open.append(mini(el, 'doc', state.links.txDoc, 'The review document for this pair'));
    tr.append(open);

    tbody.append(tr);
  }
  table.append(tbody);
  box.append(table);
  return box;
}

/**
 * The English-side write controls: `en-status` and the content-escalation flag.
 *
 * Both live on the `data` tab, so both are facts about the PAGE and apply to all ten
 * locales at once — which is why they are in their own panel above the locale matrix
 * rather than repeated in every row of it.
 */
function englishSection(el, page, opts, g) {
  const box = section(
    el,
    'English source',
    '`en-status` is the SEND GATE: `tx:send` requires an explicit `en-published` and '
      + 'never infers it from a crawl, because sending is the one irreversible, '
      + 'money-costing step in the pipeline.',
  );
  box.append(linkRow(el, [
    ['preview', page.links.enPreview, 'The English page on the preview host'],
    ['live', page.links.enLive, 'The English page on the live host'],
    ['DA', page.links.enEdit, 'Edit the English document in Document Authoring'],
    ['QA doc', page.links.qaDoc, 'The English QA-notes document'],
  ]));

  const field = el('label', 'pt-field');
  field.append(el('span', null, 'en-status'));
  const select = g.register(el('select', 'pt-select pt-write'));
  for (const s of EN_STATUSES) {
    const opt = el('option', null, s.label);
    opt.value = s.value;
    if (s.value.toLowerCase() === page.enStatus.toLowerCase()) opt.selected = true;
    select.append(opt);
  }
  const enStatusMsg = el('span', 'pt-write-status');
  // See `reviewCell`: revert to the option as built, never to the raw cell.
  const asBuilt = select.value;
  select.addEventListener('change', async () => {
    const { value } = select;
    enStatusMsg.textContent = '…';
    const result = await g.run(() => opts.onEnStatus(value));
    enStatusMsg.textContent = result.ok ? '✓ saved' : `✕ ${result.reason}`;
    if (!result.ok) select.value = asBuilt;
  });
  field.append(select);
  field.append(enStatusMsg);
  box.append(field);

  const flagBox = el('div', 'pt-flagbox');
  flagBox.append(el('p', 'pt-hint', 'A content escalation is a FLAG, not a verdict: it says '
    + 'a decision is outstanding on the English source. It coexists with any stage, so '
    + 'raising it on a page whose German is signed off leaves the German signed off.'));
  const flag = g.register(el(
    'button',
    `pt-btn pt-write ${page.contentEscalation ? 'pt-btn-warn' : ''}`,
    page.contentEscalation ? '✓ Clear content escalation' : '⚑ Raise content escalation',
  ));
  flag.type = 'button';
  const flagMsg = el('span', 'pt-write-status');
  flag.addEventListener('click', async () => {
    flagMsg.textContent = '…';
    const result = await g.run(() => opts.onEscalation(!page.contentEscalation));
    flagMsg.textContent = result.ok ? '✓ saved' : `✕ ${result.reason}`;
  });
  flagBox.append(flag);
  flagBox.append(flagMsg);
  box.append(flagBox);

  return box;
}

/** What the model concluded and why, so a surprising stage is explainable on the spot. */
function stageSection(el, page) {
  const box = section(el, 'Derived stage', null);
  const line = el('p', 'pt-stage-line');
  const chip = el('span', 'pt-stage', page.stageShort);
  chip.dataset.stage = page.blocked ? 'blocked' : statusClass(page.stage);
  line.append(chip);
  line.append(el('span', 'pt-stage-label', page.stageLabel));
  box.append(line);
  box.append(el('p', 'pt-hint', page.stageHint));
  if (page.warnings.length) {
    const ul = el('ul', 'pt-warnings');
    for (const w of page.warnings) ul.append(el('li', null, w));
    box.append(ul);
  }
  return box;
}

/**
 * Render the drawer for one page.
 *
 * @param {object} page  the focused view row (its `locale` picks which locale the tier
 *                       report and the report panel are about)
 * @param {object} opts  `{ locales, report, readonly, onClose, onEnStatus,
 *                       onReviewStatus, onEscalation }`
 * @returns {Element}
 */
export function renderDrawer(page, opts) {
  const { el, statusChip } = dom(opts.mount || document.body);
  const g = gate();

  const aside = el('aside', 'pt-drawer');
  aside.setAttribute('aria-label', `Detail for ${page.path}`);

  const head = el('header', 'pt-drawer-head');
  const titles = el('div');
  titles.append(el('h2', null, page.title));
  titles.append(el('p', 'pt-path', page.path));
  head.append(titles);
  const close = el('button', 'pt-btn pt-btn-quiet', '✕');
  close.type = 'button';
  close.title = 'Close';
  close.addEventListener('click', opts.onClose);
  head.append(close);
  aside.append(head);

  if (opts.readonly) {
    aside.append(el('p', 'pt-readonly', 'Read-only — ?readonly=1 is set, so every write '
      + 'control below is disabled.'));
  }

  aside.append(stageSection(el, page));
  aside.append(englishSection(el, page, opts, g));
  if (page.locale) aside.append(reportSection(el, page, opts.report));
  aside.append(localeSection(el, statusChip, page, opts, g));

  /*
   * Readonly is applied LAST, over the whole registry, for the same reason the busy
   * gate is one gate: a per-control `if (readonly)` at each creation site is a list
   * that a new control is added without. Freezing the registry means a write control
   * this app grows tomorrow is disabled by readonly the day it is written.
   */
  if (opts.readonly) g.freeze('read-only mode — ?readonly=1 is set');

  return aside;
}
