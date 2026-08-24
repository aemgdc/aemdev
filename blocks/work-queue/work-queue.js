/*
 * work-queue — what needs doing, and whose it is.
 *
 * The board's job is to tell a SPECIFIC PERSON that something is theirs, so `owner`
 * comes off `QUEUES` in the model and is rendered on every queue heading. It is in the
 * model rather than in this file because the boards, the DA app and the escalation feed
 * must not disagree about who is being asked.
 *
 * ─── Two sources, deliberately, and what each one can say ────────────────────
 *
 *   COUNTS come from the roll-up's `queues` tab — one row per (locale, queue), built by
 *          running the model over the group sheets. That is the authoritative "how many".
 *   DETAIL comes from the two escalation feeds, which carry one row per escalated
 *          (page, locale) with a summary and a doc link.
 *
 * They do not cover the same set and the difference matters. A pair lands in
 * `retranslate` because a reviewer wrote `needs-retranslation` in a sheet; nothing
 * escalated, so there is no escalation row and never will be. So a queue can honestly
 * read "6 pairs" with no rows beneath it, and this board says so in words rather than
 * rendering an empty list that reads as lost data.
 *
 * ─── An empty queue is the GOOD state ────────────────────────────────────────
 *
 * Nothing is translated yet, so every queue is legitimately empty and will be for a
 * while. That is success, not an error, and it is styled and worded as such. The state
 * that IS an error — no feed at all — is a different panel with the command to run.
 *
 * ─── A queue name nobody owns is surfaced, never dropped ─────────────────────
 *
 * A `queue` value the model does not define has no label, no owner and no filter that
 * matches it, so filtering it out would silently delete work. Upstream this happened at
 * scale: a feed whose `group` values no filter could match left 21 of 23 groups
 * unfilterable, and nobody noticed because the boards looked fine. Anything with a
 * dangling queue id is rendered in its own warning section with the raw value shown.
 *
 * Authored config (key/value rows, all optional):
 *   queue    restrict to one queue id
 *   owner    restrict to one owner (`pipeline`, `human`, `developer`)
 *   locale   restrict to one target locale code
 *   group    restrict the detail rows to one page group
 *   limit    detail rows per queue (default 10)
 */

import { loadTxRollup, loadEscalations, loadTxEscalations } from '../../scripts/tracker/data.js';
import { QUEUES, queueMeta, isQueue } from '../../scripts/tracker/stages.js';
import { TARGET_LOCALES, locale as localeFor } from '../../scripts/tracker/locales.js';
import {
  FEEDS, daEditUrl, links, pageTrackerUrl,
} from '../../scripts/tracker/paths.js';
import { dom, readConfig, fmtInt } from '../../scripts/tracker/block-utils.js';

/** Detail rows shown per queue before the board says how many it is holding back. */
const DEFAULT_LIMIT = 10;

const num = (v) => Number(v || 0);
const text = (v) => String(v ?? '').trim();

/** Every owner the model defines, in first-appearance order. For the config warning. */
const OWNERS = [...new Set(QUEUES.map((q) => q.owner))];

/** An external link, or nothing at all — a dead anchor is worse than a missing one. */
function anchor(el, href, label, hint) {
  if (!href) return null;
  const a = el('a', 'wq-link', label);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  if (hint) a.title = hint;
  return a;
}

/**
 * One escalation row, rendered.
 *
 * Every link is built by `links()` / `daEditUrl()` / `pageTrackerUrl()` from paths.js.
 * None is assembled here: a row on a board, a row in the DA app and a line in a report
 * point at the same three places, and three hand-rolled spellings is how they drift.
 */
function detailRow(el, row, group) {
  const path = text(row['page-path']);
  const code = text(row.locale).toLowerCase();
  const known = localeFor(code);
  const li = el('li', 'wq-item');

  const head = el('div', 'wq-item-head');
  head.append(el('span', 'wq-path', path || '(no page-path)'));
  if (code) {
    const chip = el('span', 'wq-locale', known ? `${known.native} /${code}` : `/${code}`);
    if (!known) {
      chip.classList.add('wq-locale-unknown');
      chip.title = `"${code}" is not one of the ten target locales.`;
    }
    head.append(chip);
  }
  if (group) head.append(el('span', 'wq-group', group));
  const attempts = num(row.attempts);
  if (attempts) {
    const tries = `${fmtInt(attempts)} ${attempts === 1 ? 'attempt' : 'attempts'}`;
    head.append(el('span', 'wq-attempts', tries));
  }
  li.append(head);

  const summary = text(row.summary);
  li.append(el('p', 'wq-summary', summary || 'No summary published for this item.'));

  const actions = el('div', 'wq-actions');
  /*
   * `links()` needs a locale to build the locale-side URLs, and an EN-side escalation
   * has none. It returns nulls for those, and `anchor()` drops them — so an EN row
   * offers the English page and its QA doc, and a locale row offers the translated page
   * and its review doc, without either being asked to fake the other.
   */
  if (path) {
    const l = links(path, known ? code : undefined);
    for (const a of [
      anchor(
        el,
        l.localePreview || l.enPreview,
        'Page',
        'The page on the preview host, which is where the tiers observed it.',
      ),
      anchor(
        el,
        row.doc ? daEditUrl(text(row.doc)) : (l.txDoc || l.qaDoc),
        'Review doc',
        'The review document in DA — the full story, including the prose this public '
        + 'feed deliberately strips.',
      ),
      anchor(
        el,
        pageTrackerUrl({ group, locale: known ? code : undefined }),
        'Page Tracker',
        'This page in the Page Tracker app, filtered to its group and locale.',
      ),
    ]) {
      if (a) actions.append(a);
    }
  }
  li.append(actions);
  return li;
}

/** A queue's heading: label, owner, count, and the hint that says what it means. */
function queueHead(el, meta, count, shown) {
  const head = el('div', 'wq-head');
  const title = el('h3', 'wq-title', meta.label);
  head.append(title);

  const owner = el('span', 'wq-owner', meta.owner);
  owner.title = `${meta.owner} clears this queue. The owner is part of the status model, `
    + 'so this board, the DA app and the escalation feed cannot disagree about who is '
    + 'being asked.';
  head.append(owner);

  const n = el('span', 'wq-count', fmtInt(count));
  n.title = `${fmtInt(count)} (page, locale) pairs are in this queue.`;
  head.append(n);

  if (shown) head.append(el('span', 'wq-shown', shown));
  return head;
}

/** A panel that says what was wanted, where it looked, and what to run. */
function panel(el, cls, heading, lines) {
  const box = el('div', `wq-panel ${cls}`);
  box.append(el('h3', 'wq-panel-title', heading));
  for (const line of lines) box.append(el('p', 'wq-panel-line', line));
  return box;
}

/** Authored-config and feed-data problems, listed rather than swallowed. */
function warningList(el, warnings) {
  const box = el('div', 'wq-warnings');
  box.append(el('h3', 'wq-warn-title', 'Needs a look'));
  const list = el('ul', 'wq-warn-list');
  for (const w of warnings) list.append(el('li', 'wq-warn-item', w));
  box.append(list);
  return box;
}

/**
 * Queue ids present in the data that the model does not define.
 *
 * Counted from both sources, because either can carry one: the roll-up builds its rows
 * from `QUEUES` and cannot, but a hand-edited sheet or an older feed can, and the
 * escalation `.jsonl` is written by drivers that record a queue verbatim.
 */
function danglingQueues(queueRows, detailRows) {
  const found = new Map();
  /*
   * `pairs` is the number of (page, locale) pairs stranded, not the number of rows
   * carrying the id. A roll-up row saying `count: 7` is seven pairs nobody owns, and
   * reporting it as "appears once" would understate the thing by a factor of seven.
   */
  const note = (id, where, pairs, path) => {
    const key = text(id);
    if (key && !isQueue(key)) {
      const entry = found.get(key) || {
        id: key, pairs: 0, rows: 0, sources: new Set(), paths: [],
      };
      entry.pairs += pairs;
      entry.rows += 1;
      entry.sources.add(where);
      if (path && !entry.paths.includes(path)) entry.paths.push(path);
      found.set(key, entry);
    }
  };
  for (const row of queueRows) note(row.queue, 'the roll-up', num(row.count), '');
  for (const row of detailRows) {
    note(row.queue, 'an escalation feed', 1, text(row['page-path']));
  }
  return [...found.values()];
}

/** Resolve authored config, naming anything it could not match. */
function resolveConfig(cfg, warnings) {
  const queue = text(cfg.queue).toLowerCase();
  if (queue && !isQueue(queue)) {
    warnings.push(`Authored \`queue\` is "${queue}", which is not a queue in the model. `
      + `The ten are: ${QUEUES.map((q) => q.id).join(', ')}. Showing all queues.`);
  }
  const owner = text(cfg.owner).toLowerCase();
  if (owner && !OWNERS.includes(owner)) {
    warnings.push(`Authored \`owner\` is "${owner}"; the owners in the model are `
      + `${OWNERS.join(', ')}. Showing all owners.`);
  }
  const code = text(cfg.locale).toLowerCase();
  if (code && !TARGET_LOCALES.includes(code)) {
    warnings.push(`Authored \`locale\` is "${code}", which is not a target locale. `
      + `The ten are: ${TARGET_LOCALES.join(', ')}. Showing all locales.`);
  }
  const limit = Number(cfg.limit);
  return {
    queue: isQueue(queue) ? queue : '',
    owner: OWNERS.includes(owner) ? owner : '',
    code: TARGET_LOCALES.includes(code) ? code : '',
    group: text(cfg.group),
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT,
  };
}

export default async function init(block) {
  const { el } = dom(block);
  const cfg = readConfig(block);
  block.textContent = '';

  const warnings = [];
  const opts = resolveConfig(cfg, warnings);

  const [rollup, qa, tx] = await Promise.all([
    loadTxRollup(),
    loadEscalations(),
    loadTxEscalations(),
  ]);

  /*
   * The roll-up is the only feed this board cannot work without — it holds the counts,
   * and the escalation feeds only ever hold a subset of them. A missing escalation feed
   * is reported below as a missing DETAIL source, not as a broken board.
   */
  if (rollup.missing) {
    block.append(panel(el, 'wq-panel-error', 'No work-queue counts yet', [
      `This board reads ${FEEDS.txRollup}, which did not answer `
      + `(${rollup.error || 'unknown error'}).`,
      'Nothing is translated yet and the feed is built by the pipeline, so this is the '
      + 'expected state until it has run once.',
      'To populate it: `npm run group:sync --apply`, then `npm run tx:scan --apply`, then '
      + '`npm run rollup`.',
    ]));
    return;
  }

  const queueRows = (rollup.queues || []).filter((row) => {
    const code = text(row.locale).toLowerCase();
    return !opts.code || code === opts.code;
  });

  if (!(rollup.queues || []).length) {
    warnings.push('The roll-up carries no `queues` tab. It is the second tab dropped when the '
      + 'feed hits its size ceiling, so the counts below may be from the escalation feeds '
      + 'alone — check `meta.queues-withheld` on the feed.');
  }

  const detail = [
    ...(qa.rows || []).map((row) => ({ ...row, side: 'qa' })),
    ...(tx.rows || []).map((row) => ({ ...row, side: 'tx' })),
  ].filter((row) => {
    const code = text(row.locale).toLowerCase();
    const group = text(row.group);
    return (!opts.code || code === opts.code) && (!opts.group || group === opts.group);
  });

  const missingDetail = [
    qa.missing ? `${FEEDS.escalations} (${qa.error})` : null,
    tx.missing ? `${FEEDS.txEscalations} (${tx.error})` : null,
  ].filter(Boolean);

  const shown = QUEUES.filter((q) => (!opts.queue || q.id === opts.queue)
    && (!opts.owner || q.owner === opts.owner));

  /*
   * Resolved to a list first, then rendered. A queue with no count AND no detail row is
   * not drawn at all — ten empty headings is a board nobody scans — but the decision has
   * to be made before anything is appended, because whether EVERY queue is empty is the
   * difference between this board and the "nothing queued" panel.
   */
  const work = shown.map((meta) => ({
    meta,
    count: queueRows
      .filter((row) => text(row.queue) === meta.id)
      .reduce((a, row) => a + num(row.count), 0),
    rows: detail.filter((row) => text(row.queue) === meta.id),
  })).filter((w) => w.count || w.rows.length);

  const board = el('div', 'wq-board');

  for (const { meta, count, rows } of work) {
    const section = el('section', 'wq-queue');
    section.dataset.owner = meta.owner;
    const held = rows.length > opts.limit
      ? `showing ${fmtInt(opts.limit)} of ${fmtInt(rows.length)} published items`
      : '';
    section.append(queueHead(el, meta, count || rows.length, held));
    section.append(el('p', 'wq-hint', meta.hint));

    if (rows.length) {
      const list = el('ul', 'wq-list');
      for (const row of rows.slice(0, opts.limit)) {
        list.append(detailRow(el, row, text(row.group)));
      }
      section.append(list);
    } else {
      /*
       * Counts without detail is a NORMAL combination, not a gap: most queues are
       * entered by a status a human typed in a sheet, and only an escalated item gets a
       * feed row. Saying which is which stops an empty list reading as lost data.
       */
      section.append(el('p', 'wq-nodetail', `${fmtInt(count)} pairs are in this queue with no `
        + 'published escalation detail — this queue is entered by a recorded status, not by an '
        + 'escalation. Open the Page Tracker to see which pages.'));
      const a = anchor(
        el,
        pageTrackerUrl({ filter: meta.id, locale: opts.code || undefined }),
        'Open in Page Tracker',
        'The Page Tracker app, filtered to this queue.',
      );
      if (a) section.append(a);
    }
    board.append(section);
  }

  if (work.length) {
    block.append(board);
  } else {
    /*
     * The good state. Worded positively and styled quietly: an empty work queue means
     * nobody is owed anything, and dressing it as an error trains people to ignore the
     * board. It still names the scope, so "nothing queued" cannot be mistaken for
     * "nothing was looked at".
     */
    const scope = [
      opts.queue ? `the ${queueMeta(opts.queue).label} queue` : 'any queue',
      opts.owner ? `owned by ${opts.owner}` : '',
      opts.code ? `in ${localeFor(opts.code).name}` : 'across all ten locales',
    ].filter(Boolean).join(' ');
    block.append(panel(el, 'wq-panel-clear', 'Nothing queued', [
      `No pages need action in ${scope}. Nobody is owed anything here.`,
      `Counted from ${FEEDS.txRollup}, rolled up `
      + `${rollup.generatedAt || 'at an unrecorded time'}.`,
    ]));
  }

  const dangling = danglingQueues(rollup.queues || [], detail);
  for (const d of dangling) {
    const examples = d.paths.length ? ` For example: ${d.paths.slice(0, 3).join(', ')}.` : '';
    warnings.push(`Queue id "${d.id}" holds ${fmtInt(d.pairs)} pair(s) across `
      + `${fmtInt(d.rows)} row(s) of ${[...d.sources].join(' and ')}, but is not defined in `
      + 'the model — so it has no label, no owner and no filter that matches it, and nobody '
      + 'is being asked to clear it. Either the model is missing a queue or the data has a '
      + `typo.${examples}`);
  }
  if (missingDetail.length) {
    warnings.push(`No escalation detail: ${missingDetail.join('; ')}. Counts above are from the `
      + 'roll-up; per-page summaries appear once `npm run escalations --apply` has published a '
      + 'feed.');
  }
  if (warnings.length) block.append(warningList(el, warnings));
}
