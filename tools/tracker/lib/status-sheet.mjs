/**
 * status-sheet.mjs — read/write a DA multi-sheet tracking doc (the group sheets
 * registered in .tracker/orchestrator.json under `groups.<name>`).
 *
 * The shape of every write is the same: GET the full multi-sheet doc, mutate it, POST
 * the whole doc back (untouched tabs pass through unchanged), then preview it. DA has
 * no partial-write API, which is the root reason the tracker keeps per-page verdicts in
 * per-page docs and leaves the sheet to a SINGLE writer — a sheet write is always a
 * whole-doc write, and two of them racing loses one side's rows outright.
 *
 * The row-level helper at the bottom is a side-channel status board, not a QA gate — a
 * failure there (row not found, token missing, network) is returned as a reason and
 * swallowed by the caller so it never fails the run that triggered it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { daSourceUrl, previewApiUrl } from '../../../scripts/tracker/paths.js';
import { sheetRows, sheetTabs } from '../../../scripts/tracker/stages.js';
import { cachedDaToken, DA_TOKEN_CACHE } from './da-ims.mjs';

const TOKEN_FILES = ['today-da-token.txt', 'today-auth-token.txt'].map((f) => join(homedir(), f));

/**
 * The discovery order, as one string.
 *
 * Exported because the order used to be echoed by hand in five separate error messages
 * as well as in `resolveToken()` itself, so a change had to be made in six places and
 * was not. Every "no token" message in the pipeline interpolates this.
 */
export const TOKEN_HINT = `checked DA_TOKEN, ${DA_TOKEN_CACHE}, ${TOKEN_FILES.join(', ')}`;

/**
 * Both Authorization headers an admin.hlx.page request needs.
 *
 * `admin.hlx.page` does not just record a preview: it goes and FETCHES the document
 * from the content source (DA) to build it. So it needs two credentials — one to
 * authorise the call to itself, and one to present to DA on our behalf:
 *
 *     Authorization:                  Bearer <token>
 *     x-content-source-authorization: Bearer <token>
 *
 * This is Adobe's server-to-server guidance for using a single Edge Delivery Services
 * credential against both APIs. With a human-pasted DA *user* token the second header
 * is redundant — verified, both with and without it return 200 — which is exactly why
 * it is safe to send everywhere.
 *
 * Without it, an S2S token authenticates to the AEM admin and then fails to read the
 * source, which surfaces as a preview error rather than an auth error and sends you
 * looking in the wrong place.
 */
export const aemAdminHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  'x-content-source-authorization': `Bearer ${token}`,
});

/** Token extraction tolerant of a pasted JSON blob as well as a bare token. */
function extractToken(raw) {
  if (!raw) return '';
  if (!/^[[{"]/.test(raw)) return raw.trim();
  try {
    const stack = [JSON.parse(raw)];
    while (stack.length) {
      const cur = stack.pop();
      if (cur && typeof cur === 'object') {
        for (const [k, v] of Object.entries(cur)) {
          if (typeof v === 'string' && /^(access_?token|token)$/i.test(k)) return v;
          if (v && typeof v === 'object') stack.push(v);
        }
      }
    }
  } catch { /* not JSON */ }
  return raw.trim();
}

export function resolveToken() {
  if (process.env.DA_TOKEN) return process.env.DA_TOKEN;
  /*
   * A machine-minted S2S token, if one is cached and still good.
   *
   * Preferred over the hand-pasted files because it is refreshed by a token step rather
   * than by a human remembering — a 24h user token is what let a cron write 401s for a
   * day while reporting success. Read synchronously so every caller of this function
   * stays synchronous; minting is a separate, explicit step (lib/da-ims.mjs).
   *
   * Falls through to the files when there is no credential or the cache has lapsed, so
   * a workstation with no S2S credential still works.
   */
  const cached = cachedDaToken();
  if (cached) return cached.token;
  for (const f of TOKEN_FILES) {
    if (existsSync(f)) {
      const token = extractToken(readFileSync(f, 'utf8'));
      if (token) return token;
    }
  }
  return null;
}

/* -------------------------------------------------------------- the doc envelope */

/** A DA sheet object: the row array plus the three counters every reader expects. */
export const sheet = (data) => ({
  total: data.length, limit: data.length, offset: 0, data,
});

/**
 * DA source URL for a registry entry's sheet.
 *
 * `daSourceUrl` refuses to guess an extension — DA addresses a sheet as `.json` and a
 * document as `.html`, and the path you GET is the path you POST — so the registry's
 * `.json` suffix is stripped and handed back explicitly. Normalising here means a
 * registry entry written with or without the suffix resolves to the same URL.
 *
 * `org`/`repo` on the registry entry are NOT read: there is one DA site and its
 * identity lives in scripts/tracker/paths.js, so the URL has exactly one spelling.
 * config.mjs asserts the registry agrees with it at load time.
 */
const withJson = (path) => (String(path).endsWith('.json') ? String(path) : `${path}.json`);
const sourceUrlFor = (sheetCfg) => daSourceUrl(withJson(sheetCfg.path).replace(/\.json$/, ''), 'json');
const filenameFor = (sheetCfg) => withJson(sheetCfg.path).split('/').pop();

const isSheetObject = (v) => Boolean(v) && typeof v === 'object' && Array.isArray(v.data);

/**
 * Refuse a doc the content bus will reject, BEFORE it is written.
 *
 * Two rules, both learned from writes that succeeded and then failed:
 *
 *   1. Every top-level key is either `:`-prefixed metadata or a sheet object
 *      (`{total, limit, offset, data}`). Anything else — a bare timestamp, a stray
 *      count — is refused with "error from content-bus". A scalar that needs to be
 *      published goes in its own single-row sheet (conventionally `meta`).
 *
 *   2. A doc with more than one tab MUST be `:type: 'multi-sheet'` with `:names`
 *      listing the tabs. The malformed single-sheet spelling is ACCEPTED by
 *      admin.da.live and then refused at *preview* with `400 error from content-bus`,
 *      which leaves DA holding a file that every reader 404s and a tool that printed
 *      success. Failing here instead is the whole point of this function.
 *
 * A one-tab doc is allowed to be either shape, because da.live's own sheet editor
 * collapses a one-tab multi-sheet doc to single-sheet on save — which is also why
 * every group sheet is created with its locale tabs already present.
 */
export function assertSheetDoc(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('sheet doc: not an object');
  const bad = Object.entries(doc)
    .filter(([k, v]) => !k.startsWith(':') && !isSheetObject(v))
    .map(([k]) => k);
  if (bad.length) {
    throw new Error(`sheet doc: top-level key(s) ${bad.join(', ')} are neither ":"-prefixed `
      + 'nor a {total,limit,offset,data} sheet — the content bus refuses the whole doc');
  }
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
      throw new Error(`sheet doc: :names does not match the tabs (missing: ${missing.join(', ') || 'none'}; `
        + `unknown: ${extra.join(', ') || 'none'})`);
    }
  }
  return doc;
}

/**
 * Build a multi-sheet doc from ordered `[tabName, rows]` pairs.
 *
 * Ordered because `:names` order is the tab order da.live shows, and the master tab
 * must come first. Validated on the way out so a malformed envelope cannot leave here.
 */
export function multiSheetDoc(tabs) {
  const names = tabs.map(([name]) => name);
  const doc = { ':version': 3, ':type': 'multi-sheet', ':names': names };
  for (const [name, rows] of tabs) doc[name] = sheet(rows);
  return assertSheetDoc(doc);
}

/* ------------------------------------------------------------------- read / write */

/*
 * Strip a weak-ETag prefix before using the value in `If-Match`.
 *
 * This normalization is load-bearing: Cloudflare sits in front of admin.da.live and
 * rewrites the origin's strong ETag into a WEAK one (`W/"<hash>"`) whenever it gzips
 * the response — which it does for any client sending `Accept-Encoding: gzip`, i.e.
 * both node's fetch and every browser. `If-Match` requires strong comparison, so a
 * weak validator NEVER matches and the write always 412s. The inner hash is the
 * origin's real validator, so sending that succeeds. Measured, both directions:
 *
 *   GET gzip     -> W/"abc"   If-Match: W/"abc" -> 412   If-Match: "abc" -> 200
 *   GET identity ->   "abc"   If-Match: W/"abc" -> 412   If-Match: "abc" -> 200
 *
 * Without this, every conditional write fails closed — which for a status sync means
 * silently never syncing a verdict to the sheet.
 */
const strongEtag = (etag) => (etag ? etag.replace(/^W\//, '') : null);

/** GET the full multi-sheet doc. Throws with a descriptive message on failure. */
export async function fetchStatusDoc(sheetCfg, token) {
  const res = await fetch(sourceUrlFor(sheetCfg), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`status sheet GET ${res.status}`);
  return res.json();
}

/**
 * Same GET, but also returning the doc's ETag as `version`, and `exists: false`
 * instead of throwing on a 404 (a group sheet that has not been scaffolded yet is a
 * state the create path handles, not an error).
 *
 * A GET on a `.json` source DOES return an ETag and admin.da.live enforces `If-Match`,
 * so a sheet write can be made genuinely conditional. An `.html` source returns NO
 * ETag at all, so the same trick is impossible for the per-page QA/review docs: there,
 * conflicts have to be detected client-side by re-reading immediately before the write.
 * That asymmetry is why verdicts live in per-page docs and only the sheet is written by
 * a single writer — see lib/qa-doc-io.mjs for the doc side.
 *
 * Use this plus `writeStatusDoc`'s `version` option for any read-modify-write of a
 * whole sheet — the operation that would otherwise silently lose a concurrent write.
 */
export async function fetchStatusDocVersioned(sheetCfg, token) {
  const res = await fetch(sourceUrlFor(sheetCfg), { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return { exists: false, doc: null, version: null };
  if (!res.ok) throw new Error(`status sheet GET ${res.status}`);
  return { exists: true, doc: await res.json(), version: strongEtag(res.headers.get('ETag')) };
}

const docForm = (doc, filename) => {
  const form = new FormData();
  form.append('data', new Blob([JSON.stringify(doc)], { type: 'application/json' }), filename);
  return form;
};

const conflict = (message) => {
  const err = new Error(message);
  err.conflict = true;
  return err;
};

/**
 * POST the full doc back and preview it. Throws with a descriptive message on failure.
 *
 * `version` (an ETag from `fetchStatusDocVersioned`) makes the write conditional: a 412
 * then means the sheet changed since it was read and the caller must re-read and
 * re-apply rather than overwriting.
 *
 * `createOnly` sends `If-None-Match: '*'` instead, which admin.da.live honours — a 412
 * means somebody else created the sheet first. That is what makes create-if-missing
 * race-safe, and it is the one server-side precondition available on a doc with no
 * ETag.
 */
export async function writeStatusDoc(sheetCfg, token, doc, { version, createOnly } = {}) {
  assertSheetDoc(doc);
  const precondition = () => {
    if (createOnly) return { 'If-None-Match': '*' };
    return version ? { 'If-Match': strongEtag(version) } : {};
  };
  const post = await fetch(sourceUrlFor(sheetCfg), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...precondition() },
    body: docForm(doc, filenameFor(sheetCfg)),
  });
  if (post.status === 412) {
    throw conflict(createOnly
      ? 'status sheet already exists (412) — read it and apply the change instead'
      : 'status sheet changed since it was read (412) — re-read and re-apply');
  }
  if (!post.ok) throw new Error(`status sheet POST ${post.status}`);
  /*
   * PREVIEW, and REPORT what happened.
   *
   * Firing and ignoring the response hides a whole class of failure: a doc whose source
   * POST succeeds and whose preview is rejected exists in DA, is never served to the
   * site, and leaves every caller printing "published". A rollup missing `:version` did
   * exactly that — 400 from the content bus, and the dashboards quietly skipped the row
   * for hours while the tool reported success.
   *
   * Returned rather than thrown, because the source write HAS landed by this point and
   * throwing would misreport that. Callers decide; `x-error` carries the content bus's
   * own reason, which is the only thing that makes a 400 here diagnosable.
   */
  const pv = await fetch(previewApiUrl(withJson(sheetCfg.path), sheetCfg.branch), {
    method: 'POST',
    headers: aemAdminHeaders(token),
  });
  return {
    previewed: pv.ok,
    previewStatus: pv.status,
    previewError: pv.ok ? null : (pv.headers.get('x-error') || `preview ${pv.status}`),
  };
}

/**
 * Read-modify-write one sheet, safely.
 *
 * The full sequence, and every step of it is there because of a way this goes wrong:
 *
 *   1. read the doc with its ETag (or learn it does not exist);
 *   2. `mutate(doc)` builds the new doc — on a missing sheet it is called with `null`,
 *      so the caller can scaffold;
 *   3. write it: `If-Match` on an update, `If-None-Match: '*'` on a create;
 *   4. on 412, re-read ONCE and re-apply, then give up. A single retry, not a loop:
 *      when several locales are written back to back the previous write's preview is
 *      still settling inside the read-to-write window, so 412s arrive in bursts and a
 *      retry loop turns a contended sheet into a spin. The correct fix for a batch is
 *      one write per run, not more retries;
 *   5. read the doc back and let `confirm(doc)` check the change actually landed,
 *      rather than trusting a 200.
 *
 * Returns `{ written, created, retried, conditional, preview }`. Throws on a second
 * conflict (with `.conflict = true`) and on a failed confirmation.
 *
 * `conditional: false` means the update went out with NO precondition, because the read
 * returned no validator. That should not happen — a `.json` source always carries an
 * ETag — so it is reported rather than papered over: an unconditional whole-doc write
 * to a shared sheet is exactly the operation that loses a concurrent writer's rows.
 */
export async function updateStatusDoc(sheetCfg, token, mutate, { confirm } = {}) {
  const apply = async () => {
    const { exists, doc, version } = await fetchStatusDocVersioned(sheetCfg, token);
    const next = await mutate(doc, { exists, version });
    if (!next) return { skipped: true, created: false, conditional: true };
    const preview = await writeStatusDoc(sheetCfg, token, next, {
      version: exists ? version : undefined,
      createOnly: !exists,
    });
    return { created: !exists, conditional: !exists || Boolean(version), preview };
  };

  let result;
  let retried = false;
  try {
    result = await apply();
  } catch (e) {
    if (!e.conflict) throw e;
    retried = true;
    result = await apply();
  }
  if (result.skipped) {
    return {
      written: false,
      created: false,
      retried,
      conditional: true,
      preview: null,
    };
  }

  if (confirm) {
    const after = await fetchStatusDoc(sheetCfg, token);
    const problem = confirm(after);
    if (problem) throw new Error(`write reported success but ${problem}`);
  }
  return {
    written: true,
    created: result.created,
    retried,
    conditional: result.conditional,
    preview: result.preview,
  };
}

/* ------------------------------------------------------------------ row updates */

/**
 * Update one row of one tab, keyed on `page-path`.
 *
 * `page-path` is the join key across the master tab and its locale tabs (see
 * `indexLocaleRows` in scripts/tracker/stages.js). `locale` picks a locale tab; omit it
 * for the master `data` tab.
 *
 * `values` is written unconditionally; `valuesIfBlank` is written only where the cell
 * is currently empty, so a pipeline can record a derived status without clobbering a
 * verdict a human typed.
 *
 * Returns `{ updated: true }`, or `{ updated: false, reason }` for any non-fatal miss
 * (no token, sheet missing, row not found, HTTP error) — callers log `reason` as a
 * warning and move on. This is a status board, not a gate: it must never fail the run
 * that triggered it.
 */
export async function updateRow(sheetCfg, {
  pagePath, locale, values = {}, valuesIfBlank = {},
}) {
  const token = resolveToken();
  if (!token) return { updated: false, reason: `no DA token (${TOKEN_HINT})` };

  const tabName = locale || sheetCfg.sheet || 'data';
  try {
    const res = await updateStatusDoc(sheetCfg, token, (doc, { exists }) => {
      if (!exists) throw new Error(`${sheetCfg.path} does not exist — scaffold the group first`);
      if (!sheetTabs(doc).includes(tabName)) throw new Error(`no "${tabName}" tab in ${sheetCfg.path}`);
      const row = sheetRows(doc, tabName).find((r) => String(r['page-path'] || '').trim() === pagePath);
      if (!row) throw new Error(`no row with page-path "${pagePath}" in the ${tabName} tab`);
      Object.assign(row, values);
      for (const [k, v] of Object.entries(valuesIfBlank)) {
        if (!row[k]) row[k] = v;
      }
      return doc;
    });
    return {
      updated: true,
      previewed: res.preview?.previewed ?? null,
      retried: res.retried,
      conditional: res.conditional,
    };
  } catch (e) {
    return { updated: false, reason: e.message };
  }
}
