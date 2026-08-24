#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * tx-scan.mjs — THE OBSERVER. Look at both hosts for every (page, locale) and write
 * the two crawl columns; corroborate `sent` against DA's own translation projects;
 * apply the SLA rule.
 *
 * Everything downstream gates on this: the QA tiers cannot read a page that is not
 * previewed, and the boards cannot show a locale as online until something observed it.
 *
 * CLI SURFACE
 *   node tools/tracker/tx-scan.mjs [--group=<name>] [--locale=<code> …]
 *        [--dry-run|--apply] [--limit=N] [--branch=<ref>]
 *        [--from-index] [--no-projects] [--force-lock] [--help]
 *
 *   npm run tx:scan                                      plan, every group, ten locales
 *   npm run tx:scan -- --group=meetups --dry-run          plan, one group
 *   npm run tx:scan -- --group=meetups --locale=de --apply
 *   npm run tx:scan -- --from-index                       observe with no DA token at all
 *
 *   --group=<name>   one registered group. Default: all of them.
 *   --locale=<code>  repeatable. Default: all ten target locales.
 *   --dry-run        observe and print the plan; write nothing. THE DEFAULT.
 *   --apply          write one sheet per group, under the writer lease.
 *   --limit=N        observe at most N pairs per group. Unscanned pairs are LEFT
 *                    ALONE, which is correct: only observed columns are written.
 *   --branch=<ref>   observe this ref's hosts. Default `main`.
 *   --from-index     take the page list from the public /en/query-index.json instead
 *                    of the group sheets. Read-only, refuses --apply — see below.
 *   --no-projects    skip the DA translation-project read (no `sent` corroboration).
 *   --force-lock     take the writer lease even if one is held. Only when you know
 *                    the holding run is dead.
 *
 * ─── `previewed` and `online` are two DISTINCT states, structurally ─────────
 *
 * DA's translation connector writes documents into DA and stops. So a translated page
 * is routinely PRESENT in DA and absent from both hosts. Existence in DA, answering on
 * the preview host, and answering on the live host are three different facts, and the
 * tool this was ported from conflated the first two: its tier-1 fetch of
 * `<url>.plain.html` 404'd on an unpreviewed document and the driver recorded
 * `rollout-fail` — technically true, completely misleading. The rollout had worked; the
 * preview had simply never run.
 *
 * Hence two columns, both re-observed every run. They are the opposite of testimony:
 * `classifyTranslation()`'s clamp ("not on the preview host = not translated, whatever
 * is recorded") only works because these are re-derived and never preserved.
 *
 * ─── One status call, not two HEADs ────────────────────────────────────────
 *
 * `admin.hlx.page/status/<org>/<site>/<ref><path>` answers UNAUTHENTICATED for this
 * site (`site.json` has `requireAuth` false) and returns `preview.status` AND
 * `live.status` in ONE response. That halves the request count against a rate-limited
 * endpoint and — more importantly — removes a HEAD-vs-GET discrepancy: a HEAD against
 * the two hosts asks a subtly different question (edge cache, redirects) than the
 * pipeline's own view of what is published. The two-HEAD path is kept as a FALLBACK for
 * when the status API itself cannot be reached, and it is reported as a fallback so a
 * run never quietly answers a different question than it claims to.
 *
 * ─── `sent` is corroborated, never overwritten ─────────────────────────────
 *
 * `sent` is the one state nothing can observe. DA's Translate app keeps its queue as
 * JSON under `/.da/translation/active/`, so a project IS a second witness — a better
 * one than our own row, because it is written by the thing that does the work. Where a
 * project confirms a pair our sheet has blank, the project wins and the run says so.
 *
 * Where a project does NOT cover a stored `sent`, that is a WARNING and nothing more.
 * Never a rewrite: a completed project is (almost certainly) moved out of `active/`, so
 * absence is weak evidence, and erasing the only record that a page was handed over on
 * the strength of weak evidence is unrecoverable — nothing can reconstruct `sent-at`.
 *
 * ─── The SLA rule ──────────────────────────────────────────────────────────
 *
 *   sent · `sent-at` older than `tx.previewSlaHours` · still not previewed
 *       → `preview-missing` (queue `awaiting-preview`)
 *   signed off · previewed · not online after `tx.publishSlaHours`
 *       → `publish-fail` (queue `publish-issues`)
 *
 * KNOWN MODEL GAP, flagged rather than worked around: `classifyTranslation()` returns
 * early on `review-status: TRANSLATION OK` (step 2) with an empty queue list, so a
 * `publish-fail` written on a signed-off row is stored correctly and then ignored by
 * every board. The stored value is still the right record of what was observed; the
 * fix belongs in `stages.js` step 2, not here, and inventing a different status to
 * dodge it would put two spellings on one concept.
 *
 * ─── SINGLE WRITER, one write per group ────────────────────────────────────
 *
 * Every locale's observations are batched into ONE conditional sheet write per group,
 * and the run holds a DA writer lease while it writes. The tool this was ported from
 * wrote nine locales back to back and 412'd 7 of 9, because the previous locale's
 * preview was still settling inside the read-to-write window. Ten locales makes that
 * worse. There is ONE 412 re-read-and-reapply retry, never a loop: on a contended
 * sheet a retry loop is a spin, and the actual fix is fewer writes.
 *
 * ─── --from-index: observing without a DA credential ───────────────────────
 *
 * Reading a group sheet needs a DA token; observing the two hosts needs nothing. So
 * `--from-index` takes the page list from the public English query index and reports
 * exactly the same observation, writing nothing. It exists because the observer's
 * transport is worth verifying independently of whether anyone has credentials on this
 * machine, and because it answers "is ANYTHING translated yet" on a repo whose group
 * sheets have not been scaffolded. It refuses `--apply`: the index is not the tracker's
 * page list, and a write keyed off it would invent rows.
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  observed and planned/written cleanly
 *   1  a defect was recorded THIS RUN — an SLA breach became `preview-missing` or
 *      `publish-fail`. Pre-existing blockers do not re-fire it.
 *   2  could not reach a verdict — no token, a sheet or the index unreachable, the
 *      writer lease held elsewhere. NOTHING was written.
 *   3  usage or configuration error, including a group sheet that does not exist.
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  TARGET_LOCALES, isTargetLocale, locale as localeMeta, normalizePath, pathForLocale,
} from '../../scripts/tracker/locales.js';
import { statusApiUrl, previewUrl, liveUrl } from '../../scripts/tracker/paths.js';
import { countsAsPage, translationOrder } from '../../scripts/tracker/stages.js';
import { loadConfig, groupConfig, groupNames } from './config.mjs';
import { resolveToken, TOKEN_HINT } from './lib/status-sheet.mjs';
import { groupForPath } from './lib/group-map.mjs';
import {
  dataRowsOf,
  localeRowsOf,
  indexLocaleTab,
  readGroupDoc,
  withLocaleRows,
  updateGroupDoc,
  groupSheetLink,
  syncLocaleRow,
  setLocaleStatus,
} from './lib/group-sheet.mjs';
import { loadProjects, sentPairs } from './lib/tx-project.mjs';
import { createLimiter, pool, request } from './lib/http-pool.mjs';
import { withWriterLock } from './lib/writer-lock.mjs';
import { fetchIndex } from './sync-groups-from-index.mjs';

/*
 * Built-in fallbacks for the `tx` block of .tracker/orchestrator.json. Stated here so
 * the tool still runs against a repo whose config predates the block, and PRINTED at
 * the top of every run so nobody has to guess which values were in force.
 */
const DEFAULTS = {
  concurrency: 6,
  requestsPerSecond: 10,
  previewSlaHours: 48,
  publishSlaHours: 24,
};

/** The partial-input floor for --from-index. Same meaning as group:sync's. */
const INDEX_FLOOR = 10;

const HELP = `tx:scan — observe both hosts for every (page, locale) and write the crawl columns.

  --group=<name>   one registered group (default: all)
  --locale=<code>  repeatable (default: all ten target locales)
  --dry-run        observe and print the plan, write nothing (DEFAULT)
  --apply          write one sheet per group, under the DA writer lease
  --limit=N        observe at most N pairs per group; unscanned pairs are left alone
  --branch=<ref>   observe this ref's hosts (default: main)
  --from-index     page list from the public /en/query-index.json; read-only
  --no-projects    skip the DA translation-project read (no sent corroboration)
  --force-lock     take the writer lease even if one is held
  --help           this text

exit 0 ok · 1 an SLA breach was recorded · 2 no verdict, nothing written · 3 usage/config`;

function parseArgs(args) {
  const o = {
    group: null,
    locales: [],
    apply: false,
    limit: 0,
    branch: null,
    fromIndex: false,
    projects: true,
    forceLock: false,
    help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--from-index') o.fromIndex = true;
    else if (a === '--no-projects') o.projects = false;
    else if (a === '--force-lock') o.forceLock = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--group=')) o.group = a.slice(8);
    else if (a.startsWith('--locale=')) o.locales.push(a.slice(9).trim().toLowerCase());
    else if (a.startsWith('--limit=')) o.limit = Number(a.slice(8));
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (o.help) return o;
  if (o.limit && !Number.isInteger(o.limit)) throw new Error('--limit must be a whole number');
  for (const code of o.locales) {
    if (!isTargetLocale(code)) {
      throw new Error(`--locale=${code} is not a target locale. Known: ${TARGET_LOCALES.join(', ')}`);
    }
  }
  if (o.fromIndex && o.apply) {
    throw new Error('--from-index refuses --apply: the query index is not the tracker\'s page list, '
      + 'so a write keyed off it would invent rows. Scaffold and sync the group sheets first.');
  }
  return o;
}

const text = (v) => (v == null ? '' : String(v).trim());
const val = (row, key) => text(row?.[key]);
const truthy = (v) => ['yes', 'y', 'true', '1'].includes(text(v).toLowerCase());
const yesNo = (b) => (b ? 'yes' : '');

/* ------------------------------------------------------------------ observation */

/**
 * Observe one (page, locale) on BOTH hosts.
 *
 * The primary signal is the status API, which reports preview and live in one call.
 * `fellBack: true` means the status API could not be reached and the two-HEAD path
 * answered instead — reported, never silent, because a HEAD asks a slightly different
 * question and a run must not quietly change what it is measuring.
 *
 * `ok: false` means we did not manage to look at all. The caller then writes NEITHER
 * column, leaving whatever the sheet had: writing `previewed: ''` on a transport error
 * would record "this page is not translated" on the strength of a DNS hiccup, and the
 * clamp in `classifyTranslation()` would then read that as a withdrawn page.
 */
export async function observePair(localePath, branch, opts) {
  const primary = await request(statusApiUrl(localePath, branch), {}, opts);
  if (primary.ok) {
    const doc = await primary.res.json().catch(() => null);
    if (doc) {
      return {
        ok: true,
        fellBack: false,
        previewed: doc.preview?.status === 200,
        online: doc.live?.status === 200,
        lastModified: doc.preview?.lastModified || doc.live?.lastModified || '',
      };
    }
  }
  const head = { method: 'HEAD', redirect: 'manual' };
  const [pv, lv] = await Promise.all([
    request(previewUrl(localePath, branch), head, opts),
    request(liveUrl(localePath, branch), head, opts),
  ]);
  // A 404 is a real answer: the page is not there. Only a transport failure or a 5xx on
  // BOTH hosts means we failed to look.
  const answered = (r) => r.ok || (r.status >= 400 && r.status < 500);
  if (!answered(pv) && !answered(lv)) {
    return {
      ok: false,
      fellBack: true,
      why: `status API ${primary.status} (${primary.detail}); HEAD preview ${pv.status}, live ${lv.status}`,
    };
  }
  return {
    ok: true, fellBack: true, previewed: pv.ok, online: lv.ok, lastModified: '',
  };
}

/* ------------------------------------------------------------------- the decision */

const HOUR = 3600000;

/** Hours since an ISO stamp, or `null` when there is no parseable stamp. */
function hoursSince(stamp, now) {
  const t = Date.parse(text(stamp));
  return Number.isNaN(t) ? null : (now - t) / HOUR;
}

/**
 * What this scan would write for one pair. Pure, so it can be tested against real rows.
 *
 * The status transitions are an EXPLICIT, ENUMERATED table rather than a comparison
 * against the funnel order, and that is the regression guard: `translationStage()`
 * exists because a reconcile built on `classifyTranslation()` silently moved 33 rows
 * backwards (every one of them carried a `review-status`, so classify compared two
 * identical answers and every write looked safe). Naming the from-state of every
 * transition means a scan can only ever make the four moves listed here.
 *
 * @returns {{ observed, status, sentAt, warnings, note }}
 */
export function decidePair({
  localeRow, obs, project, projectsRead, now, sla,
}) {
  const warnings = [];
  const current = val(localeRow, 'translation-status');
  const review = val(localeRow, 'review-status').toLowerCase();
  let sentAt = val(localeRow, 'sent-at');
  let status = null;
  let note = null;

  if (!obs.ok) {
    warnings.push(`not observed (${obs.why}) — previewed and online LEFT AS THEY WERE`);
    return {
      observed: null, status: null, sentAt: null, warnings, note,
    };
  }

  /*
   * 1. Corroborate `sent` against DA's own project queue.
   *
   * The project is the better witness: it was written by the thing that does the work.
   * So where it confirms a pair we have blank, it wins — and where our row says `sent`
   * with no `sent-at`, the project supplies the timestamp the SLA rule needs.
   */
  if (project) {
    if (current === '') {
      status = { to: 'sent', from: current, why: `project ${project.project} covers this pair` };
      sentAt = project.at;
      note = 'corroborated from the DA translation project — the project outranks our blank row';
    } else if (current === 'sent' && !sentAt) {
      sentAt = project.at;
      note = `sent-at filled from project ${project.project}`;
    }
  } else if (projectsRead && current === 'sent') {
    /*
     * A warning, and deliberately NOT a rewrite. `active/` is the queue: a completed
     * project is moved out of it, so absence here is weak evidence. Erasing `sent-at`
     * on weak evidence is unrecoverable — nothing else in the model records it.
     */
    warnings.push('recorded "sent" but no ACTIVE project covers this pair — it may have completed '
      + 'and been archived out of active/, or the send was never made. NOT rewritten.');
  }

  const effective = status ? status.to : current;
  const { previewed, online } = obs;

  // 2. Arrived. The one forward transition a crawl can justify: the page is on the
  //    preview host and we know it was sent, so `sent` → `preview-ok`.
  if ((effective === 'sent' || effective === 'preview-missing') && previewed) {
    if (translationOrder('preview-ok') > translationOrder(effective) || effective === 'preview-missing') {
      status = {
        to: 'preview-ok',
        from: current,
        why: effective === 'preview-missing' ? 'arrived late — the page now answers on the preview host' : 'answers on the preview host',
      };
    }
  } else if (effective === 'sent' && !previewed) {
    // 3. The preview SLA.
    const age = hoursSince(sentAt, now);
    if (age === null) {
      warnings.push('recorded "sent" with no sent-at — the preview SLA cannot be applied to a pair '
        + 'with no timestamp, and sent-at is testimony nothing else can rebuild');
    } else if (age > sla.previewHours) {
      status = {
        to: 'preview-missing',
        from: current,
        why: `sent ${Math.round(age)}h ago (SLA ${sla.previewHours}h) and still not on the preview host`,
        breach: true,
      };
    }
  }

  /*
   * 4. The publish SLA. Signed off and previewed but never live.
   *
   * `review-updated` is the right clock here — the sign-off is what started the wait —
   * and `sent-at` is the fallback for a row signed off before that column was written.
   */
  if (!status && review === 'translation ok' && previewed && !online) {
    const age = hoursSince(val(localeRow, 'review-updated') || sentAt, now);
    if (age !== null && age > sla.publishHours && current !== 'publish-fail') {
      status = {
        to: 'publish-fail',
        from: current,
        why: `signed off ${Math.round(age)}h ago (SLA ${sla.publishHours}h), previewed, never live`,
        breach: true,
      };
    }
  }

  return {
    observed: { previewed: yesNo(previewed), online: yesNo(online) },
    status,
    sentAt: sentAt !== val(localeRow, 'sent-at') ? sentAt : null,
    warnings,
    note,
    changed: truthy(val(localeRow, 'previewed')) !== previewed
      || truthy(val(localeRow, 'online')) !== online,
    fellBack: obs.fellBack,
  };
}

/* ---------------------------------------------------------------- pair assembly */

/** Every (page, locale) a group sheet claims, paired with its locale row. */
function pairsFromSheet(doc, codes, limit) {
  const rows = dataRowsOf(doc).filter((r) => countsAsPage(r));
  const byLocale = new Map(codes.map((c) => [c, indexLocaleTab(doc, c)]));
  const pairs = [];
  for (const row of rows) {
    const path = normalizePath(val(row, 'page-path'));
    for (const code of codes) {
      pairs.push({
        path,
        code,
        localePath: pathForLocale(path, code),
        row,
        localeRow: byLocale.get(code).get(path) || {},
      });
    }
  }
  return { pairs: limit ? pairs.slice(0, limit) : pairs, pages: rows.length };
}

/** Same shape, from the public index. No stored columns exist, so every row is `{}`. */
function pairsFromIndex(indexPages, group, codes, limit) {
  const paths = indexPages
    .filter((p) => !group || p.group === group)
    .map((p) => p.path);
  const pairs = [];
  for (const path of paths) {
    for (const code of codes) {
      pairs.push({
        path, code, localePath: pathForLocale(path, code), row: {}, localeRow: {},
      });
    }
  }
  return { pairs: limit ? pairs.slice(0, limit) : pairs, pages: paths.length };
}

/* -------------------------------------------------------------------- the report */

const SAMPLE = 12;

/**
 * Print one group's observation.
 *
 * The all-zero case is spelled out rather than left as a bare `0 of 140`. With nothing
 * translated anywhere, a correct run writes `previewed=''` everywhere — and a reader
 * who cannot tell that from a failed crawl will treat every future zero as suspect.
 */
function printGroup(name, plan) {
  console.log(`\n── ${name} ──`);
  if (plan.error) {
    console.log(`   ✗ ${plan.error}`);
    return;
  }
  console.log(`   sheet:  ${plan.sheetLabel}`);
  if (!plan.pages) {
    /*
     * `bios` legitimately has no pages from the query index: /en/fragments/** is in the
     * aemdev-en index's `exclude` and its roster (/bios.json) is owned elsewhere. Saying
     * so beats printing four bare zeroes and letting a reader wonder which of them broke.
     */
    console.log(`   no pages in this group${plan.name === 'bios'
      ? ' — expected: /en/fragments/** is excluded from that index and /bios.json is owned elsewhere'
      : ' — check the prefix rules in lib/group-map.mjs if that is a surprise'}.`);
    return;
  }
  const { total, answered, unreachable } = plan.counts;
  const universe = plan.pages * plan.codes.length;
  console.log(`   ${total} pair(s)${total < universe ? ` of ${universe} (--limit)` : ''}`
    + ` · ${plan.pages} page(s) × ${plan.codes.length} locale(s)`
    + ` · ${answered} answered · ${unreachable} not observed`);
  if (total < universe) {
    console.log(`   the ${universe - total} pair(s) the limit hid are LEFT ALONE — only observed columns are written`);
  }
  if (plan.shared) {
    console.log(`   ${plan.shared} pair(s) share a locale path with another row (\`/\` and \`/en\` are the`);
    console.log('   same page under basePath) — asked once, applied to both rows');
  }
  console.log(`   previewed: ${plan.counts.previewed} of ${answered}      online: ${plan.counts.online} of ${answered}`);
  if (plan.counts.fellBack) {
    console.log(`   ! ${plan.counts.fellBack} pair(s) answered via the HEAD fallback, not the status API`);
  }
  if (answered && !plan.counts.previewed && !plan.counts.online) {
    console.log('   Nothing is translated in these locales yet: every one of those pairs was ASKED and');
    console.log('   answered 404 on both hosts. A correct scan writes previewed=\'\' and online=\'\' for');
    console.log('   all of them. This is the honest zero, not a failed crawl.');
  }

  const perLocale = plan.codes
    .map((c) => `${c} ${plan.byLocale[c].previewed}/${plan.byLocale[c].answered}`)
    .join(' · ');
  console.log(`   previewed by locale: ${perLocale}`);

  console.log(`   crawl columns changing on ${plan.columnChanges} row(s)`);
  if (!plan.statusChanges.length) {
    console.log('   status changes: none');
  } else {
    console.log(`   status changes: ${plan.statusChanges.length}`);
    for (const c of plan.statusChanges.slice(0, SAMPLE)) {
      console.log(`     ~ ${c.path} [${c.code}]  translation-status "${c.status.from || '(blank)'}" → `
        + `"${c.status.to}"  — ${c.status.why}`);
      if (c.sentAt) console.log(`       sent-at → ${c.sentAt}`);
    }
    if (plan.statusChanges.length > SAMPLE) {
      console.log(`     ~ … ${plan.statusChanges.length - SAMPLE} more`);
    }
  }
  for (const c of plan.notes.slice(0, SAMPLE)) console.log(`     + ${c.path} [${c.code}]  ${c.note}`);
  for (const w of plan.warnings.slice(0, SAMPLE)) console.log(`     ! ${w.path} [${w.code}]  ${w.warning}`);
  if (plan.warnings.length > SAMPLE) console.log(`     ! … ${plan.warnings.length - SAMPLE} more warnings`);
}

/* --------------------------------------------------------------------- the group */

function tallyPlan({
  name, codes, pages, decisions, sheetLabel,
}) {
  const counts = {
    total: decisions.length,
    answered: 0,
    unreachable: 0,
    previewed: 0,
    online: 0,
    fellBack: 0,
  };
  const zero = () => ({ answered: 0, previewed: 0, online: 0 });
  const byLocale = Object.fromEntries(codes.map((c) => [c, zero()]));
  const statusChanges = [];
  const warnings = [];
  const notes = [];
  let columnChanges = 0;

  for (const d of decisions) {
    const bucket = byLocale[d.code];
    if (!d.decision.observed) {
      counts.unreachable += 1;
    } else {
      counts.answered += 1;
      bucket.answered += 1;
      if (d.decision.observed.previewed) {
        counts.previewed += 1;
        bucket.previewed += 1;
      }
      if (d.decision.observed.online) {
        counts.online += 1;
        bucket.online += 1;
      }
      if (d.decision.fellBack) counts.fellBack += 1;
      if (d.decision.changed) columnChanges += 1;
    }
    if (d.decision.status) {
      statusChanges.push({
        path: d.path, code: d.code, status: d.decision.status, sentAt: d.decision.sentAt,
      });
    }
    if (d.decision.note) notes.push({ path: d.path, code: d.code, note: d.decision.note });
    for (const w of d.decision.warnings) warnings.push({ path: d.path, code: d.code, warning: w });
  }

  return {
    name,
    codes,
    pages,
    sheetLabel,
    counts,
    byLocale,
    statusChanges,
    warnings,
    notes,
    columnChanges,
    breaches: statusChanges.filter((c) => c.status.breach).length,
  };
}

/**
 * Apply one group's decisions: ONE conditional write, every locale tab at once.
 *
 * The decisions are re-applied against a FRESHLY read doc inside `updateGroupDoc`, keyed
 * on (page-path, locale). A row set built from the earlier read would be stale by the
 * time it landed, and on a 412 retry it would write that stale set over somebody else's
 * concurrent change.
 */
async function applyGroup(sheetCfg, token, codes, decisions) {
  const byKey = new Map(decisions.map((d) => [`${d.path}\0${d.code}`, d.decision]));
  const want = new Map();
  for (const [key, decision] of byKey) {
    if (decision.observed || decision.status || decision.sentAt) want.set(key, decision);
  }
  if (!want.size) return { written: false };

  const res = await updateGroupDoc(sheetCfg, token, (doc, { exists }) => {
    if (!exists) throw new Error('sheet vanished between the read and the write');
    let next = doc;
    for (const code of codes) {
      const rows = localeRowsOf(doc, code).map((existing) => {
        const path = normalizePath(val(existing, 'page-path'));
        const decision = path ? want.get(`${path}\0${code}`) : null;
        if (!decision) return existing;
        // Crawl columns go through `observed`; the preserved columns go through
        // `setLocaleStatus`, which refuses anything that is not testimony.
        const { row } = syncLocaleRow(existing, {
          pagePath: path, code, observed: decision.observed || undefined,
        });
        const stamped = {};
        if (decision.status) stamped['translation-status'] = decision.status.to;
        if (decision.sentAt) stamped['sent-at'] = decision.sentAt;
        return Object.keys(stamped).length ? setLocaleStatus(row, stamped).row : row;
      });
      next = withLocaleRows(next, code, rows);
    }
    return next;
  }, {
    confirm: (after) => {
      for (const code of codes) {
        const tab = indexLocaleTab(after, code);
        const mine = [...want].filter(([key, d]) => key.endsWith(`\0${code}`) && d.observed);
        for (const [key, decision] of mine) {
          const path = key.split('\0')[0];
          const row = tab.get(path);
          if (!row) return `the ${code} tab lost the row for ${path}`;
          if (val(row, 'previewed') !== decision.observed.previewed) {
            return `${path} [${code}] previewed did not take the observed value`;
          }
        }
      }
      return null;
    },
  });
  return { written: true, ...res };
}

/* ------------------------------------------------------------------------- run */

async function scanGroup({
  name, cfg, codes, opts, token, index, sent, projectsRead, http, sla, now,
}) {
  const sheetCfg = opts.fromIndex ? null : groupConfig(cfg, name);
  let built;
  let sheetLabel;

  if (opts.fromIndex) {
    built = pairsFromIndex(index, name, codes, opts.limit);
    sheetLabel = '(--from-index: /en/query-index.json, nothing will be written)';
  } else {
    const current = await readGroupDoc(sheetCfg, token);
    if (!current.exists) {
      return {
        config: true,
        error: `sheet does not exist — run \`npm run group:scaffold -- --group=${name}\` first`,
      };
    }
    if (current.missingTabs.length) {
      return {
        config: true,
        error: `missing locale tab(s): ${current.missingTabs.join(', ')} — da.live collapsed the `
          + 'envelope. Repair it before scanning, or the observations land nowhere.',
      };
    }
    built = pairsFromSheet(current.doc, codes, opts.limit);
    sheetLabel = `${sheetCfg.path} · ${groupSheetLink(sheetCfg)}`;
  }

  /*
   * Observe each DISTINCT locale path once.
   *
   * Two data rows can share one locale path, and one pair actually does: `/` (the site
   * root) and `/en` (the locale home) have the same `basePath`, so both fan out to
   * `/de`, `/fr`, … The `indexes` group carries both rows deliberately, so the
   * collision is real rather than a bug here — observing it twice would just ask
   * admin.hlx.page the same question twice and count one page as two.
   */
  const distinct = [...new Set(built.pairs.map((p) => p.localePath))];
  const seen = new Map();
  await pool(distinct, http.lanes, async (localePath) => {
    seen.set(localePath, await observePair(localePath, http.branch, http.opts));
    return localePath;
  });

  const decisions = built.pairs.map((pair) => ({
    path: pair.path,
    code: pair.code,
    decision: decidePair({
      localeRow: pair.localeRow,
      obs: seen.get(pair.localePath),
      project: sent.get(`${pair.path}\0${pair.code}`) || null,
      projectsRead,
      now,
      sla,
    }),
  }));

  const plan = tallyPlan({
    name, codes, pages: built.pages, decisions, sheetLabel,
  });
  plan.shared = built.pairs.length - distinct.length;
  if (!opts.apply) return plan;
  const written = await applyGroup(sheetCfg, token, codes, decisions);
  return { ...plan, written };
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const branch = opts.branch || cfg.publish?.branch;
  const tx = { ...DEFAULTS, ...(cfg.tx || {}) };
  const codes = opts.locales.length ? [...new Set(opts.locales)] : [...TARGET_LOCALES];
  const names = opts.group ? [opts.group] : groupNames(cfg);
  if (!opts.fromIndex) {
    for (const n of names) groupConfig(cfg, n); // fail on a typo before any I/O
  } else if (opts.group && !groupNames(cfg).includes(opts.group)) {
    throw new Error(`unknown group "${opts.group}"`);
  }

  const token = resolveToken();
  if (!token && !opts.fromIndex) {
    console.error(`ERROR: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first, or use `
      + '--from-index to observe the hosts without reading any sheet.');
    return 2;
  }

  const limiter = createLimiter({ perSecond: tx.requestsPerSecond });
  const http = {
    lanes: tx.concurrency,
    branch,
    opts: { limiter, attempts: 3, timeoutMs: cfg.qa?.fetchTimeoutMs ?? 30000 },
  };
  const sla = { previewHours: tx.previewSlaHours, publishHours: tx.publishSlaHours };
  const now = Date.now();

  console.log(`── tx:scan · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} · branch ${branch} `
    + `· ${codes.length} locale(s) ──`);
  console.log('   observing: admin.hlx.page/status (preview + live in ONE call, unauthenticated)');
  console.log(`   limits:    ${tx.requestsPerSecond} req/s · ${tx.concurrency} lane(s) · `
    + `SLA preview ${sla.previewHours}h / publish ${sla.publishHours}h`
    + `${cfg.tx ? ' (from .tracker/orchestrator.json)' : ' (built-in — no `tx` block in orchestrator.json)'}`);
  console.log(`   locales:   ${codes.map((c) => `${c} (${localeMeta(c).name})`).join(', ')}`);

  // The page list, when it comes from the index rather than the sheets.
  let index = null;
  if (opts.fromIndex) {
    let fetched;
    try {
      fetched = await fetchIndex(branch, INDEX_FLOOR);
    } catch (e) {
      console.error(`\n✗ REFUSED ON PARTIAL INPUT — nothing was observed.\n  ${e.message}`);
      return 2;
    }
    index = fetched.rows
      .map((r) => normalizePath(r.path))
      .filter(Boolean)
      .map((path) => ({ path, group: groupForPath(path) }));
    const grouped = index.filter((p) => p.group).length;
    console.log(`   index:     ${fetched.url} · ${fetched.rows.length} row(s) · ${grouped} in a tracked group`);
    console.log('   --from-index: READ-ONLY. The page list is the query index, not the group sheets, so');
    console.log('   nothing is written and no stored status exists to corroborate or to time against.');
  }

  /*
   * The project queue, read ONCE for the whole run: it is site-wide, not per group, and
   * a project legitimately spans several groups.
   */
  let sent = new Map();
  let projectsRead = false;
  if (opts.projects && token) {
    const loaded = await loadProjects(token, { limiter, attempts: 2 });
    if (!loaded.ok) {
      console.log(`   projects:  COULD NOT READ (${loaded.status} ${loaded.detail || ''}) — no \`sent\` `
        + 'corroboration this run, and no contradiction is claimed from a list we did not get.');
    } else {
      const derived = sentPairs(loaded.projects);
      sent = derived.pairs;
      projectsRead = true;
      console.log(`   projects:  ${loaded.projects.length} active · ${sent.size} (page, locale) pair(s) `
        + `confirmed sent${loaded.failed.length ? ` · ${loaded.failed.length} unreadable` : ''}`);
      for (const f of loaded.failed) console.log(`     ! ${f.name} unreadable (${f.detail})`);
      for (const o of derived.other.slice(0, 6)) {
        console.log(`     · ${o.name} ${o.code}: ${o.why} — not counted as sent`);
      }
    }
  } else {
    console.log(`   projects:  not read (${opts.projects ? 'no DA token' : '--no-projects'}) — \`sent\` `
      + 'is taken from the sheet alone this run.');
  }

  const run = async () => {
    let configError = false;
    let transportError = false;
    let breaches = 0;
    for (const name of names) {
      try {
        const plan = await scanGroup({
          name, cfg, codes, opts, token, index, sent, projectsRead, http, sla, now,
        });
        printGroup(name, plan);
        if (plan.config) configError = true;
        breaches += plan.breaches || 0;
        if (plan.written?.written) {
          console.log(`   ✓ one write${plan.written.retried ? ' after one 412 retry' : ''} · preview `
            + `${plan.written.preview?.previewed ? 'ok' : `FAILED: ${plan.written.preview?.previewError}`}`);
        } else if (opts.apply) {
          console.log('   = nothing to write (no pair was observed, and no status moved)');
        }
      } catch (e) {
        console.error(`\n── ${name} ──\n   ✗ ${e.message}`);
        transportError = true;
      }
    }
    return { configError, transportError, breaches };
  };

  const result = opts.apply
    ? await withWriterLock(token, `tx:scan ${names.join(',')}`, { force: opts.forceLock }, run)
    : await run();

  if (!opts.apply) console.log('\n   Re-run with --apply to write the crawl columns.');
  else console.log('\n   Crawl columns written. Nothing else moved: this tool observes.');

  // Worst outcome wins: a configuration problem needs a human before anything else.
  if (result.configError) return 3;
  if (result.transportError) return 2;
  if (result.breaches) {
    console.log(`\n   ${result.breaches} SLA breach(es) recorded — exit 1. The pairs are in a work queue now.`);
    return 1;
  }
  return 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ tx:scan: ${e.message}`);
      exit(/^unknown arg|must be a whole number|is not a target locale|unknown group|refuses --apply/.test(e.message) ? 3 : 2);
    });
}
