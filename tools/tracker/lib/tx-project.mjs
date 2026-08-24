/**
 * tx-project.mjs — DA's OWN translation projects: the shape, and the two directions
 * the tracker talks to them.
 *
 * Node-only (`.mjs`; never importable from a browser entry).
 *
 * ─── What a project is ─────────────────────────────────────────────────────
 *
 * The translation mechanism on this site is DA's built-in Translate app (Google
 * connector), not a service we call. Its queue is a folder of plain JSON documents in
 * DA:
 *
 *     /<org>/<site>/.da/translation/active/<epochMs>.json
 *
 * `tx:send` WRITES one of those to hand a batch over; `tx:scan` READS them to
 * corroborate the one fact nothing else in the model can observe — that a page was
 * sent. That is the whole reason this file exists as a shared module: two tools with
 * two private opinions about `langs[].code` is a batch that reads as sent by one tool
 * and unsent by the other.
 *
 * The contract below was reverse-engineered from the adobe/da-nx source; it is not
 * publicly documented. Where a field's encoding could not be verified this file says
 * so and READS DEFENSIVELY rather than guessing on the read side — a wrong guess when
 * writing is visible in DA's own UI, a wrong guess when reading silently drops
 * testimony.
 *
 * ─── These are NOT sheets ──────────────────────────────────────────────────
 *
 * A project carries bare top-level keys (`org`, `site`, `title`, `langs`). That is
 * refused outright for a DA *sheet* — see `assertSheetDoc` in lib/status-sheet.mjs —
 * and it is fine here, because a project is application state read by da-nx through
 * admin.da.live, never published through the content bus. So:
 *
 *   - `assertSheetDoc` must NOT be applied to a project;
 *   - a project must NOT be previewed. Previewing it would push DA application state
 *     at the content bus, which refuses it, and `/tracker/**` publicity aside, a
 *     project carries `createdBy` — an email address that has no business on a public
 *     host.
 *
 * `assertProject` below is the sheet-envelope check's counterpart for this shape.
 */
import { LOCALES, SOURCE_LOCALE, normalizePath } from '../../../scripts/tracker/locales.js';
import {
  ORG, SITE, DA_TRANSLATION_ACTIVE, daSourceUrl, daListUrl,
} from '../../../scripts/tracker/paths.js';
import { request } from './http-pool.mjs';

/**
 * The per-language actions a project may ask for.
 *
 * `translate` is the only one `tx:send` ever writes. The others are listed because
 * `tx:scan` reads projects DA's own app created and must not mistake a `copy` (source
 * text placed in a locale tree untranslated) for a translation — that pair is not
 * sent for translation, it is a deliberate passthrough, and counting it as sent would
 * make a locale look further along than it is.
 */
export const PROJECT_ACTIONS = ['translate', 'copy', 'rollout', 'skip'];

/**
 * The lifecycle views, in order. A project's `view` is where DA's app opens it.
 *
 * `dashboard` is the least-progressed value and is what `tx:send` writes, deliberately:
 * we create the project and queue it, we do not run the connector. Claiming a later
 * view would tell the app a step happened that did not.
 */
export const PROJECT_VIEWS = ['dashboard', 'basics', 'validate', 'options', 'sync', 'translate', 'rollout', 'complete'];

/** `status: 'complete'` is how a project marks one of its three stages done. */
export const STAGE_COMPLETE = 'complete';

/* ------------------------------------------------------- the two locale spellings */

/*
 * The connector is told the BCP-47 casing (`zh-CN`); DA's `location` and our sheet tabs
 * use the lowercase form (`zh-cn`). scripts/tracker/locales.js holds both per locale so
 * exactly one place knows the difference — these two functions are that place for the
 * project shape, and they are derived from the registry rather than restating it.
 *
 * The failure this prevents is silent: the connector accepts an unknown code and hands
 * back the SOURCE TEXT untranslated. So a project written with `zh-cn` does not error,
 * it produces a Chinese page full of English, weeks later, in review.
 */
const BY_SERVICE = new Map(LOCALES.map((l) => [l.serviceCode.toLowerCase(), l]));

/** Our code → what the connector is told. `null` for an unknown locale. */
export const serviceCodeFor = (code) => {
  const hit = LOCALES.find((l) => l.code === String(code || '').trim().toLowerCase());
  return hit ? hit.serviceCode : null;
};

/** A project's `langs[].code` → our canonical code. `null` when nothing matches. */
export function localeForServiceCode(code) {
  const key = String(code || '').trim().toLowerCase();
  if (!key) return null;
  const hit = BY_SERVICE.get(key) || LOCALES.find((l) => l.code === key);
  return hit ? hit.code : null;
}

/* -------------------------------------------------------------------- addressing */

/** DA path of one project, WITHOUT the extension (`daSourceUrl` adds it). */
export const projectPathFor = (epochMs) => `${DA_TRANSLATION_ACTIVE}/${epochMs}`;

/** The epoch-ms id out of a project filename, or `null` for a name we did not write. */
export function epochFromName(name) {
  const m = /^(\d{10,16})\.json$/.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------------ construction */

/**
 * Build one project document.
 *
 * @param {object} spec
 * @param {string} spec.title       human label, shown in DA's project list
 * @param {string[]} spec.paths     EN page paths, the source side of the batch
 * @param {string[]} spec.codes     our locale codes (not service codes)
 * @param {string} spec.createdBy   who is asking. Recorded, and never invented.
 * @param {number} [spec.now]       epoch ms; also the document id
 * @param {string} [spec.view]      lifecycle view, default `dashboard`
 *
 * @returns {{ doc, path, epochMs }}
 *
 * Every lang gets all three stage objects (`translation`, `copy`, `rollout`) with a
 * BLANK status rather than being omitted. da-nx reads `lang.translation.status` to
 * decide whether a stage is done, and an absent object and a `'complete'` one are one
 * `?.` away from each other — writing the empty shape means a missing stage can only
 * read as not-done.
 */
export function buildProject({
  title, paths, codes, createdBy, now = Date.now(), view = 'dashboard',
}) {
  const epochMs = now;
  const doc = {
    org: ORG,
    site: SITE,
    title: String(title || '').trim(),
    view,
    urls: paths.map((p) => ({ suppliedPath: normalizePath(p) })),
    createdBy: String(createdBy || '').trim(),
    modifiedBy: String(createdBy || '').trim(),
    /*
     * Epoch ms, matching the document id. da-nx's own encoding of this field could not
     * be verified from outside, so the tracker's READER (`projectStamp`) accepts an
     * epoch number or an ISO string either way — a project DA wrote must parse here
     * whichever it used.
     */
    modifiedDate: epochMs,
    options: { 'source.language': { location: `/${SOURCE_LOCALE}` } },
    langs: codes.map((code) => {
      const l = LOCALES.find((x) => x.code === code);
      return {
        name: l.name,
        code: l.serviceCode,
        location: l.location,
        action: 'translate',
        translation: { status: '' },
        copy: { status: '' },
        rollout: { status: '' },
        locales: [],
      };
    }),
  };
  return { doc, path: projectPathFor(epochMs), epochMs };
}

/**
 * Refuse a project the tracker would not be able to read back.
 *
 * The checks are the ones whose failure is SILENT rather than loud: an unknown lang
 * code returns untranslated source text, an empty `urls` array queues a project with
 * nothing in it, and a `source.language.location` other than `/en` would translate
 * from a tree that is itself a translation.
 */
export function assertProject(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('project: not an object');
  if (doc.org !== ORG || doc.site !== SITE) {
    throw new Error(`project: org/site must be ${ORG}/${SITE}, got ${doc.org}/${doc.site}`);
  }
  if (!Array.isArray(doc.urls) || !doc.urls.length) {
    throw new Error('project: `urls` is empty — a project with no pages queues nothing and cannot be told apart from a bug');
  }
  const badUrl = doc.urls.find((u) => !u || !String(u.suppliedPath || '').startsWith('/'));
  if (badUrl) throw new Error(`project: every url needs an absolute suppliedPath, got ${JSON.stringify(badUrl)}`);
  if (!Array.isArray(doc.langs) || !doc.langs.length) throw new Error('project: `langs` is empty');
  for (const lang of doc.langs) {
    if (!localeForServiceCode(lang.code)) {
      throw new Error(`project: lang code "${lang.code}" is not a known locale — the connector accepts an `
        + 'unknown code and returns the SOURCE TEXT untranslated, so this fails silently weeks later');
    }
    if (!PROJECT_ACTIONS.includes(lang.action)) {
      throw new Error(`project: lang ${lang.code} action "${lang.action}" is not one of ${PROJECT_ACTIONS.join(', ')}`);
    }
  }
  const src = doc.options?.['source.language']?.location;
  if (src !== `/${SOURCE_LOCALE}`) {
    throw new Error(`project: source.language.location must be /${SOURCE_LOCALE}, got ${JSON.stringify(src)}`);
  }
  if (!PROJECT_VIEWS.includes(doc.view)) {
    throw new Error(`project: view "${doc.view}" is not one of ${PROJECT_VIEWS.join(', ')}`);
  }
  return doc;
}

/* ------------------------------------------------------------------- read / write */

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * List the active projects. `{ ok, projects, status }`.
 *
 * A 404 on the folder is `ok` with zero projects: nobody has ever created one, which
 * is the state this site is in today and is not an error. Anything else is reported as
 * a failure so a caller can refuse to draw a conclusion from a list it did not get —
 * an empty list read as fact would turn every stored `sent` into a contradiction and
 * fire ten warnings per page.
 */
export async function listProjects(token, opts = {}) {
  const res = await request(daListUrl(DA_TRANSLATION_ACTIVE), { headers: auth(token) }, opts);
  if (res.status === 404) return { ok: true, projects: [], status: 404 };
  if (!res.ok) return { ok: false, projects: [], status: res.status, detail: res.detail };
  const entries = await res.res.json().catch(() => null);
  if (!Array.isArray(entries)) return { ok: false, projects: [], status: res.status, detail: 'list did not return an array' };
  const projects = entries
    .filter((e) => e && (e.ext === 'json' || /\.json$/.test(e.name || '')))
    .map((e) => ({
      name: e.name,
      epochMs: epochFromName(e.name) ?? epochFromName(`${e.name}.json`),
      path: projectPathFor(String(e.name).replace(/\.json$/, '')),
    }));
  return { ok: true, projects, status: res.status };
}

/** Read one project. `{ ok, doc, status }`. */
export async function readProject(token, path, opts = {}) {
  const res = await request(daSourceUrl(path, 'json'), { headers: auth(token) }, opts);
  if (!res.ok) return { ok: false, doc: null, status: res.status, detail: res.detail };
  const doc = await res.res.json().catch(() => null);
  if (!doc) return { ok: false, doc: null, status: res.status, detail: 'project is not JSON' };
  return { ok: true, doc, status: res.status };
}

/**
 * Write one project and read it back.
 *
 * NOT previewed, and NOT written through `writeStatusDoc`: see the header. The read-back
 * is the confirmation — `tx:send` stamps the sheet only after this returns, because a
 * `sent` with no project is a claim nothing can later contradict, while a project with
 * no `sent` is exactly what `tx:scan`'s corroboration pass repairs.
 */
export async function writeProject(token, path, doc) {
  assertProject(doc);
  const form = new FormData();
  const name = `${String(path).split('/').pop()}.json`;
  form.append('data', new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }), name);
  const post = await request(daSourceUrl(path, 'json'), {
    method: 'POST', headers: auth(token), body: form,
  }, { attempts: 1 });
  if (!post.ok) return { ok: false, status: post.status, detail: post.detail };
  const back = await readProject(token, path);
  if (!back.ok) return { ok: false, status: back.status, detail: `written but unreadable: ${back.detail}` };
  const wrote = (back.doc.urls || []).length;
  if (wrote !== doc.urls.length) {
    return { ok: false, status: 200, detail: `read back ${wrote} url(s), wrote ${doc.urls.length}` };
  }
  return { ok: true, status: post.status, doc: back.doc };
}

/* ----------------------------------------------------------------- corroboration */

/**
 * The timestamp a project carries, whichever way it encoded it.
 *
 * Falls back to the document id, which IS a timestamp by construction — a project's
 * filename is the epoch ms it was created at. So there is always an answer, and it is
 * never invented.
 */
export function projectStamp(project, epochMs) {
  const raw = project?.modifiedDate;
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw).toISOString();
  const parsed = Date.parse(String(raw || ''));
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : '';
}

/**
 * Every (page, locale) a set of projects says was sent for TRANSLATION.
 *
 * Keyed `` `${path}\0${code}` `` — the same NUL-separated key `indexLocaleRows()` in
 * scripts/tracker/stages.js uses, for the same reason: a page path may contain anything
 * a slug allows, and a separator that can occur inside a key is a silent collision.
 *
 * Only `action: 'translate'` counts. A `copy` places the source text in a locale tree
 * untranslated and a `skip` does nothing; counting either as sent would make a locale
 * look further along than it is. Both are returned separately so a run can say what it
 * saw rather than dropping it.
 */
export function sentPairs(projects) {
  const pairs = new Map();
  const other = [];
  for (const { doc, epochMs, name } of projects) {
    const at = projectStamp(doc, epochMs);
    const paths = (doc.urls || []).map((u) => normalizePath(u.suppliedPath)).filter(Boolean);
    for (const lang of doc.langs || []) {
      const code = localeForServiceCode(lang.code);
      if (!code) {
        other.push({ name, code: lang.code, action: lang.action, why: 'unknown locale code' });
      } else if (lang.action !== 'translate') {
        other.push({
          name, code, action: lang.action, why: `action is "${lang.action}", not a translation`,
        });
      } else {
        for (const path of paths) {
          const key = `${path}\0${code}`;
          const prior = pairs.get(key);
          // Latest project wins on the timestamp, so a re-send is what `sent-at` reads.
          if (!prior || at > prior.at) {
            pairs.set(key, {
              at, project: name, status: lang.translation?.status || '', path, code,
            });
          }
        }
      }
    }
  }
  return { pairs, other };
}

/**
 * Load every active project, ready for `sentPairs`.
 *
 * `{ ok, projects, failed, status }`. `ok: false` means the LIST failed and no
 * conclusion may be drawn; a project that individually fails to read is reported in
 * `failed` and the rest still count, because one unreadable document is not a reason
 * to discard nine readable ones.
 */
export async function loadProjects(token, opts = {}) {
  const listed = await listProjects(token, opts);
  if (!listed.ok) return { ...listed, failed: [] };
  const projects = [];
  const failed = [];
  for (const entry of listed.projects) {
    const got = await readProject(token, entry.path, opts);
    if (got.ok) projects.push({ ...entry, doc: got.doc });
    else failed.push({ ...entry, detail: got.detail, status: got.status });
  }
  return {
    ok: true, projects, failed, status: listed.status,
  };
}
