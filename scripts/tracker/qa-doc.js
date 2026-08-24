/*
 * qa-doc.js — the ENGLISH QA-notes document model, and the only place that knows how
 * to read or edit one.
 *
 * Browser + Node. Zero dependencies, no DOM globals, no `node:*`. See ./README.md.
 *
 * One doc per EN page, at `qaDocPath(enPath)` — `/tracker/qa/<en-path>`. Three
 * consumers, which is why the model lives here rather than inside any one of them:
 *   - the Page Tracker DA app (`tools/page-tracker/*`), browser
 *   - the pipeline's doc writer (`tools/tracker/lib/qa-doc-io.mjs`), Node
 *   - the sheet write-back (`tools/tracker/sync-review-status.mjs`), Node
 *
 * ─── The caller supplies the Document ───────────────────────────────────────────
 *
 * Every read and edit below is real DOM work and the `Document` is a parameter: the
 * browser passes `document` (or a `DOMParser` result), Node passes a `jsdom` one.
 * Two reasons, both load-bearing. These docs are hand-edited in DA's rich-text
 * editor, which reflows the HTML on save — regex-patching them would break the
 * first time a human touched one. And a DOM global here would make the file
 * unimportable in Node, which would fork the parsing logic in two. The one
 * exception is `buildQaDocHtml()`: it creates a doc from scratch, so it needs no
 * parse and no Document.
 *
 * ─── The dual write ────────────────────────────────────────────────────────────
 *
 * Anything this doc records, it records TWICE:
 *
 *   - a VISIBLE line (`CONTENT ESCALATION: YES`), so a reviewer can read it — and
 *     edit it — in DA without learning any block syntax. Non-negotiable: the people
 *     using these documents are content owners and reviewers, not engineers, and a
 *     verdict they cannot see is a verdict they will not trust.
 *   - a `metadata` block, which EDS hoists into `<meta name="content-escalation">`,
 *     so the `aemdev-tracker` index can report a whole group's state in ONE fetch
 *     instead of one request per page. That index is the entire reason the block
 *     exists (see PORT-MANIFEST E.4).
 *
 * Every writer here writes both together, in one call, never separately — a partial
 * write is exactly what produces the `mismatch` state described below.
 *
 * ─── Precedence on READ, per field ─────────────────────────────────────────────
 *
 *   field                  wins            why
 *   content-escalation     visible line    a human edits the line; the metadata is
 *                          (else metadata) the app's mirror of it. Absence is
 *                                          meaningful — a CLEARED flag leaves no
 *                                          line at all (a `CONTENT ESCALATION: NO`
 *                                          on every clean page would be noise), so
 *                                          metadata decides when there is no line.
 *   en-status              metadata ONLY   an OBSERVED fact (crawl / `set-en-status`),
 *                                          not a judgement. The sheet column is
 *                                          authoritative and the next scan rewrites
 *                                          it; a hand-editable visible line would
 *                                          create a second authority for a value
 *                                          nobody here owns. It is mirrored into the
 *                                          metadata only so the index can serve it.
 *   qa-actor / qa-updated  metadata ONLY   provenance of the last write. Same reason.
 *   findings sections      the document    machine-owned; replaced wholesale per run.
 *   notes / log            the document    the human's prose, and the audit trail.
 *
 * `legacy` and `mismatch` are NOT the same thing and are reported separately:
 *   legacy   — the doc carries no metadata mirror at all. Every doc scaffolded
 *              before the block existed is in this state; reporting all of them as
 *              inconsistent would bury the real signal. They gain a block, in
 *              agreement, the first time anything writes a verdict.
 *   mismatch — both representations exist and disagree, i.e. someone hand-edited one
 *              of them. Reported, never silently resolved: picking a winner behind a
 *              reviewer's back is how a verdict gets lost.
 *
 * ─── Shared with tx-doc.js ─────────────────────────────────────────────────────
 *
 * The DOM helpers below (`contentRoot`, `headingFor`, `listFor`, `itemsUnder`,
 * `setItems`, `readMetadata`, `writeMetadata`, …) are exported for `tx-doc.js`, the
 * sibling model. The two files this was ported from kept private copies and they
 * drifted: one `itemsUnder` scoped `:scope > li` and the other `li` (so nested items
 * counted twice), one `listFor` grew a `before` anchor and the other did not (so a
 * late-created section landed under the append-only log, where nobody reads it), and
 * the two `writeMetadata`s disagreed about which `.metadata` block wins and whether
 * it stays last. One copy, shared, so that cannot happen again.
 */

import { CONTENT_ESCALATION_COLUMN, CONTENT_ESCALATION_RE, EN_STATUSES } from './stages.js';

/* --------------------------------------------------------------- the sections */

/**
 * The machine-owned sections, in document order. Replaced wholesale on every run,
 * which is only safe because the reviewer's prose lives under its own heading —
 * an earlier shape shared one section and the second run of any check deleted the
 * note explaining why the first run's finding was acceptable.
 */
export const FINDING_SECTIONS = ['Structural Check', 'Fidelity Findings'];

/** Where the reviewer's prose lives (replaced wholesale by a verdict write). */
export const NOTES_SECTION = 'Reviewer Notes';

/** Append-only audit trail — one line per event. Always last. */
export const LOG_SECTION = 'QA Review Log';

/**
 * The "nothing here" placeholder for a findings section.
 *
 * EXPORTED because every writer has to use the same string: `itemsUnder` filters it
 * out, so a writer inventing its own wording (the source's reconcile wrote "No
 * automated findings.") makes the placeholder read back as a genuine finding.
 */
export const EMPTY_ISSUE = 'No findings yet';

/** Same contract as EMPTY_ISSUE, for the prose sections. */
export const EMPTY_NOTES = 'No notes yet';

/**
 * Metadata keys. Deliberately IDENTICAL to the sheet column names and to the
 * `aemdev-tracker` index properties, so `sync-review-status` maps them 1:1 and no
 * layer has to translate a vocabulary.
 */
export const EN_STATUS_KEY = 'en-status';
export const QA_ACTOR_KEY = 'qa-actor';
export const QA_UPDATED_KEY = 'qa-updated';

/**
 * The label of the visible escalation line.
 *
 * This file has to know the label because it WRITES the line; the marker
 * vocabulary stays in `stages.js` and is matched only by the regex exported from
 * there. Locating the line uses the label and interpreting it uses the regex, on
 * purpose: a line a human typo'd (`CONTENT ESCALATION: MAYBE`) is still found and
 * corrected in place, instead of being missed and joined by a second, contradictory
 * line at the top of the doc.
 */
export const ESCALATION_LABEL = 'CONTENT ESCALATION';

const ESCALATION_LABEL_RE = new RegExp(`${ESCALATION_LABEL}\\s*:`, 'i');

const KNOWN_EN_STATUS = new Set(EN_STATUSES.map((s) => s.value));

const SECTION_ORDER = [...FINDING_SECTIONS, NOTES_SECTION, LOG_SECTION];

/**
 * The sections that must stay BELOW `heading`, nearest first.
 *
 * Passed to `listFor` as its `before` anchors, which is what keeps a section
 * created late in the right place instead of appended at the end of the doc.
 */
const laterSections = (heading) => SECTION_ORDER.slice(SECTION_ORDER.indexOf(heading) + 1);

/* ------------------------------------------------------------- html scaffolding */

/**
 * Escape for HTML.
 *
 * `"` is escaped too, because these strings land in `href` attributes as well as in
 * text — a title or URL carrying a quote would otherwise end the attribute.
 */
export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** The `metadata` block as HTML, for the scaffolders. */
export const metadataBlockHtml = (meta) => {
  const rows = Object.entries(meta)
    .map(([k, v]) => `<div><div>${escapeHtml(k)}</div><div>${escapeHtml(v)}</div></div>`)
    .join('');
  return `<div class="metadata">${rows}</div>`;
};

/** A `<h2>` plus its placeholder list, as HTML. */
export const emptySectionHtml = (heading, empty) => [
  `<h2>${escapeHtml(heading)}</h2>`,
  `<ul><li><em>${escapeHtml(empty)}</em></li></ul>`,
];

/** A preamble link line, as HTML. */
export const linkLineHtml = (label, url) => `<p><em>${escapeHtml(label)}: `
  + `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a></em></p>`;

/**
 * A brand-new EN QA-notes doc.
 *
 * CREATE-IF-MISSING ONLY. The pipeline never overwrites an existing doc, so notes
 * already written always survive a re-run — and that rule is enforced by the caller
 * (`qa-doc-io.mjs`), because only it can see whether the doc exists.
 */
export function buildQaDocHtml({
  title, previewUrl = '', liveUrl = '', editUrl = '', enStatus = '',
}) {
  return [
    '<body><header></header><main><div>',
    `<h1>QA notes — ${escapeHtml(title)}</h1>`,
    // Only the links we were given: a line reading "Live: " with nothing after it
    // states less than no line at all.
    ...(previewUrl ? [linkLineHtml('Preview', previewUrl)] : []),
    ...(liveUrl ? [linkLineHtml('Live', liveUrl)] : []),
    ...(editUrl ? [linkLineHtml('DA Edit', editUrl)] : []),
    ...FINDING_SECTIONS.flatMap((h) => emptySectionHtml(h, EMPTY_ISSUE)),
    ...emptySectionHtml(NOTES_SECTION, EMPTY_NOTES),
    // No escalation line: a clear flag leaves none, so a fresh doc has none either.
    // No log section: it is created by the first event, so an untouched doc does not
    // show an empty audit trail.
    metadataBlockHtml({
      [EN_STATUS_KEY]: enStatus,
      [CONTENT_ESCALATION_COLUMN]: '',
      [QA_ACTOR_KEY]: '',
      [QA_UPDATED_KEY]: '',
    }),
    '</div></main><footer></footer></body>',
  ].join('\n');
}

/* ------------------------------------------------------------- the DOM helpers */

/** The content section every block lives in (`main > div`), created if absent. */
export function contentRoot(doc) {
  const main = doc.querySelector('main') || doc.body.appendChild(doc.createElement('main'));
  return main.querySelector(':scope > div') || main.appendChild(doc.createElement('div'));
}

/**
 * The innermost element whose text matches `labelRe` — the visible status line.
 *
 * The `!el.querySelector(...)` guard is what makes it the innermost one, and it is
 * not tidiness: a `<p><strong>CONTENT ESCALATION: YES</strong></p>` matches both the
 * `p` and the `strong`, and setting the `p`'s textContent throws the `strong` away —
 * silently un-bolding the one line a reviewer looks for.
 */
export function labelledLineEl(scope, labelRe) {
  return [...scope.querySelectorAll('strong, b, p, h1, h2, h3')]
    .find((el) => labelRe.test(el.textContent || '') && !el.querySelector('strong, b, p')) || null;
}

/**
 * The marker `re` matches in `text`, or null when the line says something else.
 *
 * `re` is a vocabulary regex exported from `stages.js`, and those regexes have no
 * TRAILING boundary: `TRANSLATION STATUS: OKAY` matches the `OK` alternative and
 * `CONTENT ESCALATION: NOPE` matches `NO`. Left alone, a mistyped marker reads back
 * as a valid verdict — the worst failure a document model can produce, because
 * nothing downstream has any reason to doubt it. So a marker has to end at a
 * non-letter.
 *
 * Only the character AFTER the match is inspected. The vocabulary itself stays in
 * `stages.js`: the source grew a second copy of it in its crawler and the two drifted
 * until they disagreed about which markers existed. Trailing prose is still fine —
 * `OK — but check the date` reads as `OK`, because a parser that demands an exact
 * cell is the brittleness the requirements brief already suffers from.
 */
export function markerIn(text, re) {
  const s = String(text ?? '');
  const m = re.exec(s);
  if (!m) return null;
  return /^[a-z]/i.test(s.slice(m.index + m[0].length)) ? null : m[1].toUpperCase();
}

/**
 * Add a bold status line to the preamble, above the first section heading.
 *
 * Above the headings, not at the end: the status lines are what a reviewer reads
 * first, and a line appended after the append-only log is a line nobody sees.
 */
export function addStatusLine(doc, text) {
  const root = contentRoot(doc);
  const p = doc.createElement('p');
  const strong = doc.createElement('strong');
  strong.textContent = text;
  p.append(strong);
  const firstHeading = root.querySelector(':scope > h2');
  if (firstHeading) root.insertBefore(p, firstHeading);
  else root.append(p);
  return p;
}

/** The `h2`/`h3` whose text is exactly `text`, or null. `scope` may be any element. */
export const headingFor = (scope, text) => [...scope.querySelectorAll('h2, h3')]
  .find((h) => (h.textContent || '').trim().toLowerCase() === text.toLowerCase()) || null;

/**
 * The `<ul>` directly following a heading, created (with the heading) if absent.
 *
 * `before` names the headings the new section must be placed ABOVE — a list, first
 * one present wins, because the sections it anchors against are themselves created
 * on demand and in no guaranteed order. Without it a created section lands at the
 * end of the doc, which in the source put a whole review section BELOW the
 * append-only log: the last thing anyone reads, so effectively invisible.
 */
export function listFor(doc, heading, { create = false, before = [] } = {}) {
  let h = headingFor(doc, heading);
  if (!h) {
    if (!create) return null;
    h = doc.createElement('h2');
    h.textContent = heading;
    const root = contentRoot(doc);
    // The metadata block stays last — EDS reads it from the end of the section, and
    // a human editing the doc expects it there.
    const candidates = [
      ...[before].flat().filter(Boolean).map((t) => headingFor(doc, t)),
      root.querySelector(':scope > .metadata'),
    ];
    const anchor = candidates.find((c) => c && c.parentElement === root);
    if (anchor) root.insertBefore(h, anchor);
    else root.append(h);
  }
  let list = h.nextElementSibling;
  if (!list || list.tagName !== 'UL') {
    if (!create) return null;
    list = doc.createElement('ul');
    h.after(list);
  }
  return list;
}

/** Text of each `<li>` directly under a heading, placeholders dropped. */
export function itemsUnder(doc, heading) {
  const list = listFor(doc, heading);
  if (!list) return [];
  return [...list.querySelectorAll(':scope > li')]
    .map((li) => (li.textContent || '').trim())
    .filter((t) => t && t !== EMPTY_ISSUE && t !== EMPTY_NOTES);
}

/**
 * Replace a section's list with `items`, or with the italic placeholder when empty.
 *
 * `before` is the caller's section order (see `listFor`) rather than this module's,
 * because `tx-doc.js` shares this function and its five sections are not these four.
 * Baking one order in here would put a late-created translation section below the
 * append-only log — the exact bug `before` exists to prevent.
 */
export function setItems(doc, heading, items, { empty = EMPTY_ISSUE, before = [] } = {}) {
  const list = listFor(doc, heading, { create: true, before });
  list.textContent = '';
  if (!items.length) {
    const li = doc.createElement('li');
    const em = doc.createElement('em');
    em.textContent = empty;
    li.append(em);
    list.append(li);
    return list;
  }
  for (const item of items) {
    const li = doc.createElement('li');
    li.textContent = String(item);
    list.append(li);
  }
  return list;
}

/**
 * Append one line to a log section, dropping the placeholder first.
 *
 * The placeholder is not content — left above a real entry it makes the section read
 * as empty.
 */
export function appendLogLine(doc, section, parts, { before = [] } = {}) {
  const log = listFor(doc, section, { create: true, before });
  for (const li of [...log.querySelectorAll(':scope > li')]) {
    const text = (li.textContent || '').trim();
    if (text === EMPTY_NOTES || text === EMPTY_ISSUE) li.remove();
  }
  const entry = doc.createElement('li');
  entry.textContent = [parts].flat().filter(Boolean).join(' — ');
  log.append(entry);
  return entry;
}

/** The doc's `metadata` block as a plain object. */
export function readMetadata(doc) {
  const block = doc.querySelector('.metadata');
  if (!block) return {};
  const out = {};
  for (const row of block.querySelectorAll(':scope > div')) {
    const cells = row.querySelectorAll(':scope > div');
    if (cells.length >= 2) {
      out[(cells[0].textContent || '').trim()] = (cells[1].textContent || '').trim();
    }
  }
  return out;
}

/** Upsert keys into the `metadata` block, creating it (last in the section) if absent. */
export function writeMetadata(doc, patch) {
  const root = contentRoot(doc);
  let block = root.querySelector(':scope > .metadata') || doc.querySelector('.metadata');
  if (!block) {
    block = doc.createElement('div');
    block.className = 'metadata';
    root.append(block);
  }
  const rowFor = (key) => [...block.querySelectorAll(':scope > div')]
    .find((r) => (r.querySelector(':scope > div')?.textContent || '').trim() === key);
  for (const [key, value] of Object.entries(patch)) {
    let row = rowFor(key);
    if (!row) {
      row = doc.createElement('div');
      const k = doc.createElement('div');
      k.textContent = key;
      row.append(k);
      block.append(row);
    }
    /*
     * A row whose value cell a human deleted in DA gets the cell back rather than a
     * second row with the same key. The source skipped the write entirely in that
     * case, so the verdict was silently lost; appending a whole new row instead
     * would grow the block by one row on every save, because the lookup above finds
     * the malformed row first every time.
     */
    const cells = row.querySelectorAll(':scope > div');
    if (cells.length >= 2) {
      cells[1].textContent = value ?? '';
    } else {
      const v = doc.createElement('div');
      v.textContent = value ?? '';
      row.append(v);
    }
  }
  // Metadata must stay the last block in the section for EDS to hoist it.
  if (block.parentElement === root) root.append(block);
  return block;
}

/* ------------------------------------------------------------------- reading */

/** Everything a consumer needs from an EN QA-notes doc. */
export function readQaDoc(doc) {
  const metadata = readMetadata(doc);

  const el = labelledLineEl(doc, ESCALATION_LABEL_RE);
  const line = el ? markerIn(el.textContent, CONTENT_ESCALATION_RE) : null;
  const hasMetadata = CONTENT_ESCALATION_COLUMN in metadata;
  const metaFlag = (metadata[CONTENT_ESCALATION_COLUMN] ?? '').trim().toLowerCase() === 'yes';

  /*
   * The visible line wins when it exists; metadata decides when it does not. The
   * asymmetry is deliberate: clearing the flag REMOVES the line, so "no line" is a
   * legitimate cleared state rather than missing information.
   */
  const contentEscalation = line ? line === 'YES' : metaFlag;

  /*
   * A raised flag nobody can see is the failure mode the visible line exists to
   * prevent, so metadata-says-yes-with-no-line counts as a disagreement — it can
   * only come from a partial write or from someone deleting the line. A cleared
   * flag (no line, metadata blank) is not a disagreement, and a doc with no
   * metadata block at all is `legacy`, not mismatched.
   */
  const mismatch = hasMetadata && (line ? (line === 'YES') !== metaFlag : metaFlag);

  const enStatus = (metadata[EN_STATUS_KEY] ?? '').trim();

  return {
    title: (doc.querySelector('h1')?.textContent || '').trim(),
    contentEscalation,
    escalationLine: line,
    // The line is present but says something outside the vocabulary — surfaced as a
    // data-quality warning rather than bucketed as "not escalated".
    escalationUnknown: Boolean(el) && line === null,
    enStatus,
    enStatusUnknown: enStatus !== '' && !KNOWN_EN_STATUS.has(enStatus),
    actor: (metadata[QA_ACTOR_KEY] ?? '').trim(),
    updated: (metadata[QA_UPDATED_KEY] ?? '').trim(),
    metadata,
    legacy: !hasMetadata,
    mismatch,
    findings: Object.fromEntries(FINDING_SECTIONS.map((h) => [h, itemsUnder(doc, h)])),
    notes: itemsUnder(doc, NOTES_SECTION),
    log: itemsUnder(doc, LOG_SECTION),
  };
}

/* ------------------------------------------------------------------- writing */

/**
 * Set or clear the content-escalation flag — the one human verdict this doc carries.
 *
 * The flag is a FLAG and not a status for the reason `stages.js` gives: "the recap
 * video is a dead link" is true at the same time as "the German translation is ready
 * for review", and it stays true across re-translations. So raising it must not
 * overwrite anything, and clearing it must not promote anything.
 *
 * It is also the one flag that belongs to the PAGE rather than to a (page, locale)
 * pair — a dead link in English is dead in all ten locales — which is why it lives
 * on this doc and not on the ten translation docs, even though a translation
 * reviewer is usually the person who spots it.
 *
 * `note` APPENDS to the reviewer's prose rather than replacing it: an escalation is
 * an addition to the page's record, not a restatement of it, and the flag is often
 * raised on a page that already carries someone's notes.
 *
 * ON  → a visible line in the preamble, plus metadata `yes`.
 * OFF → the line is REMOVED and metadata set to empty, so a page that was flagged
 *       and resolved is indistinguishable from one never flagged, except in the log,
 *       which keeps both events.
 *
 * `at` is the caller's clock rather than this module's, so the caller controls the
 * timestamp and tests stay deterministic.
 */
export function applyContentEscalation(doc, {
  on, actor = '', note = null, at = '',
}) {
  const existing = labelledLineEl(doc, ESCALATION_LABEL_RE);
  if (on) {
    const text = `${ESCALATION_LABEL}: YES`;
    if (existing) existing.textContent = text;
    else addStatusLine(doc, text);
  } else if (existing) {
    (existing.closest('p') ?? existing).remove();
  }

  writeMetadata(doc, {
    [CONTENT_ESCALATION_COLUMN]: on ? 'yes' : '',
    [QA_ACTOR_KEY]: actor,
    [QA_UPDATED_KEY]: at,
  });

  if (note !== null) {
    const list = listFor(doc, NOTES_SECTION, {
      create: true, before: laterSections(NOTES_SECTION),
    });
    for (const li of [...list.querySelectorAll(':scope > li')]) {
      if ((li.textContent || '').trim() === EMPTY_NOTES) li.remove();
    }
    /*
     * Appending is right — an escalation adds to the record — but appending BLINDLY
     * is not. The drawer pre-fills its notes box with the doc's existing notes, so
     * raising a flag without editing that box re-appends every line verbatim. That
     * happened on the source's first real escalation: one page ended up carrying the
     * dead-video note twice. Lines already present are skipped.
     */
    const present = new Set([...list.querySelectorAll(':scope > li')]
      .map((li) => (li.textContent || '').trim()));
    const lines = String(note).split('\n').map((l) => l.trim())
      .filter((l) => l && !present.has(l));
    for (const text of lines) {
      present.add(text);
      const li = doc.createElement('li');
      li.textContent = text;
      list.append(li);
    }
  }

  appendLogLine(doc, LOG_SECTION, [
    on ? 'CONTENT ESCALATION RAISED' : 'CONTENT ESCALATION CLEARED', actor, at,
  ]);
  return doc;
}

/**
 * Mirror the observed `en-status` into the metadata, and change nothing else.
 *
 * Metadata only, and no visible line: the value is observed (a crawl, or
 * `set-en-status`) rather than judged, the sheet column is authoritative, and the
 * next scan rewrites it. A hand-editable line would invite a reviewer to correct a
 * value this document does not own, and their edit would vanish without explanation.
 *
 * A CHANGE is logged; a re-run that records the same value is not. A crawl that
 * keeps saying `en-published` is not an event, and an audit trail nobody can read is
 * not an audit trail.
 */
export function applyEnStatus(doc, { enStatus = '', actor = '', at = '' } = {}) {
  const before = (readMetadata(doc)[EN_STATUS_KEY] ?? '').trim();
  const next = String(enStatus ?? '').trim();
  if (before === next) return { doc, changed: false };
  writeMetadata(doc, { [EN_STATUS_KEY]: next, [QA_ACTOR_KEY]: actor, [QA_UPDATED_KEY]: at });
  appendLogLine(doc, LOG_SECTION, [`EN STATUS: ${next || '(blank)'}`, actor, at]);
  return { doc, changed: true };
}

/**
 * Write the automated findings into the doc, replacing each machine-owned section.
 *
 * Called after a QA run so a reviewer opening the doc sees what the checks found
 * without going anywhere else — and, more to the point, does not spend their time
 * re-finding it.
 *
 * `findings` is keyed by section heading: `{ 'Structural Check': [...], … }`. A
 * missing key empties that section, which is correct: the run looked and found
 * nothing. Deliberately NOT logged — a check that keeps saying "clean" is not an
 * event, and one log line per nightly run would bury the verdicts.
 */
export function applyQaFindings(doc, findings = {}) {
  for (const section of FINDING_SECTIONS) {
    setItems(doc, section, findings[section] || [], { before: laterSections(section) });
  }
  return doc;
}

/**
 * Append one line to the review log, and change NOTHING else.
 *
 * Narrower than the writers above on purpose. These documents are open in front of
 * reviewers while automation runs, so a tool that only needs to say "this ran again"
 * must not touch a flag, a metadata cell, or a word of anyone's prose. The log is
 * the append-only audit trail and the only place an automated event belongs.
 */
export function appendQaLog(doc, text, { at = '' } = {}) {
  appendLogLine(doc, LOG_SECTION, [text, at]);
  return doc;
}

/**
 * The part of a doc a findings rewrite must leave BYTE-IDENTICAL: everything outside
 * the sections named. Shared with `tx-doc.js`, whose sections differ.
 *
 * Structural, not field-by-field, and that is the whole point. The source's first
 * version of this check compared parsed `notes`, which return `[]` unless the prose
 * sits in a `<ul>` immediately after an exact `<h2>` — so notes typed as paragraphs
 * in DA read as absent, and a diff that destroyed them compared equal. Serializing
 * the remainder cannot be fooled by shape: if anything outside the findings sections
 * moved, the string differs.
 */
export function docOutsideSections(doc, headings) {
  const clone = doc.body.cloneNode(true);
  for (const heading of headings) {
    const h = headingFor(clone, heading);
    if (h) {
      let n = h.nextElementSibling;
      while (n && !/^H[1-6]$/.test(n.tagName)) {
        const next = n.nextElementSibling;
        n.remove();
        n = next;
      }
    }
  }
  return clone.outerHTML;
}

/** `docOutsideSections` bound to this doc's machine-owned sections. */
export const docOutsideFindings = (doc) => docOutsideSections(doc, FINDING_SECTIONS);

/** Serialize back to the `<body>…</body>` form DA stores. */
export const serializeQaDoc = (doc) => doc.body.outerHTML;
