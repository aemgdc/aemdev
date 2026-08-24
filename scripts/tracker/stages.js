/*
 * stages.js — the status model. Every other part of the tracker agrees through here.
 *
 * Browser + Node. Zero dependencies, no DOM. See ./README.md.
 *
 * ─── The question this model answers ────────────────────────────────────────
 *
 * The tracker this is ported from answered "how far along is this page's
 * rebuild?" — a per-PAGE question with a long human-owned phase before any machine
 * touched the page. This one answers "has this page's translation landed, and is it
 * correct?" — a per-(PAGE, LOCALE) question with almost no pre-phase, because the
 * English page already exists.
 *
 * So the funnel is per (page, locale), and the English side collapses to a two-state
 * gate. `classifyTranslation()` is the real model; `classifyEnglish()` is the gate.
 *
 * ─── Derived, never stored ──────────────────────────────────────────────────
 *
 * Nothing writes a stage. A stage is computed from stored columns plus two OBSERVED
 * facts — does the page answer on the preview host, and on the live host — every time
 * it is asked. That is what lets a crawl correct a stale status instead of arguing
 * with it, and it is why `previewed`/`online` are crawl output and are regenerated on
 * every scan while the status columns are preserved.
 *
 * The single most load-bearing rule in this file is step 4 of
 * `classifyTranslation()`: if the page does not answer on the preview host, it is not
 * translated, whatever any status column says. Nothing ever clears a status column,
 * so without that clamp a page translated, judged and then withdrawn would read
 * `autoQaPass` forever.
 */

import { TARGET_LOCALES, normalizePath } from './locales.js';

/* ------------------------------------------------------------------ the funnel */

/**
 * The forward funnel one (page, locale) pair moves through, in order.
 *
 * `short` is the chip label in the DA app's tight table columns; `label` is the prose
 * form used on the boards.
 */
export const PAGE_STAGES = [
  { id: 'catalogued', label: 'Catalogued', short: 'CAT', hint: 'In a tracked group; the English page is not published yet.' },
  { id: 'enPublished', label: 'EN published', short: 'EN', hint: 'The English page is live. Ready to send for translation.' },
  { id: 'sentForTranslation', label: 'Sent for translation', short: 'SENT', hint: 'Handed to the translation service; nothing has come back yet.' },
  { id: 'previewed', label: 'Previewed', short: 'PREV', hint: 'The translated page answers on the preview host. Auto QA can run.' },
  { id: 'autoQaPass', label: 'Auto QA passed', short: 'AQA', hint: 'Structural and translation-fidelity tiers are clean.' },
  { id: 'layoutQaPass', label: 'Layout QA passed', short: 'LAY', hint: 'The visual tier found no layout damage from text expansion.' },
  { id: 'inReview', label: 'In native review', short: 'REV', hint: 'Queued for a native speaker.' },
  { id: 'reviewOk', label: 'Review OK', short: 'OK', hint: 'Signed off. Ready to publish.' },
  { id: 'online', label: 'Online', short: 'LIVE', hint: 'Answering on the live host in this locale.' },
];

export const STAGE_INDEX = Object.fromEntries(PAGE_STAGES.map((s, i) => [s.id, i]));

const STAGE_IDS = new Set(PAGE_STAGES.map((s) => s.id));

/* ------------------------------------------------------------------ work queues */

/**
 * Queues a pair is pulled into when it needs a human or a re-run.
 *
 * A queue can coexist with a funnel stage (`content-escalation` does) or replace it
 * (every blocker does). `owner` is who clears it, and it is in the model rather than
 * in the UI because the boards, the DA app and the escalation feed must not disagree
 * about who is being asked.
 */
export const QUEUES = [
  { id: 'send-issues', label: 'Send failed', owner: 'pipeline', hint: 'The translation service refused or errored.' },
  { id: 'awaiting-preview', label: 'Never arrived', owner: 'pipeline', hint: 'Sent, but nothing has appeared on the preview host.' },
  { id: 'auto-qa-issues', label: 'Auto QA failures', owner: 'pipeline', hint: 'A tier found a fidelity defect.' },
  { id: 'escalations', label: 'Escalations', owner: 'human', hint: 'The judge could not decide; a human must look.' },
  { id: 'layout-issues', label: 'Layout damage', owner: 'developer', hint: 'Text expansion broke the layout.' },
  { id: 'retranslate', label: 'Needs retranslation', owner: 'pipeline', hint: 'A reviewer rejected the translation.' },
  { id: 'terminology', label: 'Terminology fixes', owner: 'human', hint: 'A term that should not have been translated was, or vice versa.' },
  { id: 'link-issues', label: 'English links', owner: 'pipeline', hint: 'Links still point at the English tree.' },
  { id: 'publish-issues', label: 'Publish failed', owner: 'pipeline', hint: 'Signed off and previewed, but never went live.' },
  { id: 'content-escalation', label: 'Content escalations', owner: 'human', hint: 'A problem in the English source, flagged during translation QA.' },
];

const QUEUE_IDS = new Set(QUEUES.map((q) => q.id));

/* ------------------------------------------------- stored: the English-side gate */

/**
 * `en-status` — the English half. Human- or crawl-set. Blank is normal.
 *
 * Deliberately tiny. The original had four `readiness` values and a three-owner
 * requirements gate because a page had to be BUILT before it could be migrated. Here
 * the page already exists, so the only question is whether it is published enough to
 * translate from.
 */
export const EN_STATUSES = [
  { value: '', label: 'Not assessed' },
  { value: 'draft', label: 'Draft' },
  { value: 'en-previewed', label: 'Previewed' },
  { value: 'en-published', label: 'Published' },
];

// Folded, because every reader of `en-status` folds case — see `classifyEnglish`
// and the send gate. A Set of raw values made `EN-Published` an unknown status.
const KNOWN_EN = new Set(EN_STATUSES.map((s) => s.value.toLowerCase()));

/* ------------------------------------- stored: the pipeline's per-locale verdict */

/**
 * `translation-status` — written by the pipeline, one value per (page, locale).
 *
 * `sent` is the one value here that is NOT observable anywhere. Every other state can
 * be re-derived by crawling two hosts or re-running a tier; "we handed this to the
 * translation service" exists only because we recorded it. So it carries a `sent-at`
 * timestamp and is the only status the reconcile treats as testimony rather than as a
 * cache — which is also why a missing preview after the SLA becomes
 * `preview-missing` rather than being silently forgotten.
 */
export const TRANSLATION_STATUSES = [
  { value: '', label: 'Not sent', actor: 'automated' },
  { value: 'sent', label: 'Sent', actor: 'human' },
  { value: 'preview-ok', label: 'Previewed', actor: 'automated' },
  { value: 'auto-qa-ok', label: 'Auto QA passed', actor: 'judge' },
  { value: 'visual-qa-ok', label: 'Layout QA passed', actor: 'automated' },
  { value: 'send-fail', label: 'Send failed', actor: 'automated', queue: 'send-issues' },
  { value: 'preview-missing', label: 'Never arrived', actor: 'automated', queue: 'awaiting-preview' },
  { value: 'untranslated', label: 'Still English', actor: 'automated', queue: 'retranslate' },
  { value: 'unlocalized-links', label: 'English links', actor: 'automated', queue: 'link-issues' },
  { value: 'auto-qa-fail', label: 'Auto QA failed', actor: 'judge', queue: 'auto-qa-issues' },
  { value: 'auto-qa-escalate', label: 'Escalated', actor: 'judge', queue: 'escalations' },
  { value: 'visual-qa-fail', label: 'Layout QA failed', actor: 'automated', queue: 'layout-issues' },
  { value: 'publish-fail', label: 'Publish failed', actor: 'automated', queue: 'publish-issues' },
];

const KNOWN_TRANSLATION = new Set(TRANSLATION_STATUSES.map((s) => s.value));

/** Blocking `translation-status` → the queue it lands in. */
const TRANSLATION_BLOCKERS = Object.fromEntries(
  TRANSLATION_STATUSES.filter((s) => s.queue).map((s) => [s.value, s.queue]),
);

/** Forward (non-blocking) `translation-status` → funnel stage. */
const TRANSLATION_FORWARD = {
  '': 'enPublished',
  sent: 'sentForTranslation',
  'preview-ok': 'previewed',
  'auto-qa-ok': 'autoQaPass',
  'visual-qa-ok': 'layoutQaPass',
};

/* ------------------------------------------- stored: the only human input there is */

/**
 * `review-status` — a native speaker's verdict. The ONLY stored human judgement.
 *
 * `TRANSLATION OK` keeps the SAS original's deliberate casing oddity (it had `QA OK`
 * and `LANG OK`): a literal uppercase-with-space STORED value, matched everywhere via
 * `.toLowerCase()`. It survives the port because the same string is what the review
 * document's marker means, and a human edits that document in DA's rich-text editor.
 * Two spellings for one concept is a class of round-trip bug; one odd-looking spelling
 * is not.
 */
export const REVIEW_STATUSES = [
  { value: '', label: '—' },
  { value: 'ready-for-review', label: 'Ready for review' },
  { value: 'TRANSLATION OK', label: 'Translation OK' },
  { value: 'needs-retranslation', label: 'Needs retranslation', queue: 'retranslate' },
  { value: 'needs-terminology-fix', label: 'Needs terminology fix', queue: 'terminology' },
  { value: 'needs-layout-fix', label: 'Needs layout fix', queue: 'layout-issues' },
];

const KNOWN_REVIEW = new Set(REVIEW_STATUSES.map((s) => s.value.toLowerCase()));

const REVIEW_BLOCKERS = Object.fromEntries(
  REVIEW_STATUSES.filter((s) => s.queue).map((s) => [s.value.toLowerCase(), s.queue]),
);

/* ------------------------------------------------------------- document markers */

/**
 * `review-status` ↔ the marker written into the review document.
 *
 * The document is the reviewer's surface and the sheet is the tracker's; both must
 * carry the verdict, so it round-trips through a marker line a human can read, grep
 * and hand-edit.
 */
export const REVIEW_DOC_MARKERS = [
  { status: '', marker: 'PENDING' },
  { status: 'ready-for-review', marker: 'READY FOR REVIEW' },
  { status: 'TRANSLATION OK', marker: 'OK' },
  { status: 'needs-retranslation', marker: 'NEEDS RETRANSLATION' },
  { status: 'needs-terminology-fix', marker: 'NEEDS TERMINOLOGY FIX' },
  { status: 'needs-layout-fix', marker: 'NEEDS LAYOUT FIX' },
];

/**
 * The marker-matching regex.
 *
 * Alternation is sorted LONGEST-FIRST and it has to be: a regex offering `OK` before
 * `NEEDS TERMINOLOGY FIX` would never match the longer one, because JavaScript
 * alternation is first-match not longest-match. Sorting here means adding a marker
 * later cannot reintroduce the bug.
 *
 * The trailing `(?![A-Za-z])` is the other half of that and is NOT optional. Without
 * it the alternation matched a marker that was merely a PREFIX of what the human
 * actually typed, and the failure was silent and in the worst direction:
 * `TRANSLATION STATUS: OKAY` read as the `OK` marker, i.e. a sign-off nobody gave.
 * (`READY FOR REVIEWING` → `ready-for-review` and `NEEDS TERMINOLOGY FIXES` →
 * `needs-terminology-fix` were the same bug, less dangerously.) With the boundary,
 * a mistyped marker matches nothing, `reviewStatusFromDocText` returns null, and the
 * doc model reports it as an unknown marker — a warning a human resolves, which is
 * the posture this whole file takes toward data it cannot parse.
 *
 * A non-letter after the marker is still fine, so `OK — check the date` reads as OK:
 * reviewers append prose to these lines and forbidding that would just get the line
 * rewritten by hand into something unparseable.
 */
export const REVIEW_STATUS_RE = new RegExp(
  `TRANSLATION STATUS:\\s*(${REVIEW_DOC_MARKERS.map((m) => m.marker)
    .sort((a, b) => b.length - a.length)
    .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(?![A-Za-z])`,
  'i',
);

/** `review-status` → marker. Anything unrecognised is PENDING, never a guess. */
export function docMarkerFor(reviewStatus) {
  const hit = REVIEW_DOC_MARKERS.find(
    (m) => m.status.toLowerCase() === String(reviewStatus || '').trim().toLowerCase(),
  );
  return hit ? hit.marker : 'PENDING';
}

/**
 * marker → `review-status`. Unknown markers return `null` rather than throwing.
 *
 * `null` and not `''`, because `''` is the real value of the PENDING marker. Returning
 * `''` for both collapsed "nobody has reviewed this yet" and "this document says
 * something I cannot parse" into one answer, and the second one is a data-quality
 * problem someone has to look at — bucketing it as pending is exactly the silent
 * mis-count this module's warnings exist to prevent.
 */
export function reviewStatusFromMarker(marker) {
  const hit = REVIEW_DOC_MARKERS.find(
    (m) => m.marker.toLowerCase() === String(marker || '').trim().toLowerCase(),
  );
  return hit ? hit.status : null;
}

/** Pull a verdict out of a document's text. Returns null when there is no marker. */
export function reviewStatusFromDocText(text) {
  const m = REVIEW_STATUS_RE.exec(String(text || ''));
  return m ? reviewStatusFromMarker(m[1]) : null;
}

/* ---------------------------------------------------- content-escalation: a FLAG */

/*
 * Every other status here is single-valued: setting one replaces the last. A problem
 * in the ENGLISH source does not work that way. "The recap video is a dead link" is
 * true at the same time as "the German translation is ready for review", and it stays
 * true across re-translations and re-judges until a content owner decides something.
 *
 * Folding it into `translation-status` would force a choice between recording the
 * content problem and recording the translation state, and losing one of them. So it
 * is an independent column that COEXISTS with any stage.
 *
 * It is also the one flag that belongs to the PAGE rather than the pair: a dead link
 * in English is dead in all ten locales. It lives on the `data` tab for that reason.
 */
export const CONTENT_ESCALATION_COLUMN = 'content-escalation';

/*
 * Same trailing boundary, same reason as `REVIEW_STATUS_RE` — and here the dangerous
 * direction is CLEARING a flag: `CONTENT ESCALATION: NOPE` matched `NO` and read as
 * "the content problem is resolved". (`YESTERDAY` → `YES` was the mirror image.)
 */
export const CONTENT_ESCALATION_RE = /CONTENT ESCALATION:\s*(YES|NO)(?![A-Za-z])/i;

const get = (row, key) => (row && row[key] != null ? String(row[key]).trim() : '');

/** Tolerant truthiness for the crawl columns, which are written as text. */
function truthy(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'yes' || s === 'y' || s === 'true' || s === '1' || s === '200' || s === 'ok';
}

/** Tolerant truthiness — a human types in this cell. */
export function hasContentEscalation(row) {
  const v = get(row, CONTENT_ESCALATION_COLUMN).toLowerCase();
  return v === 'yes' || v === 'y' || v === 'true' || v === '1' || v === 'x';
}

/* ---------------------------------------------------------------- the send gates */

/**
 * THE SEND GATE — may this pair be handed to the translation service?
 *
 * Requires an EXPLICIT `en-published`. Never a derived default: a page that merely
 * *looks* published (the crawl saw a 200 once) must not be sent on that basis, because
 * sending is the one irreversible, money-costing step in the pipeline.
 *
 * Also excludes any pair the pipeline already worked, so a re-run cannot masquerade as
 * new work and get sent twice.
 *
 * Case is FOLDED, like every other reader of these columns. It used to be compared
 * raw, and the result was two functions contradicting each other about one cell: a
 * hand-typed `EN-Published` classified as stage `enPublished` via `classifyEnglish`
 * (which folds) while the gate said no, so `classifyTranslation` warned "en-status is
 * not en-published" about a row the board was simultaneously showing as published.
 * Folding does not weaken the gate — the cell must still say `en-published`; it just
 * stops the shift key from being a semantic difference in a spreadsheet a human edits.
 */
const enStatusOf = (row) => get(row, 'en-status').toLowerCase();

export const isSendable = (row, localeRow) => enStatusOf(row) === 'en-published'
  && get(localeRow, 'translation-status') === '';

/**
 * Stays true after the pipeline ran.
 *
 * This is the one `classifyTranslation()` uses to decide whether a recorded
 * `translation-status` is believable at all. Kept separate from `isSendable` on
 * purpose — conflating "may be sent" with "was legitimately sent" is how an ungated
 * status silently counts as progress.
 */
export const passedSendGate = (row) => enStatusOf(row) === 'en-published';

/* -------------------------------------------------------------- countable pages */

/*
 * Pages excluded from every count.
 *
 * Drafts and sandboxes are not pages a visitor lands on, and `config/sites/aemdev/
 * query.yaml` already excludes them from the index — counting them here would make
 * the tracker's denominator disagree with the site's own inventory.
 *
 * NOTE the deliberate difference from the original, which excluded
 * `/<lang>/fragments/**` wholesale. Here `/en/fragments/bios/**` is a TRACKED GROUP:
 * bios are translated, so they are countable pages even though they are fragments.
 * Only non-bio fragments are excluded.
 */
const EXCLUDED_PATH = /^\/[a-z]{2}(?:-[a-z]{2})?\/(?:drafts|sandbox)\//i;
const EXCLUDED_FRAGMENT = /^\/[a-z]{2}(?:-[a-z]{2})?\/fragments\/(?!bios\/)/i;

/** Does this row represent a countable page? */
export function countsAsPage(row) {
  const path = get(row, 'page-path');
  if (!path) return false; // a blank path is a scaffold placeholder, not a page
  return !EXCLUDED_PATH.test(path) && !EXCLUDED_FRAGMENT.test(path);
}

/* ------------------------------------------------------------- the English side */

/**
 * Where does the ENGLISH page sit? Two states, plus the flag.
 *
 * Kept as its own function rather than folded into `classifyTranslation` because the
 * English page has exactly one job in this model — be publishable — and the boards
 * need to count "how many pages are even ready to translate" without picking a locale.
 */
export function classifyEnglish(row) {
  const raw = get(row, 'en-status');
  const status = raw.toLowerCase();
  const warnings = [];
  const queues = hasContentEscalation(row) ? ['content-escalation'] : [];

  if (raw !== '' && !KNOWN_EN.has(status)) warnings.push(`unknown en-status: "${raw}"`);

  const stage = status === 'en-published' ? 'enPublished' : 'catalogued';
  return {
    stage, order: STAGE_INDEX[stage], queues, blocked: false, warnings,
  };
}

/* ------------------------------------------------------- the translation funnel */

/**
 * Classify one (page, locale) pair.
 *
 * @param {object} row       the `data` tab row — carries `en-status`, `content-escalation`
 * @param {object} localeRow the locale tab row — carries `translation-status`,
 *                           `review-status`, and the two crawl columns
 * @returns {{ stage: string|null, order: number, queues: string[],
 *             blocked: boolean, warnings: string[] }}
 *
 * `stage` is null exactly when `blocked` is true. `queues` may be non-empty alongside
 * a real stage (that is what `content-escalation` does). `warnings` surfaces anything
 * unrecognised rather than silently bucketing it — a status nobody can explain is
 * worth more as a visible warning than as a confident wrong number.
 *
 * The evaluation ORDER below is the contract, not an implementation detail. Each step
 * exists because the step above it would otherwise give a wrong answer.
 */
export function classifyTranslation(row, localeRow) {
  const translationRaw = get(localeRow, 'translation-status');
  const translation = translationRaw.toLowerCase();
  const reviewRaw = get(localeRow, 'review-status');
  const review = reviewRaw.toLowerCase();
  const previewed = truthy(get(localeRow, 'previewed'));
  const online = truthy(get(localeRow, 'online'));
  const warnings = [];

  /*
   * 1. The flag first, and applied to EVERY exit path below.
   *
   * This is step 1 because in the original it was not: the early returns for
   * `ready-for-review` and `QA OK` were written before the flag existed and silently
   * dropped it, so exactly the pages furthest along were the ones whose content
   * escalation disappeared from the board.
   */
  const flagged = hasContentEscalation(row) ? ['content-escalation'] : [];
  const withFlag = (result) => ({ ...result, queues: [...result.queues, ...flagged] });

  // 2. A human verdict outranks everything — including a pipeline PASS, and including
  //    a pipeline FAILURE a native speaker has since looked at and accepted.
  if (REVIEW_BLOCKERS[review]) {
    return withFlag({
      stage: null, order: -1, queues: [REVIEW_BLOCKERS[review]], blocked: true, warnings,
    });
  }
  if (review === 'ready-for-review') {
    return withFlag({
      stage: 'inReview', order: STAGE_INDEX.inReview, queues: [], blocked: false, warnings,
    });
  }
  if (review === 'translation ok') {
    // Signed off. Whether it is `online` is still an observed fact, not a claim.
    const stage = online ? 'online' : 'reviewOk';
    return withFlag({
      stage, order: STAGE_INDEX[stage], queues: [], blocked: false, warnings,
    });
  }
  // 3. An unrecognised human verdict is a warning, not a stage. Fall through.
  if (reviewRaw !== '' && !KNOWN_REVIEW.has(review)) {
    warnings.push(`unknown review-status: "${reviewRaw}"`);
  }

  /*
   * 4. NOT ON THE PREVIEW HOST = not translated, full stop, whatever is recorded.
   *
   * The clamp. Presence is OBSERVED; a status column is a cached derivation, and
   * nothing in this system ever clears one. A page that was translated, judged, and
   * then withdrawn from preview must read `sentForTranslation` — not `autoQaPass`
   * from the last run. Without this line the board's most advanced numbers are also
   * its least trustworthy ones.
   */
  if (!previewed) {
    const wasForward = translation !== '' && translation !== 'sent' && !TRANSLATION_BLOCKERS[translation];
    if (wasForward) {
      warnings.push(`recorded "${translationRaw}" but nothing answers on the preview host `
        + '— it was withdrawn, or the status is stale');
    }
    // Still legitimately in flight, or never sent at all.
    if (translation === 'sent' || translation === 'preview-missing') {
      const q = translation === 'preview-missing' ? ['awaiting-preview'] : [];
      return withFlag({
        stage: translation === 'preview-missing' ? null : 'sentForTranslation',
        order: translation === 'preview-missing' ? -1 : STAGE_INDEX.sentForTranslation,
        queues: q,
        blocked: translation === 'preview-missing',
        warnings,
      });
    }
    /*
     * The clamp is about the STAGE, never about the QUEUE.
     *
     * This branch is general on purpose. It used to name `send-fail` alone, so the
     * other six blockers (`untranslated`, `unlocalized-links`, `auto-qa-fail`,
     * `auto-qa-escalate`, `visual-qa-fail`, `publish-fail`) fell through to the
     * English fallback below and came back `{stage:'enPublished', queues:[],
     * blocked:false}` with NO warning: the queue, the blocked flag and any trace that
     * a human owed an answer all vanished, for exactly the pairs where something had
     * already gone wrong. Clamping a stage is honest — a withdrawn page is not
     * translated. Deleting the work item is not, and doing it silently is the same
     * class of failure as the dropped content-escalation flag at step 1.
     *
     * `preview-missing` is a blocker too, but it is answered above with its own
     * queue, so it never reaches here.
     *
     * It warns only for the blockers the pipeline could not have produced WITHOUT
     * reading the page off the preview host — a judged verdict on a page that now
     * answers nothing means it was withdrawn or the row is stale, and that is worth a
     * human's attention. `send-fail` is excluded: the send never happened, so nothing
     * on preview is the definition of that status rather than a contradiction, and
     * warning about it would be a tautology on every failed send.
     */
    if (TRANSLATION_BLOCKERS[translation]) {
      if (translation !== 'send-fail') {
        warnings.push(`recorded "${translationRaw}" and nothing answers on the preview host `
          + '— the queue stands, but the page is not translated');
      }
      return withFlag({
        stage: null,
        order: -1,
        queues: [TRANSLATION_BLOCKERS[translation]],
        blocked: true,
        warnings,
      });
    }
    const en = classifyEnglish(row);
    return withFlag({
      stage: en.stage, order: en.order, queues: [], blocked: false, warnings,
    });
  }

  /*
   * 5. The ungated guard.
   *
   * A `translation-status` on a pair whose English page was never marked published is
   * not progress — it is a mis-send, or a stale row from before the gate existed.
   * Reporting it as forward motion inflates the only number anyone reads.
   */
  if (translation !== '' && !passedSendGate(row)) {
    const en = classifyEnglish(row);
    warnings.push(`translation-status "${translationRaw}" but en-status is not en-published `
      + '— not counted as sent');
    return withFlag({
      stage: en.stage, order: en.order, queues: [], blocked: false, warnings,
    });
  }

  // 6. A blocking pipeline verdict pulls the pair into a queue and out of the funnel.
  if (TRANSLATION_BLOCKERS[translation]) {
    return withFlag({
      stage: null, order: -1, queues: [TRANSLATION_BLOCKERS[translation]], blocked: true, warnings,
    });
  }

  /*
   * 7. Forward position.
   *
   * A blank status on a pair that IS on the preview host means the tiers have not run
   * yet — a real and common state, because a translation can arrive without the
   * pipeline being told. That is exactly the queue `tx:batch` works from, so it reads
   * `previewed`, not `enPublished`.
   */
  let stage = TRANSLATION_FORWARD[translation];
  if (!stage) {
    stage = 'previewed';
    // Distinguish "a value we know but did not expect here" from "a value nobody
    // defined", because the two need different fixes: a model bug vs a typo in a cell.
    warnings.push(KNOWN_TRANSLATION.has(translation)
      ? `translation-status "${translationRaw}" is not a forward state here`
      : `unknown translation-status: "${translationRaw}"`);
  } else if (translation === '') {
    stage = 'previewed';
  }

  // Signed-off-and-live is handled at step 2; a live page with no verdict is still
  // only `layoutQaPass` at best. Publishing without review is possible but is not
  // progress the model will claim on a reviewer's behalf.
  if (online && STAGE_INDEX[stage] >= STAGE_INDEX.autoQaPass) {
    warnings.push('answering on the live host without a reviewer sign-off');
  }

  return withFlag({
    stage, order: STAGE_INDEX[stage], queues: [], blocked: false, warnings,
  });
}

/* ------------------------------------------------- the regression-guard pair */

/**
 * The stage a `translation-status` implies ON ITS OWN, ignoring `review-status`.
 *
 * `classifyTranslation` deliberately lets a human verdict win — `ready-for-review`
 * puts a pair at `inReview` whatever the pipeline recorded. That is right for the
 * board and useless for asking "would writing this status move the pair forwards or
 * backwards?", because whenever a review-status is set, classify compares two
 * identical answers and every write looks safe.
 *
 * In the SAS original that is precisely how a reconcile silently moved 33 rows from
 * `visual-qa-pass` back to `judge-dredd-ok`: all 33 carried `ready-for-review`, so
 * the guard built on classify() could not fire. The function and the reason are both
 * ported. Any writer that claims to prevent regressions must use THIS.
 */
export function translationStage(status) {
  const s = String(status ?? '').trim().toLowerCase();
  return TRANSLATION_FORWARD[s] || null;
}

/** Funnel index of a `translation-status` alone; -1 when it implies no stage. */
export const translationOrder = (status) => {
  const stage = translationStage(status);
  return stage ? STAGE_INDEX[stage] : -1;
};

/* --------------------------------------------------------------- progress bands */

/**
 * The progress bar as a reader scans it, left to right.
 *
 * Coarser than PAGE_STAGES on purpose: from outside the pipeline "auto QA is running"
 * is one fact, not three, so the two QA stages and the two review stages each collapse
 * into one band.
 */
export const PROGRESS_BUCKETS = [
  { id: 'catalogued', label: 'Catalogued' },
  { id: 'enPublished', label: 'EN published' },
  { id: 'sent', label: 'Sent' },
  { id: 'previewed', label: 'Previewed' },
  { id: 'autoQa', label: 'Auto QA passed' },
  { id: 'inReview', label: 'In review' },
  { id: 'reviewOk', label: 'Signed off' },
  { id: 'online', label: 'Online' },
];

const BUCKET_FOR_STAGE = {
  catalogued: 'catalogued',
  enPublished: 'enPublished',
  sentForTranslation: 'sent',
  previewed: 'previewed',
  autoQaPass: 'autoQa',
  layoutQaPass: 'autoQa',
  inReview: 'inReview',
  reviewOk: 'reviewOk',
  online: 'online',
};

/**
 * Which band does a STAGE ID collapse into? `null` for anything that is not a stage.
 *
 * Exported because a board has to explain the collapse, not just apply it: the primer
 * renders "these two stages are one band" from the map itself, and `group-progress`
 * dims the columns a band cannot reach. Both would otherwise carry a second copy of
 * this table, and the two QA stages folding into one band is exactly the kind of
 * detail a hand-written copy gets right once and then loses.
 */
export const bucketForStage = (id) => BUCKET_FOR_STAGE[id] ?? null;

/**
 * Which band does this pair sit in? `null` when it is not on the line at all, so it
 * can be counted as inventory without being counted as progress.
 *
 * Furthest-along-first by construction (the stage already is), so a pair appears in
 * exactly one band and the bands sum to the total.
 */
export function progressBucket(row, localeRow) {
  if (!countsAsPage(row)) return null;
  const { stage } = classifyTranslation(row, localeRow);
  return stage ? BUCKET_FOR_STAGE[stage] : null;
}

/* ------------------------------------------------------------- zeroed accumulators */

export const emptyStageCounts = () => Object.fromEntries([
  ...PAGE_STAGES.map((s) => [s.id, 0]),
  ['blocked', 0],
]);

export const emptyQueueCounts = () => Object.fromEntries(QUEUES.map((q) => [q.id, 0]));

export const emptyBucketCounts = () => Object.fromEntries(PROGRESS_BUCKETS.map((b) => [b.id, 0]));

/**
 * Tally a list of (row, localeRow) pairs into stage, queue and bucket counts.
 *
 * Defined ONCE and used for the locale summary, the group drill-in and the rollup, so
 * three views cannot disagree about one number.
 *
 * Returns nested objects deliberately — `{ stages, queues, buckets, total, counted }`
 * rather than a flat spread. The SAS original returned a flat shape and callers wrote
 * `{ ...tally(x), ...stage }`, which silently shadowed every key the two had in
 * common. Nesting makes that impossible to write by accident.
 */
export function tally(pairs) {
  const stages = emptyStageCounts();
  const queues = emptyQueueCounts();
  const buckets = emptyBucketCounts();
  let total = 0;
  let counted = 0;
  const warnings = [];

  const accumulate = (row, localeRow) => {
    const result = classifyTranslation(row, localeRow);
    if (result.blocked) stages.blocked += 1;
    else if (result.stage) stages[result.stage] += 1;

    for (const q of result.queues) {
      if (QUEUE_IDS.has(q)) queues[q] += 1;
    }

    const bucket = result.stage ? BUCKET_FOR_STAGE[result.stage] : null;
    if (bucket) buckets[bucket] += 1;

    for (const w of result.warnings) {
      warnings.push({ path: get(row, 'page-path'), locale: get(localeRow, 'locale'), warning: w });
    }
  };

  for (const { row, localeRow } of pairs) {
    total += 1;
    if (countsAsPage(row)) {
      counted += 1;
      accumulate(row, localeRow);
    }
  }

  return {
    stages, queues, buckets, total, counted, warnings,
  };
}

/* ------------------------------------------------------------------ sheet access */

/**
 * Rows of a named tab, tolerating both DA sheet shapes.
 *
 * A single-sheet doc carries `{ data: [...] }` at the top level; a multi-sheet doc
 * carries `{ <name>: { data: [...] }, ':names': [...] }`. Every reader goes through
 * here so neither shape needs handling twice.
 */
export function sheetRows(doc, tab = 'data') {
  if (!doc) return [];
  if (doc[tab] && Array.isArray(doc[tab].data)) return doc[tab].data;
  if (tab === 'data' && Array.isArray(doc.data)) return doc.data;
  return [];
}

/** Named tabs of a multi-sheet doc; empty for a single-sheet doc. */
export function sheetTabs(doc) {
  if (!doc) return [];
  if (Array.isArray(doc[':names'])) return doc[':names'];
  return Object.keys(doc).filter((k) => !k.startsWith(':') && doc[k] && Array.isArray(doc[k].data));
}

/**
 * Index a group document's locale tabs by (page path, locale).
 *
 * PAGE path, not base path — the key is the locale row's own stored `page-path`
 * verbatim (normalized), which per the group-document schema is the EN path both
 * tabs carry as the join key; the row's `locale-path` is a separate column. Reading
 * this doc line as `basePath()` and building lookups that way makes every call
 * return `{}`, and `{}` classifies as `catalogued`/`enPublished` — a silent
 * under-count with no warning, which is why the wording is worth being exact about.
 *
 * The join between the `data` tab and its ten locale tabs. Returns a Map keyed
 * `"<page-path> <locale>"` — a NUL separator because a path may contain anything
 * a slug allows, and a delimiter that can appear in a key is a silent collision.
 */
export function indexLocaleRows(doc) {
  const map = new Map();
  for (const code of TARGET_LOCALES) {
    for (const r of sheetRows(doc, code)) {
      const path = normalizePath(get(r, 'page-path'));
      if (path) map.set(`${path} ${code}`, r);
    }
  }
  return map;
}

/** Look one pair out of the index built above. Missing is `{}`, never undefined. */
export const localeRowFor = (index, path, code) => index.get(`${normalizePath(path)} ${code}`) || {};

/* ------------------------------------------------------------------- conveniences */

/** Just the stage id, or null when blocked. */
export const deriveStage = (row, localeRow) => classifyTranslation(row, localeRow).stage;

/** A stable CSS class for any stored status value. */
export const statusClass = (value) => String(value || 'none')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '') || 'none';

/** Lookups by id, for labels and hints. */
export const stageMeta = (id) => PAGE_STAGES.find((s) => s.id === id) || null;
export const queueMeta = (id) => QUEUES.find((q) => q.id === id) || null;
export const isStage = (id) => STAGE_IDS.has(id);
export const isQueue = (id) => QUEUE_IDS.has(id);
