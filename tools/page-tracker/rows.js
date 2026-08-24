/*
 * rows.js — sheet rows to view rows, plus filtering.
 *
 * ─── The one rule this file exists to keep ──────────────────────────────────
 *
 * **The stage is DERIVED here, on every build, and never read from a cell.**
 *
 * Nothing in this system stores a stage. `classifyTranslation()` computes one from
 * the stored columns plus two OBSERVED facts — does the page answer on the preview
 * host, and on the live host — and its step-4 clamp is what lets a crawl CORRECT a
 * stale status instead of arguing with it. An app that read a `stage` column would
 * be a second implementation of the funnel, free to disagree with every board and
 * with the rollup, and it would lose the clamp: a page translated, judged and then
 * withdrawn would read `autoQaPass` for ever.
 *
 * The English mode is not a special case of that. Pairing a `data` row with an EMPTY
 * locale row is exactly what `classifyTranslation` expects for "no row in that
 * locale", so it falls through to `classifyEnglish` on its own — the same call, the
 * same code path, one less thing to keep in step. (It is also how `rollup.json`
 * counts the English side; see docs/tracker/data-contract.md §3.)
 *
 * ─── The other rule ────────────────────────────────────────────────────────
 *
 * A locale row that is not there is `{}`, never `undefined`, and it renders as
 * "not sent" — the first `TRANSLATION_STATUSES` label. Ten locales times nineteen
 * pages is 190 pairs and today all 190 of them are missing, so the absent row is the
 * NORMAL input to this function, not an edge case to guard against.
 */

import {
  EN_STATUSES, PAGE_STAGES, QUEUES, REVIEW_STATUSES, TRANSLATION_STATUSES,
  classifyTranslation, hasContentEscalation, localeRowFor, stageMeta,
} from '../../scripts/tracker/stages.js';
import { TARGET_LOCALES, locale as localeFor, normalizePath } from '../../scripts/tracker/locales.js';
import { links } from '../../scripts/tracker/paths.js';
import { UNASSIGNED, subgroupNames, subgroupOf } from '../../scripts/tracker/subgroups.js';

const text = (v) => (v == null ? '' : String(v).trim());

/**
 * A stored value's display label, from the enum it belongs to.
 *
 * Case-folded, because every one of these columns is hand-editable in da.live's sheet
 * editor and `TRANSLATION OK` is a real stored value with a space and capitals in it.
 * An unrecognised value falls back to ITSELF rather than to a dash: a cell nobody can
 * explain is worth more on screen as its own raw text than hidden behind an em dash,
 * and `classifyTranslation` is already emitting a warning about it.
 */
const labelOf = (enumeration, value) => {
  const v = text(value).toLowerCase();
  const hit = enumeration.find((s) => s.value.toLowerCase() === v);
  return hit ? hit.label : text(value);
};

/** Tolerant truthiness for the two crawl columns, which are stored as text. */
const observed = (v) => ['yes', 'y', 'true', '1', '200', 'ok'].includes(text(v).toLowerCase());

/* ------------------------------------------------------------------- view rows */

/**
 * One (page, locale) pair as the table and the drawer want it.
 *
 * `code` of `null` means English mode: the `localeRow` is `{}` and the stage falls
 * through to the English gate. `missingLocaleRow` distinguishes "this locale has no
 * row" from "this locale has a row with nothing in it" — the second is a page the
 * pipeline touched and the first is one it never reached, and the two want different
 * next actions.
 */
export function viewRow(row, localeRow, code, branch) {
  const path = normalizePath(row?.['page-path']);
  const lr = localeRow || {};
  const result = classifyTranslation(row, lr);
  const meta = result.stage ? stageMeta(result.stage) : null;
  const name = subgroupOf(row);

  return {
    path,
    title: text(row?.title) || path,
    template: text(row?.template),
    pagetype: text(row?.pagetype),
    subgroup: name,
    lastModified: text(row?.['last-modified']),
    enLive: observed(row?.['en-live']),
    translate: text(row?.translate),
    notes: text(row?.notes),

    locale: code || null,
    localeName: code ? (localeFor(code)?.native || code) : 'English',
    localePath: text(lr['locale-path']),
    missingLocaleRow: Object.keys(lr).length === 0,

    // Derived every time. See this file's header.
    stage: result.stage,
    stageLabel: meta ? meta.label : 'Blocked',
    stageShort: meta ? meta.short : 'BLOCK',
    stageHint: meta ? meta.hint : 'Out of the funnel until the queue below is cleared.',
    blocked: result.blocked,
    queues: result.queues,
    warnings: result.warnings,

    // The three STORED statuses, raw and labelled. Raw is what somebody greps the
    // sheet for, so both travel together.
    enStatus: text(row?.['en-status']),
    enStatusLabel: labelOf(EN_STATUSES, row?.['en-status']),
    translationStatus: text(lr['translation-status']),
    translationLabel: labelOf(TRANSLATION_STATUSES, lr['translation-status']),
    reviewStatus: text(lr['review-status']),
    reviewLabel: labelOf(REVIEW_STATUSES, lr['review-status']),
    reviewUpdated: text(lr['review-updated']),
    sentAt: text(lr['sent-at']),

    // The two CRAWL columns. Read-only here by design — see da-source.js.
    previewed: observed(lr.previewed),
    online: observed(lr.online),

    contentEscalation: hasContentEscalation(row),

    links: links(path, code || null, branch),
    row,
    localeRow: lr,
  };
}

/**
 * The table's rows for one group in one mode.
 *
 * @param {object}  opts
 * @param {object[]} opts.rows        the `data` tab, placeholders already dropped
 * @param {Map}     opts.localeIndex  from `indexLocaleRows()`
 * @param {string}  [opts.code]       a target locale, or falsy for English mode
 * @param {string}  [opts.branch]     the ref the page links point at
 */
export function buildRows({
  rows, localeIndex, code = null, branch,
}) {
  const out = (rows || []).map((row) => {
    const lr = code ? localeRowFor(localeIndex, row['page-path'], code) : {};
    return viewRow(row, lr, code || null, branch);
  });
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Every locale's state for ONE page, side by side.
 *
 * This is the view no board can give: a board picks a locale and shows every page, so
 * "German is signed off, Japanese never arrived, the other eight were never sent" takes
 * ten board loads to assemble and cannot be seen at once. Built from the same
 * `viewRow` as the table, so a cell here and a row there cannot disagree.
 *
 * Always all ten, in registry order, including the ones with no row at all — their
 * absence IS the rollout status, and a list that showed only the locales with rows
 * would make a ten-language programme look like a one-language one.
 */
export function localeStates(row, localeIndex, branch) {
  return TARGET_LOCALES.map((code) => viewRow(
    row,
    localeRowFor(localeIndex, row['page-path'], code),
    code,
    branch,
  ));
}

/* --------------------------------------------------------------- the tier chips */

/**
 * The three tiers, always all three, always in this order.
 *
 * A page's QA position is not one value but three independent answers, and collapsing
 * them into a single badge loses the distinction that decides WHO fixes it: "the
 * structure survived but the translation is wrong" and "the translation is right but
 * the layout broke" have different owners, and one status word cannot say which.
 */
export const TIERS = [
  {
    id: 'structural',
    label: 'Structural',
    short: 'STRUCT',
    hint: 'Tier 1 — blocks, authoring keys, enum values, links and inline markup survived.',
  },
  {
    id: 'judge',
    label: 'Fidelity',
    short: 'JUDGE',
    hint: 'Tier 2 — the page is genuinely translated and the terminology and meaning hold.',
  },
  {
    id: 'visual',
    label: 'Layout',
    short: 'VISUAL',
    hint: 'Tier 3 — no overflow, clipping or misalignment from text expansion.',
  },
];

/** A tier verdict we know how to colour. Anything else is shown as itself. */
const TIER_STATES = new Set(['pass', 'fail', 'review', 'escalate']);

/**
 * What each tier said, for one published report.
 *
 * `'not-run'` is a FIRST-CLASS state, distinct from `pass`, and this is the single
 * most important line in the file after the derived stage: `null` and `"pass"` must
 * never look the same, because "we did not look" is not "we looked and it was fine".
 * The publisher already enforces the storage half — a tier that did not run writes
 * `''`, never `'pass'` (docs/tracker/data-contract.md §3) — and this is the rendering
 * half of the same rule.
 *
 * A missing report yields three `not-run` chips rather than nothing at all. Today
 * every report is missing, so an empty tier row would be the app's normal appearance
 * and would read as "nothing to report" instead of "nothing has run".
 *
 * @param {object|null} report the `report` tab's single row, or null
 */
export function tierStates(report) {
  return TIERS.map((tier) => {
    const verdict = text(report?.[tier.id]);
    let state = 'not-run';
    if (verdict) state = TIER_STATES.has(verdict.toLowerCase()) ? verdict.toLowerCase() : 'unknown';
    return {
      ...tier,
      verdict,
      state,
      title: state === 'not-run'
        ? `${tier.hint} — DID NOT RUN. Not a pass: nothing has looked at this yet.`
        : `${tier.hint} — ${verdict}`,
    };
  });
}

/* ------------------------------------------------------------------- filtering */

/** The pseudo-stage for a pair that is out of the funnel. `stage` is null there. */
export const BLOCKED = 'blocked';

/**
 * Stage options for the filter bar, in funnel order, with counts.
 *
 * Built from `PAGE_STAGES` so a stage added to the model appears here without a code
 * change, and `blocked` is appended as a real option because `classifyTranslation`
 * answers `stage: null` for a whole class of pairs that a reviewer very much wants to
 * list.
 */
export function stageOptions(viewRows) {
  const counts = new Map();
  for (const r of viewRows || []) {
    const key = r.blocked ? BLOCKED : r.stage;
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [
    ...PAGE_STAGES.map((s) => ({
      id: s.id, label: s.label, hint: s.hint, count: counts.get(s.id) || 0,
    })),
    {
      id: BLOCKED,
      label: 'Blocked',
      hint: 'Out of the funnel entirely — a pipeline failure or a human rejection.',
      count: counts.get(BLOCKED) || 0,
    },
  ];
}

/** Queue options, from the model, with counts. A pair can be in more than one. */
export function queueOptions(viewRows) {
  const counts = new Map();
  for (const r of viewRows || []) {
    for (const q of r.queues) counts.set(q, (counts.get(q) || 0) + 1);
  }
  return QUEUES.map((q) => ({
    id: q.id, label: q.label, hint: q.hint, owner: q.owner, count: counts.get(q.id) || 0,
  }));
}

/**
 * Subgroup options, biggest first with `(unassigned)` forced last.
 *
 * Order comes from `subgroups.js`, not from a sort written here. Early on almost every
 * row is unclassified, so size-sorting the residue to the top buries the labels
 * somebody actually authored — the rule is "regardless of size", which is exactly the
 * clause a second copy loses because it looks like a tiebreak.
 */
export function subGroupOptions(viewRows) {
  const rows = (viewRows || []).map((r) => r.row);
  const names = subgroupNames(rows);
  const hasBlank = (viewRows || []).some((r) => r.subgroup === UNASSIGNED);
  const count = (name) => (viewRows || []).filter((r) => r.subgroup === name).length;
  return [
    ...names.map((name) => ({ id: name, label: name, count: count(name) })),
    ...(hasBlank ? [{ id: UNASSIGNED, label: UNASSIGNED, count: count(UNASSIGNED) }] : []),
  ];
}

/** Free-text match: path, title and subgroup — the three things anybody types. */
const matchesText = (r, q) => r.path.toLowerCase().includes(q)
  || r.title.toLowerCase().includes(q)
  || r.subgroup.toLowerCase().includes(q);

/**
 * Apply every active constraint. Absent or blank constraints match everything.
 *
 * @param {object[]} viewRows
 * @param {{stage?:string, queue?:string, subGroup?:string, text?:string}} f
 */
export function applyFilters(viewRows, f = {}) {
  const q = text(f.text).toLowerCase();
  const sub = text(f.subGroup).toLowerCase();
  return (viewRows || []).filter((r) => {
    if (f.stage && (f.stage === BLOCKED ? !r.blocked : r.stage !== f.stage)) return false;
    if (f.queue && !r.queues.includes(f.queue)) return false;
    if (sub && r.subgroup.toLowerCase() !== sub) return false;
    if (q && !matchesText(r, q)) return false;
    return true;
  });
}

/**
 * The active constraints, named the way the empty state has to name them.
 *
 * A table that matches nothing must say WHICH filter emptied it and offer to clear
 * that one — "no pages match" is a dead end, and the reader's next move is otherwise
 * to reload the app and lose their place. Returned as data rather than rendered here
 * so the same list drives the empty state and the filter summary.
 *
 * @returns {Array<{key:string, label:string, value:string}>}
 */
export function activeFilters(f = {}) {
  const out = [];
  if (f.stage) {
    const hit = stageOptions([]).find((s) => s.id === f.stage);
    out.push({ key: 'stage', label: 'Stage', value: hit ? hit.label : f.stage });
  }
  if (f.queue) {
    const hit = QUEUES.find((q) => q.id === f.queue);
    out.push({ key: 'queue', label: 'Queue', value: hit ? hit.label : f.queue });
  }
  if (text(f.subGroup)) out.push({ key: 'subGroup', label: 'Subgroup', value: text(f.subGroup) });
  if (text(f.text)) out.push({ key: 'text', label: 'Find', value: text(f.text) });
  return out;
}
