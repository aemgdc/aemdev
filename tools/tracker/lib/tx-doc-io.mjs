/**
 * tx-doc-io.mjs — the Node side of the per-(page, locale) TRANSLATION review document.
 *
 * One doc per pair at `/tracker/tx/<locale-path>` (`txDocPath()`). The document's SHAPE
 * lives in scripts/tracker/tx-doc.js — a zero-dependency dual-runtime module the Page
 * Tracker app also reads — so this file owns only the fetch/auth/concurrency plumbing.
 *
 * ─── THE DELIBERATE TWIN, AND THE DUPLICATION TO COLLAPSE ───────────────────
 *
 * This is the sibling of `qa-doc-io.mjs`, which does the same job for the English QA
 * doc. Its header carries the full reasoning for the seven-step write sequence and every
 * step is there for the same reason here — read the WHY there, not twice:
 *
 *   1. READ and keep a version token (ETag → Last-Modified → SHA-256 of the body; a DA
 *      `.html` GET returns NEITHER header, so on this endpoint the hash is the only
 *      validator that exists)
 *   2. BUILD the next body in jsdom, through the tx-doc.js writers
 *   3. PROVE the edit is in scope: `docOutsideFindings()` must be byte-identical
 *   4. RE-READ immediately before writing and compare the token
 *   5. SNAPSHOT into DA's version history — NO SNAPSHOT, NO WRITE
 *   6. WRITE, then PREVIEW, and REPORT the preview result
 *   7. READ BACK and re-prove step 3
 *
 * `readDoc`/`postDoc`/`createDoc`/`snapshot` below are the same four operations as that
 * file's. **They should be one shape-agnostic core with two adapters.** They are not yet
 * because the two files landed in parallel, and hoisting one out from under the other
 * mid-write is how both end up broken. Collapsing them is a known, wanted follow-up: the
 * shapes differ only in which module's writers run in step 2 and which sections step 3
 * treats as machine-owned.
 *
 * ─── Why a document per pair at all ─────────────────────────────────────────
 *
 * A DA `.json` sheet supports `If-Match`; a DA `.html` document has no ETag and ignores
 * `If-Unmodified-Since`. There is no server-side precondition for an edit — which is
 * exactly why per-pair verdicts live in one document per pair rather than as rows in a
 * shared sheet. THE DOCUMENT GRANULARITY IS THE CONCURRENCY CONTROL. Ten locale
 * reviewers on one page are writing ten different files and cannot collide at all;
 * writing their verdicts into one sheet would mean ten reviewers and a running batch all
 * POSTing the same whole document, and every collision destroys somebody's finished
 * review.
 *
 * NOTHING HERE THROWS INTO A BATCH. Every path returns `{ ..., reason }`. A review
 * document is a reviewer's surface, not a gate: it must never fail the run that
 * triggered it.
 */
import { createHash } from 'node:crypto';
// jsdom is a devDependency on purpose: nothing a visitor loads reaches this file.
// eslint-disable-next-line import/no-extraneous-dependencies
import { JSDOM } from 'jsdom';
import { locale as localeFor, normalizePath, pathForLocale } from '../../../scripts/tracker/locales.js';
import {
  daSourceUrl, previewApiUrl, daEditUrl, txDocPath, previewUrl, DA_ADMIN, ORG, SITE,
} from '../../../scripts/tracker/paths.js';
import {
  buildTxDocHtml, applyTierFindings, applyPipelineStatus, applyReviewVerdict,
  appendReviewLog, serializeTxDoc, docOutsideFindings, readTxDoc as parseTxDoc, TIER_SECTIONS,
} from '../../../scripts/tracker/tx-doc.js';
import { resolveToken, TOKEN_HINT, aemAdminHeaders } from './status-sheet.mjs';

/**
 * The review-doc path for a pair.
 *
 * `txDocPath()` is the canonical spelling and config.mjs defaults every registry entry's
 * `txNotesPath` to the same constant, so the two agree unless a group has deliberately
 * been pointed elsewhere. Honouring the override costs one line and makes the registry
 * field mean what it says.
 */
export function docPathFor(sheetCfg, enPath, code) {
  if (!sheetCfg?.txNotesPath) return txDocPath(enPath, code);
  const localePath = pathForLocale(enPath, code);
  if (!localePath) throw new Error(`docPathFor: unknown locale "${code}"`);
  return `${sheetCfg.txNotesPath}${normalizePath(localePath)}`;
}

/** Everything a caller needs to point a reviewer at the doc. */
export const docLinksFor = (sheetCfg, enPath, code) => {
  const path = docPathFor(sheetCfg, enPath, code);
  return { path, edit: daEditUrl(path) };
};

/** A version token for a document with no ETag. A real validator beats a derived one. */
const versionOf = (res, body) => res.headers.get('ETag')
  || res.headers.get('Last-Modified')
  || `sha256:${createHash('sha256').update(body).digest('hex')}`;

async function readDoc(path, token) {
  const res = await fetch(daSourceUrl(path, 'html'), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return { exists: false, status: 404 };
  if (!res.ok) return { exists: false, status: res.status, error: `GET ${res.status}` };
  const html = await res.text();
  return {
    exists: true, status: 200, html, version: versionOf(res, html),
  };
}

const docForm = (path, html) => {
  const form = new FormData();
  form.append('data', new Blob([html], { type: 'text/html' }), `${path.split('/').pop()}.html`);
  return form;
};

const previewResult = (pv) => ({
  previewed: pv.ok,
  previewError: pv.ok ? null : (pv.headers.get('x-error') || `preview ${pv.status}`),
});

async function postDoc(path, token, html, branch) {
  const post = await fetch(daSourceUrl(path, 'html'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: docForm(path, html),
  });
  if (!post.ok) return { ok: false, status: post.status, reason: `POST ${post.status}` };
  const pv = await fetch(previewApiUrl(path, branch), { method: 'POST', headers: aemAdminHeaders(token) });
  return { ok: true, ...previewResult(pv) };
}

/**
 * Create if and only if it does not exist, with `If-None-Match: '*'`.
 *
 * The precondition is not belt-and-braces on top of the 404 check, it IS the check. A
 * GET-then-POST has a window, and two locales' drivers scaffolding docs for the same EN
 * page at the same moment is the ordinary case here rather than the exotic one — there
 * are ten of them.
 */
async function createDoc(path, token, html, branch) {
  const post = await fetch(daSourceUrl(path, 'html'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*' },
    body: docForm(path, html),
  });
  if (post.status === 412) return { ok: false, exists: true, reason: 'already created by another writer (412)' };
  if (!post.ok) return { ok: false, reason: `create POST ${post.status}` };
  const pv = await fetch(previewApiUrl(path, branch), { method: 'POST', headers: aemAdminHeaders(token) });
  return { ok: true, ...previewResult(pv) };
}

/** Snapshot into DA's own version history. `/versionsource/`, not `/source/`. */
async function snapshot(path, token, label) {
  const res = await fetch(`${DA_ADMIN}/versionsource/${ORG}/${SITE}${path}.html`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
  return { ok: res.ok, status: res.status };
}

/* ------------------------------------------------------------------- public API */

/**
 * Create a pair's review doc if it is missing. Never touches an existing one.
 *
 * The pipeline must not overwrite a review doc, ever: whatever a native reviewer typed
 * there survives every re-run, and the rule is enforced HERE rather than in tx-doc.js
 * because only this layer can see whether the doc exists.
 */
export async function ensureTxDoc(sheetCfg, {
  enPath, code, title, branch, translationStatus = '', sentAt = '', token = null,
}) {
  const auth = token || resolveToken();
  if (!auth) return { created: false, reason: `no DA token (${TOKEN_HINT})` };
  const loc = localeFor(code);
  if (!loc) return { created: false, reason: `unknown locale "${code}"` };
  const path = docPathFor(sheetCfg, enPath, code);
  const ref = branch || sheetCfg?.branch;
  try {
    const existing = await readDoc(path, auth);
    if (existing.exists) return { created: false, path, reason: 'already exists (left untouched)' };
    if (existing.status !== 404) return { created: false, path, reason: `existence check ${existing.status}` };

    const html = buildTxDocHtml({
      title: title || enPath,
      locale: loc.code,
      localeName: loc.name,
      enUrl: previewUrl(enPath, ref),
      localeUrl: previewUrl(pathForLocale(enPath, loc.code), ref),
      editUrl: daEditUrl(pathForLocale(enPath, loc.code)),
      translationStatus,
      sentAt,
    });
    const put = await createDoc(path, auth, html, ref);
    if (!put.ok) return { created: false, path, reason: put.reason };
    return {
      created: true, path, previewed: put.previewed, previewError: put.previewError,
    };
  } catch (e) {
    return { created: false, path, reason: `create failed: ${e.message}` };
  }
}

/**
 * Write a run's tier findings into a pair's review doc, and change NOTHING else.
 *
 * `findings` is keyed by section heading (`TIER_SECTIONS`). A missing key EMPTIES that
 * section, which is correct: the run looked and found nothing. That split is the whole
 * point of the document — the pipeline owns the findings, the human owns the verdict and
 * the notes, and they share one file without either overwriting the other.
 *
 * `dryRun` runs steps 1–3 and stops, returning the diff it WOULD have made. That is what
 * lets a batch's `--dry-run` print the actual document edit instead of a count of
 * documents.
 */
export async function writeTxFindings(sheetCfg, {
  enPath, code, findings = {}, log = null, translationStatus = null, sentAt = '',
  actor = 'tx pipeline', at = new Date().toISOString(), branch = null, token = null,
  dryRun = false,
}) {
  const auth = token || resolveToken();
  if (!auth) return { written: false, reason: `no DA token (${TOKEN_HINT})` };
  const path = docPathFor(sheetCfg, enPath, code);
  const ref = branch || sheetCfg?.branch;

  try {
    const first = await readDoc(path, auth);
    if (!first.exists) {
      return {
        written: false,
        path,
        reason: first.status === 404 ? 'no review doc yet — scaffold it first' : `read ${first.status}`,
      };
    }

    const { document } = new JSDOM(first.html).window;
    const before = parseTxDoc(document);
    const invariant = docOutsideFindings(document);

    applyTierFindings(document, findings);
    if (translationStatus !== null) {
      applyPipelineStatus(document, {
        translationStatus, sentAt, actor, at,
      });
    }
    if (log) appendReviewLog(document, log, { at });

    /*
     * The scope proof. `applyPipelineStatus` and `appendReviewLog` legitimately write
     * OUTSIDE the findings sections (the metadata block and the log), so they are applied
     * after the invariant is captured and the comparison is made only when neither ran.
     * Checking it unconditionally would refuse every run that logs anything — which is
     * how a safety check gets deleted instead of understood.
     */
    const scoped = translationStatus === null && !log;
    if (scoped && docOutsideFindings(document) !== invariant) {
      return { written: false, path, reason: 'REFUSED — writing findings would have changed more than the findings' };
    }

    const next = serializeTxDoc(document);
    if (next === first.html) return { written: false, path, reason: 'no change (findings already match)' };

    const after = parseTxDoc(document);
    const plan = {
      path,
      edit: daEditUrl(path),
      sections: TIER_SECTIONS.map((h) => ({
        section: h,
        was: before.findings[h] || [],
        now: after.findings[h] || [],
      })),
      ...(translationStatus !== null
        ? { translationStatus: { was: before.translationStatus, now: after.translationStatus } }
        : {}),
      ...(log ? { log } : {}),
      // The reviewer's own fields, so a plan can PROVE it is not touching them.
      reviewStatus: before.status,
      notes: before.notes.length,
    };
    if (dryRun) {
      return {
        written: false, dryRun: true, path, plan,
      };
    }

    // Re-read: this doc may be open in DA in front of a reviewer right now.
    const current = await readDoc(path, auth);
    if (!current.exists) return { written: false, path, reason: `pre-write re-read ${current.status}` };
    if (current.version !== first.version) {
      return { written: false, path, reason: 'changed while findings were being prepared — left alone' };
    }

    const snap = await snapshot(path, auth, `tx findings ${at}`);
    if (!snap.ok) return { written: false, path, reason: `no version snapshot (${snap.status}) — findings not written` };

    const put = await postDoc(path, auth, next, ref);
    if (!put.ok) return { written: false, path, reason: put.reason };

    const verify = await readDoc(path, auth);
    if (!verify.exists) return { written: true, path, reason: `written but unverifiable (${verify.status})` };
    if (scoped && docOutsideFindings(new JSDOM(verify.html).window.document) !== invariant) {
      return {
        written: true,
        path,
        reason: `WRITTEN AND SOMETHING ELSE CHANGED — restore the DA version of ${path}`,
      };
    }
    return {
      written: true,
      path,
      plan,
      previewed: put.previewed,
      previewError: put.previewError,
    };
  } catch (e) {
    return { written: false, path, reason: `write failed: ${e.message}` };
  }
}

/**
 * Read one pair's review doc, parsed.
 *
 * The read direction is what `qa:sync` and `tx:reconcile` are built on: the DOCUMENT is
 * where the human typed, so on `review-status` it WINS over the sheet. Returns
 * `{ exists: false }` for a missing doc rather than throwing — a pair whose doc has not
 * been scaffolded is an ordinary state, not an error.
 */
export async function fetchTxDoc(sheetCfg, enPath, code, token = null) {
  const auth = token || resolveToken();
  if (!auth) return { exists: false, reason: `no DA token (${TOKEN_HINT})` };
  const path = docPathFor(sheetCfg, enPath, code);
  const res = await readDoc(path, auth);
  if (!res.exists) {
    return {
      exists: false, path, status: res.status, reason: res.error || 'not found',
    };
  }
  return {
    exists: true, path, edit: daEditUrl(path), doc: parseTxDoc(new JSDOM(res.html).window.document),
  };
}

/**
 * Write a REVIEW VERDICT into the doc — the human's own field.
 *
 * Used only by a tool acting on a human's instruction (`tx:reconcile --to-doc`), never by
 * a QA tier. It is separate from `writeTxFindings` for exactly that reason: the two touch
 * different halves of the document and one function that could write either half is one
 * bug away from a pipeline signing off its own work.
 */
export async function writeReviewVerdict(sheetCfg, {
  enPath, code, reviewStatus, note = null, actor = 'tx:reconcile',
  at = new Date().toISOString(), branch = null, token = null, dryRun = false,
}) {
  const auth = token || resolveToken();
  if (!auth) return { written: false, reason: `no DA token (${TOKEN_HINT})` };
  const path = docPathFor(sheetCfg, enPath, code);
  const ref = branch || sheetCfg?.branch;
  try {
    const first = await readDoc(path, auth);
    if (!first.exists) return { written: false, path, reason: `read ${first.status}` };
    const { document } = new JSDOM(first.html).window;
    const before = parseTxDoc(document);
    applyReviewVerdict(document, {
      reviewStatus, actor, note, at,
    });
    const next = serializeTxDoc(document);
    if (next === first.html) return { written: false, path, reason: 'no change' };
    const plan = {
      path, edit: daEditUrl(path), reviewStatus: { was: before.status, now: reviewStatus },
    };
    if (dryRun) {
      return {
        written: false, dryRun: true, path, plan,
      };
    }
    const current = await readDoc(path, auth);
    if (current.version !== first.version) {
      return { written: false, path, reason: 'changed while the verdict was being prepared — left alone' };
    }
    const snap = await snapshot(path, auth, `review verdict ${at}`);
    if (!snap.ok) return { written: false, path, reason: `no version snapshot (${snap.status}) — verdict not written` };
    const put = await postDoc(path, auth, next, ref);
    if (!put.ok) return { written: false, path, reason: put.reason };
    return {
      written: true, path, plan, previewed: put.previewed, previewError: put.previewError,
    };
  } catch (e) {
    return { written: false, path, reason: `write failed: ${e.message}` };
  }
}
