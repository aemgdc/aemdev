#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * watch-rollup.mjs — rebuild the two rollup feeds on a poll and republish them ONLY
 * when their content actually changed.
 *
 * CLI SURFACE
 *   node tools/tracker/watch-rollup.mjs [--dry-run|--apply] [--interval=<seconds>]
 *        [--max-runs=N] [--once] [--branch=<ref>] [--max-bytes=N] [--help]
 *
 *   npm run rollup:watch -- --apply              publish on every real change
 *   npm run rollup:watch -- --interval=60        poll once a minute
 *   npm run rollup:watch -- --once               one cycle, then exit
 *
 *   --dry-run        report what would be published, write nothing. THE DEFAULT.
 *   --apply          publish on change.
 *   --interval=<s>   seconds between polls. Default 20.
 *   --max-runs=N     stop after N cycles. Default: run until interrupted.
 *   --once           equivalent to --max-runs=1.
 *   --branch=<ref>   the ref the feeds describe. Default main.
 *   --max-bytes=N    per-feed size ceiling, passed through to the build.
 *
 * ─── WHY "ONLY WHEN CHANGED" IS THE WHOLE FEATURE ───────────────────────────
 *
 * Publishing a DA sheet is a source POST plus a preview call, and previewing a doc is
 * not free — it makes admin.hlx.page fetch the document back out of DA and rebuild it.
 * A 20-second poll that republished unconditionally would preview both feeds 4,320
 * times a day for no reader benefit, and every one of those is a chance to leave DA
 * holding a half-written doc.
 *
 * `fingerprint()` in lib/feed.mjs is what makes the comparison possible: it strips the
 * keys that change on every build — `generated` and `generatedAt` — so two builds of
 * the same sheet state compare equal. Without that strip every cycle looks like a
 * change and the watcher becomes exactly the unconditional republisher it exists not to
 * be.
 *
 * ─── WHAT A CYCLE REFUSES TO DO ────────────────────────────────────────────
 *
 * A watcher must never turn a transient failure into a wrong number, and must never
 * stop because of one. So:
 *
 *   - an invariant violation SKIPS the publish and keeps watching. The next cycle will
 *     re-check, and a human fixing the sheet is picked up automatically. It is recorded
 *     as a violation cycle and reflected in the exit code, so a run that never managed
 *     a clean build does not exit 0;
 *   - a build error (DA down, no readable sheet) is logged and the cycle is skipped.
 *     The last good feed stays published, which is the correct answer to "we cannot see
 *     the sheets right now";
 *   - the fingerprint is only updated after a SUCCESSFUL publish. A failed write must
 *     be retried on the next cycle, and recording the new fingerprint first is how a
 *     watcher convinces itself it already published something it did not.
 *
 * EXIT CODES (docs/tracker/data-contract.md section 5)
 *   0  the watch ended and the last cycle was clean
 *   1  the watch ended with an invariant violation or a failed publish outstanding
 *   2  could not reach a verdict at all — no token, or no cycle ever built
 *   3  usage error
 */
import process, { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { FEEDS } from '../../scripts/tracker/paths.js';
import { loadConfig } from './config.mjs';
import { resolveToken, TOKEN_HINT } from './lib/status-sheet.mjs';
import {
  SIZE_CEILING_BYTES, fingerprint, docBytes, kb, writeFeed,
} from './lib/feed.mjs';
import { buildFeeds } from './build-rollup.mjs';

/**
 * Default poll interval, in seconds.
 *
 * 20 s is the source pipeline's value and it is a compromise, not a measurement: fast
 * enough that a reviewer flipping a status in da.live sees the board move while they are
 * still looking at it, slow enough that four group-sheet GETs per cycle is not a load.
 */
const DEFAULT_INTERVAL = 20;

const HELP = `rollup:watch — republish the rollup feeds when they actually change.

  --dry-run        report changes, write nothing (DEFAULT)
  --apply          publish on change
  --interval=<s>   seconds between polls (default ${DEFAULT_INTERVAL})
  --max-runs=N     stop after N cycles (default: until interrupted)
  --once           one cycle, then exit
  --branch=<ref>   the ref the feeds describe (default: main)
  --max-bytes=N    per-feed size ceiling (default ${SIZE_CEILING_BYTES})
  --help           this text

exit 0 clean · 1 violation or failed publish outstanding · 2 never built · 3 usage`;

function parseArgs(args) {
  const o = {
    apply: false,
    interval: DEFAULT_INTERVAL,
    maxRuns: 0,
    branch: null,
    maxBytes: SIZE_CEILING_BYTES,
    cells: true,
    subgroups: true,
    help: false,
  };
  for (const a of args) {
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--once') o.maxRuns = 1;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--interval=')) o.interval = Number(a.slice(11));
    else if (a.startsWith('--max-runs=')) o.maxRuns = Number(a.slice(11));
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else if (a.startsWith('--max-bytes=')) o.maxBytes = Number(a.slice(12));
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isFinite(o.interval) || o.interval < 1) throw new Error('--interval must be at least 1 second');
  if (!Number.isInteger(o.maxRuns) || o.maxRuns < 0) throw new Error('--max-runs must be a whole number');
  if (!Number.isInteger(o.maxBytes) || o.maxBytes <= 0) throw new Error('--max-bytes must be a positive whole number');
  return o;
}

const stamp = () => new Date().toISOString().slice(11, 19);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * One cycle: build, compare, publish what moved.
 *
 * `seen` maps a feed path to the fingerprint last SUCCESSFULLY published (or, in a dry
 * run, last reported). Mutated in place so the caller's loop stays trivial.
 *
 * @returns {{ built: boolean, violations: number, published: string[], failed: string[] }}
 */
export async function cycle({
  cfg, token, opts, seen,
}) {
  let built;
  try {
    built = await buildFeeds(cfg, token, opts);
  } catch (e) {
    console.log(`${stamp()} build failed, keeping the last published feeds — ${e.message}`);
    return {
      built: false, violations: 0, published: [], failed: [],
    };
  }

  if (built.violations.length) {
    console.log(`${stamp()} INVARIANT VIOLATED (${built.violations.length}) — nothing published this cycle`);
    for (const v of built.violations) console.log(`         ${v}`);
    return {
      built: true, violations: built.violations.length, published: [], failed: [],
    };
  }

  const feeds = [[FEEDS.rollup, built.rollup], [FEEDS.txRollup, built.txRollup]];
  const refused = feeds.filter(([, f]) => f.refused);
  if (refused.length) {
    for (const [path, f] of refused) console.log(`${stamp()} ${path} over the ceiling: ${f.refused}`);
    return {
      built: true, violations: 0, published: [], failed: refused.map(([p]) => p),
    };
  }

  const published = [];
  const failed = [];
  let quiet = 0;
  for (const [path, feed] of feeds) {
    const print = fingerprint(feed.doc);
    if (seen.get(path) === print) {
      quiet += 1;
    } else if (!opts.apply) {
      console.log(`${stamp()} ${path} CHANGED (${kb(docBytes(feed.doc))}) — would publish`);
      // A dry run records the fingerprint so a long watch reports each change once
      // rather than the same change every 20 seconds.
      seen.set(path, print);
      published.push(path);
    } else {
      try {
        const res = await writeFeed(path, built.branch, token, feed.doc);
        if (res.preview?.previewed) {
          // Recorded ONLY after the preview succeeded. A doc that is in DA but was
          // refused at preview is served to nobody, so treating it as published is how
          // a watcher stops retrying something that never worked.
          seen.set(path, print);
          published.push(path);
          console.log(`${stamp()} ${path} published (${kb(docBytes(feed.doc))})`
            + `${res.retried ? ' after one 412 retry' : ''}`);
        } else {
          failed.push(path);
          console.log(`${stamp()} ${path} written but PREVIEW REFUSED: ${res.preview?.previewError}`);
        }
      } catch (e) {
        failed.push(path);
        console.log(`${stamp()} ${path} publish failed: ${e.message}`);
      }
    }
  }
  if (quiet === feeds.length) console.log(`${stamp()} unchanged`);
  return {
    built: true, violations: 0, published, failed,
  };
}

async function main() {
  const opts = parseArgs(argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const cfg = loadConfig();
  const token = resolveToken();
  if (!token) {
    console.error(`ERROR: no DA token (${TOKEN_HINT}) — run \`npm run da-token\` first`);
    return 2;
  }

  console.log(`── rollup:watch · ${opts.apply ? 'APPLY' : 'DRY RUN (default)'} · every ${opts.interval}s`
    + `${opts.maxRuns ? ` · ${opts.maxRuns} cycle(s)` : ' · until interrupted (Ctrl-C)'} ──`);
  console.log('   comparing on a fingerprint that ignores: generated, generatedAt');

  /*
   * A clean interrupt rather than a killed process. A SIGINT in the middle of a publish
   * would otherwise abandon the write between the source POST and the preview, which is
   * precisely the state that leaves DA holding a doc every reader 404s — so the flag is
   * checked between cycles and the in-flight cycle is allowed to finish.
   */
  let stopping = false;
  const onSignal = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\n   stopping after this cycle (Ctrl-C again to abandon it)');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const seen = new Map();
  let runs = 0;
  let everBuilt = false;
  let last = null;
  while (!stopping && (!opts.maxRuns || runs < opts.maxRuns)) {
    runs += 1;
    last = await cycle({
      cfg, token, opts, seen,
    });
    everBuilt = everBuilt || last.built;
    const done = stopping || (opts.maxRuns && runs >= opts.maxRuns);
    if (!done) await sleep(opts.interval * 1000);
  }

  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  console.log(`   ${runs} cycle(s) run`);
  if (!everBuilt) return 2;
  if (last.violations || last.failed.length) return 1;
  return 0;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main()
    .then((code) => exit(code))
    .catch((e) => {
      console.error(`✗ rollup:watch: ${e.message}`);
      exit(/^unknown arg|must be a|must be at least/.test(e.message) ? 3 : 2);
    });
}
