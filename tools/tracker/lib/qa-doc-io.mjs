/**
 * qa-doc-io.mjs — the Node side of the per-page EN QA document.
 *
 * One doc per English page at `/tracker/qa/<en-path>` (`qaDocPath()`), mirroring the
 * content tree so an index page and a same-named page in another section cannot
 * collide at the root. The document's SHAPE lives in scripts/tracker/qa-doc.js — a
 * zero-dependency dual-runtime module the Page Tracker app also reads — so this file
 * owns only the fetch/auth/concurrency plumbing. That split is what keeps the DA app
 * and the pipeline from growing two opinions about where a verdict is written.
 *
 * ─── WHY THIS FILE IS LONGER THAN A POST ────────────────────────────────────
 *
 * A DA `.json` sheet supports `If-Match`. A DA `.html` document has NO ETag AT ALL,
 * and `If-Unmodified-Since` is ignored (see lib/status-sheet.mjs). So there is no
 * server-side precondition available for an edit — which is precisely why per-page
 * verdicts live in one doc per page rather than as rows in a shared sheet: the
 * document granularity IS the concurrency control, and two QA engineers working two
 * pages cannot collide at all.
 *
 * What is left to defend against is the one real race: a doc open in DA in front of a
 * human while automation writes to it. The sequence below is the whole defence, and
 * every step of it is there because of a way this goes wrong:
 *
 *   1. READ, and keep a version token. `ETag`, else `Last-Modified`, else a SHA-256
 *      of the body. The hash fallback is not paranoia — a DA `.html` GET returns
 *      neither header, so on this endpoint the hash is the ONLY validator that exists,
 *      and a comparison that silently has nothing to compare is worse than none.
 *   2. BUILD the next body in jsdom, through the qa-doc.js writers. These documents
 *      are hand-edited in DA's rich-text editor, which reflows the HTML on save;
 *      regex-patching one breaks the first time a human touches it.
 *   3. PROVE the edit is in scope, BEFORE writing: `docOutsideFindings()` serializes
 *      everything outside the machine-owned sections and must be byte-identical.
 *      Structural, not field-by-field — the source's first version of this check
 *      compared parsed `notes`, which read as absent when the prose was typed as
 *      paragraphs, so a diff that destroyed them compared equal.
 *   4. RE-READ immediately before writing and compare the token. A change here means
 *      a human's save landed inside our read-to-write window; we skip rather than
 *      overwrite them.
 *   5. SNAPSHOT into DA's own version history. NO SNAPSHOT, NO WRITE — that is what
 *      makes the rollback path for anything this gets wrong a human clicking restore
 *      in the DA UI.
 *   6. WRITE, then PREVIEW, and report the preview result rather than firing and
 *      forgetting: a doc whose source POST succeeds and whose preview is refused
 *      exists in DA, is never served, and leaves every caller printing success.
 *   7. READ BACK and re-prove step 3. A 200 is not evidence the right bytes landed.
 *
 * Create is the one operation with a real server-side precondition: `If-None-Match:
 * '*'`, which admin.da.live honours. A 412 there means somebody else created the doc
 * first, which makes create-if-missing race-safe.
 *
 * NOTHING HERE THROWS INTO A BATCH. Every path returns `{ ..., reason }`. A QA
 * document is a reviewer's surface, not a gate: it must never fail the run that
 * triggered it — the same contract lib/status-sheet.mjs states for the sheet.
 */
import { createHash } from 'node:crypto';
// jsdom is a devDependency on purpose: nothing a visitor loads reaches this file.
// eslint-disable-next-line import/no-extraneous-dependencies
import { JSDOM } from 'jsdom';
import { normalizePath } from '../../../scripts/tracker/locales.js';
import {
  daSourceUrl, previewApiUrl, daEditUrl, qaDocPath, previewUrl, liveUrl, DA_ADMIN, ORG, SITE,
} from '../../../scripts/tracker/paths.js';
import {
  buildQaDocHtml, applyQaFindings, appendQaLog, applyEnStatus, serializeQaDoc,
  docOutsideFindings, readQaDoc as parseQaDoc, FINDING_SECTIONS,
} from '../../../scripts/tracker/qa-doc.js';
import { resolveToken, TOKEN_HINT, aemAdminHeaders } from './status-sheet.mjs';

/**
 * The doc path for a page.
 *
 * `qaDocPath()` is the canonical spelling and config.mjs defaults every registry
 * entry's `qaNotesPath` to the same constant, so the two agree unless a group has
 * deliberately been pointed somewhere else. Honouring the override costs one line and
 * makes the registry field mean what it says.
 */
export const docPathFor = (sheetCfg, enPath) => (sheetCfg?.qaNotesPath
  ? `${sheetCfg.qaNotesPath}${normalizePath(enPath)}`
  : qaDocPath(enPath));

/** Everything a caller needs to point a human at the doc. */
export const docLinksFor = (sheetCfg, enPath) => {
  const path = docPathFor(sheetCfg, enPath);
  return { path, edit: daEditUrl(path) };
};

/**
 * A version token for a document with no ETag.
 *
 * Order matters: a real validator beats a derived one. The hash is over the body, so
 * it changes exactly when the content does — which is stricter than `Last-Modified`
 * (one-second granularity) and available where nothing else is.
 */
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
  return { exists: true, status: 200, html, version: versionOf(res, html) };
}

async function postDoc(path, token, html, branch) {
  const form = new FormData();
  form.append('data', new Blob([html], { type: 'text/html' }), `${path.split('/').pop()}.html`);
  const post = await fetch(daSourceUrl(path, 'html'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!post.ok) return { ok: false, status: post.status, reason: `POST ${post.status}` };
  const pv = await fetch(previewApiUrl(path, branch), {
    method: 'POST',
    headers: aemAdminHeaders(token),
  });
  return {
    ok: true,
    previewed: pv.ok,
    previewError: pv.ok ? null : (pv.headers.get('x-error') || `preview ${pv.status}`),
  };
}

/**
 * Create the doc if and only if it does not exist, with `If-None-Match: '*'`.
 *
 * The precondition is not belt-and-braces on top of the 404 check — it is the check.
 * A GET-then-POST has a window, and two locales' drivers scaffolding the same EN page
 * at the same moment is the ordinary case rather than the exotic one.
 */
async function createDoc(path, token, html, branch) {
  const form = new FormData();
  form.append('data', new Blob([html], { type: 'text/html' }), `${path.split('/').pop()}.html`);
  const post = await fetch(daSourceUrl(path, 'html'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'If-None-Match': '*' },
    body: form,
  });
  if (post.status === 412) return { ok: false, exists: true, reason: 'already created by another writer (412)' };
  if (!post.ok) return { ok: false, reason: `create POST ${post.status}` };
  const pv = await fetch(previewApiUrl(path, branch), {
    method: 'POST',
    headers: aemAdminHeaders(token),
  });
  return {
    ok: true,
    previewed: pv.ok,
    previewError: pv.ok ? null : (pv.headers.get('x-error') || `preview ${pv.status}`),
  };
}

/**
 * Snapshot a doc into DA's own version history before touching it.
 *
 * `/versionsource/` and not `/source/`: it is a different endpoint with a different
 * shape, and the label it takes is what a human sees in the DA restore list. Same
 * rule the source pipeline applied to every doc it edited that a human also edits:
 * no snapshot, no write.
 */
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
 * Create the EN QA doc for a page if it is missing. Never touches an existing one.
 *
 * The pipeline must not overwrite a doc, ever: whatever a reviewer wrote there
 * survives every re-run, and that rule is enforced HERE rather than in qa-doc.js
 * because only this layer can see whether the doc exists.
 */
export async function ensureQaDoc(sheetCfg, {
  enPath, title, branch, enStatus = '', token = null,
}) {
  const auth = token || resolveToken();
  if (!auth) return { created: false, reason: `no DA token (${TOKEN_HINT})` };
  const path = docPathFor(sheetCfg, enPath);
  const ref = branch || sheetCfg?.branch;
  try {
    const existing = await readDoc(path, auth);
    if (existing.exists) return { created: false, path, reason: 'already exists (left untouched)' };
    if (existing.status !== 404) return { created: false, path, reason: `existence check ${existing.status}` };

    const html = buildQaDocHtml({
      title: title || enPath,
      previewUrl: previewUrl(enPath, ref),
      liveUrl: liveUrl(enPath, ref),
      editUrl: daEditUrl(enPath),
      enStatus,
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
 * Write a run's findings into the doc, and change NOTHING else.
 *
 * `findings` is keyed by section heading (`{ 'Structural Check': [...], 'Fidelity
 * Findings': [...] }`). A missing key EMPTIES that section, which is correct: the run
 * looked and found nothing. `log` appends one line to the append-only audit trail —
 * the only place an automated event belongs.
 *
 * `dryRun` runs steps 1–3 and stops, returning the diff it would have made. That is
 * what makes a batch's `--dry-run` able to show the actual document edit rather than
 * a count of documents.
 */
export async function writeQaFindings(sheetCfg, {
  enPath, findings = {}, log = null, enStatus = null, actor = 'qa pipeline',
  at = new Date().toISOString(), branch = null, token = null, dryRun = false,
}) {
  const auth = token || resolveToken();
  if (!auth) return { written: false, reason: `no DA token (${TOKEN_HINT})` };
  const path = docPathFor(sheetCfg, enPath);
  const ref = branch || sheetCfg?.branch;

  try {
    const first = await readDoc(path, auth);
    if (!first.exists) {
      return { written: false, path, reason: first.status === 404 ? 'no QA doc yet — scaffold it first' : `read ${first.status}` };
    }

    const { document } = new JSDOM(first.html).window;
    const before = parseQaDoc(document);
    const invariant = docOutsideFindings(document);

    applyQaFindings(document, findings);
    if (enStatus !== null) applyEnStatus(document, { enStatus, actor, at });
    if (log) appendQaLog(document, log, { at });

    /*
     * The scope proof. `applyEnStatus` and `appendQaLog` legitimately write OUTSIDE
     * the findings sections (the metadata block and the log), so they are applied
     * after the invariant is captured and the comparison is made only when neither
     * ran. Checking it unconditionally would refuse every run that logs anything —
     * which is how a safety check gets deleted instead of understood.
     */
    const scoped = enStatus === null && !log;
    if (scoped && docOutsideFindings(document) !== invariant) {
      return { written: false, path, reason: 'REFUSED — writing findings would have changed more than the findings' };
    }

    const next = serializeQaDoc(document);
    if (next === first.html) return { written: false, path, reason: 'no change (findings already match)' };

    const after = parseQaDoc(document);
    const plan = {
      path,
      edit: daEditUrl(path),
      sections: FINDING_SECTIONS.map((h) => ({
        section: h,
        was: before.findings[h] || [],
        now: after.findings[h] || [],
      })),
      ...(enStatus !== null ? { enStatus: { was: before.enStatus, now: after.enStatus } } : {}),
      ...(log ? { log } : {}),
    };
    if (dryRun) return { written: false, dryRun: true, path, plan };

    // Re-read: this doc may be open in DA in front of a reviewer right now.
    const current = await readDoc(path, auth);
    if (!current.exists) return { written: false, path, reason: `pre-write re-read ${current.status}` };
    if (current.version !== first.version) {
      return { written: false, path, reason: 'changed while findings were being prepared — left alone' };
    }

    const snap = await snapshot(path, auth, `qa findings ${at}`);
    if (!snap.ok) return { written: false, path, reason: `no version snapshot (${snap.status}) — findings not written` };

    const put = await postDoc(path, auth, next, ref);
    if (!put.ok) return { written: false, path, reason: put.reason };

    const verify = await readDoc(path, auth);
    if (!verify.exists) return { written: true, path, reason: `written but unverifiable (${verify.status})` };
    const verified = new JSDOM(verify.html).window.document;
    if (scoped && docOutsideFindings(verified) !== invariant) {
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

/** Read a page's QA doc and hand back the parsed model (or why not). */
export async function fetchQaDoc(sheetCfg, enPath, token = null) {
  const auth = token || resolveToken();
  if (!auth) return { exists: false, reason: `no DA token (${TOKEN_HINT})` };
  const path = docPathFor(sheetCfg, enPath);
  const res = await readDoc(path, auth);
  if (!res.exists) return { exists: false, path, reason: res.error || 'not found' };
  return { exists: true, path, doc: parseQaDoc(new JSDOM(res.html).window.document) };
}
