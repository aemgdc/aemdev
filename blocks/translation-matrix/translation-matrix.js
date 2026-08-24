/*
 * translation-matrix — where is every page, in every language?
 *
 * Ten locales down, four groups across, and in each cell that (locale, group)'s
 * distribution across the funnel. It is the one board that answers the question the
 * whole tracker exists for, so it is also the one that must be honest when the answer
 * is "nowhere yet".
 *
 * ─── Which tab it reads, and why it is not `cells` ───────────────────────────
 *
 * The long-form `cells` tab and the wide `groups` tab carry the same numbers;
 * `docs/tracker/data-contract.md` §3 says which is for whom — "a matrix reads the wide
 * one and a drill-in reads the long one" — and two facts make that the right call here:
 *
 *   1. `cells` is the FIRST tab dropped when the published feed hits its size ceiling
 *      (then `queues`), and withholding is a normal operating mode rather than an
 *      error. A matrix built on `cells` goes blank exactly when the rollout gets big
 *      enough to be interesting.
 *   2. `cells` carries non-zero triples only, so a cell with no row is indistinguishable
 *      from a group with no pages — and "no pages tracked here" and "pages tracked,
 *      none moved" are the two states this board must never conflate. `bios` is the
 *      live example: a registered group with zero rows.
 *
 * `scripts/tracker/data.js` exposes `groups` and does not expose `cells`, so this also
 * keeps the board on the memoised data layer instead of a second fetch of the same doc.
 *
 * ─── 390px: a scrolling table, not per-locale cards ──────────────────────────
 *
 * A 10x4 matrix does not fit a phone, so it has to degrade one of two ways. It stays a
 * TABLE inside an `overflow-x` container with the locale column stuck to the left edge,
 * and it deliberately does not reflow into per-locale cards.
 *
 * The reason is what a matrix is FOR: reading down a column ("has anything moved on
 * meetups, in any language?") and across a row in the same glance. Cards preserve the
 * row and destroy the column, which is the comparison this board was built to make —
 * you would be scrolling through ten cards holding four numbers in your head.
 *
 * Measured at a 390px viewport with all four groups and a totals column: the table is
 * 651px inside a 364px container, so it is under one swipe wide, with the locale column
 * pinned at 109px and the page itself not scrolling horizontally at all. At 1280px it
 * fills the container and the inner scroll disappears. Six columns is what makes that
 * work; twenty would be a different decision.
 *
 * ─── The state you will actually be looking at ───────────────────────────────
 *
 * Nothing is translated. Every locale tree is empty and no feed exists in DA yet, so
 * "no feed" and "nothing sent" are the primary states here, not edge cases:
 *
 *   feed 404s        say what was wanted, where it looked, and what to run.
 *   feed, no rows    the rollup is built but describes no locales.
 *   nothing sent     a banner naming the command, ABOVE a matrix that still shows the
 *                    real pre-translation inventory. The English pages exist and are
 *                    published; every pair legitimately classifies as `catalogued` or
 *                    `enPublished`, and that inventory is the denominator every
 *                    percentage on every board divides by. Blanking it out to render
 *                    the banner alone would be hiding real data.
 */

import { loadTxRollup } from '../../scripts/tracker/data.js';
import {
  PAGE_STAGES, PROGRESS_BUCKETS, STAGE_INDEX, bucketForStage, stageMeta,
} from '../../scripts/tracker/stages.js';
import { TARGET_LOCALES, locale as localeFor } from '../../scripts/tracker/locales.js';
import { FEEDS, pageTrackerUrl } from '../../scripts/tracker/paths.js';
import {
  dom, readConfig, fmtInt, pctOf,
} from '../../scripts/tracker/block-utils.js';

/**
 * The out-of-funnel column. Not a PAGE_STAGES member — `classifyTranslation` returns
 * `stage: null` with `blocked: true` — but the rollup publishes it as a stage column
 * and it must be visible in a cell, because it is the only band that means somebody
 * has to do something.
 */
const BLOCKED = 'blocked';

/** Fallback vocabulary for `blocked`, used only when the feed carries no `stages` tab. */
const BLOCKED_FALLBACK = {
  label: 'Blocked',
  short: 'BLK',
  hint: 'Out of the funnel entirely; sits in a work queue until a human or a re-run clears it.',
};

/** Columns summed when rolling several feed rows into one. */
const SUM_COLUMNS = [...PAGE_STAGES.map((s) => s.id), BLOCKED, 'total', 'counted'];

/**
 * The stage that separates inventory from translation work.
 *
 * Everything below it is the English page's own state, which exists whether or not the
 * translation pipeline has ever run. `sentForTranslation` and above is the only
 * evidence that it has.
 */
const FIRST_SENT_ORDER = STAGE_INDEX.sentForTranslation;

/** A segment narrow enough that its label would not fit needs the tooltip instead. */
const LABEL_MIN_PCT = 14;

const num = (v) => Number(v || 0);

/*
 * The (locale, group) key. NUL separator, matching `indexLocaleRows()` in stages.js: a
 * group name is a sheet basename and may contain anything a filename allows, and a
 * delimiter that can appear inside a key is a silent collision.
 */
const cellKey = (code, group) => `${code}\0${group}`;

/** Split an authored list cell. Authors type "de, fr" or "de fr" and mean the same thing. */
const listOf = (v) => String(v || '').split(/[\s,]+/).filter(Boolean);

/**
 * The stage vocabulary as the build that counted the rows spelled it.
 *
 * The `stages` tab travels WITH the data for exactly this reason, so a chip cannot be
 * labelled from a stage list the feed no longer counts. `stageMeta()` is the fallback
 * for a rollup built before the tab existed.
 */
function vocabulary(stageRows) {
  const vocab = new Map();
  for (const row of stageRows || []) {
    const id = String(row?.id || '');
    if (id) {
      vocab.set(id, {
        label: String(row.label || id),
        short: String(row.short || id),
        hint: String(row.hint || ''),
      });
    }
  }
  return vocab;
}

/** One band's label, short label and hint — from the feed first, then the model. */
function stageBand(id, vocab) {
  const fromFeed = vocab.get(id);
  if (fromFeed) return { id, ...fromFeed };
  const meta = stageMeta(id);
  if (meta) {
    return {
      id, label: meta.label, short: meta.short, hint: meta.hint,
    };
  }
  return { id, ...BLOCKED_FALLBACK };
}

/**
 * The bands a cell is divided into, in PAGE_STAGES order, `blocked` last.
 *
 * In `buckets` view a band's SHORT label is borrowed from the first stage that folds
 * into it, and its hint NAMES the stages it folds. PROGRESS_BUCKETS carries a `label`
 * and no `short`, and inventing one here would be a second vocabulary for the same
 * concept — the thing this codebase spends its comments preventing. Saying which
 * stages collapsed is also the only thing a reader needs that the label cannot tell
 * them: `autoQa` is two stages wearing one name.
 */
function bandsFor(view, vocab) {
  const blocked = stageBand(BLOCKED, vocab);
  if (view !== 'buckets') {
    return [...PAGE_STAGES.map((s) => stageBand(s.id, vocab)), blocked];
  }
  return [...PROGRESS_BUCKETS.map((bucket) => {
    const folded = PAGE_STAGES.filter((s) => bucketForStage(s.id) === bucket.id);
    const first = folded[0];
    return {
      id: bucket.id,
      label: bucket.label,
      short: first ? stageBand(first.id, vocab).short : bucket.id,
      hint: folded.length
        ? `Folds ${folded.map((s) => stageBand(s.id, vocab).label).join(' + ')}.`
        : '',
    };
  }), blocked];
}

/**
 * A feed row's counts, per band.
 *
 * ALWAYS folded from the stage columns through `bucketForStage()` — never read off the
 * published `b_` bucket columns, even on the `locales` tab that carries them. The two
 * are equal by construction (one tally, one map), and reading cells one way and totals
 * the other is how a footer comes to disagree with the column above it. One path.
 */
function bandCounts(row, bands, view) {
  const counts = Object.fromEntries(bands.map((b) => [b.id, 0]));
  for (const stage of PAGE_STAGES) {
    const n = num(row?.[stage.id]);
    if (n) {
      const id = view === 'buckets' ? bucketForStage(stage.id) : stage.id;
      if (id && counts[id] !== undefined) counts[id] += n;
    }
  }
  counts[BLOCKED] += num(row?.[BLOCKED]);
  return counts;
}

/** Sum a set of wide rows column by column, so a total is never re-derived twice. */
const sumRows = (rows) => Object.fromEntries(
  SUM_COLUMNS.map((c) => [c, (rows || []).reduce((a, r) => a + num(r?.[c]), 0)]),
);

/** Pairs at or beyond `sentForTranslation` — the evidence that anything was sent. */
const sentOnward = (row) => PAGE_STAGES
  .filter((s) => STAGE_INDEX[s.id] >= FIRST_SENT_ORDER)
  .reduce((a, s) => a + num(row?.[s.id]), 0);

/**
 * One cell: a stacked bar over the pairs counted in that (locale, group), plus a lead
 * line naming the furthest band anything has reached.
 *
 * The lead exists because a bar answers "where is the work" well and "how far has it
 * got" badly, and at 40 cells a reader needs the second answer without a hover. The
 * denominator is NOT repeated here — it is constant down a column (every locale
 * expects the same pages) and sits in the column header instead.
 */
function cellBody(el, row, ctx) {
  const { bands, view, href } = ctx;
  const counted = num(row?.counted);
  const link = el('a', 'tm-cell-link');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';

  if (!row) {
    /*
     * NO ROW AT ALL, which is a third fact and not the same as either zero pages or no
     * progress: the roll-up did not describe this (locale, group). The matrix is always
     * ten locales wide because the REGISTRY says so, not because the feed carried ten
     * rows, so an absent row has to be visibly absent rather than borrowing the "nothing
     * expected here" wording below. Reading the two as one is how a build that skipped a
     * locale looks like a locale with nothing in it.
     */
    link.classList.add('tm-cell-absent');
    link.append(el('span', 'tm-cell-dash', '?'));
    link.title = `The roll-up carries no row for ${ctx.name} / ${ctx.group}, so this cell is `
      + 'not zero — it is unknown.';
    return link;
  }

  if (!counted) {
    /*
     * Nothing EXPECTED here, which is a different fact from nothing having moved and
     * must not read as an empty bar. `bios` is the live case: a registered group whose
     * roster has not been seeded, so it legitimately has zero pages.
     */
    link.classList.add('tm-cell-none');
    link.append(el('span', 'tm-cell-dash', '—'));
    link.title = `${ctx.name}: no pages tracked in ${ctx.group} yet — nothing is expected `
      + 'in this cell.';
    return link;
  }

  const counts = bandCounts(row, bands, view);
  const bar = el('span', 'tm-bar');
  const present = bands.filter((b) => counts[b.id] > 0);
  for (const band of present) {
    const n = counts[band.id];
    const seg = el('span', 'tm-seg');
    seg.dataset.band = band.id;
    seg.style.flexGrow = String(n);
    seg.title = `${band.label}: ${fmtInt(n)} of ${fmtInt(counted)} ${ctx.name} `
      + `${ctx.group} pages${band.hint ? ` — ${band.hint}` : ''}`;
    if (pctOf(n, counted) >= LABEL_MIN_PCT) seg.append(el('span', 'tm-seg-label', band.short));
    bar.append(seg);
  }
  link.append(bar);

  const lead = el('span', 'tm-lead');
  const furthest = present.filter((b) => b.id !== BLOCKED).pop();
  if (furthest) {
    lead.append(el('span', 'tm-lead-band', furthest.short));
    lead.append(el('span', 'tm-lead-num', fmtInt(counts[furthest.id])));
  }
  if (counts[BLOCKED]) {
    const flag = el('span', 'tm-lead-blocked', `⚑ ${fmtInt(counts[BLOCKED])}`);
    flag.title = `${fmtInt(counts[BLOCKED])} of ${fmtInt(counted)} pairs are out of the funnel `
      + 'and sitting in a work queue.';
    lead.append(flag);
  }
  link.append(lead);

  const summary = bands
    .filter((b) => counts[b.id] > 0)
    .map((b) => `${b.label} ${fmtInt(counts[b.id])}`)
    .join(', ');
  link.title = `${ctx.name} / ${ctx.group} — ${summary || 'nothing counted'}. `
    + `${fmtInt(counted)} pages tracked. Opens the Page Tracker filtered to this cell.`;
  return link;
}

/** A header cell that carries its own explanation. `scope` is required, not implied. */
function headCell(el, cls, text, hint, scope) {
  const cell = el('th', cls, text);
  cell.scope = scope;
  if (hint) cell.title = hint;
  return cell;
}

/** The locale row header: the NATIVE name, then the code that keys every feed and tab. */
function localeHead(el, code) {
  const known = localeFor(code);
  const th = el('th', 'tm-locale');
  th.scope = 'row';
  th.append(el('span', 'tm-locale-native', known ? known.native : code));
  th.append(el('span', 'tm-locale-code', `/${code}`));
  if (known) th.title = `${known.name} (${known.native}) — /${code}`;
  return th;
}

/**
 * The board's legend, doubling as the site-wide band totals.
 *
 * One list, not two: a legend that also says how many pairs are in each band is the
 * cheapest way to make a bar of unfamiliar shades readable, and it puts the funnel's
 * own shape on the page for someone who has never seen this model before.
 */
function legend(el, bands, totals, view) {
  const wrap = el('div', 'tm-legend');
  const counts = bandCounts(totals, bands, view);
  const counted = num(totals.counted);
  for (const band of bands) {
    const item = el('span', 'tm-legend-item');
    const dot = el('span', 'tm-legend-dot');
    dot.dataset.band = band.id;
    item.append(dot);
    item.append(el('span', 'tm-legend-label', band.label));
    item.append(el('span', 'tm-legend-num', fmtInt(counts[band.id])));
    item.title = `${band.label}${band.hint ? ` — ${band.hint}` : ''} `
      + `(${fmtInt(counts[band.id])} of ${fmtInt(counted)} pairs)`;
    wrap.append(item);
  }
  return wrap;
}

/**
 * Provenance, stated rather than implied.
 *
 * `expected`/`listed`/`withheld` is not decoration: a feed that lists fewer pairs than
 * exist must say so, or a short feed reads as "we are nearly done" rather than "we
 * truncated". `incomplete` is the separate and worse fact — a group sheet the build
 * could not read at all contributes an UNKNOWN number of pairs, which the contract
 * forbids folding into `withheld` precisely because claiming otherwise makes a rollout
 * look further along than it is.
 */
function provenance(el, meta, generatedAt) {
  const wrap = el('div', 'tm-meta');
  const when = generatedAt ? new Date(generatedAt) : null;
  const stamp = when && !Number.isNaN(when.getTime())
    ? `Rolled up ${when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'Roll-up time unknown';
  wrap.append(el('p', 'tm-meta-line', `${stamp} · ${fmtInt(meta.locales)} locales `
    + `× ${fmtInt(meta.groups)} groups · ${fmtInt(meta.listed)} of ${fmtInt(meta.expected)} `
    + '(page, locale) pairs counted'));

  if (num(meta.withheld)) {
    wrap.append(el('p', 'tm-meta-line tm-meta-warn', `${fmtInt(meta.withheld)} pairs were `
      + 'withheld from this feed — drafts, sandbox pages and scaffold placeholders. A short '
      + 'feed is truncation, not progress.'));
  }
  if (num(meta['cells-withheld'])) {
    wrap.append(el('p', 'tm-meta-line', 'The feed\'s long-form detail tab was dropped at the '
      + 'size ceiling. This board reads the wide per-group tab, which survives, so the matrix '
      + 'is unaffected.'));
  }
  if (String(meta.incomplete || '').trim()) {
    wrap.append(el('p', 'tm-meta-line tm-meta-bad', '⚑ At least one group sheet could not be '
      + `read (${String(meta['groups-failed'] || 'unnamed')}). These numbers are an UNDERCOUNT `
      + 'by an unknown amount — an unread sheet is not a quantity we know.'));
  }
  return wrap;
}

/** A panel that says what was wanted, where it looked, and what to run. */
function panel(el, cls, heading, lines) {
  const box = el('div', `tm-panel ${cls}`);
  box.append(el('h3', 'tm-panel-title', heading));
  for (const line of lines) box.append(el('p', 'tm-panel-line', line));
  return box;
}

/** Authored warnings and feed defects, surfaced rather than silently dropped. */
function warningList(el, warnings) {
  const box = el('div', 'tm-warnings');
  box.append(el('h3', 'tm-warn-title', warnings.length === 1
    ? '1 thing on this board needs a look'
    : `${warnings.length} things on this board need a look`));
  const list = el('ul', 'tm-warn-list');
  for (const w of warnings) list.append(el('li', 'tm-warn-item', w));
  box.append(list);
  return box;
}

/**
 * Resolve the authored config against the registry and the feed.
 *
 * A typo in an authored cell is BAD DATA, not a crash and not an empty board: it names
 * what it could not match and what it accepted instead, then carries on with everything.
 */
function resolveConfig(cfg, feedGroups, warnings) {
  const wanted = listOf(cfg.locales).map((c) => c.toLowerCase());
  const codes = wanted.length ? TARGET_LOCALES.filter((c) => wanted.includes(c)) : TARGET_LOCALES;
  for (const code of wanted) {
    if (!TARGET_LOCALES.includes(code)) {
      warnings.push(`Authored \`locales\` names "${code}", which is not a target locale. `
        + `The ten are: ${TARGET_LOCALES.join(', ')}.`);
    }
  }
  if (wanted.length && !codes.length) {
    warnings.push('No authored locale matched the registry, so all ten are shown.');
  }

  const askedGroups = listOf(cfg.groups);
  const groups = askedGroups.length
    ? askedGroups.filter((g) => feedGroups.includes(g))
    : feedGroups;
  for (const g of askedGroups) {
    if (!feedGroups.includes(g)) {
      warnings.push(`Authored \`groups\` names "${g}", which the rollup does not carry. `
        + `It has: ${feedGroups.join(', ') || 'no groups at all'}.`);
    }
  }

  const rawView = String(cfg.view || '').trim().toLowerCase();
  let view = 'stages';
  if (rawView === 'buckets' || rawView === 'stages') view = rawView;
  else if (rawView) {
    warnings.push(`Authored \`view\` is "${rawView}"; the two views are \`stages\` and `
      + '`buckets`. Showing stages.');
  }

  return {
    codes: codes.length ? codes : TARGET_LOCALES,
    groups: groups.length ? groups : feedGroups,
    view,
  };
}

/** Group names in the order the rollup emitted them, deduplicated. */
function feedGroupNames(rows, warnings) {
  const seen = [];
  for (const row of rows) {
    const name = String(row?.group || '').trim();
    if (name && !seen.includes(name)) seen.push(name);
    if (!name) {
      warnings.push('The rollup carries a row with no `group` — it cannot be placed '
      + 'in the matrix and is not counted here.');
    }
  }
  return seen;
}

export default async function init(block) {
  const { el } = dom(block);
  const cfg = readConfig(block);
  block.textContent = '';

  const data = await loadTxRollup();

  if (data.missing) {
    block.append(panel(el, 'tm-panel-error', 'No translation roll-up yet', [
      `This board reads ${FEEDS.txRollup}, which did not answer (${data.error || 'unknown error'}).`,
      'That is the expected state until the pipeline has run once: nothing is translated, '
      + 'and the feed is written by the roll-up build rather than by hand.',
      'To populate it: `npm run group:scaffold --apply` for each group, then '
      + '`npm run group:sync --apply`, then `npm run tx:scan --apply`, then `npm run rollup`.',
    ]));
    return;
  }

  const warnings = [];
  const groupRows = data.groups || [];
  const allGroups = feedGroupNames(groupRows, warnings);
  const { codes, groups, view } = resolveConfig(cfg, allGroups, warnings);
  const vocab = vocabulary(data.stages);
  const bands = bandsFor(view, vocab);

  if (!groupRows.length || !groups.length) {
    block.append(panel(el, 'tm-panel-empty', 'The roll-up is built but describes no groups', [
      `${FEEDS.txRollup} answered, and its per-group tab is empty — so there is nothing to `
      + 'put in a cell. A built feed with no rows means the group sheets exist but hold no '
      + 'pages, or no group sheet could be read at all.',
      'Run `npm run group:sync --apply` to seed the sheets from the query index, then '
      + '`npm run rollup`.',
    ]));
    if (warnings.length) block.append(warningList(el, warnings));
    return;
  }

  /*
   * Index by (locale, group) so a missing row reads as an empty cell rather than
   * shortening the matrix. The matrix is always ten locales wide because the registry
   * says so — never as wide as whatever the feed happened to carry.
   */
  const byCell = new Map();
  for (const row of groupRows) {
    const code = String(row?.locale || '').trim().toLowerCase();
    if (code && !TARGET_LOCALES.includes(code)) {
      warnings.push(`The rollup carries locale "${code}", which is not in the registry — its `
        + 'rows are not shown. Either the registry or the build is wrong.');
    }
    byCell.set(cellKey(code, String(row?.group || '')), row);
  }
  /*
   * `undefined` for an absent row, deliberately not `{}` — see `cellBody`. A summed
   * total treats a missing row as zeros (`sumRows` reads absent columns as 0), but a CELL
   * has to be able to say "the feed does not describe this" rather than "there is nothing
   * here".
   */
  const cellFor = (code, group) => byCell.get(cellKey(code, group));

  const localeTotals = new Map(
    (data.locales || []).map((row) => [String(row?.locale || '').trim().toLowerCase(), row]),
  );

  // Column totals are summed from the cells, row totals come off the `locales` tab —
  // the published per-locale aggregate, which is the number the rest of the tracker
  // quotes. Summing a row here as well would be a second opinion about one figure.
  const columnTotals = new Map(groups.map((g) => [g, sumRows(codes.map((c) => cellFor(c, g)))]));
  const grandTotal = sumRows(codes.map((c) => localeTotals.get(c) || {}));

  const absentLocales = codes.filter((c) => !groups.some((g) => cellFor(c, g)));
  if (absentLocales.length) {
    warnings.push(`The roll-up describes no groups at all for ${absentLocales.join(', ')}. `
      + 'Those rows read `?` rather than zero — the build either skipped them or could not '
      + 'read a sheet. Check `meta.groups-failed` on the feed.');
  }

  const anythingSent = codes.some((c) => sentOnward(localeTotals.get(c) || {}))
    || groups.some((g) => sentOnward(columnTotals.get(g)));

  if (!anythingSent) {
    block.append(panel(el, 'tm-panel-notice', 'Nothing sent for translation yet', [
      'Every pair below sits at the English gate — the pages exist and are published, and '
      + 'no locale has been asked for. That is inventory, not progress.',
      'Run `npm run tx:send` (it defaults to a dry run and prints a plan) to hand a group '
      + 'to the translation service. The matrix fills in from `npm run tx:scan`, which '
      + 're-observes both hosts, and `npm run rollup`.',
    ]));
  }

  const scroll = el('div', 'tm-scroll');
  const table = el('table', 'tm-table');
  table.append(el('caption', 'tm-caption', view === 'buckets'
    ? 'Translation progress bands, by locale and page group'
    : 'Funnel stage, by locale and page group'));

  const thead = el('thead');
  const headRow = el('tr');
  headRow.append(headCell(
    el,
    'tm-corner',
    'Locale',
    'The ten target locales, in registry order. Native name, then the path prefix.',
    'col',
  ));
  for (const group of groups) {
    // The denominator is constant down a column — every locale expects the same pages —
    // so it belongs in the header once rather than in ten cells.
    const perLocale = Math.round(num(columnTotals.get(group).counted) / (codes.length || 1));
    const hint = `${fmtInt(perLocale)} pages tracked in ${group}, expected in each of `
      + `${codes.length} locales.`;
    const th = headCell(el, 'tm-group', group, hint, 'col');
    th.append(el('span', 'tm-group-den', `${fmtInt(perLocale)} pages`));
    headRow.append(th);
  }
  headRow.append(headCell(
    el,
    'tm-group tm-group-all',
    'All groups',
    'From the roll-up\'s own per-locale aggregate, not summed from the cells.',
    'col',
  ));
  thead.append(headRow);
  table.append(thead);

  const tbody = el('tbody');
  for (const code of codes) {
    const known = localeFor(code);
    const name = known ? known.name : code;
    const tr = el('tr');
    tr.append(localeHead(el, code));
    for (const group of groups) {
      const td = el('td', 'tm-cell');
      td.append(cellBody(el, cellFor(code, group), {
        bands,
        view,
        group,
        name,
        href: pageTrackerUrl({ group, locale: code }),
      }));
      tr.append(td);
    }
    const td = el('td', 'tm-cell tm-cell-all');
    td.append(cellBody(el, localeTotals.get(code) || {}, {
      bands, view, group: 'all groups', name, href: pageTrackerUrl({ locale: code }),
    }));
    tr.append(td);
    tbody.append(tr);
  }
  table.append(tbody);

  const tfoot = el('tfoot');
  const footRow = el('tr');
  footRow.append(headCell(
    el,
    'tm-locale tm-locale-all',
    'All locales',
    'Every locale in this board, summed.',
    'row',
  ));
  for (const group of groups) {
    const td = el('td', 'tm-cell');
    td.append(cellBody(el, columnTotals.get(group), {
      bands, view, group, name: 'all locales', href: pageTrackerUrl({ group }),
    }));
    footRow.append(td);
  }
  const allTd = el('td', 'tm-cell tm-cell-all');
  allTd.append(cellBody(el, grandTotal, {
    bands, view, group: 'all groups', name: 'all locales', href: pageTrackerUrl({}),
  }));
  footRow.append(allTd);
  tfoot.append(footRow);
  table.append(tfoot);

  scroll.append(table);
  block.append(scroll);
  block.append(legend(el, bands, grandTotal, view));
  if (warnings.length) block.append(warningList(el, warnings));
  block.append(provenance(el, data.meta || {}, data.generatedAt));
}
