#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * build-escalations.mjs — turn the two append-only escalation queues into the two
 * published escalation feeds: `/tracker/data/escalations.json` (the English QA side)
 * and `/tracker/data/tx-escalations.json` (the translation side).
 *
 * CLI SURFACE
 *   node tools/tracker/build-escalations.mjs [--dry-run|--apply] [--kind=qa|tx|both]
 *        [--branch=<ref>] [--include-resolved] [--max-bytes=N] [--out=<dir>] [--help]
 *
 *   npm run escalations                      plan both feeds
 *   npm run escalations -- --apply           publish both feeds
 *   npm run escalations -- --kind=tx --apply publish only the translation feed
 *
 *   --dry-run           print the plan, write nothing. THE DEFAULT.
 *   --apply             publish.
 *   --kind=qa|tx|both   which feed(s). Default both.
 *   --branch=<ref>      the ref recorded and previewed on. Default main.
 *   --include-resolved  keep entries the ledger says have since moved forward.
 *   --max-bytes=N       size ceiling per feed (see lib/feed.mjs).
 *   --out=<dir>         write the docs under <dir> instead of publishing.
 *
 * ─── WHAT IS PUBLISHED, AND WHY THE STRIPPING IS MANDATORY ──────────────────
 *
 * `/tracker/**` is PUBLICLY READABLE once previewed. There is one DA site here and no
 * site auth, unlike the tracker this is ported from where every page and feed returned
 * 401 and the same stripping was merely prudent. noindex is not access control.
 *
 * So every row goes through `publishable()` in lib/feed.mjs: an ALLOW-LIST projection
 * onto the thirteen columns of docs/tracker/data-contract.md section 3, with every
 * surviving value required to be a bounded scalar. That removes the whole class
 * structurally rather than by remembering field names — the raw prose blobs, the full
 * `checks` array, the `issues[]` with its verbatim `evidence` quotes, any
 * `textSample.pairs` of source and target sentences. `summary` and `detail` are the two
 * prose columns that DO ship, and they are built here by `problemLine()` from
 * classifications and counts, never by copying a model's paragraph through.
 *
 * ─── ONE GROUP VOCABULARY, ASSERTED ────────────────────────────────────────
 *
 * The upstream tracker resolved an escalation's `group` from two hardcoded URL segments
 * and emitted SINGULAR TEMPLATE KEYS where every other surface used the group name.
 * The result: the escalation feed's `group` values and the work-queue's `group` values
 * were mutually incompatible, and 21 of 23 groups were unfilterable in the UI.
 *
 * Here group name === template key === sheet basename. So `group` is resolved from the
 * page path through `groupForPath()` — the same resolver the sync uses — and every
 * emitted value is ASSERTED to be a registered group before the doc can leave this
 * process. A row whose recorded `group` disagrees with the resolver is EXCLUDED and
 * reported, never silently rewritten: a disagreement means one of the two is wrong and
 * publishing either is a guess.
 *
 * ─── WHO IS ESCALATED, AND WHO DECIDES IT IS OVER ──────────────────────────
 *
 * The `.jsonl` queue is the source of truth for WHO. It is an append-only event log,
 * one JSON object per line, written by a driver at the moment it gave up on a page.
 * The LAST line for a key is the current detail; earlier lines are history.
 *
 * The ledger is NOT consulted for status — docs/tracker/data-contract.md section 4 is
 * explicit that the ledger is run bookkeeping and the locale tab is the source of truth,
 * and the upstream tracker's weakest link was exactly this confusion. It is read for
 * two things only: `attempts`, and RESOLUTION. An append-only log with no resolution
 * rule grows forever, so an entry whose ledger status has since moved FORWARD (via
 * `translationStage()`, the regression-guard function, not `classifyTranslation` — a
 * human `review-status` would otherwise make every write look safe) is dropped and
 * counted in `meta.resolved`.
 *
 * Expected line shape — this is the contract the drivers write against:
 *
 *   { "first-seen": "<iso>", "page-path": "/en/meetups/x", "locale": "de",
 *     "tier": "structural|judge|visual|driver", "queue": "<a QUEUES id>",
 *     "scope": "template|page|content", "status": "<a TRANSLATION_STATUSES value>",
 *     "summary": "…", "detail": "…", "confidence": 0.42, "attempts": 2,
 *     "report": ".tracker/reports/tx/de--meetups--x.json" }
 *
 * Only `page-path` is required. Everything else degrades to a stated default, because a
 * driver that crashed mid-write must still leave a usable escalation behind.
 *
 * ─── A MISSING QUEUE FILE IS NOT AN EMPTY QUEUE ────────────────────────────
 *
 * If the `.jsonl` does not exist, this tool publishes NOTHING for that side and says
 * so. The browser data layer distinguishes a missing feed (`missing: true`, "never
 * built") from an empty one ("built, nothing escalated"), and publishing an empty feed
 * for a pipeline that has never run would render as "0 escalations — clear queue".
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  built (and published, with --apply). An empty-but-real queue is a 0.
 *   1  a row could not be attributed to a registered group, or a write landed and its
 *      preview was refused.
 *   2  could not reach a verdict — no token, DA unreachable.
 *   3  usage error, or the smallest honest feed is over the size ceiling.
 */
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { normalizePath, isTargetLocale } from '../../scripts/tracker/locales.js';
import {
  FEEDS, qaDocPath, txDocPath, slugOf,
} from '../../scripts/tracker/paths.js';
import {
  QUEUES,
  TRANSLATION_STATUSES,
  isQueue,
  translationStage,
} from '../../scripts/tracker/stages.js';
import {
  loadConfig, groupNames, REPO_ROOT,
} from './config.mjs';
import { resolveToken, TOKEN_HINT } from './lib/status-sheet.mjs';
import { groupForPath } from './lib/group-map.mjs';
import {
  SIZE_CEILING_BYTES,
  metaRow,
  feedDoc,
  docBytes,
  kb,
  publishable,
  writeFeed,
  writeLocalFeed,
} from './lib/feed.mjs';

/**
 * The published columns, verbatim from docs/tracker/data-contract.md section 3.
 *
 * This array IS the privacy boundary — `publishable()` projects onto it and nothing
 * else survives. Adding a column here is a decision about what goes on a public page.
 */
export const ESCALATION_COLUMNS = [
  'page-path', 'locale', 'group', 'queue', 'scope', 'summary', 'detail', 'tier',
  'confidence', 'first-seen', 'attempts', 'doc', 'report',
];

/** `translation-status` → the queue it lands in. Derived from the model, once. */
const QUEUE_FOR_STATUS = Object.fromEntries(
  TRANSLATION_STATUSES.filter((s) => s.queue).map((s) => [s.value, s.queue]),
);

/** Label of a recorded status, for a summary a human can read without a lookup. */
const LABEL_FOR_STATUS = Object.fromEntries(TRANSLATION_STATUSES.map((s) => [s.value, s.label]));

/** The queue an escalation lands in when nothing said otherwise. */
const DEFAULT_QUEUE = 'escalations';

/** Scope of the defect. `page` is the honest default: we know which page. */
const SCOPES = ['template', 'page', 'content'];

const HELP = `escalations — publish the two escalation feeds from the .jsonl queues.

  --dry-run           print the plan, write nothing (DEFAULT)
  --apply             publish
  --kind=qa|tx|both   which feed (default: both)
  --branch=<ref>      the ref recorded and previewed on (default: main)
  --include-resolved  keep entries the ledger says have moved forward
  --max-bytes=N       per-feed size ceiling (default ${SIZE_CEILING_BYTES})
  --out=<dir>         write the docs under <dir> instead of publishing
  --help              this text

Every emitted \`group\` is asserted to be a registered group before the write.

exit 0 ok · 1 unattributable row or refused preview · 2 no verdict · 3 usage or size`;

function parseArgs(args) {
  const o = {
    apply: false,
    kind: 'both',
    branch: null,
    includeResolved: false,
    maxBytes: SIZE_CEILING_BYTES,
    out: null,
    help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--include-resolved') o.includeResolved = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--kind=')) o.kind = a.slice(7);
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a.startsWith('--max-bytes=')) o.maxBytes = Number(a.slice(12));
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!['qa', 'tx', 'both'].includes(o.kind)) throw new Error('--kind must be qa, tx or both');
  if (!Number.isInteger(o.maxBytes) || o.maxBytes <= 0) throw new Error('--max-bytes must be a positive whole number');
  return o;
}

const text = (v) => (v == null ? '' : String(v).trim());

/* ------------------------------------------------------------------- the queue */

/**
 * Read a `.jsonl` queue.
 *
 * A malformed line is REPORTED and skipped, never fatal. The queue is append-only and
 * written by a process that may have been killed mid-line; refusing the whole feed
 * because of one truncated tail would hide every escalation behind it, which is the
 * opposite of what an escalation queue is for.
 */
export function readQueue(file) {
  if (!existsSync(file)) return { exists: false, events: [], malformed: [] };
  const events = [];
  const malformed = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(parsed);
        else malformed.push({ line: i + 1, why: 'not a JSON object' });
      } catch (e) {
        malformed.push({ line: i + 1, why: e.message });
      }
    }
  }
  return { exists: true, events, malformed };
}

/** The ledger, or an empty one. A ledger that has never been written is normal. */
function readLedger(file) {
  if (!existsSync(file)) return { pages: {} };
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    return { pages: doc?.pages && typeof doc.pages === 'object' ? doc.pages : {} };
  } catch (e) {
    // A corrupt ledger costs `attempts` and the resolution check, not the feed.
    return { pages: {}, error: e.message };
  }
}

/*
 * The ledger's own key: `page-path` NUL `locale`.
 *
 * Written as the `\0` ESCAPE, never pasted as a raw byte: a control character in a
 * source file makes the file binary to grep, silently hiding it from every audit that
 * greps this tree. It has to be NUL all the same — a path may contain anything a slug
 * allows, so a delimiter that can occur inside a key is a silent collision. Must agree
 * with docs/tracker/data-contract.md section 4 and `indexLocaleRows()` in
 * scripts/tracker/stages.js exactly, or every lookup misses and every entry reads as
 * unresolved.
 */
const ledgerKey = (path, code) => `${normalizePath(path)}\0${code || ''}`;

/*
 * The QA ledger is keyed by BARE PAGE PATH — English QA has no locale dimension, so
 * `qa-driver.mjs` writes `ledger.pages[path]`. Asking it for `path + NUL + ''` misses
 * every single time, which is not a visible error: `ledgerEntry` goes null, so the
 * RESOLUTION rule can never fire (the queue then grows forever, the exact failure the
 * resolution rule exists to prevent) and `attempts` silently falls back to the event
 * count, which for a page escalated once per run looks exactly like a real attempt
 * count. Measured on the committed queue: 13 of 13 rows, `resolved 0`, forever.
 */
const qaLedgerKey = (path) => normalizePath(path);

/*
 * The timestamp a driver actually writes.
 *
 * `first-seen` is what BOTH drivers emit (`qa-driver.mjs` and `tx-driver.mjs`); qa also
 * carries a per-line `ts`. This function previously read `e.at` alone — a field neither
 * driver has ever written — so `first-seen` was published EMPTY on every row and the
 * documented "old escalation outranks a fresh one" tie-break never once ran. Proven on
 * the committed queue before the fix: 13 of 13 rows blank.
 *
 * Ordered by authority, not by preference: a driver's own `first-seen` already carries
 * history forward across runs, so it beats this line's own wall clock.
 */
const eventTime = (e) => text(e['first-seen']) || text(e.at) || text(e.ts);

/* ------------------------------------------------------------- the problem line */

const MAX_ISSUES_NAMED = 3;

/**
 * One bounded, publishable line describing what is wrong.
 *
 * Heterogeneous by necessity: the input may be a driver's own message, a tier's
 * classification, a judge report on disk, or nothing but a recorded status. Each source
 * gets a shape, and the shapes are tried in order of how specific they are.
 *
 * What it must NEVER do is copy prose through. `issue.detail` is the judge's own
 * sentence about a defect and is bounded and quoted here; `issue.evidence` — the
 * verbatim source or target text the judge quoted — is deliberately not read at all,
 * and that is the single most important line in this function.
 *
 * @returns {{ summary: string, detail: string }}
 */
export function problemLine(event, report) {
  const status = text(event.status);
  const recorded = LABEL_FOR_STATUS[status] || status;
  const summary = text(event.summary)
    || (recorded ? `${recorded}${event.tier ? ` (${text(event.tier)})` : ''}` : '')
    || 'escalated with no recorded reason';

  const parts = [];
  if (text(event.detail)) parts.push(text(event.detail));

  const judge = report?.tiers?.judge;
  const issues = Array.isArray(judge?.issues) ? judge.issues : [];
  if (issues.length) {
    const named = issues.slice(0, MAX_ISSUES_NAMED)
      .map((i) => `${text(i.severity) || 'unrated'}/${text(i.kind) || 'unclassified'}: ${text(i.detail)}`)
      .join(' · ');
    const more = issues.length > MAX_ISSUES_NAMED ? ` (+${issues.length - MAX_ISSUES_NAMED} more)` : '';
    parts.push(`${issues.length} judge issue(s) — ${named}${more}`);
  }

  const structural = report?.tiers?.structural;
  if (structural?.fatal) parts.push(`structural tier fatal: ${text(structural.fatal)}`);

  const visual = report?.tiers?.visual;
  const widths = visual?.widths && typeof visual.widths === 'object' ? visual.widths : null;
  if (widths) {
    const bad = Object.entries(widths).filter(([, v]) => v !== 'pass').map(([w, v]) => `${w}px ${v}`);
    if (bad.length) parts.push(`visual: ${bad.join(', ')}`);
  }

  return { summary, detail: parts.join(' | ') || summary };
}

/* -------------------------------------------------------------- the aggregation */

/**
 * Collapse an event log into one candidate per (page, locale).
 *
 * `first-seen` is the EARLIEST `at`, `attempts` falls back to the number of events, and
 * the LAST event supplies everything else. That split is the point: a queue re-appended
 * on every retry would otherwise report the newest timestamp as the first sighting, and
 * "escalated 40 minutes ago" reads very differently from "escalated on Tuesday and
 * still open".
 */
export function collapseEvents(events) {
  const byKey = new Map();
  for (const e of events) {
    const path = normalizePath(text(e['page-path'] ?? e.path));
    if (path) {
      const code = text(e.locale);
      const key = ledgerKey(path, code);
      const at = eventTime(e);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, {
          path, locale: code, first: at, count: 1, last: e,
        });
      } else {
        prev.count += 1;
        prev.last = e;
        if (at && (!prev.first || at < prev.first)) prev.first = at;
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Build the rows for one side, with every refusal and exclusion accounted for.
 *
 * Pure apart from reading report files, so the attribution rules can be exercised
 * against real event shapes.
 *
 * @returns {{ rows, excluded, resolved, unattributed }}
 */
export function buildRows(candidates, {
  kind, ledger, registered, readReport, includeResolved,
}) {
  const rows = [];
  const excluded = [];
  let resolved = 0;

  for (const c of candidates) {
    const resolvedGroup = groupForPath(c.path);
    const recordedGroup = text(c.last.group);
    const ledgerEntry = ledger.pages?.[kind === 'qa'
      ? qaLedgerKey(c.path)
      : ledgerKey(c.path, c.locale)] || null;

    /*
     * Resolution. `translationStage()` and not `classifyTranslation()`: the latter lets
     * a human `review-status` win, so whenever a reviewer had touched the row the
     * comparison would see two identical answers and every entry would look resolved.
     * That is the exact bug the regression-guard function exists for.
     */
    /*
     * The two ledgers record progress in two different vocabularies, so "has moved on"
     * has to be asked in the right one. The tx ledger carries `translation-status`; the
     * QA ledger carries a `verdict` and nothing else that means progress. Asking the QA
     * ledger for `translation-status` — as this did — is never an error and always
     * false, so the QA feed could never resolve a single row.
     *
     * For QA, moved-on is `verdict: 'pass'`: the page was escalated, has since been
     * re-judged, and passed. Anything else (fail, escalate, error, absent) leaves the
     * row in the queue, which is the safe direction — a stale escalation costs a human
     * one look, a dropped one costs a defect shipped.
     */
    const ledgerStatus = text(ledgerEntry?.['translation-status']);
    const movedOn = kind === 'qa'
      ? text(ledgerEntry?.verdict) === 'pass'
      : Boolean(ledgerStatus) && Boolean(translationStage(ledgerStatus));

    if (!resolvedGroup) {
      excluded.push({ ...c, why: `no tracked group owns ${c.path} — see lib/group-map.mjs prefix rules` });
    } else if (!registered.includes(resolvedGroup)) {
      excluded.push({ ...c, why: `resolves to "${resolvedGroup}", which is not a registered group` });
    } else if (recordedGroup && recordedGroup !== resolvedGroup) {
      /*
       * A recorded group that disagrees with the resolver. Excluded, never rewritten:
       * one of the two is wrong, publishing either is a guess, and a guess here is what
       * made 21 of 23 groups unfilterable in the tracker this is ported from.
       */
      excluded.push({
        ...c,
        why: `recorded group "${recordedGroup}" but the path resolves to "${resolvedGroup}" — `
          + 'one of them is wrong and publishing either would be a guess',
      });
    } else if (movedOn && !includeResolved) {
      resolved += 1;
    } else {
      const code = c.locale;
      const status = text(c.last.status);
      const recordedQueue = text(c.last.queue);
      /*
       * One queue vocabulary, resolved in order of authority: what the driver recorded,
       * then what the model says the recorded status implies, then the catch-all. An
       * unrecognised recorded queue is DROPPED rather than published — `isQueue` is the
       * gate — because a queue id no board filters on is an escalation nobody sees.
       */
      const queue = [recordedQueue, QUEUE_FOR_STATUS[status], DEFAULT_QUEUE]
        .find((q) => isQueue(q));
      const scope = SCOPES.includes(text(c.last.scope)) ? text(c.last.scope) : 'page';
      const report = readReport(c, ledgerEntry);
      const { summary, detail } = problemLine(c.last, report);
      const conf = Number(c.last.confidence);

      rows.push(publishable({
        'page-path': c.path,
        locale: code,
        group: resolvedGroup,
        queue,
        scope,
        summary,
        detail,
        tier: text(c.last.tier),
        /*
         * Normalized to 0..1. Live reports in the source carried `95` against a 0..1
         * schema, and a board rendering that as a percentage showed 9500%.
         */
        confidence: Number.isFinite(conf) ? Math.min(1, conf > 1 ? conf / 100 : conf) : '',
        'first-seen': c.first,
        attempts: Number(ledgerEntry?.attempts) || c.count,
        doc: kind === 'tx' && isTargetLocale(code) ? txDocPath(c.path, code) : qaDocPath(c.path),
        report: text(ledgerEntry?.report) || text(c.last.report),
      }, ESCALATION_COLUMNS));
    }
  }

  /*
   * THE ASSERTION. Every emitted `group` is a registered group — one vocabulary shared
   * with the work queue, the group sheets and the rollup. Unreachable by construction
   * given the filter above, which is exactly what a guard should be; if it ever fires,
   * the doc does not get written.
   */
  const bad = [...new Set(rows.map((r) => r.group).filter((g) => !registered.includes(g)))];
  if (bad.length) {
    throw new Error(`escalation group(s) ${bad.join(', ')} are not registered groups — `
      + `registered: ${registered.join(', ')}. A group value no filter can match is how an `
      + 'escalation becomes invisible in the UI.');
  }

  /*
   * `attempts` descending: the page that has burned the most machine time without a
   * verdict is the one a human should look at first. `first-seen` ascending breaks the
   * tie, so an old escalation outranks a fresh one at the same attempt count.
   */
  rows.sort((a, b) => (b.attempts - a.attempts)
    || String(a['first-seen']).localeCompare(String(b['first-seen']))
    || String(a['page-path']).localeCompare(String(b['page-path'])));

  return {
    rows, excluded, resolved, unattributed: excluded.length,
  };
}

/* ------------------------------------------------------------------- one feed */

const KINDS = {
  qa: {
    label: 'escalations.json (English QA)',
    feed: FEEDS.escalations,
    queueKey: 'escalations',
    ledgerKey: 'ledger',
    reportsKey: 'reportsDir',
    reportPrefix: '',
  },
  tx: {
    label: 'tx-escalations.json (translation)',
    feed: FEEDS.txEscalations,
    queueKey: 'txEscalations',
    ledgerKey: 'txLedger',
    reportsKey: 'txReportsDir',
    reportPrefix: 'locale',
  },
};

/** Load one report file, tolerating absence. Never throws: a report is enrichment. */
function reportReader(dir, kind) {
  return (candidate, ledgerEntry) => {
    const explicit = text(ledgerEntry?.report);
    const guessed = kind === 'tx'
      ? `${candidate.locale}--${slugOf(candidate.path)}.json`
      : `${slugOf(candidate.path)}.json`;
    const named = explicit || join(dir, guessed);
    const file = isAbsolute(named) ? named : join(REPO_ROOT, named);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
}

function buildOne(kind, cfg, opts) {
  const spec = KINDS[kind];
  const queueFile = cfg.state[spec.queueKey];
  const queue = readQueue(queueFile);
  if (!queue.exists) {
    return {
      kind, spec, queueFile, skipped: true,
    };
  }

  const ledger = readLedger(cfg.state[spec.ledgerKey]);
  // Collapsed ONCE: two calls are two chances for `expected` and the row set to be
  // counted from different collapses of the same log.
  const candidates = collapseEvents(queue.events);
  const built = buildRows(candidates, {
    kind,
    ledger,
    registered: groupNames(cfg),
    readReport: reportReader(cfg.state[spec.reportsKey], kind),
    includeResolved: opts.includeResolved,
  });

  const branch = opts.branch || cfg.publish?.branch;
  const expected = candidates.length;
  const doc = feedDoc([
    ['meta', [metaRow({
      branch,
      expected,
      listed: built.rows.length,
      extra: {
        events: queue.events.length,
        malformed: queue.malformed.length,
        resolved: built.resolved,
        unattributed: built.unattributed,
        queues: QUEUES.length,
      },
    })]],
    ['escalations', built.rows],
  ]);

  return {
    kind, spec, queueFile, queue, ledger, built, doc, branch,
  };
}

/* ---------------------------------------------------------------------- the plan */

const SAMPLE = 10;

function printPlan(one, opts) {
  console.log(`\n   ── ${one.spec.label} → ${one.spec.feed} ──`);
  console.log(`      queue: ${one.queueFile}`);
  if (one.skipped) {
    console.log('      ✗ queue file does not exist — NOTHING will be published for this side.');
    console.log('        A missing feed reads as "never built"; an empty one reads as "clear queue".');
    console.log('        Those are different facts and this tool refuses to conflate them.');
    return;
  }
  const meta = one.doc.meta.data[0];
  console.log(`      events: ${meta.events} line(s) → ${meta.expected} (page, locale) key(s)`);
  if (one.queue.malformed.length) {
    for (const m of one.queue.malformed) console.log(`      ! line ${m.line} skipped: ${m.why}`);
  }
  if (one.ledger.error) console.log(`      ! ledger unreadable (${one.ledger.error}) — attempts and resolution fall back to the queue`);
  console.log(`      units:  expected ${meta.expected} · listed ${meta.listed} · withheld ${meta.withheld}`);
  console.log(`      resolved ${meta.resolved} (moved forward since)${opts.includeResolved ? ' — KEPT (--include-resolved)' : ' — dropped'}`);
  console.log(`      size:   ${kb(docBytes(one.doc))} (ceiling ${kb(opts.maxBytes)})`);
  console.log(`      columns published: ${ESCALATION_COLUMNS.join(', ')}`);

  for (const r of one.built.rows.slice(0, SAMPLE)) {
    console.log(`      → ${r['page-path']}${r.locale ? ` [${r.locale}]` : ''} ${r.group}/${r.queue} `
      + `attempts=${r.attempts} tier=${r.tier || '—'} · ${r.summary}`);
  }
  if (one.built.rows.length > SAMPLE) console.log(`      → … ${one.built.rows.length - SAMPLE} more`);
  if (!one.built.rows.length) {
    console.log('      (no open escalations — an empty feed IS published: the queue file exists,');
    console.log('       so "built, nothing escalated" is a real fact and not a missing feed)');
  }

  for (const x of one.built.excluded) {
    console.log(`      ✗ EXCLUDED ${x.path}${x.locale ? ` [${x.locale}]` : ''}: ${x.why}`);
  }
}

/* ---------------------------------------------------------------------- the run */

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const kinds = opts.kind === 'both' ? ['qa', 'tx'] : [opts.kind];

  console.log(`── escalations · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} · ${kinds.join(' + ')} ──`);
  console.log(`   registered groups: ${groupNames(cfg).join(', ')}`);

  const results = [];
  for (const kind of kinds) {
    const one = buildOne(kind, cfg, opts);
    printPlan(one, opts);
    results.push(one);
  }

  const live = results.filter((r) => !r.skipped);
  const oversize = live.filter((r) => docBytes(r.doc) > opts.maxBytes);
  for (const r of oversize) {
    console.error(`\n✗ ${r.spec.feed} is ${kb(docBytes(r.doc))}, over the ${kb(opts.maxBytes)} ceiling. `
      + 'An escalation feed cannot withhold rows — every row is a page a human owes an answer on. '
      + 'Clear some of the queue, or raise the ceiling deliberately with --max-bytes=.');
  }
  if (oversize.length) return 3;

  const unattributed = live.reduce((n, r) => n + r.built.unattributed, 0);

  if (opts.out) {
    const dir = isAbsolute(opts.out) ? opts.out : join(REPO_ROOT, opts.out);
    for (const r of live) console.log(`   wrote ${writeLocalFeed(dir, r.spec.feed, r.doc)}`);
    return unattributed ? 1 : 0;
  }

  if (!opts.apply) {
    console.log('\n   Re-run with --apply to publish.');
    return unattributed ? 1 : 0;
  }

  const token = resolveToken();
  if (!token) {
    console.error(`\nERROR: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }

  let bad = false;
  for (const r of live) {
    const res = await writeFeed(r.spec.feed, r.branch, token, r.doc);
    const preview = res.preview?.previewed ? 'ok' : `FAILED: ${res.preview?.previewError}`;
    console.log(`   ✓ ${r.spec.feed}${res.created ? ' (created)' : ''}${res.retried ? ' after one 412 retry' : ''}`
      + ` · ${r.built.rows.length} row(s) · preview ${preview}`);
    if (!res.preview?.previewed) bad = true;
  }
  return bad || unattributed ? 1 : 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ escalations: ${e.message}`);
      exit(/^unknown arg|--kind must|must be a positive/.test(e.message) ? 3 : 2);
    });
}
