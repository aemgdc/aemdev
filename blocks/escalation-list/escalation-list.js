/*
 * escalation-list — what the judge could not decide.
 *
 * Reads both published escalation feeds: the English-side QA feed and the per-(page,
 * locale) translation feed.
 *
 * ─── Why it groups by `scope` and not by page ────────────────────────────────
 *
 * Because the triage ACTION differs per scope, and one of the three is worth far more
 * than the other two:
 *
 *   template  the requirements brief for a whole group is wrong or unresolved. ONE fix
 *             clears every page in that group. This is the single most useful thing this
 *             board can tell anybody, so template scope leads, says how many pages it
 *             covers, and links to the group rather than to a page.
 *   page      this page. Read the doc, decide, record a verdict.
 *   content   the ENGLISH source is wrong, found while checking a translation. It is not
 *             the translator's problem and it stays true across re-translations — it
 *             needs a content owner, not a re-run.
 *
 * A page-by-page list buries that distinction: twelve rows that are really one brief
 * problem read as twelve problems, and somebody works them one at a time.
 *
 * ─── What is NOT here, and why it must not be implied ────────────────────────
 *
 * `/tracker/**` is publicly readable once previewed — noindex is not access control — so
 * `publishable()` projects each escalation onto thirteen scalar columns and strips the
 * prose: the judge's `issues[]` with its verbatim `evidence`, the `checks` array, any
 * source or target TEXT. That is deliberate and it is a privacy boundary, not a gap.
 *
 * So this board renders exactly what is in the feed and never says "see the detail
 * below" about something that was withheld. An empty `detail` cell means the feed
 * carried none, and the row's DOC LINK is where the full story lives — in DA, behind
 * the same auth as the content.
 *
 * Authored config (key/value rows, all optional):
 *   scope    restrict to template | page | content
 *   group    restrict to one page group
 *   locale   restrict to one target locale code (or `en` for the English-side feed)
 *   side     qa | tx | both (default both)
 *   limit    rows per scope (default 20)
 */

import { loadEscalations, loadTxEscalations } from '../../scripts/tracker/data.js';
import { queueMeta } from '../../scripts/tracker/stages.js';
import { TARGET_LOCALES, locale as localeFor } from '../../scripts/tracker/locales.js';
import {
  FEEDS, daEditUrl, links, pageTrackerUrl,
} from '../../scripts/tracker/paths.js';
import {
  dom, readConfig, fmtInt, fmtPct,
} from '../../scripts/tracker/block-utils.js';

/**
 * The three scopes, in triage order, with what each one means for the person reading.
 *
 * `build-escalations.mjs` writes one of exactly these and defaults to `page` — "we know
 * which page" is the honest default. Anything else the feed carries is rendered in its
 * own section rather than dropped, because a scope nobody recognises is still work.
 */
const SCOPES = [
  {
    id: 'template',
    label: 'Template scope',
    lead: 'The requirements brief for a whole group is wrong, or carries an unresolved `?` '
      + 'row. ONE fix clears every page in the group — start here.',
  },
  {
    id: 'page',
    label: 'Page scope',
    lead: 'One page, one decision. Read the review doc, rule on it, and record the verdict '
      + 'there.',
  },
  {
    id: 'content',
    label: 'Content scope',
    lead: 'A problem in the ENGLISH source, found while checking a translation. It needs a '
      + 'content owner, not a re-translation — and it stays true in all ten locales until '
      + 'somebody fixes the English page.',
  },
];

const DEFAULT_LIMIT = 20;

const num = (v) => Number(v || 0);
const text = (v) => String(v ?? '').trim();

/** An external link, or nothing — a dead anchor is worse than a missing one. */
function anchor(el, href, label, hint) {
  if (!href) return null;
  const a = el('a', 'es-link', label);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  if (hint) a.title = hint;
  return a;
}

/** A short absolute date. Fixed to en-GB so it can be diffed against a pipeline log. */
function stamp(iso) {
  const when = iso ? new Date(iso) : null;
  if (!when || Number.isNaN(when.getTime())) return '';
  return when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * One escalation, rendered.
 *
 * `confidence` is a 0..1 number in this model — a tier that emitted 95 against a 0..1
 * schema was one of the defects fixed rather than ported — so it is shown as a
 * percentage of 1 and only when the feed actually carried one. A blank confidence and a
 * confidence of zero are different facts.
 */
function card(el, row) {
  const path = text(row['page-path']);
  const code = text(row.locale).toLowerCase();
  const known = localeFor(code);
  const group = text(row.group);
  const queue = text(row.queue);
  const meta = queueMeta(queue);

  const li = el('li', 'es-item');
  li.dataset.tier = text(row.tier) || 'unknown';

  const head = el('div', 'es-head');
  head.append(el('span', 'es-path', path || '(no page-path)'));
  if (code) {
    const chip = el('span', 'es-locale', known ? `${known.native} /${code}` : `/${code}`);
    if (!known && code !== 'en') {
      chip.classList.add('es-bad');
      chip.title = `"${code}" is not one of the ten target locales.`;
    }
    head.append(chip);
  }
  if (group) head.append(el('span', 'es-group', group));
  li.append(head);

  li.append(el('p', 'es-summary', text(row.summary)
    || 'No summary was published for this escalation.'));

  const detail = text(row.detail);
  if (detail) li.append(el('p', 'es-detail', detail));

  const facts = el('div', 'es-facts');
  const fact = (label, value, hint) => {
    if (!value) return;
    const f = el('span', 'es-fact');
    f.append(el('span', 'es-fact-label', label));
    f.append(el('span', 'es-fact-value', value));
    if (hint) f.title = hint;
    facts.append(f);
  };

  fact('tier', text(row.tier), 'Which tier escalated: structural, judge, visual, or the '
    + 'driver itself.');
  /*
   * A queue id the model does not define is shown RAW and flagged. It has no label and
   * no owner, so nobody is being asked to clear it — that is a data or model defect and
   * hiding it would delete the work item.
   */
  if (queue) {
    if (meta) fact('queue', `${meta.label} · ${meta.owner}`, meta.hint);
    else {
      const f = el('span', 'es-fact es-bad');
      f.append(el('span', 'es-fact-label', 'queue'));
      f.append(el('span', 'es-fact-value', `${queue} — not in the model`));
      f.title = 'This queue id has no label and no owner, so no board filters on it and '
        + 'nobody is being asked to clear it.';
      facts.append(f);
    }
  }
  if (text(row.confidence) !== '') {
    fact(
      'confidence',
      fmtPct(num(row.confidence), 1),
      'The judge\'s own confidence in its verdict, 0..1. A low number is why it escalated '
      + 'rather than ruled.',
    );
  }
  fact('first seen', stamp(row['first-seen']), 'When this escalation was first recorded. An '
    + 'old one that is still here has been waiting for a human.');
  const attempts = num(row.attempts);
  if (attempts) {
    fact('attempts', fmtInt(attempts), 'How many times the pipeline has tried this page. '
      + 'Re-running it again is unlikely to give a different answer.');
  }
  li.append(facts);

  const actions = el('div', 'es-actions');
  const l = path ? links(path, known ? code : undefined) : null;
  for (const a of [
    l ? anchor(
      el,
      l.localePreview || l.enPreview,
      'Page',
      'The page on the preview host — what the tier actually looked at.',
    ) : null,
    anchor(
      el,
      row.doc ? daEditUrl(text(row.doc)) : (l && (l.txDoc || l.qaDoc)),
      'Review doc',
      'The review document in DA. The prose, the source text and the tier working set are '
      + 'stripped from this public feed and live there.',
    ),
    anchor(
      el,
      pageTrackerUrl({ group: group || undefined, locale: known ? code : undefined }),
      'Page Tracker',
      'This page in the Page Tracker app, filtered to its group and locale.',
    ),
  ]) {
    if (a) actions.append(a);
  }
  li.append(actions);

  const report = text(row.report);
  if (report) {
    const note = el('p', 'es-report', report);
    note.title = 'The tier\'s full report, in the repo. Not published — it holds the prose '
      + 'and source text this feed strips.';
    li.append(note);
  }
  return li;
}

/** A panel that says what was wanted, where it looked, and what to run. */
function panel(el, cls, heading, lines) {
  const box = el('div', `es-panel ${cls}`);
  box.append(el('h3', 'es-panel-title', heading));
  for (const line of lines) box.append(el('p', 'es-panel-line', line));
  return box;
}

/**
 * One scope's section.
 *
 * Template scope additionally says how many GROUPS it spans and links to each, because
 * "one fix clears many pages" is only actionable if you can see which many.
 */
function scopeSection(el, scope, rows, limit) {
  const section = el('section', 'es-scope');
  section.dataset.scope = scope.id;

  const head = el('div', 'es-scope-head');
  head.append(el('h3', 'es-scope-title', scope.label));
  head.append(el('span', 'es-scope-count', fmtInt(rows.length)));
  section.append(head);
  section.append(el('p', 'es-scope-lead', scope.lead));

  if (scope.id === 'template') {
    const groups = [...new Set(rows.map((r) => text(r.group)).filter(Boolean))];
    if (groups.length) {
      const spans = el('p', 'es-spans');
      spans.append(el('span', 'es-spans-label', groups.length === 1
        ? 'Affects the whole group:'
        : `Affects ${groups.length} groups:`));
      for (const group of groups) {
        const hint = `Every ${group} page in the Page Tracker. A template-scope fix `
          + 'clears all of them.';
        const a = anchor(el, pageTrackerUrl({ group }), group, hint);
        if (a) spans.append(a);
      }
      section.append(spans);
    }
  }

  const list = el('ul', 'es-list');
  for (const row of rows.slice(0, limit)) list.append(card(el, row));
  section.append(list);

  if (rows.length > limit) {
    section.append(el('p', 'es-more', `Showing ${fmtInt(limit)} of ${fmtInt(rows.length)}. `
      + 'Raise `limit` in the block config, or work the ones above first.'));
  }
  return section;
}

/** Authored-config and feed problems, listed rather than swallowed. */
function warningList(el, warnings) {
  const box = el('div', 'es-warnings');
  box.append(el('h3', 'es-warn-title', 'Needs a look'));
  const list = el('ul', 'es-warn-list');
  for (const w of warnings) list.append(el('li', 'es-warn-item', w));
  box.append(list);
  return box;
}

/** Resolve authored config, naming anything it could not match. */
function resolveConfig(cfg, warnings) {
  const scope = text(cfg.scope).toLowerCase();
  if (scope && !SCOPES.some((s) => s.id === scope)) {
    warnings.push(`Authored \`scope\` is "${scope}"; the three are `
      + `${SCOPES.map((s) => s.id).join(', ')}. Showing all scopes.`);
  }
  const code = text(cfg.locale).toLowerCase();
  if (code && code !== 'en' && !TARGET_LOCALES.includes(code)) {
    warnings.push(`Authored \`locale\` is "${code}", which is not a target locale. `
      + `The ten are: ${TARGET_LOCALES.join(', ')}, plus \`en\` for the English-side feed.`);
  }
  const side = text(cfg.side).toLowerCase();
  if (side && !['qa', 'tx', 'both'].includes(side)) {
    warnings.push(`Authored \`side\` is "${side}"; it is \`qa\`, \`tx\` or \`both\`. `
      + 'Reading both feeds.');
  }
  const limit = Number(cfg.limit);
  return {
    scope: SCOPES.some((s) => s.id === scope) ? scope : '',
    code: code === 'en' || TARGET_LOCALES.includes(code) ? code : '',
    group: text(cfg.group),
    side: ['qa', 'tx', 'both'].includes(side) ? side : 'both',
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT,
  };
}

export default async function init(block) {
  const { el } = dom(block);
  const cfg = readConfig(block);
  block.textContent = '';

  const warnings = [];
  const opts = resolveConfig(cfg, warnings);

  const [qa, tx] = await Promise.all([
    opts.side === 'tx' ? { rows: [], missing: false, error: null } : loadEscalations(),
    opts.side === 'qa' ? { rows: [], missing: false, error: null } : loadTxEscalations(),
  ]);

  /*
   * Both feeds absent is the only true error state. `build-escalations` publishes
   * NOTHING for a side whose `.jsonl` queue does not exist rather than publishing an
   * empty feed, precisely so a reader can tell "the pipeline has never run" from
   * "nothing escalated" — so a missing feed must not render as a clear queue.
   */
  const absent = [
    qa.missing ? `${FEEDS.escalations} → ${qa.error}` : null,
    tx.missing ? `${FEEDS.txEscalations} → ${tx.error}` : null,
  ].filter(Boolean);

  if (absent.length === (opts.side === 'both' ? 2 : 1)) {
    block.append(panel(el, 'es-panel-error', 'No escalation feed yet', [
      `This board reads ${FEEDS.escalations} and ${FEEDS.txEscalations}. Neither answered: `
      + `${absent.join('; ')}.`,
      'A missing feed is not an empty queue. The build publishes nothing at all for a side '
      + 'whose queue file does not exist, so this means the pipeline has not escalated '
      + 'anything yet — which is the expected state before it has run.',
      'To populate it: run `npm run qa:batch` or `npm run tx:batch`, then '
      + '`npm run escalations --apply`.',
    ]));
    return;
  }

  // One side missing while the other answered is a partial view, not an error — but it
  // has to be SAID, or the rows shown read as the whole picture.
  if (absent.length) {
    warnings.push(`One side has no feed: ${absent.join('; ')}. Its escalations, if any, are `
      + 'not represented on this board.');
  }

  const rows = [...(qa.rows || []), ...(tx.rows || [])].filter((row) => {
    const code = text(row.locale).toLowerCase();
    const group = text(row.group);
    const scope = text(row.scope).toLowerCase();
    return (!opts.code || code === opts.code || (opts.code === 'en' && !code))
      && (!opts.group || group === opts.group)
      && (!opts.scope || scope === opts.scope);
  });

  if (!rows.length) {
    /*
     * The good state, and it is only reachable when at least one feed was READ. Worded
     * as a clear queue rather than as an absence, because that is what it is.
     */
    block.append(panel(el, 'es-panel-clear', 'Nothing escalated', [
      'Both escalation feeds were read and no tier has anything it could not decide. '
      + 'Nobody is waiting on a human judgement.',
      opts.scope || opts.group || opts.code
        ? 'Note this board is filtered — widen it before concluding the whole tracker is clear.'
        : 'That covers every group and all ten locales.',
    ]));
    if (warnings.length) block.append(warningList(el, warnings));
    return;
  }

  const shownScopes = opts.scope ? SCOPES.filter((s) => s.id === opts.scope) : SCOPES;
  const board = el('div', 'es-board');
  for (const scope of shownScopes) {
    const mine = rows.filter((row) => text(row.scope).toLowerCase() === scope.id);
    if (mine.length) board.append(scopeSection(el, scope, mine, opts.limit));
  }

  /*
   * A scope value the model does not define gets its own section rather than being
   * dropped. `build-escalations` coerces to `page`, so this can only arrive from a
   * hand-edited feed or a future scope — either way it is real work.
   */
  const known = new Set(SCOPES.map((s) => s.id));
  const unknown = rows.filter((row) => !known.has(text(row.scope).toLowerCase()));
  if (unknown.length && !opts.scope) {
    board.append(scopeSection(el, {
      id: 'unknown',
      label: 'Unrecognised scope',
      lead: 'These rows carry a `scope` the model does not define, so nothing above claims '
        + 'them and no triage rule applies. Either the model is missing a scope or the feed '
        + 'has a typo — they are shown here so they are not silently lost.',
    }, unknown, opts.limit));
  }
  block.append(board);

  if (warnings.length) block.append(warningList(el, warnings));

  block.append(el('p', 'es-meta', 'The feeds are published to a world-readable tree, so the '
    + 'judge\'s prose, its evidence quotes and any source or target text are stripped before '
    + 'writing. Every row\'s review doc holds the full story.'));
}
