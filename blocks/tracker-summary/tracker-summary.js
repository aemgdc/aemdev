/*
 * tracker-summary — the top-line board for /tracker/.
 *
 * Two feeds, one fetch each (memoised in data.js, so several blocks on this page share
 * them): `rollup.json` for the English side and `tx-rollup.json` for the ten locales.
 *
 * ─── THE EMPTY STATE IS THE PRIMARY STATE ───────────────────────────────────
 *
 * Today both feeds 404 and every locale tree is empty, so the state this board renders
 * in practice is "nothing has been built yet". That is designed FIRST here, not patched
 * on: a board that draws a blank area when its feed is missing has failed at the only
 * job it had, because the reader cannot tell "the pipeline has not run" from "the page
 * is broken" from "we are done and everything is zero".
 *
 * So a missing feed renders a panel that says three things, in this order: what it
 * wanted (the feed path, and the UNIT that feed aggregates), what it got (the literal
 * error string from the data layer, status code and all), and what to run to fix it.
 * `data.js` returns `missing` and `error` alongside a zeroed shape precisely so this is
 * possible without a try/catch that cannot tell a 404 from a parse failure.
 *
 * ─── THE UNIT PROBLEM ───────────────────────────────────────────────────────
 *
 * The two feeds count different things, and putting their numbers side by side without
 * saying so invites the one mistake that makes the board lie: adding them. The English
 * rollup counts PAGES. The translation rollup counts (page, locale) PAIRS — ten times
 * as many. Every figure below carries its unit for that reason, and the progress bar is
 * explicitly over pairs.
 *
 * It also means the English side of `rollup.json` can only ever show `catalogued` and
 * `enPublished`: it pairs each page with an EMPTY locale row on purpose, so the two KPI
 * tiles are the whole of what that feed can honestly say. Everything downstream of the
 * gate comes from the translation feed.
 */
import { loadRollup, loadTxRollup } from '../../scripts/tracker/data.js';
import { PROGRESS_BUCKETS } from '../../scripts/tracker/stages.js';
import { TARGET_LOCALES, locale as localeFor } from '../../scripts/tracker/locales.js';
import { FEEDS, pageTrackerUrl } from '../../scripts/tracker/paths.js';
import { dom, fmtInt, fmtPct } from '../../scripts/tracker/block-utils.js';

/*
 * The `b_` prefix is the feed's, not ours: `online` is both a PAGE_STAGES id and a
 * PROGRESS_BUCKETS id, so the locale rows carry the bucket columns prefixed to stop one
 * column name from having two meanings in one row. Spelled once, here.
 */
const bucketColumn = (id) => `b_${id}`;

/** A DA sheet cell is text, so every number on this board arrives as a string. */
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * What each feed is FOR, in the words the empty state needs.
 *
 * `unit` is what the feed counts, and it lives here rather than inline because the
 * empty panel, the withheld note and the bar caption all have to use the same word —
 * otherwise the board teaches the reader that two different denominators are one.
 */
const FEED_INFO = [
  {
    key: 'rollup',
    path: FEEDS.rollup,
    unit: 'pages',
    what: 'the English side: how many pages are tracked, and how many are published',
  },
  {
    key: 'tx',
    path: FEEDS.txRollup,
    unit: '(page, locale) pairs',
    what: `the translation side: one row per locale, over all ${TARGET_LOCALES.length} of them`,
  },
];

/*
 * The commands that produce those feeds, in the order they have to run.
 *
 * Spelled as the package scripts rather than the tool paths, because that is what
 * somebody can paste. Every writing tool defaults to `--dry-run` and prints a plan, so
 * `--apply` is shown deliberately: leaving it off would make these instructions look
 * like they had failed.
 */
const BOOTSTRAP = [
  ['npm run group:scaffold -- --group=<name> --apply', 'create the group sheet, once per group'],
  ['npm run group:sync -- --apply', 'seed the pages from /en/query-index.json'],
  ['npm run tx:scan -- --apply', 'crawl both hosts and record what actually answers'],
  ['npm run rollup', 'build and publish both feeds'],
];

const PREVIEW_CAVEAT = 'The feeds are documents in DA under /tracker/data/, so they also '
  + 'have to be PREVIEWED before this page can read them — a built-but-unpreviewed feed '
  + '404s here exactly like one that was never built.';

const ENGLISH_CEILING = 'These two figures are the whole of what the English feed can '
  + 'say. It pairs every page with an empty locale row, so nothing downstream of "EN '
  + 'published" is ever non-zero there; the translation feed below is where the funnel '
  + 'lives.';

export default async function init(block) {
  const { el } = dom(block);

  /** Prose about the figures above it. One argument, so it wraps without ceremony. */
  const note = (text) => el('p', 'ts-note', text);

  /** A shortfall we can quantify: the feed left rows out and said how many. */
  const withheldNote = (text) => el('p', 'ts-note ts-note-withheld', text);

  /** A shortfall we CANNOT quantify, or an invariant that failed. Louder on purpose. */
  const warnNote = (text) => el('p', 'ts-note ts-note-incomplete', text);

  /** An anchor. Every target here is an external app, so `noopener` is unconditional. */
  const link = (href, text, title) => {
    const a = el('a', null, text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    if (title) a.title = title;
    return a;
  };

  /**
   * One KPI tile.
   *
   * `unit` is not optional. Two tiles reading 19 and 190 with nothing marking the
   * change of denominator between them is the most likely misreading of this board.
   */
  const kpi = ({
    label, value, unit, href, title,
  }) => {
    const tile = el('div', 'ts-kpi');
    const shown = fmtInt(value);
    const figure = href ? link(href, shown, title) : el('span', null, shown);
    const zero = num(value) === 0 ? ' ts-kpi-zero' : '';
    const wrap = el('span', `ts-kpi-value${zero}`);
    wrap.append(figure);
    tile.append(wrap, el('span', 'ts-kpi-label', label), el('span', 'ts-kpi-unit', unit));
    return tile;
  };

  /**
   * The panel a missing feed renders instead of nothing.
   *
   * @param {object[]} absent the FEED_INFO entries that could not be read
   * @param {object} errors   keyed by FEED_INFO.key — the data layer's own message
   */
  const missingPanel = (absent, errors) => {
    const panel = el('section', 'ts-missing');
    const both = absent.length === FEED_INFO.length;
    const head = both
      ? 'No tracker feed has been published yet'
      : `Missing feed: ${absent.map((f) => f.unit).join(', ')}`;
    const lede = both
      ? 'This board reads two published feeds and neither one exists. That is the '
        + 'expected state until the pipeline has been run over a group — it is not a '
        + 'rendering failure, and it is not a report that everything is at zero.'
      : 'The figures that feed would produce are left out below rather than shown as '
        + 'zeroes, because a zero and a missing denominator are different facts.';
    panel.append(el('h3', 'ts-missing-head', head), el('p', 'ts-missing-lede', lede));

    const list = el('dl', 'ts-missing-feeds');
    for (const feed of absent) {
      list.append(el('dt', 'ts-missing-path', feed.path));
      const dd = el('dd');
      dd.append(el('span', 'ts-missing-what', `Wanted ${feed.what}. Unit: ${feed.unit}.`));
      // The literal string from data.js — it carries the status code, and "404" versus
      // "Unexpected token" is the difference between "not built" and "built wrong".
      dd.append(el('code', 'ts-missing-error', errors[feed.key] || 'no response recorded'));
      list.append(dd);
    }
    panel.append(list);

    panel.append(el('p', 'ts-missing-run', 'To populate it, from the repo root:'));
    const steps = el('ol', 'ts-missing-steps');
    for (const [cmd, why] of BOOTSTRAP) {
      const li = el('li');
      li.append(el('code', 'ts-cmd', cmd), el('span', 'ts-cmd-why', why));
      steps.append(li);
    }
    panel.append(steps, note(PREVIEW_CAVEAT));
    return panel;
  };

  /**
   * The stacked bar over the eight progress bands, plus a final blocked segment.
   *
   * The bands partition the pairs that are ON the line; a blocked pair is in no band at
   * all. So the bar is drawn to the full COUNTED width with blocked making up the
   * difference — which means a bar that does not reach the right-hand edge is telling
   * the reader something rather than failing to lay out.
   */
  const bar = (counts, blocked, counted, label) => {
    const wrap = el('div', 'ts-bar');
    const segments = [
      ...PROGRESS_BUCKETS.map((b) => ({ id: b.id, label: b.label, n: counts[b.id] || 0 })),
      { id: 'blocked', label: 'Blocked (in a work queue)', n: blocked },
    ];
    const spoken = segments.filter((s) => s.n).map((s) => `${s.label}: ${s.n}`).join(', ');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', `${label} — ${spoken || 'nothing counted yet'}`);
    if (!counted) {
      wrap.classList.add('ts-bar-empty');
      return wrap;
    }
    // Zero-width segments are dropped rather than drawn: they are invisible and
    // unhoverable, so the only thing they add is an empty flex child between two real
    // ones — and a `title` nobody can reach is not a tooltip.
    for (const seg of segments.filter((s) => s.n)) {
      const node = el('div', 'ts-seg');
      node.dataset.bucket = seg.id;
      node.style.flexGrow = String(seg.n);
      node.title = `${seg.label}: ${fmtInt(seg.n)} of ${fmtInt(counted)} `
        + `(${fmtPct(seg.n, counted)})`;
      wrap.append(node);
    }
    return wrap;
  };

  const legend = (counts, blocked, counted) => {
    const ul = el('ul', 'ts-legend');
    const items = [
      ...PROGRESS_BUCKETS.map((b) => ({ id: b.id, label: b.label, n: counts[b.id] || 0 })),
      { id: 'blocked', label: 'Blocked', n: blocked },
    ];
    for (const item of items) {
      const li = el('li', item.n ? null : 'ts-legend-zero');
      const swatch = el('span', 'ts-swatch');
      swatch.dataset.bucket = item.id;
      li.append(
        swatch,
        el('span', 'ts-legend-label', item.label),
        el('b', 'ts-legend-n', fmtInt(item.n)),
        el('span', 'ts-legend-pct', fmtPct(item.n, counted)),
      );
      ul.append(li);
    }
    return ul;
  };

  /** One locale row: native name, a mini bar, and the two figures worth reading. */
  const localeRow = (row) => {
    const code = String(row.locale || '').trim();
    const known = localeFor(code);
    const counted = num(row.counted);
    const counts = Object.fromEntries(
      PROGRESS_BUCKETS.map((b) => [b.id, num(row[bucketColumn(b.id)])]),
    );
    const blocked = num(row.blocked);
    /*
     * "In flight" is everything past the English gate. The two English-side bands are
     * facts about the SOURCE page and are identical in all ten locales, so counting
     * them as this locale's progress would show ten rows of apparent movement on a site
     * where nothing has been translated. The gap between `counted` and those two bands
     * is the honest measure of what has actually left for translation.
     */
    const inFlight = Math.max(0, counted - counts.catalogued - counts.enPublished);

    const tr = el('tr', 'ts-locale-row');
    const name = el('td', 'ts-locale-name');
    const label = known ? known.name : code;
    const appLink = link(
      pageTrackerUrl({ locale: code }),
      known ? known.native : code,
      `Open ${label} in the Page Tracker app`,
    );
    name.append(
      appLink,
      el('span', 'ts-locale-en', known ? known.name : 'unknown locale'),
      el('span', 'ts-locale-code', code),
    );

    const barCell = el('td', 'ts-locale-bar');
    barCell.append(bar(counts, blocked, counted, label));

    const flight = el('td', 'ts-locale-num');
    flight.append(el('b', null, fmtInt(inFlight)), el('span', 'ts-of', `/${fmtInt(counted)}`));
    flight.title = `${inFlight} of ${counted} pairs have moved past the English gate`;

    const online = el('td', 'ts-locale-num ts-locale-online');
    online.append(
      el('b', null, fmtInt(counts.online)),
      el('span', 'ts-of', ` ${fmtPct(counts.online, counted)}`),
    );
    online.title = `${counts.online} of ${counted} pairs are answering on the live host`;

    tr.append(name, barCell, flight, online);
    return tr;
  };

  /**
   * The honesty notes for one feed, in the order they matter. Nothing to say appends
   * nothing — this never returns a reassurance.
   *
   * `withheld` and `incomplete` are deliberately kept apart. `withheld` is a quantity
   * the build KNOWS it left out; `incomplete` means a group sheet could not be read at
   * all and contributed an UNKNOWN number of rows. The data contract forbids folding
   * the second into the first, because an understated denominator makes a rollout look
   * further along than it is — so they get separate sentences here too.
   */
  const shortfallNotes = (meta, unit, path) => {
    const out = [];
    const withheld = num(meta.withheld);
    const expected = num(meta.expected);
    const listed = num(meta.listed);
    if (withheld > 0) {
      out.push(withheldNote(
        `${fmtInt(withheld)} of ${fmtInt(expected)} ${unit} were WITHHELD from ${path}: `
        + `it lists ${fmtInt(listed)}. Every figure above is over those ${fmtInt(listed)}, `
        + 'so this board is short by a known amount — a draft, a sandbox page or a '
        + 'scaffold placeholder — rather than further along than it looks.',
      ));
    }
    if (String(meta.incomplete || '').toLowerCase() === 'yes') {
      const failed = String(meta['groups-failed'] || '').trim();
      out.push(warnNote(
        `A group sheet could not be read when ${path} was built${failed ? `: ${failed}` : ''}. `
        + 'That is an UNKNOWN number of missing rows, not a withheld one, so the '
        + 'denominator above is understated by an amount nobody can state. Treat every '
        + 'figure on this board as a lower bound until the build runs clean.',
      ));
    }
    return out;
  };

  block.textContent = '';
  const [rollup, tx] = await Promise.all([loadRollup(), loadTxRollup()]);

  const errors = { rollup: rollup.error, tx: tx.error };
  const absent = FEED_INFO.filter((f) => (f.key === 'rollup' ? rollup.missing : tx.missing));
  if (absent.length === FEED_INFO.length) {
    block.append(missingPanel(absent, errors));
    return;
  }

  /* --------------------------------------------------------------- the English KPIs */

  /*
   * Each feed gets its own panel when it is the one that is absent. An `if (!missing)`
   * with no else was the first shape here and it silently rendered NOTHING for the
   * English side when only `rollup.json` was gone — the same blank-area failure this
   * whole board exists to avoid, reached by a different route.
   */
  if (rollup.missing) {
    block.append(missingPanel(FEED_INFO.filter((f) => f.key === 'rollup'), errors));
  } else {
    const totals = rollup.totals || {};
    const kpis = el('div', 'ts-kpis');
    kpis.append(
      kpi({
        label: 'Pages tracked',
        value: num(totals.counted),
        unit: 'English pages',
        href: pageTrackerUrl(),
        title: 'Open the Page Tracker app',
      }),
      kpi({
        label: 'EN published',
        value: num(totals.enPublished),
        unit: 'ready to translate from',
        href: pageTrackerUrl({ filter: 'en-published' }),
        title: 'Open the Page Tracker app, filtered to published English pages',
      }),
    );
    if (!tx.missing) {
      // The pair count is the translation feed's denominator, and it belongs in the KPI
      // row so the change of unit is visible BEFORE the bar rather than under it.
      kpis.append(kpi({
        label: 'Pairs tracked',
        value: num((tx.meta || {}).listed),
        unit: `pages × ${TARGET_LOCALES.length} locales`,
      }));
    }
    block.append(kpis);
    /*
     * Said whenever the English feed is on screen, not only when it looks odd. The
     * seven downstream stages of `rollup.json` are structurally zero, so a reader who
     * goes looking for them there has to be sent to the right feed rather than left to
     * conclude the pipeline is stuck.
     */
    block.append(note(ENGLISH_CEILING));
    for (const line of shortfallNotes(rollup.meta || {}, 'pages', FEEDS.rollup)) {
      block.append(line);
    }
  }

  /* ------------------------------------------------------ the site-wide progress bar */

  if (tx.missing) {
    block.append(missingPanel(FEED_INFO.filter((f) => f.key === 'tx'), errors));
    return;
  }

  const rows = tx.locales || [];
  const totals = Object.fromEntries(PROGRESS_BUCKETS.map((b) => [b.id, 0]));
  let counted = 0;
  let blocked = 0;
  for (const row of rows) {
    counted += num(row.counted);
    blocked += num(row.blocked);
    for (const b of PROGRESS_BUCKETS) totals[b.id] += num(row[bucketColumn(b.id)]);
  }
  const onLine = PROGRESS_BUCKETS.reduce((n, b) => n + totals[b.id], 0);

  const head = el('div', 'ts-band');
  const meta = `${fmtInt(counted)} (page, locale) pairs · ${rows.length} locales · `
    + `${fmtPct(totals.online, counted)} online`;
  head.append(el('h3', 'ts-band-name', 'Translation progress'), el('span', 'ts-band-meta', meta));
  block.append(head, bar(totals, blocked, counted, 'All locales'));
  block.append(legend(totals, blocked, counted));

  /*
   * Invariant (a) of the data contract — the bands plus blocked account for every
   * counted pair — checked in the READER as well as in the build.
   *
   * `build-rollup` asserts it and refuses to write a feed that fails it, so this can
   * only fire on a feed that was hand-edited in DA afterwards. That is exactly why it
   * is worth a line: the bar would still draw, and it would draw a plausible-looking
   * lie. Silent when the invariant holds.
   */
  if (counted && onLine + blocked !== counted) {
    block.append(warnNote(
      `The bands (${fmtInt(onLine)}) plus blocked (${fmtInt(blocked)}) do not add up to `
      + `the ${fmtInt(counted)} pairs this feed counted. The build asserts that they do, `
      + `so ${FEEDS.txRollup} has been edited since it was generated. Do not trust the `
      + 'bar above until it is rebuilt.',
    ));
  }

  /* --------------------------------------------------------------- the locale strip */

  if (rows.length) {
    const table = el('table', 'ts-locales');
    const thead = el('thead');
    const htr = el('tr');
    const columns = [
      ['Locale', 'ts-locale-name'],
      ['Progress', 'ts-locale-bar'],
      ['In flight', 'ts-locale-num'],
      ['Online', 'ts-locale-num'],
    ];
    for (const [label, cls] of columns) htr.append(el('th', cls, label));
    thead.append(htr);

    // Registry order, not size order: it is a fixed list of ten and a reader looks a
    // locale up by name. Re-sorting it on every build would make that impossible.
    const byCode = new Map(rows.map((r) => [String(r.locale || '').trim(), r]));
    const tbody = el('tbody');
    for (const code of TARGET_LOCALES) {
      const row = byCode.get(code);
      if (row) tbody.append(localeRow(row));
    }
    table.append(thead, tbody);
    block.append(table);

    /*
     * Two different feed defects, said separately.
     *
     * A locale with nothing translated is still a row of zeroes in a correct build, so a
     * MISSING row means the build never saw that tab — which reads on the board as a
     * locale nobody has started rather than as data nobody collected. An UNKNOWN code
     * is the opposite mistake and would silently vanish from the strip, taking its
     * pairs out of no total the reader can see.
     */
    const absentLocales = TARGET_LOCALES.filter((code) => !byCode.has(code));
    if (absentLocales.length) {
      block.append(warnNote(
        `${absentLocales.length} registered locale(s) have no row in ${FEEDS.txRollup}: `
        + `${absentLocales.join(', ')}. A locale with nothing translated is still a row `
        + 'of zeroes, so a missing row means the build did not see that tab at all.',
      ));
    }
    const unknown = rows.filter((r) => !TARGET_LOCALES.includes(String(r.locale || '').trim()));
    if (unknown.length) {
      block.append(warnNote(
        `${unknown.length} row(s) in ${FEEDS.txRollup} name a locale this site does not `
        + `serve: ${unknown.map((r) => r.locale).join(', ')}. They are left out of the `
        + 'strip above, so their pairs are in no total on this board.',
      ));
    }
  }

  for (const line of shortfallNotes(tx.meta || {}, '(page, locale) pairs', FEEDS.txRollup)) {
    block.append(line);
  }

  const stamp = tx.generatedAt || rollup.generatedAt;
  if (stamp) {
    block.append(el('p', 'ts-stamp', `Feeds generated ${new Date(stamp).toLocaleString()}`));
  }
}
