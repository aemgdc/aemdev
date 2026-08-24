/*
 * da-source.js — every DA read and write the Page Tracker makes.
 *
 * ─── Three asymmetries, each one a past failure ─────────────────────────────
 *
 * 1. **DA addresses a sheet and a document differently, and the path you GET is
 *    the path you POST.** A sheet is `<path>.json`, a document is `<path>.html`.
 *    Every URL here goes through `daSourceUrl(path, ext)` from paths.js, which
 *    THROWS without an explicit `ext` for exactly this reason — there is no safe
 *    default, and guessing GETs a document that is not there and concludes the
 *    page does not exist.
 *
 * 2. **Reads come from `admin.da.live/source`, not from the published feed.** The
 *    published copy lags a write until the doc is previewed, so an app that both
 *    reads and writes the group sheet would show its own edits as stale. The one
 *    exception is the per-page tier report (`FEEDS.txReport`), which this app only
 *    reads and never writes — that comes from the published feed, relative to the
 *    host serving the app.
 *
 * 3. **This app DOES write the group sheet**, unlike the app it is ported from.
 *    There, verdicts went to per-page documents because a sheet write means POSTing
 *    the whole multi-sheet doc back and nine reviewers would clobber each other.
 *    Here the sheet is small (four groups, 19 pages) and a `.json` source DOES
 *    carry an ETag, so the write can be made genuinely conditional — which the
 *    `.html` documents cannot be. See `updateSheet` for the full discipline.
 *
 * Everything authenticated goes through DA_SDK's `actions.daFetch`, which attaches
 * the user's own IMS token and re-authenticates on a 401. Never hand-roll an
 * Authorization header for admin.da.live here.
 */

import {
  FEEDS, TRACKER_GROUPS, daListUrl, daSourceUrl, previewApiUrl, slugOf,
} from '../../scripts/tracker/paths.js';
import { TARGET_LOCALES, normalizePath } from '../../scripts/tracker/locales.js';
import {
  EN_STATUSES, REVIEW_STATUSES, CONTENT_ESCALATION_COLUMN,
  indexLocaleRows, sheetRows, sheetTabs,
} from '../../scripts/tracker/stages.js';

/* ------------------------------------------------------------------ the session */

let daFetch = null;
let imsToken = null;

/**
 * Hand the module the SDK's fetch and token.
 *
 * `token` is used ONLY for the AEM admin preview call — `admin.hlx.page` is a
 * different service from `admin.da.live` and `daFetch` does not target it. This
 * site's admin API answers unauthenticated (`site.json` sets
 * `access.admin.requireAuth: "false"`, see docs/tracker/RESUME.md), so the headers
 * are sent when we have them and their absence is not an error.
 */
export function initDaSource(actions, token = null) {
  daFetch = actions?.daFetch || null;
  imsToken = token || null;
}

const requireFetch = () => {
  if (!daFetch) throw new Error('da-source not initialised — call initDaSource(actions, token) first');
  return daFetch;
};

const sheetUrl = (group) => daSourceUrl(FEEDS.group(group).replace(/\.json$/, ''), 'json');
const filenameFor = (group) => `${group}.json`;

/* --------------------------------------------------------------- group discovery */

/**
 * Which groups have a sheet in DA?
 *
 * DISCOVERED, not listed. The registry of group NAMES lives in
 * `tools/tracker/lib/group-map.mjs`, which is `.mjs` and Node-only — a browser
 * cannot import it, and copying the list here would give the app a private opinion
 * about which groups exist that could disagree with the pipeline's. The DA folder
 * listing is the one answer both sides already agree on: a group the app can work
 * is exactly a group with a sheet.
 *
 * `/list/` is a different verb on a different path shape from `/source/` — it takes
 * a directory with no extension and answers `[{ name, ext, path }]`.
 *
 * A 404 on the folder is the NORMAL state before `group:scaffold` has run, so it
 * comes back as an empty list plus the reason, never as a throw. The caller renders
 * that as the primary empty state.
 */
export async function listGroups() {
  const where = TRACKER_GROUPS;
  try {
    const res = await requireFetch()(daListUrl(TRACKER_GROUPS));
    if (!res.ok) {
      return { groups: [], where, error: `${daListUrl(TRACKER_GROUPS)} → ${res.status}` };
    }
    const list = await res.json();
    const groups = (Array.isArray(list) ? list : [])
      .filter((e) => e && e.ext === 'json' && e.name)
      .map((e) => String(e.name).replace(/\.json$/, ''))
      .sort((a, b) => a.localeCompare(b));
    return { groups, where, error: null };
  } catch (e) {
    return { groups: [], where, error: e.message };
  }
}

/* -------------------------------------------------------------------- sheet read */

/*
 * Strip a weak-ETag prefix before using the value in `If-Match`.
 *
 * Load-bearing, and measured in both directions on this service (recorded in
 * tools/tracker/lib/status-sheet.mjs): Cloudflare sits in front of admin.da.live and
 * rewrites the origin's strong ETag into a WEAK one (`W/"<hash>"`) whenever it gzips
 * the response — which it does for every browser, since every browser sends
 * `Accept-Encoding: gzip`. `If-Match` requires STRONG comparison, so a weak
 * validator never matches and the write always 412s. The inner hash is the origin's
 * real validator, so sending that succeeds:
 *
 *   GET gzip -> W/"abc"   If-Match: W/"abc" -> 412   If-Match: "abc" -> 200
 *
 * Without this every conditional write fails closed, which for this app means every
 * button reporting "the sheet changed since it was read" for ever.
 */
const strongEtag = (etag) => (etag ? etag.replace(/^W\//, '') : null);

const PATH_COLUMN = 'page-path';

/**
 * One group's sheet, straight from DA source, with its ETag.
 *
 * `exists: false` is a real state — a group whose sheet has never been scaffolded —
 * and is returned rather than thrown, because at zero that is the state the app
 * spends most of its life in and the empty state has to explain it.
 *
 * Rows with a blank `page-path` are dropped: `emptyGroupDoc()` writes one because
 * da.live collapses a single-tab sheet to single-sheet form on save, so every freshly
 * scaffolded group carries a placeholder that is not a page (`countsAsPage()` agrees).
 */
export async function readGroupSheet(group, { fresh = false } = {}) {
  const url = sheetUrl(group);
  let res;
  try {
    /*
     * `fresh` bypasses the HTTP cache, and it exists for exactly one caller: the
     * read-back that confirms a write.
     *
     * This is the one place the app CANNOT share the pipeline's code path and get the
     * same answer. Node's fetch has no HTTP cache, so `updateStatusDoc`'s identical
     * confirm read always sees the write it just made. A browser's fetch does have one,
     * so the confirm read was served the PRE-WRITE body and every successful write
     * reported "the write reported success but <column> did not land" — a false negative
     * on a write that had in fact landed, which is the worst possible way for this to
     * fail: it teaches an author to distrust a guard that is working.
     */
    res = await requireFetch()(url, fresh ? { cache: 'no-store' } : undefined);
  } catch (e) {
    return { exists: false, error: `${url} → ${e.message}`, where: url };
  }
  if (res.status === 404) return { exists: false, error: null, where: url };
  if (!res.ok) return { exists: false, error: `${url} → ${res.status}`, where: url };

  let doc;
  try {
    doc = await res.json();
  } catch (e) {
    // DA has served a truncated sheet before; to a reader that is the same fact as
    // no sheet at all, but it must not read as "this group has no pages".
    return { exists: false, error: `${url} → unparseable JSON (${e.message})`, where: url };
  }

  const tabs = sheetTabs(doc);
  /*
   * A tab no locale is registered for is REPORTED, never ignored. Locale rows are read
   * per registered locale rather than per tab found, so a misspelled tab name would
   * otherwise make that whole locale read as ten blank rows — untranslated, with no
   * warning anywhere. The same guard `loadGroup()` in scripts/tracker/data.js carries.
   */
  const known = new Set(['data', ...TARGET_LOCALES]);
  return {
    exists: true,
    where: url,
    error: null,
    doc,
    version: strongEtag(res.headers.get('ETag')),
    tabs,
    unknownTabs: tabs.filter((t) => !known.has(t)),
    rows: sheetRows(doc, 'data').filter((r) => normalizePath(r?.[PATH_COLUMN])),
    localeIndex: indexLocaleRows(doc),
  };
}

/* ------------------------------------------------------------ the tier report */

/**
 * One page's published tier report, for the drawer.
 *
 * Read RELATIVE and unauthenticated. DA serves this app from the site's own
 * delivery host, so a relative fetch is same-origin, needs no CORS preflight, and
 * reads the same published copy every read-only board reads.
 *
 * Not routed through `scripts/tracker/data.js` for one reason: that layer has no
 * per-page report loader (`FEEDS.txReport` is read by this drawer and nothing else),
 * and its cache is deliberately never invalidated during a page's life — right for a
 * board rendered once, wrong for an app left open across a pipeline run.
 *
 * A 404 is the normal answer today and must not read as "the tiers passed". The
 * caller turns `exists: false` into three "did not run" chips.
 */
export async function readTxReport(code, enPath) {
  const path = FEEDS.txReport(code, slugOf(enPath));
  try {
    const res = await fetch(path);
    if (!res.ok) {
      return {
        exists: false, report: null, findings: [], where: path, error: `${path} → ${res.status}`,
      };
    }
    const doc = await res.json();
    return {
      exists: true,
      report: sheetRows(doc, 'report')[0] || null,
      findings: sheetRows(doc, 'findings'),
      where: path,
      error: null,
    };
  } catch (e) {
    return {
      exists: false, report: null, findings: [], where: path, error: `${path} → ${e.message}`,
    };
  }
}

/* ---------------------------------------------------------------- write guards */

/*
 * ═══ THE ONLY THREE COLUMNS THIS APP MAY WRITE ═══════════════════════════════
 *
 * An ALLOW-LIST, not a deny-list, and the allow-list is the enforcement — a
 * comment saying "do not write the crawl columns" is a comment a future caller
 * does not read.
 *
 *   `en-status`             data tab   — a human's judgement about the English page
 *   `content-escalation`    data tab   — a human's flag on the English source
 *   `review-status`         locale tab — a native speaker's verdict, plus the
 *                                        `review-updated` stamp that dates it
 *
 * It must NEVER write these, and each has a different reason:
 *
 *   `translation-status`  belongs to the pipeline. It is the record of what the
 *                         tiers found; a human overwriting it either erases a
 *                         verdict or invents one, and `classifyTranslation`'s step-4
 *                         clamp cannot correct an invented one because nothing in
 *                         this system ever clears a status column.
 *   `previewed`, `online` are CRAWL OUTPUT, re-observed on every `tx:scan`. A human
 *                         who sets one has produced a value the next scan silently
 *                         reverts — the change appears to land, survives a reload,
 *                         and is gone by morning with nothing to explain it. Worse,
 *                         those two columns are precisely what lets the clamp correct
 *                         a stale status instead of trusting it, so hand-editing them
 *                         disables the model's only self-correction.
 *   `sent-at`             is testimony, set once. "We handed this to the translation
 *                         service" is the one fact in the model that is not
 *                         observable anywhere else.
 *
 * The reviewer's route to any of those is the pipeline: `tx:scan --apply` re-observes
 * the crawl columns, `tx:batch` re-runs the tiers.
 */
const WRITABLE = {
  data: new Set(['en-status', CONTENT_ESCALATION_COLUMN]),
  locale: new Set(['review-status', 'review-updated']),
};

const KNOWN_EN_VALUES = new Set(EN_STATUSES.map((s) => s.value));
const KNOWN_REVIEW_VALUES = new Set(REVIEW_STATUSES.map((s) => s.value));

/**
 * Refuse an envelope the content bus will reject, BEFORE it is written.
 *
 * This is the browser side of the rule `lib/status-sheet.mjs` enforces in Node and
 * `docs/tracker/data-contract.md` §2 states: **a doc with more than one tab MUST
 * carry `:type: 'multi-sheet'` and a `:names` listing every tab.** The single-sheet
 * spelling is ACCEPTED by admin.da.live and then refused AT PREVIEW with
 * `400 error from content-bus`, which leaves DA holding a file every reader 404s
 * while the app reports success. A group sheet is eleven tabs, so this is not a
 * hypothetical.
 *
 * It is a guard over an invariant, not a second copy of a vocabulary: the tab names
 * come from the doc itself, and the only literals are the two envelope keys.
 *
 * The write path round-trips the doc it read, so in the normal case this passes by
 * construction. It fires when the doc in DA is already malformed — a sheet somebody
 * edited in da.live's own editor, which collapses a one-tab multi-sheet doc — and
 * refusing to write is the right answer there: the app would otherwise be the tool
 * that published the unreadable version.
 */
export function assertWritableSheet(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('sheet doc: not an object');
  const tabs = Object.keys(doc).filter((k) => !k.startsWith(':'));
  if (tabs.length > 1) {
    if (doc[':type'] !== 'multi-sheet') {
      throw new Error(`sheet doc: ${tabs.length} tabs require :type "multi-sheet", got `
        + `${JSON.stringify(doc[':type'] ?? null)} — accepted on write, 400 at preview`);
    }
    const names = Array.isArray(doc[':names']) ? doc[':names'] : [];
    const missing = tabs.filter((t) => !names.includes(t));
    const extra = names.filter((n) => !tabs.includes(n));
    if (missing.length || extra.length) {
      throw new Error('sheet doc: :names does not match the tabs '
        + `(missing: ${missing.join(', ') || 'none'}; unknown: ${extra.join(', ') || 'none'})`);
    }
  }
  return doc;
}

const docForm = (doc, filename) => {
  const form = new FormData();
  form.append('data', new Blob([JSON.stringify(doc)], { type: 'application/json' }), filename);
  return form;
};

/* --------------------------------------------------------------- the write path */

/**
 * Set named cells on one row of one tab, safely.
 *
 * The whole sequence, and every step is here because of a way this goes wrong:
 *
 *   1. **re-read immediately before writing**, so the edit merges onto the sheet as
 *      it is now rather than onto whatever was on screen when the drawer opened;
 *   2. check the column names against the allow-list above and the values against
 *      their enum — an unknown value written to a status column is a row every
 *      reader reports as a warning for ever;
 *   3. mutate the row IN PLACE on the doc we just read, so `:type`, `:names` and
 *      every other tab survive by construction rather than by being rebuilt;
 *   4. validate the envelope (`assertWritableSheet`) before the POST;
 *   5. POST with `If-Match: <strong etag>` — a 412 then means somebody else wrote
 *      the sheet in the window between our read and our write, and the answer is to
 *      re-read and re-apply, ONCE. A single retry, not a loop: contention here comes
 *      in bursts (a `tx:scan` writing every locale back to back) and a retry loop
 *      turns a contended sheet into a spin;
 *   6. preview, and REPORT whether it worked. Firing and ignoring the response hides
 *      a whole class of failure: a source POST that succeeds and a preview the
 *      content bus rejects leaves a doc that exists in DA, is never served, and
 *      every caller printing success;
 *   7. **read the doc back and confirm the value is actually there**, rather than
 *      trusting a 200.
 *
 * Returns `{ ok, reason, conflict, previewed, previewError, row }`. Never throws for
 * an expected failure — the caller renders `reason` next to the control.
 */
async function updateSheet(group, {
  tab, pagePath, values,
}) {
  const kind = tab === 'data' ? 'data' : 'locale';
  const allowed = WRITABLE[kind];
  const bad = Object.keys(values).filter((c) => !allowed.has(c));
  if (bad.length) {
    return { ok: false, reason: `refusing to write ${bad.join(', ')} on the ${tab} tab` };
  }

  const path = normalizePath(pagePath);
  const url = sheetUrl(group);
  const fetchFn = requireFetch();

  const attempt = async () => {
    const current = await readGroupSheet(group);
    if (!current.exists) {
      return {
        ok: false,
        reason: current.error || `${FEEDS.group(group)} does not exist — scaffold the group first`,
      };
    }
    if (!current.tabs.includes(tab)) {
      return { ok: false, reason: `no "${tab}" tab in ${FEEDS.group(group)}` };
    }
    const row = sheetRows(current.doc, tab)
      .find((r) => normalizePath(r?.[PATH_COLUMN]) === path);
    if (!row) {
      return {
        ok: false,
        reason: `no row with page-path "${path}" on the ${tab} tab`
          + `${tab === 'data' ? '' : ' — the page has not been sent to this locale yet'}`,
      };
    }
    Object.assign(row, values);
    try {
      assertWritableSheet(current.doc);
    } catch (e) {
      return { ok: false, reason: e.message };
    }

    /*
     * REFUSE, before the POST, rather than falling back to writing anyway.
     *
     * No validator means an UNCONDITIONAL whole-doc write to a shared sheet, which is
     * precisely the operation that loses a concurrent writer's rows while reporting
     * success. A `.json` source on this service always carries an ETag, so its absence
     * is a fault to report, not a degraded mode to proceed in — and the check has to be
     * here and not after the request, or the write it exists to prevent has already
     * happened by the time anyone is told.
     */
    if (!current.version) {
      return {
        ok: false,
        reason: 'the sheet read returned no ETag — refusing an unconditional whole-doc write',
      };
    }

    const post = await fetchFn(url, {
      method: 'POST',
      headers: { 'If-Match': current.version },
      body: docForm(current.doc, filenameFor(group)),
    });
    if (post.status === 412) return { ok: false, conflict: true, reason: 'the sheet changed since it was read' };
    if (!post.ok) return { ok: false, reason: `sheet write failed (${post.status})` };
    return { ok: true };
  };

  let result = await attempt();
  if (result.conflict) result = await attempt();
  if (!result.ok) return result;

  let previewed = true;
  let previewError = null;
  try {
    const pv = await fetch(previewApiUrl(FEEDS.group(group)), {
      method: 'POST',
      headers: imsToken
        ? {
          Authorization: `Bearer ${imsToken}`,
          'x-content-source-authorization': `Bearer ${imsToken}`,
        }
        : {},
    });
    previewed = pv.ok;
    // `x-error` carries the content bus's own reason, which is the only thing that
    // makes a 400 here diagnosable.
    previewError = pv.ok ? null : (pv.headers.get('x-error') || `preview ${pv.status}`);
  } catch (e) {
    previewed = false;
    previewError = e.message;
  }

  const after = await readGroupSheet(group, { fresh: true });
  const saved = after.exists
    ? sheetRows(after.doc, tab).find((r) => normalizePath(r?.[PATH_COLUMN]) === path)
    : null;
  const wrong = Object.entries(values)
    .filter(([k, v]) => String(saved?.[k] ?? '') !== String(v))
    .map(([k]) => k);
  if (!saved || wrong.length) {
    return {
      ok: false,
      reason: `the write reported success but ${wrong.join(', ') || 'the row'} did not land`,
    };
  }

  return {
    ok: true, reason: null, previewed, previewError, row: saved, sheet: after,
  };
}

/* ------------------------------------------------------------- the three actions */

/**
 * Set `en-status` on the `data` row.
 *
 * The value is checked against `EN_STATUSES` RAW, not case-folded, even though every
 * reader of the column folds case. Readers fold because a human types into that cell
 * by hand; a machine writing `EN-Published` would be adding a second spelling to the
 * sheet on purpose, and the model's own comments record what that cost: two functions
 * contradicting each other about one cell.
 */
export async function setEnStatus(group, pagePath, value) {
  if (!KNOWN_EN_VALUES.has(value)) {
    return { ok: false, reason: `"${value}" is not an en-status (expected one of ${[...KNOWN_EN_VALUES].map((v) => v || '<blank>').join(', ')})` };
  }
  return updateSheet(group, { tab: 'data', pagePath, values: { 'en-status': value } });
}

/**
 * Set `review-status` on a locale row, and stamp `review-updated` with it.
 *
 * The two are one fact — a verdict nobody can date is a verdict nobody can trust
 * against a page that has been re-translated since — so they are written together
 * and there is no way to set one without the other.
 */
export async function setReviewStatus(group, pagePath, code, value, at = null) {
  if (!KNOWN_REVIEW_VALUES.has(value)) {
    return { ok: false, reason: `"${value}" is not a review-status (expected one of ${[...KNOWN_REVIEW_VALUES].map((v) => v || '<blank>').join(', ')})` };
  }
  return updateSheet(group, {
    tab: code,
    pagePath,
    values: { 'review-status': value, 'review-updated': at || new Date().toISOString() },
  });
}

/**
 * Toggle `content-escalation` on the `data` row.
 *
 * A FLAG, not a verdict, and it lives on the page rather than the pair: a dead link
 * in the English source is dead in all ten locales. It coexists with any stage, so
 * raising it on a page whose German is signed off leaves the German signed off —
 * which is the whole reason it is its own column instead of a `translation-status`
 * value.
 *
 * Written as the canonical `yes` / `''`. `hasContentEscalation()` reads five
 * spellings because a human types in this cell; a machine gets to write one.
 */
export async function toggleContentEscalation(group, pagePath, on) {
  return updateSheet(group, {
    tab: 'data',
    pagePath,
    values: { [CONTENT_ESCALATION_COLUMN]: on ? 'yes' : '' },
  });
}
