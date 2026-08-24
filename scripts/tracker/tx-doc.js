/*
 * tx-doc.js — the per-(page, locale) TRANSLATION review document model.
 *
 * Browser + Node. Zero dependencies, no DOM globals, no `node:*`. See ./README.md.
 *
 * Sibling of `qa-doc.js`, same contract and same reasons: the CALLER supplies the
 * `Document` (browser `document` / `DOMParser`, Node `jsdom`), because these docs are
 * hand-edited in DA's rich-text editor — which reflows the HTML on save, so
 * regex-patching them would break the first time a reviewer touched one — and because
 * a DOM global here would make the file unimportable in Node and fork the parsing
 * logic in two. `buildTxDocHtml()` is the exception: it creates a doc from scratch.
 *
 * One doc per (page, locale), at `txDocPath(path, code)` — `/tracker/tx/<locale-path>`.
 *
 * ─── Why a doc per pair, and not columns on a sheet ────────────────────────────
 *
 * DA has no partial-write API: recording a verdict in a sheet means GETting the whole
 * multi-sheet doc, editing one cell and POSTing all of it back. That races TEN
 * reviewers — one per locale — against each other and against the pipeline, on one
 * document, and the casualty of every collision is somebody's finished review.
 *
 * One doc per pair removes the class: the German reviewer and the Japanese reviewer
 * working the same page are writing different files. The locale tab's `review-status`
 * column is DERIVED from these docs by `sync-review-status`, which keeps the pipeline
 * the single writer of the sheet.
 *
 * ─── The dual write ───────────────────────────────────────────────────────────
 *
 * Every verdict is recorded TWICE, always in the same call:
 *
 *   - a visible `TRANSLATION STATUS: <marker>` line, so a reviewer can read and
 *     hand-edit it in DA. Non-negotiable — the people using these documents are
 *     translators and native-speaker reviewers, not engineers, and a verdict they
 *     cannot see is a verdict they will not trust.
 *   - a `metadata` block, which EDS hoists into `<meta name="review-status">`, so the
 *     `aemdev-tracker` index can report a whole locale's state in one fetch instead
 *     of one request per page. That is the entire reason the block exists.
 *
 * ─── Precedence on READ, per field ────────────────────────────────────────────
 *
 *   field                      wins            why
 *   review-status              visible line    the reviewer's own judgement, and the
 *                              (else metadata) line is what they edit. Metadata is
 *                                              the app's mirror, so it is only
 *                                              consulted when there is no line.
 *   translation-status         metadata ONLY   a fact about what the pipeline did,
 *   sent-at                                    not a judgement anyone is invited to
 *                                              overrule by typing — and the only
 *                                              form a machine can compare.
 *   locale                     metadata ONLY   identity, written once at scaffold.
 *   review-actor/-updated      metadata ONLY   provenance of the last write.
 *   findings / notes / log     the document    machine sections, prose, audit trail.
 *
 * `legacy` and `mismatch` are different states and are reported separately:
 *   legacy   — a valid visible marker with NO metadata mirror. Every doc scaffolded
 *              before the block existed reads this way; reporting them all as
 *              inconsistent would bury the real signal. They gain a block, in
 *              agreement, on the next write.
 *   mismatch — both exist and disagree, i.e. someone hand-edited one of them.
 *              Reported, never resolved here: the app shows it under "needs
 *              attention" and realigns both on the next save. Picking a winner
 *              silently is how a reviewer's verdict gets lost.
 *
 * ─── One marker parser ────────────────────────────────────────────────────────
 *
 * The marker VOCABULARY and its regex live in `stages.js` and are imported. Nothing
 * here re-implements them: the source had a second copy in its crawler, complete with
 * its own marker→status table, and the two drifted until they disagreed about which
 * markers existed. A reader with no DOM (the crawl, reading published `.plain.html`)
 * should call `reviewStatusFromDocText()` from `stages.js` directly.
 */

import { locale as localeByCode } from './locales.js';
import { docMarkerFor, REVIEW_STATUS_RE, reviewStatusFromMarker } from './stages.js';
import {
  addStatusLine,
  appendLogLine,
  docOutsideSections,
  emptySectionHtml,
  EMPTY_ISSUE,
  EMPTY_NOTES,
  escapeHtml,
  itemsUnder,
  labelledLineEl,
  linkLineHtml,
  markerIn,
  metadataBlockHtml,
  readMetadata,
  setItems,
  writeMetadata,
} from './qa-doc.js';

/* Re-exported so a caller writing findings into either doc imports one string. */
export { EMPTY_ISSUE, EMPTY_NOTES, readMetadata, writeMetadata };

/* --------------------------------------------------------------- the sections */

/**
 * The pipeline's own findings, one section per tier, in document order.
 *
 * `Preview Check` is tier 0 — does the translated page answer on the preview host at
 * all, and is it actually translated. It is a section rather than a warning because
 * "the page is still English" is the single most common finding and the reviewer must
 * see it before reading anything else.
 */
export const TIER_SECTIONS = ['Preview Check', 'Translation Findings', 'Layout Findings'];

/** Where the reviewer's prose lives (replaced wholesale by a verdict write). */
export const NOTES_SECTION = 'Reviewer Notes';

/** Append-only audit trail — one line per verdict written. Always last. */
export const LOG_SECTION = 'Translation Review Log';

/**
 * Metadata keys. Identical to the locale-tab column names and to the
 * `aemdev-tracker` index properties, so `sync-review-status` maps them 1:1 and no
 * layer has to translate a vocabulary.
 */
export const LOCALE_KEY = 'locale';
export const REVIEW_STATUS_KEY = 'review-status';
export const REVIEW_ACTOR_KEY = 'review-actor';
export const REVIEW_UPDATED_KEY = 'review-updated';
export const TRANSLATION_STATUS_KEY = 'translation-status';
export const SENT_AT_KEY = 'sent-at';

/**
 * The label of the visible marker line.
 *
 * This file knows the label because it WRITES the line; it does not know the marker
 * vocabulary, which stays in `stages.js`. Locating the line goes by label and
 * interpreting it goes by `REVIEW_STATUS_RE`, deliberately: that regex matches only
 * known markers, so a line a reviewer typo'd (`TRANSLATION STATUS: OKAY`) would
 * otherwise be invisible to the writer below and get a SECOND, contradictory marker
 * line inserted above it. Found by label, it is corrected in place.
 *
 * Must stay in step with the label inside `REVIEW_STATUS_RE`. The test asserts that
 * the line this module writes is matched by that regex, so a drift fails the build
 * rather than silently producing docs nothing can read.
 */
export const MARKER_LABEL = 'TRANSLATION STATUS';

const MARKER_LABEL_RE = new RegExp(`${MARKER_LABEL}\\s*:`, 'i');

const SECTION_ORDER = [...TIER_SECTIONS, NOTES_SECTION, LOG_SECTION];

/** The sections that must stay BELOW `heading`, nearest first (see `listFor`). */
const laterSections = (heading) => SECTION_ORDER.slice(SECTION_ORDER.indexOf(heading) + 1);

/** The visible marker line's text for a `review-status`. Unknown → PENDING. */
export const markerLineText = (reviewStatus) => `${MARKER_LABEL}: ${docMarkerFor(reviewStatus)}`;

/* ------------------------------------------------------------------ scaffolding */

/**
 * A brand-new translation review doc.
 *
 * CREATE-IF-MISSING ONLY — the pipeline never overwrites an existing doc, so a
 * reviewer's notes always survive a re-translation. The caller enforces that, being
 * the only side that can see whether the doc exists.
 *
 * `localeName` defaults to the registry's English name for the code, so ten
 * scaffolders cannot spell "Chinese (Simplified)" ten ways in ten thousand docs.
 */
export function buildTxDocHtml({
  title,
  locale,
  localeName = '',
  enUrl = '',
  localeUrl = '',
  editUrl = '',
  reviewStatus = '',
  translationStatus = '',
  sentAt = '',
}) {
  const known = localeByCode(locale);
  const name = localeName || known?.name || locale;
  return [
    '<body><header></header><main><div>',
    `<h1>${escapeHtml(name)} review — ${escapeHtml(title)}</h1>`,
    // Only the links we were given: a line reading "English: " with nothing after it
    // states less than no line at all.
    ...(enUrl ? [linkLineHtml('English', enUrl)] : []),
    ...(localeUrl ? [linkLineHtml(name, localeUrl)] : []),
    ...(editUrl ? [linkLineHtml('DA Edit', editUrl)] : []),
    `<p><strong>${escapeHtml(markerLineText(reviewStatus))}</strong></p>`,
    ...TIER_SECTIONS.flatMap((h) => emptySectionHtml(h, EMPTY_ISSUE)),
    ...emptySectionHtml(NOTES_SECTION, EMPTY_NOTES),
    // No log section: it is created by the first verdict, so an untouched doc does
    // not show an empty audit trail.
    metadataBlockHtml({
      [LOCALE_KEY]: locale,
      [REVIEW_STATUS_KEY]: reviewStatus,
      [REVIEW_ACTOR_KEY]: '',
      [REVIEW_UPDATED_KEY]: '',
      [TRANSLATION_STATUS_KEY]: translationStatus,
      [SENT_AT_KEY]: sentAt,
    }),
    '</div></main><footer></footer></body>',
  ].join('\n');
}

/* ------------------------------------------------------------------- reading */

/** The element carrying the visible marker line, or null on a doc that has none. */
export const markerEl = (doc) => labelledLineEl(doc, MARKER_LABEL_RE);

/** Everything a consumer needs from a translation review doc. */
export function readTxDoc(doc) {
  const el = markerEl(doc);
  const marker = el ? markerIn(el.textContent, REVIEW_STATUS_RE) : null;
  // '' is a real status (PENDING), so absence has to be null and not ''.
  const fromMarker = marker ? reviewStatusFromMarker(marker) : null;

  const metadata = readMetadata(doc);
  const hasMetadata = REVIEW_STATUS_KEY in metadata;
  const fromMeta = hasMetadata ? (metadata[REVIEW_STATUS_KEY] ?? '').trim() : null;

  /*
   * Compared case-insensitively. `TRANSLATION OK` is a literal uppercase-with-space
   * stored value that every other reader in the model matches via `.toLowerCase()`
   * (see stages.js), so a cell a human typed as "translation ok" is the same verdict
   * — reporting it as a disagreement would send someone looking for a conflict that
   * is not there.
   */
  const fold = (v) => String(v ?? '').trim().toLowerCase();

  return {
    title: (doc.querySelector('h1')?.textContent || '').trim(),
    marker,
    hasMarker: Boolean(marker),
    // The line is present but its value is outside the vocabulary — surfaced as a
    // data-quality warning rather than bucketed as "not reviewed".
    markerUnknown: Boolean(el) && marker === null,
    // The visible line wins; metadata is the fallback for a doc that lost its line.
    status: fromMarker ?? fromMeta ?? null,
    metaStatus: fromMeta,
    locale: metadata[LOCALE_KEY] || null,
    translationStatus: (metadata[TRANSLATION_STATUS_KEY] ?? '').trim(),
    sentAt: (metadata[SENT_AT_KEY] ?? '').trim(),
    actor: (metadata[REVIEW_ACTOR_KEY] ?? '').trim(),
    updated: (metadata[REVIEW_UPDATED_KEY] ?? '').trim(),
    metadata,
    legacy: !hasMetadata,
    mismatch: fromMarker !== null && hasMetadata && fold(fromMarker) !== fold(fromMeta),
    findings: Object.fromEntries(TIER_SECTIONS.map((h) => [h, itemsUnder(doc, h)])),
    notes: itemsUnder(doc, NOTES_SECTION),
    log: itemsUnder(doc, LOG_SECTION),
  };
}

/* ------------------------------------------------------------------- writing */

/**
 * Record a reviewer's verdict: the visible marker line and the metadata together,
 * the prose replaced, one line appended to the log.
 *
 * Both representations are written in the SAME call, never separately, because a
 * partial write is exactly what produces the `mismatch` state this file exists to
 * detect.
 *
 * The prose is replaced rather than appended because the drawer submits the whole
 * notes box — appending would duplicate every line the reviewer did not delete.
 * (The escalation flag on the EN doc is the opposite case, and appends.)
 *
 * `at` is the caller's clock, so the caller owns the timestamp and tests stay
 * deterministic.
 */
export function applyReviewVerdict(doc, {
  reviewStatus, actor = '', note = null, at = '',
}) {
  const marker = docMarkerFor(reviewStatus);
  const text = `${MARKER_LABEL}: ${marker}`;
  const el = markerEl(doc);
  // A doc a human stripped the line out of gets it back, above the first section.
  if (el) el.textContent = text;
  else addStatusLine(doc, text);

  writeMetadata(doc, {
    [REVIEW_STATUS_KEY]: reviewStatus ?? '',
    [REVIEW_ACTOR_KEY]: actor,
    [REVIEW_UPDATED_KEY]: at,
  });

  if (note !== null) {
    const lines = String(note).split('\n').map((l) => l.trim()).filter(Boolean);
    setItems(doc, NOTES_SECTION, lines, {
      empty: EMPTY_NOTES, before: laterSections(NOTES_SECTION),
    });
  }

  appendLogLine(doc, LOG_SECTION, [marker, actor, at]);
  return doc;
}

/**
 * Mirror the pipeline's own state into the metadata, and change nothing else.
 *
 * Metadata only, and deliberately no visible line: `translation-status` is a fact
 * about what the pipeline did and `sent-at` is the one value in the whole model that
 * nothing can observe or re-derive (see stages.js) — a hand-editable line would
 * invite a reviewer to "correct" testimony, and the next scan would overwrite their
 * edit without explanation.
 *
 * A CHANGE is logged; a re-run recording the same value is not. A batch that keeps
 * saying `preview-ok` is not an event, and an audit trail nobody can read is not an
 * audit trail.
 *
 * Blank values are IGNORED rather than written, so a caller holding only one of the
 * two facts cannot erase the other — the same rule the sheet's `LOCALE_PRESERVED`
 * columns follow. Clearing is not a thing the pipeline is allowed to do here.
 */
export function applyPipelineStatus(doc, {
  translationStatus = '', sentAt = '', actor = '', at = '',
}) {
  const before = readMetadata(doc);
  const patch = {};
  const status = String(translationStatus ?? '').trim();
  const sent = String(sentAt ?? '').trim();
  if (status && status !== (before[TRANSLATION_STATUS_KEY] ?? '').trim()) {
    patch[TRANSLATION_STATUS_KEY] = status;
  }
  if (sent && sent !== (before[SENT_AT_KEY] ?? '').trim()) patch[SENT_AT_KEY] = sent;
  if (!Object.keys(patch).length) return { doc, changed: false };

  writeMetadata(doc, patch);
  if (patch[TRANSLATION_STATUS_KEY]) {
    appendLogLine(doc, LOG_SECTION, [`PIPELINE: ${status}`, actor, at]);
  }
  return { doc, changed: true };
}

/**
 * Write the tiers' findings into the doc, replacing each machine-owned section.
 *
 * Called by the driver after a run, so a reviewer opening the doc sees what the three
 * tiers found without going anywhere else — and, more to the point, does not spend
 * their time re-finding it.
 *
 * `findings` is keyed by section heading: `{ 'Translation Findings': [...], … }`. A
 * missing key empties that section, which is correct — the tier looked and found
 * nothing. Replacing wholesale is only safe because the reviewer's prose lives under
 * its own heading; an earlier shape shared one section, and the second run of any
 * tier deleted the note explaining why the first run's finding was acceptable.
 *
 * Deliberately NOT logged: a tier that keeps saying "clean" is not an event.
 */
export function applyTierFindings(doc, findings = {}) {
  for (const section of TIER_SECTIONS) {
    setItems(doc, section, findings[section] || [], { before: laterSections(section) });
  }
  return doc;
}

/**
 * Append one line to the review log, and change NOTHING else.
 *
 * Narrower than the writers above on purpose. These documents are open in front of
 * reviewers while automation runs, so a tool that only needs to say "this ran again"
 * must not touch a verdict, a marker line, a metadata cell, or a word of anyone's
 * prose. The log is the append-only audit trail and the only place an automated event
 * belongs.
 */
export function appendReviewLog(doc, text, { at = '' } = {}) {
  appendLogLine(doc, LOG_SECTION, [text, at]);
  return doc;
}

/**
 * The part of a doc a findings rewrite must leave BYTE-IDENTICAL: everything outside
 * the tier sections. Structural rather than field-by-field, for the reason given on
 * `docOutsideSections` — a check that compared parsed fields read prose typed as
 * paragraphs as absent, so a diff that destroyed it compared equal.
 */
export const docOutsideFindings = (doc) => docOutsideSections(doc, TIER_SECTIONS);

/** Serialize back to the `<body>…</body>` form DA stores. */
export const serializeTxDoc = (doc) => doc.body.outerHTML;
