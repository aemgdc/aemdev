/*
 * group-progress — the per-group breakdown for /tracker/.
 *
 * One row per content group, one column per funnel position, read from `rollup.json`'s
 * `groups` tab. A caret on the group name expands one line per SUBGROUP, in the same
 * columns, from the `subgroups` tab.
 *
 * ─── Why the columns to the right are dim ───────────────────────────────────
 *
 * `rollup.json` is the ENGLISH side, and it tallies each page against an EMPTY locale
 * row on purpose — which is exactly what `classifyTranslation` reads as "no row in that
 * locale", so it falls through to the English gate. The consequence is structural: only
 * `Catalogued` and `EN published` can ever be non-zero here. The other seven columns
 * are drawn because the funnel is nine positions wide and hiding two thirds of it would
 * teach the reader a shorter model than the one they have to work with — but they are
 * dimmed and captioned, because seven columns of zeroes with no explanation reads as a
 * pipeline that has stalled rather than as a feed answering a different question.
 *
 * ─── The subgroup accordion, and when it must refuse to open ────────────────
 *
 * Two properties make the breakdown trustworthy, and both are enforced upstream in
 * `build-rollup.mjs` rather than here: the parts always re-add to the closed row PER
 * COLUMN, `(unassigned)` included; and the tab is dropped WHOLE, never trimmed, when
 * the published-feed size ceiling bites. This block's job is to honour the second one.
 * `meta['subgroups-complete']` goes blank when the tab was dropped, and a blank there
 * with authored subgroups on the group rows means the breakdown is GONE, not empty — so
 * the carets do not render at all and the board says why. A partial breakdown that
 * disagrees with the row it opens from is worse than no breakdown: the reader checks the
 * arithmetic by hand, finds it wrong, and stops believing the closed row too.
 *
 * `(unassigned)` sorts LAST regardless of size, via `compareSubgroups` in
 * scripts/tracker/subgroups.js. Early on most rows are unclassified, so size-sorting
 * would put the residue on top and bury the labels somebody actually authored — which
 * is the whole reason the column exists.
 */
import { loadRollup } from '../../scripts/tracker/data.js';
import { PAGE_STAGES, PROGRESS_BUCKETS, bucketForStage } from '../../scripts/tracker/stages.js';
import { FEEDS, pageTrackerUrl } from '../../scripts/tracker/paths.js';
import { compareSubgroups, isAssigned, subgroupSlug } from '../../scripts/tracker/subgroups.js';
import { dom, fmtInt, fmtPct } from '../../scripts/tracker/block-utils.js';

/** A DA sheet cell is text, so every number on this board arrives as a string. */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/*
 * The columns the English feed can populate. Derived from the model, not listed: the
 * two English-side stages are exactly those whose progress band is one of the first
 * two, so adding a stage before the gate cannot leave this dimming rule behind.
 */
const ENGLISH_BANDS = new Set(PROGRESS_BUCKETS.slice(0, 2).map((b) => b.id));
const isEnglishSide = (stageId) => ENGLISH_BANDS.has(bucketForStage(stageId));

const ENGLISH_CAPTION = 'Only the first two columns can be non-zero on this board. It '
  + 'reads the English feed, which pairs every page with an empty locale row, so the '
  + 'seven dimmed columns are structurally zero here rather than stalled — the per-locale '
  + 'funnel lives in the translation feed.';

const DROPPED_SUBGROUPS = 'The subgroup breakdown was DROPPED from this feed, whole. '
  + 'The published index has a hard size ceiling, and when it bites the build removes '
  + 'the subgroups tab entirely rather than trimming it — a partial breakdown would not '
  + 're-add to the group row it opens from, and a reader who checks that by hand and '
  + 'finds it wrong has no reason to trust the closed row either. Rebuild with a higher '
  + '--max-bytes, or read the breakdown in the Page Tracker app.';

export default async function init(block) {
  const { el } = dom(block);

  const note = (text) => el('p', 'gp-note', text);
  const warnNote = (text) => el('p', 'gp-note gp-note-warn', text);

  const link = (href, text, title) => {
    const a = el('a', null, text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    if (title) a.title = title;
    return a;
  };

  /**
   * A count cell.
   *
   * A zero is rendered as a muted zero rather than a dash. These columns PARTITION —
   * they add up to the pages counted — so an em dash would read as "not applicable"
   * when the honest answer is "none of them are here". The dash is reserved for a
   * figure that has no denominator at all.
   */
  const countCell = (n, cls) => {
    const value = num(n);
    const td = el('td', `gp-num${value ? '' : ' gp-zero'}${cls ? ` ${cls}` : ''}`);
    td.append(el('b', null, fmtInt(value)));
    return td;
  };

  /** The `n / total` cell that carries the row's denominator. */
  const totalCell = (counted, total) => {
    const td = el('td', 'gp-num gp-total');
    td.append(el('b', null, fmtInt(counted)));
    if (num(total) !== num(counted)) {
      // The gap is rows the tally saw and did not count — a draft, a sandbox page, a
      // scaffold placeholder. Shown rather than smoothed over: it is the difference
      // between this board's denominator and the sheet's row count.
      const of = el('span', 'gp-of', `/${fmtInt(total)}`);
      of.title = `${fmtInt(total)} rows on the sheet, ${fmtInt(counted)} of them countable pages`;
      td.append(of);
    }
    return td;
  };

  /** The nine stage cells plus blocked, for any row shaped like a tally. */
  const stageCells = (row) => {
    const cells = PAGE_STAGES.map((stage) => (
      countCell(row[stage.id], isEnglishSide(stage.id) ? null : 'gp-downstream')
    ));
    cells.push(countCell(row.blocked, 'gp-blocked'));
    return cells;
  };

  /**
   * The group name cell: a caret (only when there is a breakdown behind it), a link into
   * the Page Tracker app, and the authored-subgroup count.
   *
   * The name stays a link and the caret is a separate button rather than making the
   * whole name a disclosure: most groups will have no subgroups at all, and collapsing
   * the two would put the app one extra click away for every group on the board to buy
   * a breakdown that most of them do not have.
   */
  const nameCell = (group, authored, expandable) => {
    const td = el('td', 'gp-name');
    let toggle = null;
    if (expandable) {
      toggle = el('button', 'gp-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      const label = `Break ${group} down into its ${authored} subgroup`
        + `${authored === 1 ? '' : 's'}`;
      toggle.title = label;
      toggle.setAttribute('aria-label', label);
      toggle.append(el('span', 'gp-caret', '▸'));
      td.append(toggle);
    }
    td.append(link(
      pageTrackerUrl({ group }),
      group,
      `Open ${group} in the Page Tracker app`,
    ));
    if (authored) {
      const chip = el('span', 'gp-subcount', String(authored));
      chip.title = `${authored} subgroup${authored === 1 ? '' : 's'} authored on this sheet`;
      td.append(chip);
    }
    return { td, toggle };
  };

  /**
   * One expanded line per subgroup, as SIBLING rows of the same table.
   *
   * Not a nested table in a colspan cell: the parent table is auto-layout, so a nested
   * one cannot be made to line up with it, and a breakdown whose figures sit a few
   * pixels off the column they belong to invites exactly the hand-check that the sum
   * invariant exists to make unnecessary. Rows of the same table align by construction.
   */
  const subgroupRows = (group, rows) => rows
    /*
     * Empty buckets are dropped. A bucket contributing 0 to every column says nothing,
     * and `(unassigned)` is the usual source of one — the rollup carries that bucket
     * for every group, including the groups where every page is classified. Safe for
     * the sum property by definition: a row of zeroes cannot change a total.
     */
    .filter((sg) => num(sg.counted) > 0 || num(sg.total) > 0)
    .map((sg) => {
      const name = String(sg.subgroup ?? '');
      const tr = el('tr', `gp-subrow${isAssigned(name) ? '' : ' gp-residue'}`);
      tr.hidden = true;
      const nameTd = el('td', 'gp-sub-name');
      /*
       * `(unassigned)` links too. `?sub-group=unassigned` is a real selection and it is
       * how somebody finds the pages nobody has classified yet — which, early on, is
       * most of them.
       */
      nameTd.append(link(
        pageTrackerUrl({ group, subGroup: sg.slug || subgroupSlug(name) }),
        name,
        `Open the ${name} pages of ${group} in the Page Tracker app`,
      ));
      tr.append(nameTd, totalCell(sg.counted, sg.total), ...stageCells(sg));
      return tr;
    });

  block.textContent = '';
  const rollup = await loadRollup();

  /*
   * The missing-feed state. Short here on purpose: `tracker-summary` owns the full
   * bootstrap sequence and sits above this block on the same page, so repeating the
   * four commands would put a second copy of them one scroll apart — and two copies of
   * an instruction is how one of them comes to be wrong.
   */
  if (rollup.missing) {
    const panel = el('section', 'gp-missing');
    panel.append(el('h3', 'gp-missing-head', 'No group breakdown yet'));
    const lede = 'This board reads one published feed and it does not exist. Nothing '
      + 'has been built, which is the expected state until the pipeline has run — it is '
      + 'not a rendering failure and it is not a report that every group is at zero.';
    panel.append(el('p', 'gp-missing-lede', lede));
    panel.append(el('dl', 'gp-missing-feed'));
    const dl = panel.querySelector('.gp-missing-feed');
    dl.append(el('dt', 'gp-missing-path', FEEDS.rollup));
    const dd = el('dd');
    dd.append(el('code', 'gp-missing-error', rollup.error || 'no response recorded'));
    dl.append(dd);
    panel.append(el('p', 'gp-missing-run', 'Build it with `npm run rollup`, then preview '
      + 'the feed in DA. The full first-time sequence is on the summary board above.'));
    block.append(panel);
    return;
  }

  const groups = rollup.groups || [];
  if (!groups.length) {
    block.append(warnNote(
      `${FEEDS.rollup} exists but lists no groups. A group only appears here once its `
      + 'sheet has been scaffolded and seeded — `npm run group:scaffold -- --group=<name> '
      + '--apply`, then `npm run group:sync -- --apply`. An empty groups tab is a build '
      + 'that read no sheets, not a site with no pages.',
    ));
    return;
  }

  /*
   * Was the subgroups tab dropped, or was there never anything in it?
   *
   * `subgroups-complete` is blank in both cases — the ceiling dropped it, or the build
   * was told not to emit it, or the rollup predates the tab. So the blank alone is not
   * enough to accuse the feed of hiding something: it is only a DROP when the group
   * rows themselves claim authored subgroups that the tab does not account for. Getting
   * this wrong in the loud direction would put a permanent warning on a board where
   * nobody has ever typed a subgroup, which trains the reader to ignore it.
   */
  const meta = rollup.meta || {};
  const complete = String(meta['subgroups-complete'] || '').trim().toLowerCase() === 'yes';
  const authoredTotal = groups.reduce((n, g) => n + num(g.subgroups), 0);
  const subgroupsDropped = !complete && authoredTotal > 0;

  const subsByGroup = new Map();
  if (!subgroupsDropped) {
    for (const row of rollup.subgroups || []) {
      const key = String(row.group ?? '');
      if (!subsByGroup.has(key)) subsByGroup.set(key, []);
      subsByGroup.get(key).push(row);
    }
    // The feed's own order is not a promise: it survives a DA round trip only by luck,
    // and the residue-last rule is load-bearing. Re-apply the model's comparator.
    for (const rows of subsByGroup.values()) {
      rows.sort((a, b) => compareSubgroups(
        { name: String(a.subgroup ?? ''), size: num(a.counted) },
        { name: String(b.subgroup ?? ''), size: num(b.counted) },
      ));
    }
  }

  const table = el('table', 'gp-table');
  const thead = el('thead');
  const htr = el('tr');
  htr.append(el('th', 'gp-name', 'Group'));
  const pagesTh = el('th', 'gp-num', 'Pages');
  pagesTh.title = 'Countable pages in this group';
  htr.append(pagesTh);
  for (const stage of PAGE_STAGES) {
    // The tight `short` label, because nine columns of prose headings do not fit. It is
    // the same label the Page Tracker app uses, and the primer explains the mapping.
    const th = el('th', `gp-num${isEnglishSide(stage.id) ? '' : ' gp-downstream'}`, stage.short);
    th.title = `${stage.label} — ${stage.hint}`;
    htr.append(th);
  }
  const blockedTh = el('th', 'gp-num gp-blocked', 'BLK');
  blockedTh.title = 'Blocked — out of the funnel entirely, sitting in a work queue';
  htr.append(blockedTh);
  thead.append(htr);

  const tbody = el('tbody');
  // Biggest group first. Sorting by name buries whatever is actually in flight, and the
  // group with no pages yet (a scaffolded sheet nobody has seeded) belongs at the bottom.
  const ordered = [...groups].sort((a, b) => num(b.counted) - num(a.counted)
    || String(a.group ?? '').localeCompare(String(b.group ?? '')));

  for (const g of ordered) {
    const group = String(g.group ?? '');
    const subRows = subsByGroup.get(group) || [];
    /*
     * The caret is gated on the group row's own AUTHORED count, not on `subRows.length`:
     * `(unassigned)` is a row in that tab for every group, so a group nobody has
     * classified still has one subgroup row and must render with no caret at all.
     */
    const authored = num(g.subgroups);
    const built = authored > 0 && !subgroupsDropped ? subgroupRows(group, subRows) : [];
    const { td, toggle } = nameCell(group, authored, built.length > 0);

    const tr = el('tr', 'gp-row');
    tr.append(td, totalCell(g.counted, g.total), ...stageCells(g));
    tbody.append(tr);

    if (!toggle) continue; // eslint-disable-line no-continue

    /*
     * Built eagerly and hidden rather than on first expand. The board is four groups
     * with a handful of subgroups each, so lazy construction saves nothing and eager
     * construction buys a real property: the rows are in the document, so they are
     * findable by anything that searches the page, and expanding is a `hidden` flip
     * that cannot half-fail.
     */
    built.forEach((row, i) => {
      row.id = `gp-sub-${subgroupSlug(group)}-${i}`;
      tbody.append(row);
    });
    toggle.setAttribute('aria-controls', built.map((r) => r.id).join(' '));
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      toggle.querySelector('.gp-caret').textContent = open ? '▸' : '▾';
      for (const row of built) row.hidden = open;
    });
  }
  table.append(thead, tbody);
  block.append(table);

  block.append(note(ENGLISH_CAPTION));

  if (subgroupsDropped) {
    block.append(warnNote(DROPPED_SUBGROUPS));
  }

  /*
   * Invariant (a) per group: the funnel plus blocked accounts for every counted page.
   * `build-rollup` asserts it and writes nothing when it fails, so a violation here
   * means the feed was edited in DA afterwards — and the row would still render, quite
   * plausibly, while being wrong.
   */
  const broken = ordered.filter((g) => {
    const sum = PAGE_STAGES.reduce((n, s) => n + num(g[s.id]), 0) + num(g.blocked);
    return num(g.counted) !== sum;
  });
  if (broken.length) {
    block.append(warnNote(
      `${broken.length} group row(s) do not add up: ${broken.map((g) => g.group).join(', ')}. `
      + 'The build asserts that the funnel plus blocked equals the pages counted, so '
      + `${FEEDS.rollup} has been edited since it was generated. Rebuild before reading `
      + 'these rows.',
    ));
  }

  const totalPages = ordered.reduce((n, g) => n + num(g.counted), 0);
  const published = ordered.reduce((n, g) => n + num(g.enPublished), 0);
  block.append(note(
    `${fmtInt(published)} of ${fmtInt(totalPages)} tracked pages are published in English `
    + `(${fmtPct(published, totalPages)}) — that is the gate every locale waits on.`,
  ));

  if (rollup.generatedAt) {
    const when = new Date(rollup.generatedAt).toLocaleString();
    block.append(el('p', 'gp-stamp', `Feed generated ${when}`));
  }
}
