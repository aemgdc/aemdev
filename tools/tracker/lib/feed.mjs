/**
 * feed.mjs — the published-feed envelope: what may be written into a DA sheet that
 * lands on a public page, how big it may be, and how to tell "changed" from
 * "rebuilt".
 *
 * Every tool that publishes under `/tracker/data/**` goes through here — build-rollup,
 * build-escalations, publish-tx-reports, watch-rollup. The three rules below each cost
 * a real outage in the pipeline this is ported from, and each of them only has to be
 * forgotten once, so none of them lives in a caller's discipline.
 *
 * ─── 1. EVERY PUBLISHED CELL IS A SCALAR ────────────────────────────────────
 *
 * `/tracker/**` is PUBLICLY READABLE once previewed. There is one DA site here and no
 * site auth — unlike the source, where every tracker page and feed returned 401 — so
 * `noindex` is the only thing standing between a published report and a search engine,
 * and noindex is not access control.
 *
 * The stripping rule is therefore structural rather than a list of field names to
 * remember: a published row is an ALLOW-LIST projection onto named columns, and every
 * surviving value must be a string, number or boolean. That one rule removes the whole
 * class at once — the raw prose blobs, the full `checks` array, an `issues[]` with its
 * verbatim `evidence` quotes, a `textSample.pairs` of source and target sentences. A
 * deny-list would have to be extended every time a tier learns a new field, and the
 * failure mode of forgetting is publishing customer text.
 *
 * ─── 2. THE SIZE CEILING IS REAL, AND WITHHOLDING IS NORMAL ─────────────────
 *
 * Measured on the source pipeline: a 685 KB feed (1,301 rows) was refused outright by
 * the content bus, while a 38 KB one went through. So a feed that lists less than it
 * knows is an ordinary operating mode, not an error — but it MUST say so. A short feed
 * that does not explain itself reads as "we are nearly done" rather than "we
 * truncated", and that misreading is believed for a day.
 *
 * Hence `meta[0].{expected, listed, withheld}` on every feed, always, even when
 * withheld is 0.
 *
 * ─── 3. `expected/listed/withheld` COUNTS UNITS, NOT ROWS ───────────────────
 *
 * The unit is whatever the feed aggregates: pages for the English rollup, (page,
 * locale) pairs for the translation rollup, pages for a locale index.
 *
 * A shortfall has two completely different causes and they must not share a field:
 *
 *   withheld    units this build KNOWS about and chose not to represent (a
 *               non-countable row, a detail tab dropped under the ceiling). A known
 *               quantity.
 *   incomplete  a group sheet could not be read at all, so its pages were never
 *               discovered. An UNKNOWN quantity — folding it into `withheld` would
 *               claim we know how many pages we did not see.
 *
 * The second is carried as `incomplete` plus `groupsFailed`, and it is why a rollup
 * built while one sheet was unreachable does not quietly understate a denominator.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { previewUrl } from '../../../scripts/tracker/paths.js';
import { multiSheetDoc, updateStatusDoc, sheet } from './status-sheet.mjs';

/**
 * The refusal ceiling, in bytes of serialized JSON.
 *
 * Well under the 685 KB that was refused and well over the 38 KB that was accepted,
 * because the real limit is not published anywhere and the cost of finding it
 * empirically is a feed in DA that every reader 404s. Override per run with
 * `--max-bytes=`; a build that hits it withholds detail rather than failing, and only
 * fails when the smallest honest form still does not fit.
 */
export const SIZE_CEILING_BYTES = 400_000;

/** The tab every feed carries its provenance in. A bare top-level key is refused. */
export const META_TAB = 'meta';

/**
 * Meta keys that change on every build even when nothing else did.
 *
 * `watch-rollup` compares two builds for real change, and a timestamp makes every
 * build look different — which is how a 20-second poll turns into a 20-second
 * republish loop, each one previewing the doc again.
 */
export const VOLATILE_META = ['generated', 'generatedAt'];

/* ------------------------------------------------------------------ the meta row */

/**
 * The provenance row every feed carries, with the three unit counters filled in.
 *
 * `generatedAt` is the SAME instant as `generated`, under the spelling the browser
 * data layer (scripts/tracker/data.js) reads. It is a duplicate and it should not
 * survive: `generated` is the spelling in docs/tracker/data-contract.md section 3 and
 * `generatedAt` is what `metaRow(doc).generatedAt` in data.js asks for. Emitting one
 * would leave either the contract or every board's provenance stamp wrong, and a board
 * that silently shows "generated: never" is worse than a redundant key. COLLAPSE THIS
 * the moment data.js is amended — two spellings for one concept is exactly the class
 * of bug this codebase spends its comments on.
 *
 * @param {object} spec
 * @param {number} spec.expected units discovered
 * @param {number} spec.listed   units represented in the emitted rows
 * @param {string[]} [spec.groupsFailed] groups whose sheet could not be read
 * @param {object} [spec.extra]  feed-specific scalars
 */
export function metaRow({
  branch, expected, listed, groupsFailed = [], extra = {},
}) {
  const now = new Date().toISOString();
  const withheld = Math.max(0, expected - listed);
  return {
    generated: now,
    generatedAt: now,
    branch: branch || '',
    expected,
    listed,
    withheld,
    // '' rather than false: a DA sheet cell is text, and 'no' would read as a value a
    // human typed. Blank is the absence every other column in this system uses.
    incomplete: groupsFailed.length ? 'yes' : '',
    'groups-failed': groupsFailed.join(' '),
    ...extra,
  };
}

/* ---------------------------------------------------------------- publishability */

/** Is this value safe to put in a published cell? Scalars only — see rule 1. */
const isScalar = (v) => v === null || v === undefined
  || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * Field names that carry prose, source text or a whole tier's working set.
 *
 * NOT the mechanism — the allow-list in `publishable()` is. This list exists so a
 * caller that hands `publishable()` a column name it should not have asked for gets a
 * NAMED refusal instead of a silently published paragraph, and so the reason is
 * greppable from the field name a tier author is looking at.
 */
export const NEVER_PUBLISH = [
  'checks', 'issues', 'findings', 'evidence', 'quote', 'excerpt', 'snippet',
  'textSample', 'sourceText', 'targetText', 'enText', 'localeText',
  'html', 'plain', 'body', 'prose', 'raw', 'response', 'prompt', 'images',
];

/** Default caps. A cell is a table cell, not a paragraph. */
export const CELL_CAPS = { summary: 200, detail: 500, default: 300 };

const collapse = (v) => String(v).replace(/\s+/g, ' ').trim();

/**
 * Project one internal object onto the columns a public feed may carry.
 *
 * An ALLOW-LIST, deliberately: `publishable(row, COLUMNS)` cannot leak a field that
 * did not exist when it was written, which a deny-list cannot promise. Three refusals,
 * all throwing rather than dropping, because a silent drop here reads as "the tier
 * produced nothing" and a silent pass-through is a privacy incident:
 *
 *   - a requested column is in `NEVER_PUBLISH`;
 *   - a value is not a scalar (an object or array is a working set, not a cell);
 *   - nothing else. Unknown columns simply do not appear.
 *
 * Long strings are TRUNCATED with an ellipsis rather than refused: a judge's summary
 * legitimately runs long, and a bounded cell is the point.
 */
export function publishable(source, columns, caps = CELL_CAPS) {
  const banned = columns.filter((c) => NEVER_PUBLISH.includes(c));
  if (banned.length) {
    throw new Error(`publishable: column(s) ${banned.join(', ')} carry prose, source text or a whole `
      + 'tier working set and must never reach a published feed — /tracker/** is publicly readable '
      + 'once previewed');
  }
  const row = {};
  for (const c of columns) {
    const v = source?.[c];
    if (!isScalar(v)) {
      if (v === undefined) {
        row[c] = '';
      } else {
        throw new Error(`publishable: "${c}" is ${Array.isArray(v) ? 'an array' : typeof v} — every `
          + 'published cell must be a scalar. Summarise it into a bounded string first.');
      }
    } else if (typeof v === 'string') {
      const limit = caps[c] ?? caps.default;
      const flat = collapse(v);
      row[c] = flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
    } else {
      row[c] = v ?? '';
    }
  }
  return row;
}

/**
 * Refuse a whole tab whose rows carry a non-scalar cell.
 *
 * The backstop for rows built by hand rather than through `publishable()` — a
 * vocabulary tab, a counts row. Cheap, and it runs before the write rather than after
 * the content bus refuses the doc.
 */
export function assertScalarRows(tab, rows) {
  for (const [i, row] of (rows || []).entries()) {
    for (const [k, v] of Object.entries(row || {})) {
      if (!isScalar(v)) {
        throw new Error(`feed tab "${tab}" row ${i}: column "${k}" is `
          + `${Array.isArray(v) ? 'an array' : typeof v} — every published cell must be a scalar`);
      }
    }
  }
}

/* --------------------------------------------------------------- the doc envelope */

/**
 * Build a published feed document from ordered `[tab, rows]` pairs.
 *
 * `meta` is forced FIRST because that is the order the contract lists and the order a
 * human opening the sheet in da.live wants: the provenance stamp before the numbers.
 * Envelope validation is `multiSheetDoc`'s — never hand-roll it, because the
 * single-sheet spelling is accepted by admin.da.live and then refused at preview with
 * `400 error from content-bus`, leaving DA holding a file every reader 404s while the
 * tool prints success.
 */
export function feedDoc(tabs) {
  for (const [name, rows] of tabs) assertScalarRows(name, rows);
  const meta = tabs.filter(([n]) => n === META_TAB);
  if (!meta.length) throw new Error('feedDoc: every published feed carries a `meta` tab — a bare top-level key is refused by the content bus');
  return multiSheetDoc([...meta, ...tabs.filter(([n]) => n !== META_TAB)]);
}

/** Serialized size of a doc, in bytes. What the content bus actually weighs. */
export const docBytes = (doc) => Buffer.byteLength(JSON.stringify(doc), 'utf8');

/** Human-readable size, for a plan line. */
export const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/**
 * Replace one tab's rows on an already-built doc, keeping the envelope valid.
 *
 * Used by the withholding ladder: a doc over the ceiling drops detail rows and is
 * re-weighed, rather than being rebuilt from scratch each time.
 */
export function withFeedTab(doc, tab, rows) {
  assertScalarRows(tab, rows);
  if (!(tab in doc)) throw new Error(`withFeedTab: "${tab}" is not a tab of this doc`);
  return { ...doc, [tab]: sheet(rows) };
}

/**
 * A stable identity for a doc, ignoring the keys that change every build.
 *
 * `watch-rollup` republishes only when this changes. Sorting keys matters: the tabs
 * are built in a fixed order today, but a future build that reorders an object would
 * otherwise look like a content change forever.
 */
export function fingerprint(doc, ignore = VOLATILE_META) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v)
        .filter((k) => !ignore.includes(k))
        .sort()
        .map((k) => [k, strip(v[k])]));
    }
    return v;
  };
  return JSON.stringify(strip(doc));
}

/* ------------------------------------------------------------------- the write */

/**
 * The `{ path, branch }` shape the status-sheet writers take.
 *
 * A published feed has no registry entry — it is not a group sheet — but the transport
 * is identical, so it is handed the same minimal config rather than growing a second
 * writer. `sheet` is unset on purpose: these are whole-doc writes, never row updates.
 */
export const feedSheetCfg = (path, branch) => ({ path, branch });

/**
 * Write one feed to DA, conditionally, and preview it.
 *
 * `updateStatusDoc` supplies the whole safety envelope: `If-None-Match: '*'` on a
 * create, `If-Match` on an update, one 412 re-read-and-reapply, and a read-back
 * confirmation. A feed is rebuilt wholesale so there is nothing to merge on a
 * conflict — but the precondition still matters, because two watchers racing would
 * otherwise interleave a stale build over a fresh one.
 *
 * The preview result is RETURNED, never swallowed. A doc whose source POST succeeds and
 * whose preview is refused exists in DA, is never served to the site, and leaves every
 * caller printing "published" — which is exactly how a rollup missing `:version` sat
 * broken for hours while the tool reported success.
 */
export async function writeFeed(path, branch, token, doc) {
  const cfg = feedSheetCfg(path, branch);
  const want = Object.fromEntries((doc[':names'] || []).map((n) => [n, doc[n].data.length]));
  const res = await updateStatusDoc(cfg, token, () => doc, {
    confirm: (after) => {
      const names = after[':names'] || [];
      const missing = Object.keys(want).filter((n) => !names.includes(n));
      if (missing.length) return `the written doc is missing tab(s): ${missing.join(', ')}`;
      for (const [n, count] of Object.entries(want)) {
        const got = after[n]?.data?.length ?? -1;
        if (got !== count) return `the ${n} tab has ${got} row(s), expected ${count}`;
      }
      return null;
    },
  });
  return { ...res, url: previewUrl(path, branch) };
}

/**
 * Write a feed to a local directory instead of DA.
 *
 * Not a debug convenience: it is how a feed's exact bytes are inspected and diffed
 * without publishing them to a public page. `--out=` on every publishing tool.
 */
export function writeLocalFeed(dir, path, doc) {
  const file = join(dir, path.replace(/^\//, ''));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}
